/**
 * Tipos compartilhados do wa-bridge: fonte da verdade para todos os módulos.
 */
import type { Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

// ---------------------------------------------------------------- mensagens

export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'poll'
  | 'reaction'
  | 'unknown';

export type MediaState = 'none' | 'pending' | 'ready' | 'failed' | 'expired';

/** Mensagem normalizada do WhatsApp, como persistida e devolvida pela API. */
export interface StoredMessage {
  id: string;
  chatJid: string;
  senderJid: string | null;
  senderName: string | null;
  fromMe: boolean;
  ts: number;
  type: MessageType;
  text: string | null;
  caption: string | null;
  viewOnce: boolean;
  quotedText: string | null;
  hasMedia: boolean;
  mediaState: MediaState;
  /**
   * Telefone real (`@s.whatsapp.net`) por trás do remetente quando `senderJid` é um
   * LID (`@lid`) e o número é conhecido (veio de `key.senderPn`); `null` caso
   * contrário. Preenchido só por `GET /messages` (HTTP); as tools MCP o removem.
   * Ausente nos objetos internos (ex.: `onMessage`, `getMessage`).
   */
  senderPhoneJid?: string | null;
}

/** Onde a busca casou: no texto da mensagem ou na transcrição do áudio/vídeo dela. */
export type SearchSource = 'text' | 'transcript';

/** Um resultado de `GET /search`: a mensagem inteira mais o trecho que casou. */
export interface SearchHit {
  message: StoredMessage;
  /** Nome da conversa (grupo ou contato), quando conhecido. */
  chatName: string | null;
  source: SearchSource;
  /** Trecho em volta do termo, com o termo entre « ». */
  snippet: string;
}

/** Resumo de uma conversa para listagem. */
export interface ChatSummary {
  jid: string;
  name: string | null;
  isGroup: boolean;
  lastMessageAt: number | null;
  unreadCount: number;
  /**
   * Telefone real (`@s.whatsapp.net`) da conversa individual endereçada por LID
   * (`jid` terminando em `@lid`), quando conhecido; `null` caso contrário.
   * Preenchido só por `GET /chats` (HTTP); as tools MCP o removem.
   */
  phoneJid?: string | null;
}

// ------------------------------------------------------------------ grupos

/**
 * Membro de um grupo. `jid` é o identificador de ENDEREÇAMENTO do grupo (pode ser
 * um LID opaco, `@lid`, nos grupos novos) — é ele que vai em `mentionedJid` ao
 * mencionar alguém. `phoneJid` é o telefone real quando conhecido, usado só para
 * mascarar o número no preview.
 */
export interface GroupParticipant {
  groupJid: string;
  jid: string;
  phoneJid: string | null;
  name: string | null;
  isAdmin: boolean;
  updatedAt: number;
}

/**
 * Membro de grupo como a API o devolve: nome vindo de `contacts` (o metadata do
 * grupo não traz nome) e número mascarado, nunca cru — mesma convenção de
 * `ContactMatch`.
 */
export interface GroupMember {
  jid: string;
  name: string | null;
  alias: string | null;
  maskedNumber: string;
  isAdmin: boolean;
}

/** Candidato de resolução de membro de grupo, com confiança explícita. */
export interface GroupParticipantMatch {
  jid: string;
  phoneJid: string | null;
  name: string | null;
  alias: string | null;
  maskedNumber: string;
  isAdmin: boolean;
  score: number;
  reason: MatchReason;
}

// -------------------------------------------------------------------- mídia

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

/** Mídia materializada em disco, com transcrição e keyframes quando aplicável. */
export interface MediaArtifact {
  messageId: string;
  kind: MediaKind;
  mime: string;
  path: string;
  bytes: number;
  durationMs: number | null;
  transcript: string | null;
  framePaths: string[];
  viewOnce: boolean;
  error: string | null;
}

/** Arquivos em disco de uma mídia materializada, para a retenção apagar. */
export interface MediaFiles {
  messageId: string;
  path: string;
  framePaths: string[];
}

// ----------------------------------------------------------------- contatos

/** Contato conhecido, com apelido definido pelo usuário e datas de contato. */
export interface ContactRecord {
  jid: string;
  pushName: string | null;
  alias: string | null;
  /**
   * Telefone real (`@s.whatsapp.net`) quando o `jid` é um LID opaco (`@lid`).
   * Vem de `key.senderPn` do Baileys. É o que o preview do gate deve mascarar —
   * mascarar o próprio LID produziria um número falso.
   */
  phoneJid: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

export type MatchReason = 'alias' | 'exact-name' | 'partial-name' | 'number';

/** Candidato de resolução de contato, com confiança explícita. */
export interface ContactMatch {
  jid: string;
  name: string | null;
  alias: string | null;
  maskedNumber: string;
  score: number;
  reason: MatchReason;
  lastContactAt: number | null;
}

// ------------------------------------------------------------------- sessão

export type SessionStatus = 'connecting' | 'open' | 'close' | 'pairing';

/** Estado atual da sessão Baileys. */
export interface SessionState {
  state: SessionStatus;
  me: { jid: string; name: string | null } | null;
  qrDataUrl: string | null;
  since: number;
  lastError: string | null;
}

// --------------------------------------------------------------------- envio

/** Entrada de criação de rascunho. `to` aceita JID ou query de contato. */
export interface DraftInput {
  to: string;
  text?: string;
  mediaPath?: string;
  caption?: string;
  quoteMessageId?: string;
  /**
   * Pessoas a mencionar (@marcar), cada uma por JID, número ou nome/apelido —
   * resolvido SEMPRE dentro do grupo de destino. Só vale para grupo.
   */
  mentions?: string[];
}

/**
 * Menção já resolvida: quem será notificado e com que texto isso aparece.
 * `placeholder` é o literal (`@5551999998888`) que o WhatsApp precisa ver no
 * texto para renderizar a menção — sem ele ninguém é notificado.
 */
export interface MentionPreview {
  jid: string;
  name: string | null;
  maskedNumber: string;
  placeholder: string;
}

export type SendWarning = 'NEVER_CONTACTED' | 'QUIET_HOURS' | 'GROUP_CHAT' | 'LARGE_TEXT';

/** Rascunho devolvido ao agente, para o humano revisar antes de confirmar. */
export interface SendDraft {
  confirmToken: string;
  chatJid: string;
  resolvedName: string | null;
  maskedNumber: string;
  lastContactAt: number | null;
  neverContacted: boolean;
  bubbles: string[];
  mediaPath: string | null;
  /** Mensagem que será citada na resposta, para o humano conferir o alvo no preview. */
  quotedPreview: { messageId: string; senderName: string | null; text: string | null } | null;
  /**
   * Quem será @marcado (e notificado) por este envio. Vazio quando não há menção.
   * O humano TEM que ver isto antes de aprovar: menção notifica a pessoa.
   */
  mentionsPreview: MentionPreview[];
  estimatedDelayMs: number;
  warnings: SendWarning[];
  expiresAt: number;
}

export type SendStage =
  | 'queued'
  | 'reading'
  | 'typing'
  | 'sending'
  | 'done'
  | 'cancelled'
  | 'failed';

/** Plano de delay humano para um envio. */
export interface DelayPlan {
  readMs: number;
  bubbles: { text: string; typeMs: number; pauseAfterMs: number }[];
  totalMs: number;
  compressed: boolean;
}

// ------------------------------------------------------- observabilidade

export type CallStatus = 'ok' | 'error' | 'denied';

/** Uma chamada de tool/rota, para as métricas do dashboard. */
export interface CallRecord {
  id?: number;
  ts: number;
  traceId: string;
  agent: string;
  tool: string;
  durationMs: number;
  status: CallStatus;
  error: string | null;
}

export type AuditAction =
  | 'draft.created'
  | 'draft.expired'
  | 'send.confirmed'
  | 'send.completed'
  | 'send.cancelled'
  | 'send.failed'
  | 'send.blocked'
  | 'media.materialized'
  | 'session.paired'
  | 'session.lost'
  | 'alias.set';

/** Evento de auditoria append-only. Todo envio deixa rastro aqui. */
export interface AuditEvent {
  id?: number;
  ts: number;
  traceId: string;
  agent: string;
  action: AuditAction;
  chatJid: string | null;
  outcome: 'ok' | 'error' | 'denied';
  detail: Record<string, unknown>;
}

/** Agregados que alimentam o dashboard. */
export interface MetricsSummary {
  windowMs: number;
  generatedAt: number;
  totals: {
    calls: number;
    errors: number;
    sends: number;
    cancels: number;
    blocked: number;
    mediaProcessed: number;
    messagesRead: number;
  };
  byAgent: {
    agent: string;
    calls: number;
    errors: number;
    sends: number;
    p50Ms: number;
    p95Ms: number;
  }[];
  byTool: { tool: string; calls: number; errors: number; p95Ms: number }[];
  timeline: { bucketTs: number; calls: number; sends: number; errors: number }[];
  session: SessionState;
}
