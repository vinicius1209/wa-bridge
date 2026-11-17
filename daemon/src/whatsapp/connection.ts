/**
 * Conexão única com o WhatsApp via Baileys. Dona exclusiva das credenciais e
 * do socket — todo o resto do daemon fala com o WhatsApp através desta classe.
 */
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidGroup,
  toNumber,
  useMultiFileAuthState,
  type AnyMessageContent,
  type Chat,
  type GroupParticipant as BaileysGroupParticipant,
  type WAMessage,
  type WAMessageContent,
  type WAMessageKey,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import type { GroupParticipant, Logger, MessageType, NewChatQuota, SessionState, StoredMessage } from '../types.js';
import type { Store } from '../store/store.js';
import { isDeviceSyncProtocolType, isMediaCopyAssociation } from './protocol.js';

/** Métricas mínimas exigidas pela assinatura do contrato (ver `obs/metrics.ts`). */
export interface Metrics {
  recordCall(c: {
    ts: number;
    traceId: string;
    agent: string;
    tool: string;
    durationMs: number;
    status: 'ok' | 'error' | 'denied';
    error: string | null;
  }): void;
}

/** Teto de entradas mantidas em memória para `getRawMessage`. */
const RAW_MESSAGE_CACHE_LIMIT = 2000;

/** Teto de backoff de reconexão. */
const RECONNECT_MAX_DELAY_MS = 30_000;

/** Validade do cache local de membros de grupo (`groupMetadata` tem rate limit). */
const GROUP_PARTICIPANTS_TTL_MS = 3_600_000;

/** Quanto o novo pareamento espera o WhatsApp confirmar o logout do aparelho antigo. */
const LOGOUT_TIMEOUT_MS = 5_000;

const DAY_MS = 86_400_000;

/**
 * De onde veio a mensagem: `live` (chegou agora), `offline` (fila entregue na reconexão,
 * o Baileys marca como `append`) ou `history` (sincronização do pareamento).
 */
type IngestSource = 'live' | 'offline' | 'history';

/** Status, newsletter e listas de transmissão não são conversa: ficam fora do histórico. */
function isBroadcastJid(jid: string): boolean {
  return jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter');
}

/**
 * Normaliza o `message-capping.update`: os números vêm como número ou texto, e o fim do
 * ciclo em segundos ou milissegundos.
 */
export function toNewChatQuota(info: Record<string, unknown>, receivedAt: number): NewChatQuota {
  const num = (v: unknown): number | null => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const cycleEnd = num(info.cycle_end_timestamp);
  return {
    total: num(info.total_quota),
    used: num(info.used_quota),
    status: typeof info.capping_status === 'string' ? info.capping_status : null,
    cycleEndsAt: cycleEnd === null ? null : cycleEnd < 1e12 ? cycleEnd * 1000 : cycleEnd,
    receivedAt,
  };
}

/**
 * `JSON.parse` que devolve `Buffer` onde o `JSON.stringify` gravou `{ type: 'Buffer', data }`.
 * O `raw_json` guarda chaves de mídia assim; para o Baileys reenviar uma mensagem, os
 * campos binários precisam voltar a ser bytes de verdade.
 */
function parseRawWithBuffers(rawJson: string): unknown {
  return JSON.parse(rawJson, (_key, value: unknown) => {
    if (
      value !== null &&
      typeof value === 'object' &&
      (value as { type?: unknown }).type === 'Buffer' &&
      Array.isArray((value as { data?: unknown }).data)
    ) {
      return Buffer.from((value as { data: number[] }).data);
    }
    return value;
  });
}

/** Remove o sufixo `:device` de um JID (ex.: `551199999999:12@s.whatsapp.net`). */
function normalizeJid(jid: string): string {
  const atIdx = jid.indexOf('@');
  if (atIdx === -1) return jid;
  const localPart = jid.slice(0, atIdx);
  const domain = jid.slice(atIdx);
  const colonIdx = localPart.indexOf(':');
  if (colonIdx === -1) return jid;
  return localPart.slice(0, colonIdx) + domain;
}

/**
 * Converte um participante do `groupMetadata` no registro que persistimos.
 *
 * `id` é o identificador de endereçamento do grupo (telefone nos grupos antigos, LID
 * nos novos) e é o que precisa ir em `mentionedJid`. `phoneNumber` (quando vem) é o
 * telefone real, guardado só para o preview mostrar um número verdadeiro em vez do LID.
 */
function toParticipantRecord(p: BaileysGroupParticipant): {
  jid: string;
  phoneJid: string | null;
  name: string | null;
  isAdmin: boolean;
} {
  const jid = normalizeJid(p.id);
  const phoneFromField = p.phoneNumber ? normalizeJid(p.phoneNumber) : null;
  const phoneJid = phoneFromField ?? (jid.endsWith('@s.whatsapp.net') ? jid : null);
  return {
    jid,
    phoneJid,
    name: p.name ?? p.notify ?? null,
    isAdmin: p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin === true || p.isSuperAdmin === true,
  };
}

/**
 * Desembrulha wrappers `viewOnce*` de uma mensagem, retornando o conteúdo
 * interno. Cobre `viewOnceMessage`, `viewOnceMessageV2` e `viewOnceMessageV2Extension`.
 */
function unwrapMessage(message: WAMessageContent): WAMessageContent {
  const inner =
    message.viewOnceMessageV2?.message ??
    message.viewOnceMessage?.message ??
    message.viewOnceMessageV2Extension?.message;
  return (inner as WAMessageContent | null | undefined) ?? message;
}

/** Verdadeiro para mensagem de sincronização entre os aparelhos da conta (ver `protocol.ts`). */
function isDeviceSyncMessage(message: WAMessageContent): boolean {
  return isDeviceSyncProtocolType(unwrapMessage(message).protocolMessage?.type);
}

/**
 * Verdadeiro para mensagem sem conteúdo próprio: o cabeçalho de um álbum (`albumMessage`,
 * que só avisa quantas fotos vêm; cada foto chega como mensagem normal) e a cópia de uma
 * mídia que já chegou (versão HD, foto com movimento; ver `protocol.ts`).
 */
function isRedundantMessage(message: WAMessageContent): boolean {
  if (message.albumMessage) return true;
  if (!message.associatedChildMessage) return false;
  return isMediaCopyAssociation(message.messageContextInfo?.messageAssociation?.associationType);
}

/** Verdadeiro se a mensagem (ainda embrulhada) for um envio `viewOnce`. */
function isViewOnce(message: WAMessageContent | null | undefined): boolean {
  if (!message) return false;
  return unwrapMessage(message) !== message;
}

/** Extrai o texto já resolvido de uma mensagem (legenda incluída), ou `null`. */
function extractTextContent(message: WAMessageContent | null | undefined): string | null {
  if (!message) return null;
  const msg = unwrapMessage(message);

  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;

  if (msg.imageMessage?.caption) return `[Imagem] ${msg.imageMessage.caption}`;
  if (msg.videoMessage?.caption) return `[Vídeo] ${msg.videoMessage.caption}`;
  if (msg.documentMessage?.caption) return `[Documento] ${msg.documentMessage.caption}`;

  if (msg.imageMessage) return '[Imagem enviada]';
  if (msg.videoMessage) return '[Vídeo enviado]';
  if (msg.audioMessage) return '[Áudio enviado]';
  if (msg.stickerMessage) return '[Sticker]';
  if (msg.documentMessage) return `[Documento: ${msg.documentMessage.fileName ?? 'arquivo'}]`;
  if (msg.locationMessage) return '[Localização enviada]';
  if (msg.contactMessage ?? msg.contactsArrayMessage) return '[Contato enviado]';
  if (msg.pollCreationMessage ?? msg.pollCreationMessageV3) return '[Enquete enviada]';
  if (msg.reactionMessage) return msg.reactionMessage.text ?? '[Reação]';

  return null;
}

/** Extrai só a legenda (sem prefixo) de imagem/vídeo/documento, ou `null`. */
function extractCaption(message: WAMessageContent | null | undefined): string | null {
  if (!message) return null;
  const msg = unwrapMessage(message);
  return msg.imageMessage?.caption ?? msg.videoMessage?.caption ?? msg.documentMessage?.caption ?? null;
}

/** Classifica o tipo de mensagem no enum `MessageType` do contrato. */
function getMessageType(message: WAMessageContent | null | undefined): MessageType {
  if (!message) return 'unknown';
  const msg = unwrapMessage(message);

  if (msg.conversation || msg.extendedTextMessage) return 'text';
  if (msg.imageMessage) return 'image';
  if (msg.videoMessage) return 'video';
  if (msg.audioMessage) return 'audio';
  if (msg.stickerMessage) return 'sticker';
  if (msg.documentMessage) return 'document';
  if (msg.locationMessage) return 'location';
  if (msg.contactMessage ?? msg.contactsArrayMessage) return 'contact';
  if (msg.pollCreationMessage ?? msg.pollCreationMessageV3) return 'poll';
  if (msg.reactionMessage) return 'reaction';
  return 'unknown';
}

/** Detecta o mime de um arquivo pela extensão, para escolher o tipo de envio. */
function guessMimeFromExt(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    ogg: 'audio/ogg; codecs=opus',
    opus: 'audio/ogg; codecs=opus',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}

/**
 * Extrai da chave o telefone real por trás de um LID (`@lid`). O WhatsApp passou a
 * endereçar conversas por identificador opaco; sem isso não há como mostrar um número
 * verdadeiro no preview do gate. O Baileys 7 manda o outro endereço em `remoteJidAlt`
 * (conversa) e `participantAlt` (grupo), que pode ser o telefone ou o LID: vale só o que
 * termina em `@s.whatsapp.net`. `senderPn` e `participantPn` são do Baileys 6.
 */
function extractSenderPn(raw: WAMessage): string | null {
  const key = raw.key as unknown as Record<string, unknown>;
  for (const field of ['senderPn', 'participantPn', 'remoteJidAlt', 'participantAlt']) {
    const value = key[field];
    if (typeof value === 'string' && value.endsWith('@s.whatsapp.net')) return normalizeJid(value);
  }
  return null;
}

/** Cache LRU simples por `Map` (ordem de inserção == ordem de acesso recente). */
class LruCache<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly limit: number) {}

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
  }
}

export interface WhatsAppConnectionDeps {
  store: Store;
  log: Logger;
  metrics: Metrics;
  home: string;
  /** Dias de histórico importados no pareamento; `0` desliga a importação. */
  historyDays: number;
  /** Nome em "Aparelhos conectados" no celular; o WhatsApp só lê no pareamento. */
  deviceName: string;
}

/** Conexão Baileys com o WhatsApp, única para todo o daemon. */
export class WhatsAppConnection {
  private readonly store: Store;
  private readonly log: Logger;
  private readonly authDir: string;
  private readonly historyDays: number;
  private readonly deviceName: string;
  /** Ligado por `close()`: a partir daí nenhuma reconexão é agendada. */
  private closed = false;

  private socket: WASocket | null = null;
  private sessionState: SessionState = { state: 'connecting', me: null, qrDataUrl: null, since: Date.now(), lastError: null };
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly subscribedPresence = new Set<string>();
  private readonly rawMessages = new LruCache<WAMessageContent>(RAW_MESSAGE_CACHE_LIMIT);
  private readonly listeners: Array<(m: StoredMessage, raw: WAMessageContent) => void> = [];
  /** Última cota de conversas novas que o WhatsApp mandou; some quando o ciclo acaba. */
  private newChatQuota: NewChatQuota | null = null;

  constructor(deps: WhatsAppConnectionDeps) {
    this.store = deps.store;
    this.log = deps.log;
    this.authDir = join(deps.home, 'auth');
    this.historyDays = deps.historyDays;
    this.deviceName = deps.deviceName;
  }

  /** Abre a conexão com o WhatsApp, restaurando credenciais salvas quando existirem. */
  async connect(): Promise<void> {
    // Nunca dois sockets vivos na mesma conta: um segundo socket gera QRs próprios (o
    // QR escaneado pode ser de um socket já substituído) e, pareado, derruba o outro
    // com `device_removed`. Cancela reconexão pendente e aposenta o socket anterior.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.retireSocket();

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();
    this.log.info({ version }, 'conectando ao WhatsApp');

    const socket = makeWASocket({
      auth: state,
      // O Baileys loga o handshake inteiro em `info`, incluindo material de chave da sessão
      // (clientHello.ephemeral, devicePairingData.eIdent/eSkeyVal/eSkeySig). A redaction do
      // nosso logger não alcança esses campos, então o nível dele fica em `warn`: queremos os
      // erros de protocolo dele, não as chaves. Para depurar protocolo, use LOG_LEVEL=debug,
      // ciente de que o log vai conter segredo de sessão.
      logger: this.log.child(
        { module: 'baileys' },
        { level: this.log.level === 'debug' || this.log.level === 'trace' ? this.log.level : 'warn' },
      ),
      version,
      // O padrão do Baileys marca a conta como online ao conectar. Com um aparelho online o
      // celular para de notificar, e o daemon fica conectado o tempo todo: o celular do
      // usuário nunca mais tocaria. O daemon só recebe e lê sob demanda, sem aparecer online.
      markOnlineOnConnect: false,
      // O primeiro item vira o nome em "Aparelhos conectados" ("Google Chrome (wa-bridge)"),
      // para não confundir com o WhatsApp Web do próprio usuário. O celular grava o nome no
      // pareamento: trocar aqui só aparece depois de parear de novo.
      browser: [this.deviceName, ...Browsers.macOS('Chrome').slice(1)] as [string, string, string],
      // O Baileys pede o conteúdo de uma mensagem já enviada quando o destinatário não
      // conseguiu decifrá-la e pede reenvio (e para decifrar voto de enquete). Devolver
      // `undefined` deixa a pessoa vendo "Aguardando mensagem" para sempre.
      getMessage: async (key) => this.lookupMessageContent(key.id),
      // O Baileys 7 liga a sincronização completa por padrão: o celular mandaria anos de
      // conversa para o daemon descartar quase tudo (fica só `WA_HISTORY_DAYS`). Sem ela o
      // celular ainda manda o histórico recente, que o padrão de `shouldSyncHistoryMessage`
      // processa. Não sobrescreva essa função recusando tudo: o Baileys tira do histórico o
      // mapeamento LID -> telefone e avisa no log que a sessão fica instável sem ele.
      syncFullHistory: false,
    });
    this.socket = socket;

    socket.ev.on('creds.update', saveCreds);

    // O WhatsApp avisa quantas conversas novas a conta ainda pode iniciar no ciclo. O gate
    // usa isso para parar antes do limite dele, não depois.
    socket.ev.on('message-capping.update', (info) => {
      if (socket !== this.socket) return;
      this.newChatQuota = toNewChatQuota(info as unknown as Record<string, unknown>, Date.now());
      this.log.info({ cota: this.newChatQuota }, 'cota de conversas novas do WhatsApp atualizada');
    });

    // Grupo renomeado, ou entrada em grupo novo: mantém `chats.name` atual sem precisar
    // de um novo sync completo.
    socket.ev.on('groups.update', (updates) => {
      for (const g of updates) {
        if (!g.id || !g.subject) continue;
        this.store.upsertChat({
          jid: normalizeJid(g.id),
          name: g.subject,
          isGroup: true,
          lastMessageAt: null,
          unreadCount: 0,
        });
      }
    });

    socket.ev.on('groups.upsert', (groups) => {
      for (const g of groups) {
        if (!g.id || !g.subject) continue;
        this.store.upsertChat({
          jid: normalizeJid(g.id),
          name: g.subject,
          isGroup: true,
          lastMessageAt: null,
          unreadCount: 0,
        });
      }
    });
    // Eventos de um socket aposentado são ignorados. Sem isto, o `close` que o próprio
    // `end()` dispara no socket antigo agendava uma reconexão, e 30s depois um segundo
    // socket subia em paralelo ao atual (visto em produção após um forcePair).
    socket.ev.on('connection.update', (update) => {
      if (socket !== this.socket) return;
      void this.handleConnectionUpdate(update);
    });
    // `notify` é mensagem chegando agora; `append` é a fila que ficou no servidor enquanto
    // o daemon estava fora, entregue na reconexão. Descartar `append` perdia tudo que
    // chegou com o daemon parado.
    socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (socket !== this.socket) return;
      const source: IngestSource = type === 'notify' ? 'live' : 'offline';
      for (const message of messages) this.handleIncomingMessage(message, source);
    });
    socket.ev.on('messaging-history.set', ({ messages, chats, syncType, progress }) => {
      if (socket !== this.socket) return;
      this.importHistory(messages, chats, { syncType: syncType ?? null, progress: progress ?? null });
    });
  }

  /**
   * Importa o histórico que o celular manda logo depois do pareamento, só dos últimos
   * `historyDays` dias. O WhatsApp manda isso uma vez por pareamento: numa sessão que já
   * estava pareada, o histórico só chega pareando de novo (`./wa-bridge pair`).
   *
   * Histórico não é mensagem nova: não soma em não lidas, não sobrescreve o que já está
   * no banco e não dispara `onMessage` (nem o stream de eventos).
   */
  private importHistory(
    messages: WAMessage[],
    chats: Chat[],
    meta: { syncType: number | null; progress: number | null },
  ): void {
    if (this.historyDays <= 0) return;
    const cutoffMs = Date.now() - this.historyDays * DAY_MS;
    let imported = 0;
    for (const raw of messages) {
      const remoteJid = raw.key.remoteJid;
      if (!remoteJid || isBroadcastJid(remoteJid)) continue;
      if (toNumber(raw.messageTimestamp) * 1000 < cutoffMs) continue;
      try {
        if (this.handleIncomingMessage(raw, 'history')) imported += 1;
      } catch (error) {
        this.log.warn({ error, id: raw.key.id }, 'falha ao importar mensagem do histórico');
      }
    }
    for (const chat of chats) {
      if (!chat.id || isBroadcastJid(chat.id) || !chat.name?.trim()) continue;
      if (toNumber(chat.conversationTimestamp) * 1000 < cutoffMs) continue;
      const jid = normalizeJid(chat.id);
      this.store.upsertChat({
        jid,
        name: chat.name.trim(),
        isGroup: isJidGroup(jid) ?? false,
        lastMessageAt: null,
        unreadCount: 0,
      });
    }
    this.log.info(
      { importadas: imported, recebidas: messages.length, dias: this.historyDays, ...meta },
      'histórico do WhatsApp importado',
    );
  }

  /** Conteúdo de uma mensagem já vista (cache em memória ou `raw_json`), para o Baileys reenviar. */
  private lookupMessageContent(id: string | null | undefined): WAMessageContent | undefined {
    if (!id) return undefined;
    const cached = this.rawMessages.get(id);
    if (cached) return cached;
    const rawJson = this.store.getRawJson(id);
    if (!rawJson) return undefined;
    try {
      const parsed = parseRawWithBuffers(rawJson) as Partial<WAMessage>;
      return parsed.message ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Encerra a conexão de vez, no desligamento do daemon: sem reconexão e SEM logout
   * (`end`, não `logout`), então a credencial continua valendo no próximo boot.
   */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.retireSocket();
  }

  /**
   * Aposenta o socket atual e faz `logout`, que tira este aparelho de "Aparelhos
   * conectados" no celular. Sem isso, cada novo pareamento deixava o aparelho antigo na
   * lista. Melhor esforço: sem conexão aberta o logout falha, e o aparelho antigo fica lá
   * até ser removido à mão.
   */
  private async unlinkSocket(): Promise<void> {
    const previous = this.socket;
    // Antes do logout: o `close` que ele dispara chega com o socket já aposentado e é ignorado.
    this.socket = null;
    if (!previous) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        previous.logout(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('logout sem resposta')), LOGOUT_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      this.log.warn(
        { error },
        'não deu para desvincular o aparelho antigo; remova-o no celular em Aparelhos conectados',
      );
    } finally {
      clearTimeout(timer);
      try {
        previous.end(undefined);
      } catch (error) {
        this.log.error({ error }, 'erro ao encerrar o socket anterior');
      }
    }
  }

  /** Desliga o socket atual sem que o `close` dele dispare reconexão (o handler o ignora). */
  private retireSocket(): void {
    const previous = this.socket;
    this.socket = null;
    if (!previous) return;
    try {
      previous.end(undefined);
    } catch (error) {
      this.log.error({ error }, 'erro ao encerrar o socket anterior');
    }
  }

  /** Processa transições de estado da conexão: QR, aberta, fechada (com reconexão). */
  private async handleConnectionUpdate(update: {
    connection?: 'open' | 'connecting' | 'close';
    lastDisconnect?: { error: Error | undefined; date: Date };
    qr?: string;
  }): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Receber QR prova que o servidor respondeu: a conexão está saudável, só esperando
      // leitura. Zerar o backoff aqui faz o próximo ciclo de QR vir em ~2s, não em 30s.
      this.reconnectAttempt = 0;
      this.sessionState = { ...this.sessionState, state: 'pairing' };
      try {
        this.sessionState.qrDataUrl = await QRCode.toDataURL(qr);
      } catch (error) {
        this.log.error({ error }, 'falha ao gerar QR em data URL');
      }
      if (process.stdout.isTTY) {
        try {
          const terminalQr = await QRCode.toString(qr, { type: 'terminal', small: true });
          console.log(terminalQr);
        } catch (error) {
          this.log.error({ error }, 'falha ao renderizar QR no terminal');
        }
      }
      this.log.info('QR gerado — pareie o WhatsApp para continuar');
    }

    if (connection === 'close') {
      const statusCode = this.extractStatusCode(lastDisconnect?.error);
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        this.sessionState = {
          state: 'close',
          me: null,
          qrDataUrl: null,
          since: Date.now(),
          lastError: 'sessão deslogada — é necessário parear novamente (forcePair)',
        };
        this.log.warn('sessão deslogada pelo WhatsApp; não haverá reconexão automática');
        return;
      }

      this.sessionState = {
        ...this.sessionState,
        state: 'close',
        // O QR deste socket morreu com ele: não deixe o painel exibir um QR que não pareia.
        qrDataUrl: null,
        lastError: lastDisconnect?.error?.message ?? 'conexão fechada',
      };
      this.scheduleReconnect();
      return;
    }

    if (connection === 'open') {
      this.reconnectAttempt = 0;
      const me = this.socket?.user;
      this.sessionState = {
        state: 'open',
        me: me ? { jid: normalizeJid(me.id), name: me.name ?? null } : null,
        qrDataUrl: null,
        since: Date.now(),
        lastError: null,
      };
      this.log.info({ me: this.sessionState.me }, 'conexão com o WhatsApp aberta');
      // Sem isto todo grupo fica "(sem nome)" e o agente não tem como saber qual ler —
      // nem quem são os membros, que é o que permite @marcar alguém.
      void this.syncGroups();
    }
  }

  /**
   * Preenche `chats.name` dos grupos com o `subject` real e persiste os membros.
   *
   * Nem o nome nem a lista de membros vêm no evento de mensagem — só em
   * `groupMetadata`. Usamos `groupFetchAllParticipating`, que traz todos os grupos
   * (com participantes) numa única chamada, em vez de uma consulta por grupo (que o
   * WhatsApp limita por taxa e derrubaria a sessão).
   */
  private async syncGroups(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    try {
      const groups = await socket.groupFetchAllParticipating();
      const now = Date.now();
      let named = 0;
      let withParticipants = 0;
      for (const [rawJid, meta] of Object.entries(groups)) {
        const jid = normalizeJid(rawJid);
        const subject = meta?.subject?.trim();
        if (subject) {
          this.store.upsertChat({
            jid,
            name: subject,
            isGroup: true,
            lastMessageAt: null,
            unreadCount: 0, // delta zero: só nomeia, não mexe no contador
          });
          named += 1;
        }
        if (meta?.participants?.length) {
          this.store.replaceGroupParticipants(jid, meta.participants.map(toParticipantRecord), now);
          withParticipants += 1;
        }
      }
      this.log.info({ grupos: named, comMembros: withParticipants }, 'grupos sincronizados');
    } catch (error) {
      // Falhar aqui degrada a usabilidade, não a corretude: os grupos seguem acessíveis
      // pelo JID. Não derruba a conexão.
      this.log.warn({ error }, 'falha ao sincronizar grupos');
    }
  }

  /**
   * Devolve os membros de um grupo, consultando o WhatsApp só quando o cache local
   * está vazio ou velho.
   *
   * `groupMetadata` é consulta por grupo e tem rate limit — por isso o TTL. Se a
   * consulta falhar mas houver cache (mesmo velho), devolvemos o cache: mencionar com
   * uma lista de 1h atrás é muito melhor do que não mencionar.
   */
  async getGroupParticipants(
    groupJid: string,
    opts: { refresh?: boolean; maxAgeMs?: number } = {},
  ): Promise<GroupParticipant[]> {
    const jid = normalizeJid(groupJid);
    if (!(isJidGroup(jid) ?? false)) return [];

    const maxAgeMs = opts.maxAgeMs ?? GROUP_PARTICIPANTS_TTL_MS;
    const syncedAt = this.store.groupParticipantsSyncedAt(jid);
    const fresh = syncedAt !== null && Date.now() - syncedAt < maxAgeMs;
    if (fresh && opts.refresh !== true) return this.store.listGroupParticipants(jid);

    try {
      const socket = this.requireSocket();
      const meta = await socket.groupMetadata(jid);
      if (meta?.participants?.length) {
        this.store.replaceGroupParticipants(jid, meta.participants.map(toParticipantRecord), Date.now());
      }
      if (meta?.subject?.trim()) {
        this.store.upsertChat({
          jid,
          name: meta.subject.trim(),
          isGroup: true,
          lastMessageAt: null,
          unreadCount: 0,
        });
      }
    } catch (error) {
      this.log.warn({ error, jid }, 'falha ao buscar membros do grupo — usando cache local');
    }

    return this.store.listGroupParticipants(jid);
  }

  /** Extrai o `statusCode` de um erro de desconexão sem depender de `@hapi/boom`. */
  private extractStatusCode(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const output = (error as { output?: { statusCode?: number } }).output;
    return output?.statusCode;
  }

  /** Agenda reconexão com backoff exponencial (teto 30s) e jitter. */
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const base = Math.min(RECONNECT_MAX_DELAY_MS, 1000 * 2 ** this.reconnectAttempt);
    const jitter = Math.floor(Math.random() * 1000);
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, base + jitter);
    this.log.info({ delay, attempt: this.reconnectAttempt }, 'agendando reconexão ao WhatsApp');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error: unknown) => {
        this.log.error({ error }, 'falha ao reconectar ao WhatsApp');
        this.scheduleReconnect();
      });
    }, delay);
  }

  /**
   * Converte e persiste uma mensagem, e notifica os callbacks registrados. Devolve `true`
   * se a mensagem foi gravada. Histórico e fila offline só gravam o que ainda não existe
   * (podem repetir mensagens já vistas) e só o que é novo mexe em contadores.
   */
  private handleIncomingMessage(raw: WAMessage, source: IngestSource = 'live'): boolean {
    const remoteJid = raw.key.remoteJid;
    if (!remoteJid) return false;

    const stored = this.parseMessage(raw, remoteJid);
    if (!stored) return false;

    if (source === 'live') {
      this.store.upsertMessage(stored, JSON.stringify(raw));
    } else if (!this.store.insertMessageIfNew(stored, JSON.stringify(raw))) {
      return false;
    }
    // Histórico não entra no cache em memória: são milhares de mensagens de uma vez e
    // expulsariam as recentes. A mídia dele sai do `raw_json` persistido.
    if (raw.message && source !== 'history') this.rawMessages.set(stored.id, raw.message);

    // `senderPn` é o telefone real por trás de um LID (`@lid`). É o único jeito de o
    // preview do gate mostrar um número verdadeiro em vez de formatar o LID como telefone.
    this.updateChatAndContact(stored, extractSenderPn(raw), source !== 'history');

    if (source === 'history') return true;
    this.log.debug({ chat: stored.chatJid, type: stored.type, source }, 'mensagem recebida');

    for (const cb of this.listeners) {
      try {
        cb(stored, raw.message ?? {});
      } catch (error) {
        this.log.error({ error }, 'callback de onMessage lançou exceção');
      }
    }
    return true;
  }

  /**
   * Atualiza os registros de `chats` e `contacts` a partir de uma mensagem normalizada.
   * `countUnread = false` (histórico) registra a conversa sem somar em não lidas.
   */
  private updateChatAndContact(m: StoredMessage, senderPn: string | null = null, countUnread = true): void {
    const isGroup = isJidGroup(m.chatJid) ?? false;
    this.store.upsertChat({
      jid: m.chatJid,
      name: null,
      isGroup,
      lastMessageAt: m.ts,
      unreadCount: m.fromMe || !countUnread ? 0 : 1,
    });

    if (m.senderJid) {
      this.store.upsertContact({
        jid: m.senderJid,
        pushName: m.senderName,
        alias: null,
        phoneJid: senderPn,
        lastInboundAt: m.fromMe ? null : m.ts,
        lastOutboundAt: m.fromMe ? m.ts : null,
      });
    }

    // Conversa individual endereçada por LID: o interlocutor é o próprio chat, então o
    // telefone real também vale para o JID do chat — é ele que o preview do gate mascara.
    if (!isGroup && !m.fromMe && m.chatJid !== m.senderJid) {
      this.store.upsertContact({
        jid: m.chatJid,
        pushName: m.senderName,
        alias: null,
        phoneJid: senderPn,
        lastInboundAt: m.ts,
        lastOutboundAt: null,
      });
    }
  }

  /** Converte uma mensagem bruta do Baileys em `StoredMessage`. */
  private parseMessage(raw: WAMessage, remoteJid: string): StoredMessage | null {
    if (!raw.message || isDeviceSyncMessage(raw.message) || isRedundantMessage(raw.message)) return null;
    const chatJid = normalizeJid(remoteJid);
    const fromMe = raw.key.fromMe ?? false;
    const senderJid = fromMe
      ? null
      : normalizeJid(raw.key.participant ?? remoteJid);
    // O timestamp pode vir como `Long`; `Number(long)` daria NaN e a mensagem
    // ficaria com a hora em que foi gravada.
    const tsSeconds = toNumber(raw.messageTimestamp);
    const type = getMessageType(raw.message);
    const hasMedia = type === 'image' || type === 'video' || type === 'audio' || type === 'document' || type === 'sticker';
    const quoted = raw.message.extendedTextMessage?.contextInfo?.quotedMessage;

    return {
      id: raw.key.id ?? randomBytes(8).toString('hex'),
      chatJid,
      senderJid,
      senderName: raw.pushName ?? null,
      fromMe,
      ts: (tsSeconds || Math.floor(Date.now() / 1000)) * 1000,
      type,
      text: extractTextContent(raw.message),
      caption: extractCaption(raw.message),
      viewOnce: isViewOnce(raw.message),
      quotedText: quoted ? extractTextContent(quoted) : null,
      hasMedia,
      mediaState: hasMedia ? 'pending' : 'none',
    };
  }

  /** Estado atual da sessão (para `/session` e para o dashboard). */
  getSessionState(): SessionState {
    return this.sessionState;
  }

  /** Cota de conversas novas vigente, ou `null` se o WhatsApp nunca mandou ou o ciclo acabou. */
  getNewChatQuota(now = Date.now()): NewChatQuota | null {
    const quota = this.newChatQuota;
    if (!quota) return null;
    if (quota.cycleEndsAt !== null && quota.cycleEndsAt <= now) return null;
    return quota;
  }

  /**
   * Desvincula o aparelho atual, apaga as credenciais salvas e reconecta para gerar um QR
   * novo.
   */
  async forcePair(): Promise<void> {
    this.log.warn('forcePair: desvinculando o aparelho atual e forçando novo pareamento');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.unlinkSocket();
    await rm(this.authDir, { recursive: true, force: true });
    this.sessionState = { state: 'connecting', me: null, qrDataUrl: null, since: Date.now(), lastError: null };
    await this.connect();
  }

  /** Registra um callback de mensagem recebida. Múltiplos callbacks são suportados. */
  onMessage(cb: (m: StoredMessage, raw: WAMessageContent) => void): void {
    this.listeners.push(cb);
  }

  /** Garante um socket conectado, ou lança erro explícito. */
  private requireSocket(): WASocket {
    if (!this.socket) throw new Error('WhatsApp não conectado');
    return this.socket;
  }

  /** Garante `presenceSubscribe` no jid na primeira interação com ele. */
  private async ensurePresenceSubscribed(socket: WASocket, jid: string): Promise<void> {
    if (this.subscribedPresence.has(jid)) return;
    try {
      await socket.presenceSubscribe(jid);
      this.subscribedPresence.add(jid);
    } catch (error) {
      this.log.debug({ error, jid }, 'falha ao assinar presença (não crítico)');
    }
  }

  /** Marca `lastOutboundAt` do contato após um envio bem-sucedido. */
  private markOutbound(chatJid: string): void {
    this.store.upsertContact({
      jid: chatJid,
      pushName: null,
      alias: null,
      phoneJid: null,
      lastInboundAt: null,
      lastOutboundAt: Date.now(),
    });
  }

  /**
   * Persiste em `messages` uma mensagem que NÓS enviamos.
   *
   * O Baileys não emite `messages.upsert` para envios feitos pelo próprio socket, então
   * sem isto a conversa fica com um buraco: um agente que envia e depois lê o chat não
   * vê a própria mensagem e pode reenviá-la. O rastro em `sends`/`audit` não resolve,
   * porque `wa_read_messages` lê daqui.
   */
  private recordOutgoing(
    chatJid: string,
    id: string,
    type: MessageType,
    text: string | null,
    caption: string | null,
    raw: WAMessage | null,
  ): void {
    const stored: StoredMessage = {
      id,
      chatJid,
      senderJid: this.sessionState.me?.jid ?? null,
      senderName: this.sessionState.me?.name ?? null,
      fromMe: true,
      ts: Date.now(),
      type,
      text,
      caption,
      viewOnce: false,
      quotedText: null,
      hasMedia: type !== 'text',
      mediaState: type === 'text' ? 'none' : 'pending',
    };
    try {
      this.store.upsertMessage(stored, raw ? JSON.stringify(raw) : '{}');
      if (raw?.message) this.rawMessages.set(id, raw.message);
      this.store.upsertChat({
        jid: chatJid,
        name: null,
        isGroup: isJidGroup(chatJid) ?? false,
        lastMessageAt: stored.ts,
        unreadCount: 0,
      });
    } catch (error) {
      // Falhar aqui não pode desfazer um envio que já saiu.
      this.log.error({ error, id }, 'falha ao registrar mensagem enviada');
    }
  }

  /**
   * Reconstrói o `WAMessage` de uma mensagem já recebida, no formato que o Baileys
   * exige em `{ quoted }` para marcar uma resposta.
   *
   * Precisa da `key` COMPLETA, não só do id: em grupo o `participant` identifica quem
   * escreveu a mensagem citada, e sem ele a citação não renderiza no app. Por isso lemos
   * o `raw_json` persistido (que guarda a key original) em vez de remontar à mão.
   */
  buildQuoted(messageId: string): WAMessage | undefined {
    const rawJson = this.store.getRawJson(messageId);
    if (!rawJson) return undefined;
    try {
      const parsed = JSON.parse(rawJson) as Partial<WAMessage>;
      if (!parsed.key?.id || !parsed.message) return undefined;
      return { key: parsed.key, message: parsed.message } as WAMessage;
    } catch {
      return undefined;
    }
  }

  /**
   * Envia texto simples a um chat; `quoted` marca a mensagem como resposta a outra e
   * `mentions` preenche o `contextInfo.mentionedJid` (quem é @marcado e notificado).
   *
   * O Baileys só notifica quem está em `mentions`; quem RENDERIZA a menção é o app do
   * destinatário, casando cada JID com um literal `@<dígitos>` presente no texto. Texto
   * sem o literal = menção silenciosa. Quem garante esse casamento é o gate.
   */
  async sendText(chatJid: string, text: string, quoted?: WAMessage, mentions?: string[]): Promise<string> {
    const socket = this.requireSocket();
    const result = await socket.sendMessage(
      chatJid,
      { text, ...(mentions?.length ? { mentions } : {}) },
      quoted ? { quoted } : {},
    );
    const id = result?.key.id;
    if (!id) throw new Error('envio não retornou messageId');
    this.markOutbound(chatJid);
    this.recordOutgoing(chatJid, id, 'text', text, null, result ?? null);
    return id;
  }

  /** Envia um arquivo de mídia (imagem/vídeo/áudio/documento), detectando o tipo pelo mime. */
  async sendMedia(
    chatJid: string,
    filePath: string,
    caption?: string,
    quoted?: WAMessage,
    mentions?: string[],
  ): Promise<string> {
    const socket = this.requireSocket();
    const mime = guessMimeFromExt(filePath);
    const content = this.buildMediaContent(mime, filePath, caption);
    const result = await socket.sendMessage(
      chatJid,
      { ...content, ...(mentions?.length ? { mentions } : {}) },
      quoted ? { quoted } : {},
    );
    const id = result?.key.id;
    if (!id) throw new Error('envio de mídia não retornou messageId');
    this.markOutbound(chatJid);
    const type = getMessageType(result?.message);
    this.recordOutgoing(
      chatJid,
      id,
      type === 'unknown' ? 'document' : type,
      caption ?? null,
      caption ?? null,
      result ?? null,
    );
    return id;
  }

  /** Monta o payload de envio (`AnyMessageContent`) correto para o mime detectado. */
  private buildMediaContent(mime: string, filePath: string, caption?: string): AnyMessageContent {
    const url = { url: filePath };
    if (mime.startsWith('image/')) return { image: url, caption };
    if (mime.startsWith('video/')) return { video: url, caption };
    if (mime.startsWith('audio/')) {
      const isPtt = /\.(ogg|opus)$/i.test(filePath);
      return { audio: url, mimetype: mime, ptt: isPtt };
    }
    return { document: url, mimetype: mime, fileName: filePath.split('/').pop() ?? 'arquivo', caption };
  }

  /**
   * Atualiza o estado de digitação (`composing`/`paused`) em um chat. Não aceita
   * `available`: a conta online faz o celular parar de notificar.
   */
  async setPresence(chatJid: string, p: 'composing' | 'paused'): Promise<void> {
    const socket = this.requireSocket();
    await this.ensurePresenceSubscribed(socket, chatJid);
    await socket.sendPresenceUpdate(p, chatJid);
  }

  /**
   * Chave completa de uma mensagem já vista, lida do `raw_json` persistido.
   *
   * Em grupo a chave precisa do `participant` (quem escreveu); montar só com
   * `remoteJid` + `id` faz reação e confirmação de leitura não pegarem no app. Cai
   * para a chave mínima quando o raw não existe (mensagem antiga ou corrompida).
   */
  private keyFor(chatJid: string, messageId: string, fromMe: boolean): WAMessageKey {
    const rawJson = this.store.getRawJson(messageId);
    if (rawJson) {
      try {
        const parsed = JSON.parse(rawJson) as Partial<WAMessage>;
        if (parsed.key?.id === messageId) return { ...parsed.key, remoteJid: parsed.key.remoteJid ?? chatJid };
      } catch {
        // raw ilegível: segue com a chave mínima
      }
    }
    return { remoteJid: chatJid, id: messageId, fromMe };
  }

  /** Marca como lida a última mensagem recebida (de outra pessoa) de um chat. */
  async markRead(chatJid: string): Promise<void> {
    const socket = this.requireSocket();
    // A última mensagem pode ser nossa, e "ler" a própria mensagem não marca nada no
    // WhatsApp. Procuramos a última que veio de outra pessoa.
    const last = this.store.listMessages({ chatJid, limit: 50 }).find((m) => !m.fromMe);
    if (last) await socket.readMessages([this.keyFor(chatJid, last.id, false)]);
    // O contador local é acumulativo (ver `Store.upsertChat`); marcar como lido tem que zerá-lo,
    // senão `listChats({ onlyUnread: true })` continua devolvendo o chat para sempre.
    this.store.clearUnread(chatJid);
  }

  /** Reage com um emoji a uma mensagem específica. */
  async react(chatJid: string, messageId: string, emoji: string): Promise<void> {
    const socket = this.requireSocket();
    const message = this.store.getMessage(messageId);
    const key = this.keyFor(chatJid, messageId, message?.fromMe ?? false);
    await socket.sendMessage(chatJid, { react: { text: emoji, key } });
  }

  /** Devolve o conteúdo bruto (Baileys) de uma mensagem em cache, para o processador de mídia. */
  getRawMessage(messageId: string): WAMessageContent | null {
    return this.rawMessages.get(messageId) ?? null;
  }

  /** Desembrulha wrappers `viewOnce*` (fotos e vídeos de visualização única). */
  unwrapRawMessage(m: WAMessageContent): WAMessageContent {
    return unwrapMessage(m);
  }

  /** Verdadeiro se a mensagem bruta for um envio `viewOnce`. */
  isViewOnceMessage(m: WAMessageContent | null | undefined): boolean {
    return isViewOnce(m);
  }
}

export { downloadMediaMessage };
