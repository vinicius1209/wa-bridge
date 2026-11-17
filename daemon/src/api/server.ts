/**
 * Servidor HTTP do wa-daemon: expõe todas as rotas da tabela "HTTP API" de
 * docs/ARQUITETURA.md, sempre em 127.0.0.1, com Bearer auth, traceId por request e
 * registro de métricas em todo response.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { MediaProcessor } from '../media/processor.js';
import type { Audit } from '../obs/audit.js';
import type { Metrics } from '../obs/metrics.js';
import type { SendGate } from '../send/gate.js';
import { AppError } from '../send/errors.js';
import type { Store } from '../store/store.js';
import type { CallStatus, DraftInput, Logger } from '../types.js';
import type { WhatsAppConnection } from '../whatsapp/connection.js';
import {
  asRecord,
  optionalBoolean,
  optionalString,
  optionalStringArray,
  queryBool,
  queryInt,
  queryString,
  requireString,
} from './validation.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Id de rastreio desta requisição, propagado em logs e métricas. */
    traceId: string;
    /** Agente chamador, já sanitizado (nunca confiar no header bruto). */
    callAgent: string;
    /** Timestamp monotônico (ns) do início da requisição, para medir duração. */
    startedAtNs: bigint;
    /** Mensagem de erro (se houve) para alimentar `metrics.recordCall`. */
    apiError: string | null;
  }
}

/** Dependências injetadas pelo `index.ts` — exatamente o objeto que ele monta. */
export interface ApiDeps {
  config: Config;
  store: Store;
  wa: WhatsAppConnection;
  media: MediaProcessor;
  gate: SendGate;
  metrics: Metrics;
  audit: Audit;
  log: Logger;
}

const AGENT_HEADER = 'x-wa-agent';
const AGENT_MAX_LEN = 48;
const AGENT_RE = /^[A-Za-z0-9._-]+$/;

/** Sanitiza o header `X-WA-Agent`: até 48 chars de `[A-Za-z0-9._-]`, senão cai para "unknown". */
function sanitizeAgent(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return 'unknown';
  const truncated = raw.slice(0, AGENT_MAX_LEN);
  return AGENT_RE.test(truncated) ? truncated : 'unknown';
}

/** Compara o Bearer token em tempo constante (hash fixo de 32 bytes evita branch por tamanho). */
function isValidBearer(header: string | undefined, token: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false;
  const provided = header.slice('Bearer '.length);
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

/** Resolve o diretório do dashboard (raiz do repo + `dashboard`), criando-o se ainda não existir. */
function resolveDashboardDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url)); // .../daemon/src/api/ (ou dist/api/)
  const dashboardDir = resolve(here, '..', '..', '..', 'dashboard');
  mkdirSync(dashboardDir, { recursive: true }); // painel ausente não pode quebrar o boot
  return dashboardDir;
}

/** Monta a instância Fastify com todas as rotas do contrato. Quem chama `listen` é o `index.ts`. */
export async function createApi(deps: ApiDeps): Promise<FastifyInstance> {
  const { config, store, wa, media, gate, metrics, audit, log } = deps;

  const app = Fastify({
    logger: false,
    bodyLimit: 1_000_000, // 1 MB — não precisamos de upload por aqui
    trustProxy: false,
  });

  await app.register(fastifyStatic, {
    root: resolveDashboardDir(),
    prefix: '/dashboard',
    index: ['index.html'],
    decorateReply: false,
  });

  // `@fastify/static` só serve o índice em `/dashboard/` (com barra). Sem este redirect,
  // digitar `http://127.0.0.1:7788/dashboard` no browser dá 404 — que é justamente a URL
  // que um humano digita.
  app.get('/dashboard', async (_req, reply) => reply.redirect('/dashboard/', 308));

  // ------------------------------------------------------------- traceId + auth
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    req.startedAtNs = process.hrtime.bigint();
    req.traceId = randomUUID();
    req.apiError = null;
    req.callAgent = sanitizeAgent(req.headers[AGENT_HEADER]);
    reply.header('X-Trace-Id', req.traceId);

    if (req.url === '/health' || req.url.startsWith('/health?')) return;

    // O shell estático do dashboard sai sem Bearer: um browser não consegue anexar header
    // numa navegação de documento, então exigir token aqui tornaria o painel inacessível.
    // Isso não vaza dado nenhum — HTML/CSS/JS e os mocks não têm conteúdo real, e toda rota
    // de dados (/metrics/*, /messages, /chats, /send/*) continua atrás do token.
    if (req.url === '/dashboard' || req.url.startsWith('/dashboard/') || req.url.startsWith('/dashboard?')) {
      return;
    }

    if (!isValidBearer(req.headers.authorization, config.token)) {
      throw new AppError('UNAUTHORIZED', 401, 'token ausente ou inválido');
    }
  });

  // --------------------------------------------------------------- métricas
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const durationMs = Number(process.hrtime.bigint() - req.startedAtNs) / 1e6;
    const statusCode = reply.statusCode;
    const status: CallStatus = statusCode === 401 || statusCode === 403 || statusCode === 429
      ? 'denied'
      : statusCode >= 400
        ? 'error'
        : 'ok';
    const tool = req.routeOptions.url ?? req.url;
    metrics.recordCall({
      ts: Date.now(),
      traceId: req.traceId,
      agent: req.callAgent,
      tool,
      durationMs: Math.round(durationMs),
      status,
      error: req.apiError,
    });
  });

  // ------------------------------------------------------------ erro -> JSON
  app.setErrorHandler((error: unknown, req: FastifyRequest, reply: FastifyReply) => {
    let status = 500;
    let code = 'INTERNAL';
    let message = 'erro interno';
    let detail: unknown;

    if (error instanceof AppError) {
      status = error.status;
      code = error.code;
      message = error.message;
      detail = error.detail;
    } else if (error instanceof Error) {
      // Erros de validação/parse do próprio Fastify (ex.: JSON malformado, payload grande) chegam aqui.
      const withStatus = error as Error & { statusCode?: number };
      status = withStatus.statusCode ?? 500;
      code = status < 500 ? 'VALIDATION' : 'INTERNAL';
      message = status < 500 ? error.message : 'erro interno';
      if (status >= 500) log.error({ err: error, traceId: req.traceId }, 'erro não tratado na API');
    }

    req.apiError = message;
    void reply
      .code(status)
      .send({ error: { code, message, ...(detail !== undefined ? { detail } : {}) } });
  });

  // ------------------------------------------------------------------ rotas

  /**
   * GET /health: único endpoint sem auth; usado por monitoramento, pelo script e pela
   * identidade do painel. Qualquer processo da máquina lê isto, então só vai o mínimo:
   * o estado da sessão sem o número da conta (`me`), sem o QR e sem o último erro (esses
   * ficam em `/session`, com token).
   */
  app.get('/health', async () => {
    const session = wa.getSessionState();
    return {
      ok: true,
      version: config.version,
      session: { state: session.state, since: session.since },
      // Sem token de propósito: o painel precisa saber de qual número é antes do login.
      // Só rótulo, cor e o caminho do token (nunca o token em si).
      account: config.account,
    };
  });

  /** GET /session — estado completo da sessão Baileys, incl. QR quando pareando. */
  app.get('/session', async () => wa.getSessionState());

  /** POST /session/pair — derruba a sessão e inicia novo pareamento; não bloqueia a resposta. */
  app.post('/session/pair', async () => {
    wa.forcePair().catch((error: unknown) => log.error({ error }, 'falha ao forçar pareamento'));
    return { started: true };
  });

  /** GET /chats — lista conversas, com paginação simples e filtro de não-lidas. */
  app.get('/chats', async (req) => {
    const limit = queryInt(req.query, 'limit', 30);
    const onlyUnread = queryBool(req.query, 'only_unread', false);
    return { chats: store.listChats({ limit, onlyUnread }) };
  });

  /** GET /contacts/resolve — resolução de contato por alias/nome/número, ordenada por score. */
  app.get('/contacts/resolve', async (req) => {
    const q = queryString(req.query, 'q');
    if (!q) throw new AppError('VALIDATION', 400, '"q" é obrigatório');
    return { matches: store.resolveContact(q) };
  });

  /** POST /contacts/alias — define um apelido para um JID. */
  app.post('/contacts/alias', async (req) => {
    const body = asRecord(req.body, 'body');
    const alias = requireString(body, 'alias');
    const jid = requireString(body, 'jid');
    store.setAlias(alias, jid);
    audit.record({
      ts: Date.now(),
      traceId: req.traceId,
      agent: req.callAgent,
      action: 'alias.set',
      chatJid: jid,
      outcome: 'ok',
      detail: { alias },
    });
    return { ok: true };
  });

  /**
   * GET /groups/:jid/participants — membros de um grupo, para resolver quem pode ser
   * @marcado. `?refresh=true` força consulta ao WhatsApp (tem rate limit; use com parcimônia).
   */
  app.get<{ Params: { jid: string } }>('/groups/:jid/participants', async (req) => {
    const refresh = queryBool(req.query, 'refresh', false);
    // A chamada ao `wa` existe pelo efeito: garante a sincronização antes de ler. A
    // resposta sai do Store porque é lá que o nome (de `contacts`) é resolvido, e o
    // número sai mascarado — igual a `/contacts/resolve`, nunca cru.
    await wa.getGroupParticipants(req.params.jid, { refresh });
    return { participants: store.listGroupMembers(req.params.jid) };
  });

  /** GET /messages — histórico de um chat, com limite e corte temporal opcional. */
  app.get('/messages', async (req) => {
    const chat = queryString(req.query, 'chat');
    if (!chat) throw new AppError('VALIDATION', 400, '"chat" é obrigatório');
    const limit = queryInt(req.query, 'limit', 50);
    // `queryInt` recusa valor não numérico com 400; `Number()` cru mandaria NaN ao SQLite.
    const since = queryString(req.query, 'since') !== undefined ? queryInt(req.query, 'since', 0) : undefined;
    return { messages: store.listMessages({ chatJid: chat, limit, ...(since !== undefined ? { since } : {}) }) };
  });

  /** POST /media/:messageId — materializa (download/transcrição/keyframes) uma mídia já vista. */
  app.post<{ Params: { messageId: string } }>('/media/:messageId', async (req) => {
    const body = asRecord(req.body ?? {}, 'body');
    const transcribe = optionalBoolean(body, 'transcribe');
    const frames = optionalBoolean(body, 'frames');
    return media.materialize(req.params.messageId, {
      ...(transcribe !== undefined ? { transcribe } : {}),
      ...(frames !== undefined ? { frames } : {}),
    });
  });

  /** POST /send/draft — cria o rascunho de envio (preview + token); nada é enviado ainda. */
  app.post('/send/draft', async (req) => {
    const body = asRecord(req.body, 'body');
    const to = requireString(body, 'to');
    const text = optionalString(body, 'text');
    const mediaPath = optionalString(body, 'mediaPath');
    const caption = optionalString(body, 'caption');
    const quoteMessageId = optionalString(body, 'quoteMessageId');
    const mentions = optionalStringArray(body, 'mentions');
    const input: DraftInput = {
      to,
      ...(text !== undefined ? { text } : {}),
      ...(mediaPath !== undefined ? { mediaPath } : {}),
      ...(caption !== undefined ? { caption } : {}),
      ...(quoteMessageId !== undefined ? { quoteMessageId } : {}),
      ...(mentions !== undefined ? { mentions } : {}),
    };
    return gate.draft(input, { agent: req.callAgent, traceId: req.traceId });
  });

  /** POST /send/confirm — consome o token e dispara o envio em background. */
  app.post('/send/confirm', async (req) => {
    const body = asRecord(req.body, 'body');
    const confirmToken = requireString(body, 'confirmToken');
    const urgent = optionalBoolean(body, 'urgent');
    const acknowledge = optionalStringArray(body, 'acknowledge');
    return gate.confirm(confirmToken, req.callAgent, {
      ...(urgent !== undefined ? { urgent } : {}),
      ...(acknowledge !== undefined ? { acknowledge } : {}),
      traceId: req.traceId,
    });
  });

  /** POST /send/discard — descarta um rascunho ainda não confirmado, liberando o chat. */
  app.post('/send/discard', async (req) => {
    const body = asRecord(req.body, 'body');
    const confirmToken = requireString(body, 'confirmToken');
    return gate.discardDraft(confirmToken, { agent: req.callAgent, traceId: req.traceId });
  });

  /** POST /send/cancel — sinaliza o abort flag de um envio em andamento. */
  app.post('/send/cancel', async (req) => {
    const body = asRecord(req.body, 'body');
    const sendId = requireString(body, 'sendId');
    return gate.cancel(sendId, { agent: req.callAgent, traceId: req.traceId });
  });

  /** POST /chats/:jid/read — marca um chat como lido. */
  app.post<{ Params: { jid: string } }>('/chats/:jid/read', async (req) => {
    await wa.markRead(req.params.jid);
    return { ok: true };
  });

  /** POST /messages/:id/react — reage a uma mensagem com um emoji (resolve o chat via Store). */
  app.post<{ Params: { id: string } }>('/messages/:id/react', async (req) => {
    const body = asRecord(req.body, 'body');
    const emoji = requireString(body, 'emoji');
    const message = store.getMessage(req.params.id);
    if (!message) throw new AppError('NOT_FOUND', 404, `mensagem "${req.params.id}" não encontrada`);
    await wa.react(message.chatJid, req.params.id, emoji);
    return { ok: true };
  });

  /** GET /metrics/summary — agregados para o dashboard, numa janela de tempo. */
  app.get('/metrics/summary', async (req) => {
    const windowMs = queryInt(req.query, 'window', 86_400_000);
    return metrics.summary(windowMs);
  });

  /** GET /metrics/calls — últimas chamadas registradas (rota, agente, duração, status). */
  app.get('/metrics/calls', async (req) => {
    const limit = queryInt(req.query, 'limit', 100);
    return { calls: metrics.recentCalls(limit) };
  });

  /** GET /metrics/audit — últimos eventos de auditoria (append-only). */
  app.get('/metrics/audit', async (req) => {
    const limit = queryInt(req.query, 'limit', 100);
    return { events: audit.recent(limit) };
  });

  return app;
}
