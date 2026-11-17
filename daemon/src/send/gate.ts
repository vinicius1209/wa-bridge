/**
 * Gate de envio: todo envio passa por `draft()` (preview + token) e `confirm()`
 * (consumo único do token). Esta é a parte mais sensível do daemon — ver os
 * invariantes de segurança em docs/ARQUITETURA.md ("Gate de envio").
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants } from 'node:fs';
import { isQuietHour, maskNumber, type Config } from '../config.js';
import type { Audit } from '../obs/audit.js';
import type { Metrics } from '../obs/metrics.js';
import type { DraftRecord, Store } from '../store/store.js';
import type {
  ActiveSendView,
  DraftAction,
  DraftInput,
  GateSnapshot,
  Logger,
  MentionPreview,
  MessageChangeDone,
  PendingDraftView,
  SendDraft,
  SendWarning,
  NewChatQuota,
  StoredMessage,
} from '../types.js';
import type { WhatsAppConnection } from '../whatsapp/connection.js';
import { isBlocked as isBlockedJid } from './blocklist.js';
import { AppError } from './errors.js';
import { compressPlan, executePlan, planDelay, splitBubbles } from './human-delay.js';
import {
  applyMentionPlaceholders,
  mentionsForChunk,
  placeholderFor,
  type ResolvedMention,
} from './mentions.js';

const LARGE_TEXT_THRESHOLD = 1200;
const AMBIGUITY_SCORE_GAP = 0.15;
const ONE_HOUR_MS = 3_600_000;
const ONE_DAY_MS = 86_400_000;
/** Até quando o WhatsApp aceita editar uma mensagem enviada. */
const EDIT_WINDOW_MS = 15 * 60_000;
/** Até quando apagamos para todos. O WhatsApp aceita um pouco mais; ficamos abaixo. */
const DELETE_WINDOW_MS = 2 * ONE_DAY_MS;
/** Quanto da cota de conversas novas do WhatsApp fica de reserva (mínimo 1). */
const NEW_CHAT_QUOTA_RESERVE = 0.1;

/** Qual limite de volume barrou o envio (vai em `detail.scope` do `RATE_LIMITED`). */
type LimitScope = 'hour' | 'day' | 'chat' | 'new_contacts' | 'whatsapp_quota';

interface ExceededLimit {
  scope: LimitScope;
  message: string;
  retryAfterMs?: number;
}

/**
 * Verdadeiro quando a cota de conversas novas do WhatsApp acabou ou está na reserva: o
 * gate para antes do limite dele, não depois. `CAPPED` vale mesmo sem os números.
 */
export function newChatQuotaExhausted(quota: NewChatQuota): boolean {
  if (quota.status === 'CAPPED') return true;
  if (quota.total === null || quota.used === null) return false;
  const reserve = Math.max(1, Math.ceil(quota.total * NEW_CHAT_QUOTA_RESERVE));
  return quota.total - quota.used <= reserve;
}

/** Contexto de chamada (quem está chamando e o traceId da requisição HTTP). */
export interface CallCtx {
  agent?: string;
  traceId?: string;
}

/**
 * Payload persistido em `drafts.payload_json`. Guardamos aqui tudo que o
 * `confirm()` precisa para executar o envio sem depender de estado em memória
 * (o processo pode, em teoria, reconstruir o envio só a partir do token).
 */
interface DraftPayload {
  /** Ausente em rascunho de versão anterior do daemon, que só sabia enviar (`send`). */
  action?: DraftAction;
  /** Mensagem que a edição ou a exclusão vai mudar; ausente no envio. */
  targetMessageId?: string | null;
  chatJid: string;
  text: string | null;
  mediaPath: string | null;
  caption: string | null;
  quoteMessageId: string | null;
  bubbles: string[];
  /** Menções já resolvidas e validadas no `draft()`; o `confirm()` não re-resolve. */
  mentions: ResolvedMention[];
  warnings: SendWarning[];
  estimatedDelayMs: number;
}

/**
 * Id que o painel usa para um rascunho: hash do token de confirmação. Serve para
 * descartar e não serve para confirmar, então o token nunca precisa sair do gate.
 */
export function draftIdFor(confirmToken: string): string {
  return createHash('sha256').update(confirmToken).digest('hex').slice(0, 16);
}

/** Estado de aborto em memória para um envio em andamento (o processo é único). */
interface AbortState {
  abort: boolean;
}

export class SendGate {
  private readonly wa: WhatsAppConnection;
  private readonly store: Store;
  private readonly log: Logger;
  private readonly metrics: Metrics;
  private readonly audit: Audit;
  private readonly config: Config;
  private readonly abortFlags = new Map<string, AbortState>();

  constructor(deps: {
    wa: WhatsAppConnection;
    store: Store;
    log: Logger;
    metrics: Metrics;
    audit: Audit;
    config: Config;
  }) {
    this.wa = deps.wa;
    this.store = deps.store;
    this.log = deps.log;
    this.metrics = deps.metrics;
    this.audit = deps.audit;
    this.config = deps.config;
  }

  /** Verifica blocklist (defaults inegociáveis + `blocklist.json`) para um JID. */
  isBlocked(jid: string): { blocked: boolean; reason?: string } {
    return isBlockedJid(this.config, jid);
  }

  /** Resolve `to` (JID literal ou query de contato) sem nunca escolher por conta própria em caso de ambiguidade. */
  private resolveTarget(to: string): { jid: string; name: string | null; lastContactAt: number | null } {
    if (to.includes('@')) {
      return { jid: to, name: null, lastContactAt: this.store.lastContactAt(to) };
    }
    const matches = this.store.resolveContact(to);
    const best = matches[0];
    if (!best) {
      throw new AppError('NOT_FOUND', 404, `nenhum contato encontrado para "${to}"`);
    }
    const second = matches[1];
    if (second && best.score - second.score < AMBIGUITY_SCORE_GAP) {
      throw new AppError('AMBIGUOUS_CONTACT', 409, 'mais de um contato corresponde à busca; não escolhemos por você', {
        candidates: matches,
      });
    }
    return { jid: best.jid, name: best.name, lastContactAt: best.lastContactAt };
  }

  /**
   * Resolve cada menção pedida em um membro do grupo de destino.
   *
   * Validar a pertinência ao grupo é requisito de segurança, não conveniência: o
   * `mentionedJid` de uma mensagem é visível para todos os participantes, então
   * marcar quem não está no grupo vaza o número dessa pessoa para o grupo inteiro —
   * o mesmo vazamento que `QUOTE_WRONG_CHAT` barra na citação.
   */
  private async resolveMentions(chatJid: string, requested: string[]): Promise<ResolvedMention[]> {
    if (!chatJid.endsWith('@g.us')) {
      throw new AppError(
        'MENTION_NOT_GROUP_CHAT',
        400,
        'menção só faz sentido em grupo: em conversa individual ela não notifica ninguém e expõe o número de quem foi marcado',
      );
    }

    const participants = await this.wa.getGroupParticipants(chatJid);
    if (participants.length === 0) {
      throw new AppError(
        'GROUP_NOT_SYNCED',
        503,
        'não foi possível obter a lista de membros deste grupo; tente de novo em alguns instantes',
      );
    }

    const resolved: ResolvedMention[] = [];
    const seen = new Set<string>();

    for (const raw of requested) {
      const query = raw.trim();
      if (query.length === 0) continue;

      const matches = this.store.resolveGroupParticipant(chatJid, query);
      const best = matches[0];
      if (!best) {
        throw new AppError(
          'MENTION_NOT_IN_GROUP',
          404,
          `"${query}" não foi encontrado entre os membros deste grupo`,
          // Quem nunca falou no grupo não tem nome conhecido — só número. Dizer o
          // total ajuda o humano a entender que a lista existe, mas é anônima.
          { groupMembers: participants.length },
        );
      }
      const second = matches[1];
      if (second && best.score - second.score < AMBIGUITY_SCORE_GAP) {
        throw new AppError(
          'MENTION_AMBIGUOUS',
          409,
          `mais de um membro do grupo corresponde a "${query}"; não escolhemos por você`,
          { candidates: matches.slice(0, 8) },
        );
      }

      if (seen.has(best.jid)) continue;
      seen.add(best.jid);

      const mentionJids = best.phoneJid && best.phoneJid !== best.jid ? [best.jid, best.phoneJid] : [best.jid];
      resolved.push({
        jid: best.jid,
        phoneJid: best.phoneJid,
        name: best.name,
        maskedNumber: best.maskedNumber,
        query,
        placeholder: placeholderFor(best.jid),
        mentionJids,
      });
    }

    return resolved;
  }

  /** Garante que `mediaPath`, se informado, existe e é legível. */
  private assertMediaReadable(mediaPath: string): void {
    try {
      accessSync(mediaPath, fsConstants.R_OK);
    } catch {
      throw new AppError('MEDIA_NOT_FOUND', 404, `arquivo de mídia não encontrado ou ilegível: ${mediaPath}`);
    }
  }

  /**
   * Limites de volume, checados no rascunho e de novo no confirm. Devolve o primeiro que
   * estourou, ou `null`. Nenhum garante nada contra ban: tiram do caminho os padrões que
   * mais chamam atenção (rajada, volume alto, conversa nova em série). O intervalo por
   * conversa só vale no confirm: no rascunho ele travaria o agente enquanto o humano lê.
   */
  private exceededLimit(jid: string, firstContact: boolean, now: number, stage: 'draft' | 'confirm'): ExceededLimit | null {
    const { sendsPerHour, sendsPerDay, newContactsPerDay, chatMinIntervalMs } = this.config;
    if (this.store.countSendsSince(now - ONE_HOUR_MS) >= sendsPerHour) {
      return { scope: 'hour', message: `limite de ${sendsPerHour} envios/hora atingido` };
    }
    if (this.store.countSendsSince(now - ONE_DAY_MS) >= sendsPerDay) {
      return { scope: 'day', message: `limite de ${sendsPerDay} envios/dia atingido` };
    }
    if (stage === 'confirm' && chatMinIntervalMs > 0) {
      const last = this.store.lastSendToChatAt(jid);
      if (last !== null && now - last < chatMinIntervalMs) {
        const retryAfterMs = last + chatMinIntervalMs - now;
        return {
          scope: 'chat',
          message: `espere ${Math.ceil(retryAfterMs / 1000)}s para mandar de novo nesta conversa`,
          retryAfterMs,
        };
      }
    }
    if (firstContact) {
      if (this.store.countFirstContactSendsSince(now - ONE_DAY_MS) >= newContactsPerDay) {
        return {
          scope: 'new_contacts',
          message:
            newContactsPerDay === 0
              ? 'iniciar conversa nova está desligado (WA_NEW_CONTACTS_PER_DAY=0)'
              : `limite de ${newContactsPerDay} conversas novas por dia atingido`,
        };
      }
      const quota = this.wa.getNewChatQuota(now);
      if (quota && newChatQuotaExhausted(quota)) {
        const numbers = quota.total !== null && quota.used !== null ? ` (${quota.used} de ${quota.total})` : '';
        return {
          scope: 'whatsapp_quota',
          message: `o WhatsApp está limitando as conversas novas desta conta${numbers}`,
        };
      }
    }
    return null;
  }

  /** `RATE_LIMITED` com o limite que estourou em `detail`. */
  private rateLimited(limit: ExceededLimit): AppError {
    return new AppError('RATE_LIMITED', 429, limit.message, {
      scope: limit.scope,
      ...(limit.retryAfterMs !== undefined ? { retryAfterMs: limit.retryAfterMs } : {}),
    });
  }

  /** Cria um rascunho de envio: resolve destino, valida blocklist/rate-limit e monta o preview. */
  async draft(input: DraftInput, ctx: CallCtx = {}): Promise<SendDraft> {
    const agent = ctx.agent ?? 'unknown';
    const traceId = ctx.traceId ?? randomUUID();
    const now = Date.now();

    if (!input.to || input.to.trim().length === 0) {
      throw new AppError('VALIDATION', 400, '"to" é obrigatório');
    }
    if ((!input.text || input.text.trim().length === 0) && !input.mediaPath) {
      throw new AppError('VALIDATION', 400, 'draft precisa de "text" e/ou "mediaPath"');
    }

    const resolved = this.resolveTarget(input.to);
    const jid = resolved.jid;

    const block = this.isBlocked(jid);
    if (block.blocked) {
      this.audit.record({
        ts: now,
        traceId,
        agent,
        action: 'send.blocked',
        chatJid: jid,
        outcome: 'denied',
        detail: { reason: block.reason, stage: 'draft' },
      });
      throw new AppError('BLOCKED', 403, `destino bloqueado (${block.reason})`);
    }

    if (input.mediaPath) this.assertMediaReadable(input.mediaPath);

    // Marca como 'expired' o que já venceu, para o banco e o dashboard refletirem a
    // realidade. A correção do bloqueio está no filtro de `activeDraftForChat`; isto
    // é higiene, não a trava.
    this.store.expireDrafts(now);

    const pending = this.store.activeDraftForChat(jid);
    if (pending) {
      throw new AppError('DRAFT_ALREADY_PENDING', 409, 'já existe um rascunho pendente para este chat', {
        confirmToken: pending.confirmToken,
      });
    }

    const limit = this.exceededLimit(jid, resolved.lastContactAt === null, now, 'draft');
    if (limit) throw this.rateLimited(limit);

    // Validar a citação ANTES de montar o rascunho. Duas razões: citar uma mensagem de
    // OUTRA conversa vazaria o conteúdo dela para este chat, e citar um id inexistente
    // produziria um envio sem a citação que o humano aprovou — ambos silenciosos.
    let quotedPreview: SendDraft['quotedPreview'] = null;
    if (input.quoteMessageId) {
      const quotedMsg = this.store.getMessage(input.quoteMessageId);
      if (!quotedMsg) {
        throw new AppError('QUOTE_NOT_FOUND', 404, `mensagem citada "${input.quoteMessageId}" não encontrada`);
      }
      if (quotedMsg.chatJid !== jid) {
        throw new AppError(
          'QUOTE_WRONG_CHAT',
          409,
          'a mensagem citada pertence a outra conversa — citá-la aqui vazaria o conteúdo dela',
        );
      }
      quotedPreview = {
        messageId: quotedMsg.id,
        senderName: quotedMsg.fromMe ? 'você' : quotedMsg.senderName,
        text: quotedMsg.text,
      };
    }

    // Resolver as menções ANTES de montar o texto final: elas mudam o texto (o
    // placeholder `@<dígitos>` é injetado) e o preview precisa mostrar exatamente o
    // que vai sair, não o que o agente escreveu.
    const mentions = input.mentions?.length ? await this.resolveMentions(jid, input.mentions) : [];

    let text = input.text ?? null;
    let caption = input.caption ?? null;
    if (mentions.length > 0) {
      if (text !== null) text = applyMentionPlaceholders(text, mentions);
      else caption = applyMentionPlaceholders(caption ?? '', mentions);
    }

    const bubbles = text ? splitBubbles(text) : [];
    const plan = compressPlan(planDelay(bubbles), this.config.sendMaxDelayMs);

    const warnings: SendWarning[] = [];
    if (resolved.lastContactAt === null) warnings.push('NEVER_CONTACTED');
    if (isQuietHour(this.config, new Date(now))) warnings.push('QUIET_HOURS');
    if (jid.endsWith('@g.us')) warnings.push('GROUP_CHAT');
    if ((text?.length ?? 0) > LARGE_TEXT_THRESHOLD) warnings.push('LARGE_TEXT');

    const confirmToken = randomBytes(24).toString('base64url');
    const expiresAt = now + this.config.draftTtlMs;
    const payload: DraftPayload = {
      chatJid: jid,
      text,
      mediaPath: input.mediaPath ?? null,
      caption,
      quoteMessageId: input.quoteMessageId ?? null,
      bubbles,
      mentions,
      warnings,
      estimatedDelayMs: plan.totalMs,
    };

    this.store.insertDraft({
      confirmToken,
      chatJid: jid,
      payloadJson: JSON.stringify(payload),
      agent,
      traceId,
      createdAt: now,
      expiresAt,
      status: 'pending',
    });

    this.audit.record({
      ts: now,
      traceId,
      agent,
      action: 'draft.created',
      chatJid: jid,
      outcome: 'ok',
      detail: {
        confirmToken,
        warnings,
        bubbles: bubbles.length,
        ...(mentions.length > 0 ? { mentions: mentions.map((m) => m.jid) } : {}),
      },
    });

    const mentionsPreview: MentionPreview[] = mentions.map((m) => ({
      jid: m.jid,
      name: m.name,
      maskedNumber: m.maskedNumber,
      placeholder: m.placeholder,
    }));

    return {
      confirmToken,
      action: 'send',
      targetPreview: null,
      chatJid: jid,
      resolvedName: resolved.name,
      maskedNumber: maskNumber(this.store.phoneFor(jid)),
      lastContactAt: resolved.lastContactAt,
      neverContacted: resolved.lastContactAt === null,
      bubbles,
      mediaPath: input.mediaPath ?? null,
      quotedPreview,
      mentionsPreview,
      estimatedDelayMs: plan.totalMs,
      warnings,
      expiresAt,
    };
  }

  /**
   * Consome o `confirmToken` atomicamente (uma única vez), revalida blocklist e
   * avisos pendentes de confirmação, e dispara o envio em background. Responde
   * de imediato — o delay humano nunca bloqueia a resposta HTTP.
   */
  async confirm(
    confirmToken: string,
    agent: string,
    opts: { urgent?: boolean; acknowledge?: string[]; traceId?: string } = {},
  ): Promise<{ sendId: string; etaMs: number }> {
    const traceId = opts.traceId ?? randomUUID();
    const now = Date.now();

    // Todas as validações rodam ANTES de consumir o token. Se o consumo viesse primeiro,
    // um confirm sem o `acknowledge`/`urgent` exigido queimaria o rascunho: o agente
    // recebe CONFIRMATION_REQUIRED, repete com o campo certo e ganha "token já consumed",
    // obrigando a refazer o rascunho e a mostrar tudo de novo ao humano.
    const payload = this.pendingPayload(confirmToken, agent, traceId, now);
    // Token de edição ou exclusão não envia: o texto da edição sairia como mensagem nova.
    this.assertDraftAction(payload, 'send');
    const jid = payload.chatJid;
    this.assertNotBlocked(jid, agent, traceId, now);

    const missing: string[] = [];
    if (payload.warnings.includes('NEVER_CONTACTED') && !(opts.acknowledge ?? []).includes('NEVER_CONTACTED')) {
      missing.push('acknowledge:NEVER_CONTACTED');
    }
    if (payload.warnings.includes('QUIET_HOURS') && opts.urgent !== true) {
      missing.push('urgent');
    }
    if (missing.length > 0) {
      throw new AppError('CONFIRMATION_REQUIRED', 428, 'confirmação adicional necessária', { missing });
    }

    if (payload.mediaPath) this.assertMediaReadable(payload.mediaPath);

    // Limites TAMBÉM aqui, não só no draft. As linhas de `sends` só nascem no confirm,
    // então checar apenas no draft é furado: dá para criar N rascunhos em N chats enquanto
    // o contador está em zero e confirmar todos depois, estourando o limite à vontade.
    // O confirm é onde a mensagem realmente sai, logo é onde o limite precisa valer.
    const firstContact = payload.warnings.includes('NEVER_CONTACTED');
    const limit = this.exceededLimit(jid, firstContact, now, 'confirm');
    if (limit) {
      this.audit.record({
        ts: now,
        traceId,
        agent,
        action: 'send.blocked',
        chatJid: jid,
        outcome: 'denied',
        detail: { reason: 'RATE_LIMITED', scope: limit.scope, stage: 'confirm' },
      });
      throw this.rateLimited(limit);
    }

    // Consumo atômico: UPDATE ... WHERE status='pending' AND expires_at > now, checando
    // `changes` dentro do próprio Store. É ISTO que garante o single-use sob concorrência;
    // a leitura acima só serve para validar sem queimar o token.
    const row: DraftRecord | null = this.store.consumeDraft(confirmToken, now);
    if (!row) {
      throw new AppError('DRAFT_NOT_FOUND', 404, 'token de confirmação já usado por outra chamada');
    }

    const sendId = randomBytes(12).toString('base64url');
    this.store.insertSend({
      sendId,
      chatJid: jid,
      agent,
      traceId,
      startedAt: now,
      finishedAt: null,
      stage: 'queued',
      bubblesTotal: payload.bubbles.length,
      bubblesSent: 0,
      cancelled: false,
      messageIdsJson: '[]',
      firstContact,
    });
    this.abortFlags.set(sendId, { abort: false });

    this.audit.record({
      ts: now,
      traceId,
      agent,
      action: 'send.confirmed',
      chatJid: jid,
      outcome: 'ok',
      detail: { sendId },
    });

    // Dispara em background — a resposta HTTP não espera o delay humano.
    void this.runSend(sendId, jid, payload, agent, traceId);

    return { sendId, etaMs: payload.estimatedDelayMs };
  }

  /** Rascunho de edição de uma mensagem de texto enviada pelo usuário (até 15 minutos depois). */
  async draftEdit(input: { messageId: string; text: string }, ctx: CallCtx = {}): Promise<SendDraft> {
    if (!input.text || input.text.trim().length === 0) {
      throw new AppError('VALIDATION', 400, '"text" é obrigatório');
    }
    return this.draftChange('edit', input.messageId, input.text, ctx);
  }

  /** Rascunho de "apagar para todos" de uma mensagem enviada pelo usuário (até 2 dias depois). */
  async draftDelete(input: { messageId: string }, ctx: CallCtx = {}): Promise<SendDraft> {
    return this.draftChange('delete', input.messageId, null, ctx);
  }

  /**
   * Monta o rascunho de uma edição ou exclusão. Passa pelas mesmas travas do envio (token
   * opaco de uso único, blocklist, um rascunho ativo por conversa), e o preview traz a
   * mensagem como está hoje (`targetPreview`) para o humano conferir o alvo.
   */
  private async draftChange(
    action: 'edit' | 'delete',
    messageId: string,
    text: string | null,
    ctx: CallCtx,
  ): Promise<SendDraft> {
    const agent = ctx.agent ?? 'unknown';
    const traceId = ctx.traceId ?? randomUUID();
    const now = Date.now();

    const target = this.assertChangeable(action, messageId, now);
    if (action === 'edit' && text === target.text) {
      throw new AppError('VALIDATION', 400, 'o texto novo é igual ao atual');
    }
    const jid = target.chatJid;

    const block = this.isBlocked(jid);
    if (block.blocked) {
      this.audit.record({
        ts: now,
        traceId,
        agent,
        action: 'send.blocked',
        chatJid: jid,
        outcome: 'denied',
        detail: { reason: block.reason, stage: 'draft' },
      });
      throw new AppError('BLOCKED', 403, `destino bloqueado (${block.reason})`);
    }

    this.store.expireDrafts(now);
    const pending = this.store.activeDraftForChat(jid);
    if (pending) {
      throw new AppError('DRAFT_ALREADY_PENDING', 409, 'já existe um rascunho pendente para este chat', {
        confirmToken: pending.confirmToken,
      });
    }

    const warnings: SendWarning[] = [];
    if (jid.endsWith('@g.us')) warnings.push('GROUP_CHAT');
    if ((text?.length ?? 0) > LARGE_TEXT_THRESHOLD) warnings.push('LARGE_TEXT');

    // A edição troca o texto inteiro de uma mensagem só: não quebra em bubbles.
    const bubbles = text !== null ? [text] : [];
    const confirmToken = randomBytes(24).toString('base64url');
    const expiresAt = now + this.config.draftTtlMs;
    const payload: DraftPayload = {
      action,
      targetMessageId: messageId,
      chatJid: jid,
      text,
      mediaPath: null,
      caption: null,
      quoteMessageId: null,
      bubbles,
      mentions: [],
      warnings,
      estimatedDelayMs: 0,
    };

    this.store.insertDraft({
      confirmToken,
      chatJid: jid,
      payloadJson: JSON.stringify(payload),
      agent,
      traceId,
      createdAt: now,
      expiresAt,
      status: 'pending',
    });

    this.audit.record({
      ts: now,
      traceId,
      agent,
      action: 'draft.created',
      chatJid: jid,
      outcome: 'ok',
      detail: { confirmToken, action, messageId, warnings },
    });

    return {
      confirmToken,
      action,
      targetPreview: { messageId, ts: target.ts, text: target.text },
      chatJid: jid,
      resolvedName: this.store.getChatName(jid),
      maskedNumber: maskNumber(this.store.phoneFor(jid)),
      lastContactAt: this.store.lastContactAt(jid),
      neverContacted: false,
      bubbles,
      mediaPath: null,
      quotedPreview: null,
      mentionsPreview: [],
      estimatedDelayMs: 0,
      warnings,
      expiresAt,
    };
  }

  /**
   * Confere se a mensagem pode ser editada ou apagada agora: existe, é do usuário, não foi
   * apagada, é de texto (na edição) e está dentro do prazo do WhatsApp. Roda no rascunho e
   * de novo no confirm, porque o prazo pode vencer enquanto o humano lê o preview.
   */
  private assertChangeable(action: 'edit' | 'delete', messageId: string, now: number): StoredMessage {
    const target = this.store.getMessage(messageId);
    if (!target) {
      throw new AppError('NOT_FOUND', 404, `mensagem "${messageId}" não encontrada`);
    }
    if (!target.fromMe) {
      throw new AppError('NOT_OWN_MESSAGE', 403, 'só dá para editar ou apagar mensagem enviada por você');
    }
    if (target.deletedAt) {
      throw new AppError('MESSAGE_DELETED', 409, 'esta mensagem já foi apagada');
    }
    if (action === 'edit') {
      if (target.type !== 'text') {
        throw new AppError('EDIT_NOT_SUPPORTED', 409, 'só mensagem de texto pode ser editada');
      }
      if (now - target.ts > EDIT_WINDOW_MS) {
        throw new AppError('EDIT_WINDOW_EXPIRED', 409, 'o WhatsApp só deixa editar até 15 minutos depois do envio');
      }
    } else if (now - target.ts > DELETE_WINDOW_MS) {
      throw new AppError('DELETE_WINDOW_EXPIRED', 409, 'só apagamos para todos até 2 dias depois do envio');
    }
    return target;
  }

  /**
   * Confirma um rascunho de edição ou exclusão e executa na hora, sem delay humano (não é
   * mensagem nova). Mesmas garantias do `confirm`: token de uso único, consumido só depois
   * de todas as validações, e blocklist conferida de novo. Os limites de volume não valem
   * aqui: a mudança corrige ou desfaz algo que já saiu e não inicia conversa, e travar uma
   * correção por limite seria pior do que deixá-la passar.
   */
  async confirmChange(
    confirmToken: string,
    action: 'edit' | 'delete',
    agent: string,
    opts: { traceId?: string } = {},
  ): Promise<MessageChangeDone> {
    const traceId = opts.traceId ?? randomUUID();
    const now = Date.now();

    const payload = this.pendingPayload(confirmToken, agent, traceId, now);
    this.assertDraftAction(payload, action);
    const messageId = payload.targetMessageId;
    if (!messageId || (action === 'edit' && !payload.text)) {
      throw new AppError('DRAFT_NOT_FOUND', 404, 'rascunho incompleto; refaça o rascunho');
    }
    const jid = payload.chatJid;
    this.assertNotBlocked(jid, agent, traceId, now);
    this.assertChangeable(action, messageId, now);

    if (!this.store.consumeDraft(confirmToken, now)) {
      throw new AppError('DRAFT_NOT_FOUND', 404, 'token de confirmação já usado por outra chamada');
    }

    const auditAction = action === 'edit' ? 'message.edited' : 'message.deleted';
    try {
      if (action === 'edit') await this.wa.editMessage(jid, messageId, payload.text ?? '');
      else await this.wa.deleteMessage(jid, messageId);
    } catch (error) {
      this.log.error({ error, messageId, traceId }, `falha ao executar ${action === 'edit' ? 'edição' : 'exclusão'}`);
      this.audit.record({
        ts: Date.now(),
        traceId,
        agent,
        action: auditAction,
        chatJid: jid,
        outcome: 'error',
        detail: { messageId, error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }

    this.audit.record({
      ts: Date.now(),
      traceId,
      agent,
      action: auditAction,
      chatJid: jid,
      outcome: 'ok',
      detail: { messageId },
    });
    return { action, messageId, chatJid: jid };
  }

  /**
   * Payload de um rascunho ainda pendente e dentro da validade, sem consumir o token.
   * `DRAFT_NOT_FOUND` para token inexistente, já usado, descartado ou vencido.
   */
  private pendingPayload(confirmToken: string, agent: string, traceId: string, now: number): DraftPayload {
    const existing = this.store.getDraft(confirmToken);
    if (!existing) {
      throw new AppError('DRAFT_NOT_FOUND', 404, 'token de confirmação não encontrado');
    }
    if (existing.status !== 'pending') {
      throw new AppError('DRAFT_NOT_FOUND', 404, `token de confirmação já ${existing.status}`);
    }
    if (existing.expiresAt <= now) {
      this.audit.record({
        ts: now,
        traceId,
        agent,
        action: 'draft.expired',
        chatJid: existing.chatJid,
        outcome: 'denied',
        detail: { confirmToken },
      });
      throw new AppError('DRAFT_NOT_FOUND', 404, 'token de confirmação expirado');
    }
    return JSON.parse(existing.payloadJson) as DraftPayload;
  }

  /** Recusa um rascunho confirmado pelo caminho de outra ação (ex.: edição em `/send/confirm`). */
  private assertDraftAction(payload: DraftPayload, expected: DraftAction): void {
    const action = payload.action ?? 'send';
    if (action === expected) return;
    const names: Record<DraftAction, string> = { send: 'envio', edit: 'edição', delete: 'exclusão' };
    throw new AppError(
      'WRONG_DRAFT_ACTION',
      409,
      `este rascunho é de ${names[action]}, não de ${names[expected]}; confirme pela tool de ${names[action]}`,
      { action },
    );
  }

  /** Revalida a blocklist no confirm: o arquivo pode ter mudado desde o rascunho. */
  private assertNotBlocked(jid: string, agent: string, traceId: string, now: number): void {
    const block = this.isBlocked(jid);
    if (!block.blocked) return;
    this.audit.record({
      ts: now,
      traceId,
      agent,
      action: 'send.blocked',
      chatJid: jid,
      outcome: 'denied',
      detail: { reason: block.reason, stage: 'confirm' },
    });
    throw new AppError('BLOCKED', 403, `destino bloqueado (${block.reason})`);
  }

  /** Executa o envio (mídia primeiro, depois bubbles de texto) e atualiza `stage` conforme avança. */
  private async runSend(sendId: string, jid: string, payload: DraftPayload, agent: string, traceId: string): Promise<void> {
    const abortState = this.abortFlags.get(sendId);
    const sentIds: string[] = [];
    // Rascunho criado por uma versão anterior do daemon não tem `mentions` no payload.
    const mentions = payload.mentions ?? [];
    try {
      if (!abortState || abortState.abort) {
        this.finishAsCancelled(sendId, jid, agent, traceId, sentIds);
        return;
      }

      this.store.updateSend(sendId, { stage: 'reading' });

      // A citação vai só na PRIMEIRA mensagem do envio. Citar a mesma mensagem em todos
      // os bubbles é o que um bot faria; humano cita uma vez e continua na sequência.
      let quoted = payload.quoteMessageId ? this.wa.buildQuoted(payload.quoteMessageId) : undefined;
      if (payload.quoteMessageId && !quoted) {
        this.log.warn(
          { sendId, quoteMessageId: payload.quoteMessageId },
          'mensagem citada não encontrada — enviando sem citação',
        );
      }

      if (payload.mediaPath) {
        if (abortState.abort) {
          this.finishAsCancelled(sendId, jid, agent, traceId, sentIds);
          return;
        }
        await this.wa.setPresence(jid, 'composing');
        const mediaId = await this.wa.sendMedia(
          jid,
          payload.mediaPath,
          payload.caption ?? undefined,
          quoted,
          mentionsForChunk(payload.caption ?? '', mentions),
        );
        quoted = undefined; // consumida pela mídia
        sentIds.push(mediaId);
        this.store.updateSend(sendId, { bubblesSent: sentIds.length, messageIdsJson: JSON.stringify(sentIds) });
      }

      if (payload.bubbles.length > 0) {
        this.store.updateSend(sendId, { stage: 'typing' });
        const plan = compressPlan(planDelay(payload.bubbles), this.config.sendMaxDelayMs);
        await executePlan(plan, {
          presence: (p) => this.wa.setPresence(jid, p),
          shouldAbort: () => abortState.abort,
          send: async (bubble) => {
            this.store.updateSend(sendId, { stage: 'sending' });
            // Menção NÃO se consome como a citação: cada bubble leva as suas, porque é
            // o `@<dígitos>` presente naquele bubble que o app casa com o `mentionedJid`.
            const id = await this.wa.sendText(jid, bubble, quoted, mentionsForChunk(bubble, mentions));
            quoted = undefined; // só o primeiro bubble cita
            sentIds.push(id);
            this.store.updateSend(sendId, { bubblesSent: sentIds.length, messageIdsJson: JSON.stringify(sentIds) });
            return id;
          },
        });
      }

      const finishedAt = Date.now();
      if (abortState.abort) {
        this.store.updateSend(sendId, {
          stage: 'cancelled',
          finishedAt,
          cancelled: true,
          messageIdsJson: JSON.stringify(sentIds),
        });
        this.audit.record({
          ts: finishedAt,
          traceId,
          agent,
          action: 'send.cancelled',
          chatJid: jid,
          outcome: 'ok',
          detail: { sendId, sent: sentIds.length },
        });
      } else {
        this.store.updateSend(sendId, { stage: 'done', finishedAt, messageIdsJson: JSON.stringify(sentIds) });
        this.audit.record({
          ts: finishedAt,
          traceId,
          agent,
          action: 'send.completed',
          chatJid: jid,
          outcome: 'ok',
          detail: { sendId, sent: sentIds.length },
        });
      }
    } catch (error) {
      const finishedAt = Date.now();
      this.store.updateSend(sendId, { stage: 'failed', finishedAt, messageIdsJson: JSON.stringify(sentIds) });
      this.log.error({ error, sendId, traceId }, 'falha ao executar envio');
      this.audit.record({
        ts: finishedAt,
        traceId,
        agent,
        action: 'send.failed',
        chatJid: jid,
        outcome: 'error',
        detail: { sendId, error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      this.abortFlags.delete(sendId);
      // Envio só de mídia (ou que falhou no meio) não passa pelo fim do plano: encerra o
      // "digitando" aqui. Melhor esforço, sem socket não há o que encerrar.
      await this.wa.setPresence(jid, 'paused').catch(() => {});
    }
  }

  /** Marca um envio como cancelado antes mesmo de começar a enviar qualquer coisa. */
  private finishAsCancelled(sendId: string, jid: string, agent: string, traceId: string, sentIds: string[]): void {
    const finishedAt = Date.now();
    this.store.updateSend(sendId, {
      stage: 'cancelled',
      finishedAt,
      cancelled: true,
      messageIdsJson: JSON.stringify(sentIds),
    });
    this.audit.record({
      ts: finishedAt,
      traceId,
      agent,
      action: 'send.cancelled',
      chatJid: jid,
      outcome: 'ok',
      detail: { sendId, sent: sentIds.length },
    });
    this.abortFlags.delete(sendId);
  }

  /**
   * Descarta um rascunho ainda não confirmado, liberando o chat para um novo.
   *
   * Sem isto, revisar o texto antes de enviar obriga a esperar o TTL de 5 minutos — o
   * gate recusa um segundo rascunho para o mesmo chat (`DRAFT_ALREADY_PENDING`), que é
   * a trava correta contra envio em massa, mas vira um impasse na revisão normal.
   */
  async discardDraft(confirmToken: string, ctx: CallCtx = {}): Promise<{ discarded: boolean }> {
    const existing = this.store.getDraft(confirmToken);
    if (!existing) {
      throw new AppError('DRAFT_NOT_FOUND', 404, 'token de confirmação não encontrado');
    }
    const discarded = this.store.cancelDraft(confirmToken);
    this.audit.record({
      ts: Date.now(),
      traceId: ctx.traceId ?? randomUUID(),
      agent: ctx.agent ?? 'unknown',
      action: 'send.cancelled',
      chatJid: existing.chatJid,
      outcome: 'ok',
      detail: { stage: 'draft', discarded },
    });
    return { discarded };
  }

  /**
   * Retrato do gate para o painel: uso do limite por hora, horário de silêncio,
   * rascunhos esperando aprovação (sem o token) e envios em execução.
   */
  snapshot(now: number = Date.now()): GateSnapshot {
    const drafts: PendingDraftView[] = this.store.listPendingDrafts(now).map((d) => {
      const payload = JSON.parse(d.payloadJson) as DraftPayload;
      return {
        id: draftIdFor(d.confirmToken),
        action: payload.action ?? 'send',
        chatJid: d.chatJid,
        name: this.store.getChatName(d.chatJid),
        maskedNumber: maskNumber(this.store.phoneFor(d.chatJid)),
        bubbles: payload.bubbles,
        mediaPath: payload.mediaPath,
        warnings: payload.warnings,
        mentions: payload.mentions?.length ?? 0,
        agent: d.agent,
        createdAt: d.createdAt,
        expiresAt: d.expiresAt,
      };
    });
    // Em execução é quem tem abort flag em memória: o `stage` do banco de um envio que
    // morreu com o processo anterior não volta a andar.
    const sends: ActiveSendView[] = [];
    for (const sendId of this.abortFlags.keys()) {
      const s = this.store.getSend(sendId);
      if (!s) continue;
      sends.push({
        sendId: s.sendId,
        chatJid: s.chatJid,
        name: this.store.getChatName(s.chatJid),
        stage: s.stage,
        bubblesTotal: s.bubblesTotal ?? 0,
        bubblesSent: s.bubblesSent ?? 0,
        agent: s.agent,
        startedAt: s.startedAt,
      });
    }
    return {
      sendsLastHour: this.store.countSendsSince(now - ONE_HOUR_MS),
      sendsPerHour: this.config.sendsPerHour,
      quietHours: { active: isQuietHour(this.config, new Date(now)), window: this.config.quietHours.raw },
      draftTtlMs: this.config.draftTtlMs,
      drafts,
      sends,
    };
  }

  /** Descarta um rascunho pelo id do painel (`draftIdFor`), sem expor o token de confirmação. */
  async discardDraftById(id: string, ctx: CallCtx = {}): Promise<{ discarded: boolean }> {
    const draft = this.store.listPendingDrafts(Date.now()).find((d) => draftIdFor(d.confirmToken) === id);
    if (!draft) throw new AppError('DRAFT_NOT_FOUND', 404, 'rascunho não encontrado ou já expirado');
    return this.discardDraft(draft.confirmToken, ctx);
  }

  /** Marca o abort flag de um envio em andamento; `shouldAbort()` do plano em execução o vê. */
  async cancel(sendId: string, _ctx: CallCtx = {}): Promise<{ cancelled: boolean; stage: string }> {
    const row = this.store.getSend(sendId);
    if (!row) {
      throw new AppError('NOT_FOUND', 404, `envio "${sendId}" não encontrado`);
    }
    const state = this.abortFlags.get(sendId);
    if (!state) {
      // Já não está em execução: terminou antes do pedido de cancelamento chegar.
      return { cancelled: false, stage: row.stage };
    }
    state.abort = true;
    return { cancelled: true, stage: row.stage };
  }
}
