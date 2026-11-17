/**
 * Camada de persistência do wa-bridge. Único ponto de acesso ao SQLite —
 * nenhum outro módulo abre `node:sqlite` diretamente.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { maskNumber } from '../config.js';
import { DEVICE_SYNC_PROTOCOL_TYPES, MEDIA_COPY_ASSOCIATION_TYPES } from '../whatsapp/protocol.js';
import type {
  AuditAction,
  AuditEvent,
  CallRecord,
  CallStatus,
  ChatSummary,
  ContactMatch,
  ContactRecord,
  GroupMember,
  GroupParticipant,
  GroupParticipantMatch,
  MatchReason,
  MediaArtifact,
  MediaFiles,
  MediaKind,
  MediaState,
  MessageType,
  SearchHit,
  SearchSource,
  StoredMessage,
} from '../types.js';

/** Rascunho de envio persistido, pendente de confirmação pelo humano. */
export interface DraftRecord {
  confirmToken: string;
  chatJid: string;
  payloadJson: string;
  agent: string | null;
  traceId: string | null;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'consumed' | 'expired' | 'cancelled';
}

/** Execução de envio (plano de delay humano) em andamento ou concluída. */
export interface SendRecord {
  sendId: string;
  chatJid: string;
  agent: string | null;
  traceId: string | null;
  startedAt: number;
  finishedAt: number | null;
  stage: string;
  bubblesTotal: number | null;
  bubblesSent: number | null;
  cancelled: boolean;
  messageIdsJson: string | null;
  /** Primeira mensagem para quem nunca conversou com o usuário: conta no limite diário. */
  firstContact: boolean;
}

/** Edição ou "apagar para todos" de uma mensagem, já extraída do `protocolMessage`. */
export interface MessageChange {
  kind: 'edit' | 'revoke';
  /** Conversa onde a mudança chegou: tem que ser a mesma da mensagem alvo. */
  chatJid: string;
  targetId: string;
  /** Quem mudou: o próprio usuário (`fromMe`) ou o remetente em `senderJid`. */
  fromMe: boolean;
  senderJid: string | null;
  at: number;
  /** Só na edição: o texto novo (com o prefixo de mídia, como em `messages.text`) e a legenda. */
  text: string | null;
  caption: string | null;
}

/** O que aconteceu com uma `MessageChange`. */
export interface MessageChangeResult {
  /**
   * `applied`: a mensagem mudou. `missing`: a original não está no banco. `ignored`: a
   * original existe, mas a mudança não vale (outra conversa, outro autor, já apagada).
   */
  outcome: 'applied' | 'missing' | 'ignored';
  /** Arquivos da mídia de uma mensagem apagada, para quem chamou tirar do disco. */
  mediaFiles: MediaFiles | null;
}

/** Linha bruta de `messages`, antes da conversão de inteiros para boolean. */
interface MessageRow {
  id: string;
  chat_jid: string;
  sender_jid: string | null;
  sender_name: string | null;
  from_me: number;
  ts: number;
  type: string;
  text: string | null;
  caption: string | null;
  view_once: number;
  quoted_text: string | null;
  has_media: number;
  media_state: string;
  raw_json: string | null;
  edited_at?: number | null;
  deleted_at?: number | null;
}

interface ChatRow {
  jid: string;
  name: string | null;
  is_group: number;
  last_message_at: number | null;
  unread_count: number;
}

/** Linha de `messages` com o telefone real do remetente LID (de `contacts`). */
interface MessageWithPhoneRow extends MessageRow {
  sender_phone_jid: string | null;
}

/** Linha de `chats` com o telefone real da conversa LID (de `contacts`). */
interface ChatWithPhoneRow extends ChatRow {
  phone_jid: string | null;
}

interface ContactRow {
  jid: string;
  push_name: string | null;
  alias: string | null;
  phone_jid: string | null;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
}

interface GroupParticipantRow {
  group_jid: string;
  jid: string;
  phone_jid: string | null;
  name: string | null;
  is_admin: number;
  updated_at: number;
}

/** Linha de `group_participants` já enriquecida com nome/alias vindos de `contacts`. */
interface GroupParticipantNamedRow extends GroupParticipantRow {
  push_name: string | null;
  alias: string | null;
}

interface MediaRow {
  message_id: string;
  kind: string;
  mime: string | null;
  path: string | null;
  bytes: number | null;
  duration_ms: number | null;
  transcript: string | null;
  frames_json: string | null;
  view_once: number;
  error: string | null;
  processed_at: number | null;
}

interface DraftRow {
  confirm_token: string;
  chat_jid: string;
  payload_json: string;
  agent: string | null;
  trace_id: string | null;
  created_at: number;
  expires_at: number;
  status: string;
}

interface SendRow {
  send_id: string;
  chat_jid: string;
  agent: string | null;
  trace_id: string | null;
  started_at: number;
  finished_at: number | null;
  stage: string;
  bubbles_total: number | null;
  bubbles_sent: number | null;
  cancelled: number;
  message_ids_json: string | null;
  first_contact: number;
}

interface AuditRow {
  id: number;
  ts: number;
  trace_id: string | null;
  agent: string | null;
  action: string;
  chat_jid: string | null;
  outcome: string;
  detail_json: string | null;
}

interface CallRow {
  id: number;
  ts: number;
  trace_id: string | null;
  agent: string;
  tool: string;
  duration_ms: number;
  status: string;
  error: string | null;
}

/** Remove acentos/diacríticos e normaliza caixa para comparação de texto. */
function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Extrai só os dígitos de uma string (telefone ou JID). */
function onlyDigits(s: string): string {
  return s.replace(/\D/g, '');
}

/** Deriva `messages.media_state` do erro registrado no artefato de mídia. */
function mediaStateFor(error: string | null): MediaState {
  if (error === null) return 'ready';
  if (error.startsWith('MEDIA_EXPIRED')) return 'expired';
  // Arquivo apagado pela retenção: some do disco, mas `wa_media` ainda pode baixar de novo.
  if (error.startsWith('PRUNED')) return 'pending';
  // Falhas "leves" (whisper/ffmpeg) deixam o arquivo baixado e utilizável.
  if (error.startsWith('WHISPER_') || error.startsWith('FFMPEG_')) return 'ready';
  return 'failed';
}

/** Converte linha de `messages` no tipo `StoredMessage`. */
function rowToMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    chatJid: row.chat_jid,
    senderJid: row.sender_jid,
    senderName: row.sender_name,
    fromMe: row.from_me === 1,
    ts: row.ts,
    type: row.type as MessageType,
    text: row.text,
    caption: row.caption,
    viewOnce: row.view_once === 1,
    quotedText: row.quoted_text,
    hasMedia: row.has_media === 1,
    mediaState: row.media_state as MediaState,
    editedAt: row.edited_at ?? null,
    deletedAt: row.deleted_at ?? null,
  };
}

/** Converte linha de `chats` no tipo `ChatSummary`. */
function rowToChat(row: ChatRow): ChatSummary {
  return {
    jid: row.jid,
    name: row.name,
    isGroup: row.is_group === 1,
    lastMessageAt: row.last_message_at,
    unreadCount: row.unread_count,
  };
}

/** Converte linha de `contacts` no tipo `ContactRecord`. */
function rowToContact(row: ContactRow): ContactRecord {
  return {
    jid: row.jid,
    pushName: row.push_name,
    alias: row.alias,
    phoneJid: row.phone_jid ?? null,
    lastInboundAt: row.last_inbound_at,
    lastOutboundAt: row.last_outbound_at,
  };
}

/**
 * Membros de um grupo com nome/apelido vindos de `contacts`.
 *
 * O LEFT JOIN duplo cobre os dois jeitos de o contato estar indexado: pelo próprio id
 * de endereçamento (LID em grupo novo) ou pelo telefone (`@s.whatsapp.net`).
 */
const GROUP_PARTICIPANT_SELECT = `
  SELECT gp.*,
         COALESCE(ct.push_name, ctp.push_name) AS push_name,
         COALESCE(ct.alias, ctp.alias) AS alias
    FROM group_participants gp
    LEFT JOIN contacts ct ON ct.jid = gp.jid
    LEFT JOIN contacts ctp ON ctp.jid = gp.phone_jid
   WHERE gp.group_jid = ?`;

/** Converte linha de `group_participants` no tipo `GroupParticipant`. */
function rowToGroupParticipant(row: GroupParticipantRow): GroupParticipant {
  return {
    groupJid: row.group_jid,
    jid: row.jid,
    phoneJid: row.phone_jid,
    name: row.name,
    isAdmin: row.is_admin === 1,
    updatedAt: row.updated_at,
  };
}

/** Lê `frames_json` tolerando conteúdo ausente ou corrompido. */
function parseFramePaths(framesJson: string | null): string[] {
  if (!framesJson) return [];
  try {
    const parsed = JSON.parse(framesJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Converte texto livre numa query FTS5 que nunca dá erro de sintaxe: cada termo vira
 * uma frase entre aspas (todos obrigatórios) e `termo*` vira busca por prefixo. Sem
 * isto, um `"`, `:`, `-` ou `NEAR` digitado pelo agente quebraria o MATCH.
 */
export function toFtsQuery(input: string): string | null {
  const terms: string[] = [];
  for (const raw of input.split(/\s+/)) {
    const prefix = raw.endsWith('*');
    const core = raw.replace(/\*+$/, '').replace(/"/g, '').trim();
    if (core.length === 0) continue;
    terms.push(prefix ? `"${core}"*` : `"${core}"`);
  }
  return terms.length > 0 ? terms.join(' ') : null;
}

/** Converte linha de `media` no tipo `MediaArtifact`. */
function rowToMedia(row: MediaRow): MediaArtifact {
  const framePaths = parseFramePaths(row.frames_json);
  return {
    messageId: row.message_id,
    kind: row.kind as MediaKind,
    mime: row.mime ?? '',
    path: row.path ?? '',
    bytes: row.bytes ?? 0,
    durationMs: row.duration_ms,
    transcript: row.transcript,
    framePaths,
    viewOnce: row.view_once === 1,
    error: row.error,
  };
}

/** Converte linha de `drafts` no tipo `DraftRecord`. */
function rowToDraft(row: DraftRow): DraftRecord {
  return {
    confirmToken: row.confirm_token,
    chatJid: row.chat_jid,
    payloadJson: row.payload_json,
    agent: row.agent,
    traceId: row.trace_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status as DraftRecord['status'],
  };
}

/** Converte linha de `sends` no tipo `SendRecord`. */
function rowToSend(row: SendRow): SendRecord {
  return {
    sendId: row.send_id,
    chatJid: row.chat_jid,
    agent: row.agent,
    traceId: row.trace_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stage: row.stage,
    bubblesTotal: row.bubbles_total,
    bubblesSent: row.bubbles_sent,
    cancelled: row.cancelled === 1,
    messageIdsJson: row.message_ids_json,
    firstContact: row.first_contact === 1,
  };
}

/** Converte linha de `audit` no tipo `AuditEvent`. */
function rowToAudit(row: AuditRow): AuditEvent {
  let detail: Record<string, unknown> = {};
  if (row.detail_json) {
    try {
      const parsed = JSON.parse(row.detail_json) as unknown;
      if (parsed && typeof parsed === 'object') detail = parsed as Record<string, unknown>;
    } catch {
      detail = {};
    }
  }
  return {
    id: row.id,
    ts: row.ts,
    traceId: row.trace_id ?? '',
    agent: row.agent ?? 'unknown',
    action: row.action as AuditAction,
    chatJid: row.chat_jid,
    outcome: row.outcome as AuditEvent['outcome'],
    detail,
  };
}

/** Converte linha de `metrics_calls` no tipo `CallRecord`. */
function rowToCall(row: CallRow): CallRecord {
  return {
    id: row.id,
    ts: row.ts,
    traceId: row.trace_id ?? '',
    agent: row.agent,
    tool: row.tool,
    durationMs: row.duration_ms,
    status: row.status as CallStatus,
    error: row.error,
  };
}

/**
 * Dono exclusivo do SQLite do wa-bridge: mensagens, contatos, mídia, rascunhos
 * de envio, envios, auditoria e métricas de chamada.
 */
export class Store {
  private readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  /** Prepara (ou reaproveita) um statement, indexado pela própria SQL. */
  private prepare(sql: string): StatementSync {
    const cached = this.stmts.get(sql);
    if (cached) return cached;
    const stmt = this.db.prepare(sql);
    this.stmts.set(sql, stmt);
    return stmt;
  }

  /**
   * Evolui o schema por versão (`PRAGMA user_version`). Cada passo roda uma única vez,
   * em ordem e em transação, e grava a versão nova junto. Bancos criados antes do
   * versionamento estão na versão 0: o passo 1 é idempotente e só confirma o que existe.
   * Schema novo = passo novo no fim da lista; nunca edite um passo que já foi publicado.
   */
  migrate(): void {
    const steps: Array<() => void> = [
      () => this.migrateBaseSchema(),
      () => this.migrateSearchIndex(),
      () => this.migrateDropDeviceSyncMessages(),
      () => this.migrateSendFirstContact(),
      () => this.migrateDropRedundantMessages(),
      () => this.migrateMessageChanges(),
    ];
    const row = this.db.prepare('PRAGMA user_version').get() as unknown as { user_version: number };
    for (let target = Number(row.user_version) + 1; target <= steps.length; target += 1) {
      const step = steps[target - 1];
      if (!step) break;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        step();
        this.db.exec(`PRAGMA user_version = ${target}`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  /** Versão do schema gravada no banco (`PRAGMA user_version`). */
  schemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as unknown as { user_version: number };
    return Number(row.user_version);
  }

  /** Passo 1: schema original (tabelas, índices e a coluna `contacts.phone_jid`). */
  private migrateBaseSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY, name TEXT, is_group INTEGER NOT NULL DEFAULT 0,
        last_message_at INTEGER, unread_count INTEGER NOT NULL DEFAULT 0);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, chat_jid TEXT NOT NULL, sender_jid TEXT, sender_name TEXT,
        from_me INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL,
        text TEXT, caption TEXT, view_once INTEGER NOT NULL DEFAULT 0, quoted_text TEXT,
        has_media INTEGER NOT NULL DEFAULT 0, media_state TEXT NOT NULL DEFAULT 'none',
        raw_json TEXT);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, ts DESC);

      CREATE TABLE IF NOT EXISTS media (
        message_id TEXT PRIMARY KEY, kind TEXT NOT NULL, mime TEXT, path TEXT,
        bytes INTEGER, duration_ms INTEGER, transcript TEXT, frames_json TEXT,
        view_once INTEGER NOT NULL DEFAULT 0, error TEXT, processed_at INTEGER);

      CREATE TABLE IF NOT EXISTS group_participants (
        group_jid TEXT NOT NULL, jid TEXT NOT NULL, phone_jid TEXT, name TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
        PRIMARY KEY (group_jid, jid));

      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY, push_name TEXT, alias TEXT, phone_jid TEXT,
        last_inbound_at INTEGER, last_outbound_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_contacts_alias ON contacts(alias);

      CREATE TABLE IF NOT EXISTS drafts (
        confirm_token TEXT PRIMARY KEY, chat_jid TEXT NOT NULL, payload_json TEXT NOT NULL,
        agent TEXT, trace_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending');

      CREATE TABLE IF NOT EXISTS sends (
        send_id TEXT PRIMARY KEY, chat_jid TEXT NOT NULL, agent TEXT, trace_id TEXT,
        started_at INTEGER NOT NULL, finished_at INTEGER, stage TEXT NOT NULL,
        bubbles_total INTEGER, bubbles_sent INTEGER, cancelled INTEGER NOT NULL DEFAULT 0,
        message_ids_json TEXT);

      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, trace_id TEXT,
        agent TEXT, action TEXT NOT NULL, chat_jid TEXT, outcome TEXT NOT NULL,
        detail_json TEXT);
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);

      CREATE TABLE IF NOT EXISTS metrics_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, trace_id TEXT,
        agent TEXT NOT NULL, tool TEXT NOT NULL, duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL, error TEXT);
      CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics_calls(ts DESC);
    `);

    this.addColumnIfMissing('contacts', 'phone_jid', 'TEXT');
  }

  /**
   * Passo 2: índice de busca textual (FTS5) sobre `messages.text` e `media.transcript`.
   *
   * As duas tabelas FTS são de conteúdo externo (só o índice, sem duplicar o texto) e
   * ficam em sincronia por trigger, então nenhum caminho de escrita precisa lembrar dela.
   * `remove_diacritics` faz "reuniao" achar "Reunião". Elas dependem do `rowid` implícito
   * de `messages`/`media`: um `VACUUM` manual pode renumerá-lo, e aí é preciso rodar
   * `rebuild` (ver docs/OPERACAO.md). O código nunca roda VACUUM.
   */
  private migrateSearchIndex(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text, content='messages', content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF text ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END;

      CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(
        transcript, content='media', content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS media_fts_ai AFTER INSERT ON media BEGIN
        INSERT INTO media_fts(rowid, transcript) VALUES (new.rowid, new.transcript);
      END;
      CREATE TRIGGER IF NOT EXISTS media_fts_ad AFTER DELETE ON media BEGIN
        INSERT INTO media_fts(media_fts, rowid, transcript) VALUES ('delete', old.rowid, old.transcript);
      END;
      CREATE TRIGGER IF NOT EXISTS media_fts_au AFTER UPDATE OF transcript ON media BEGIN
        INSERT INTO media_fts(media_fts, rowid, transcript) VALUES ('delete', old.rowid, old.transcript);
        INSERT INTO media_fts(rowid, transcript) VALUES (new.rowid, new.transcript);
      END;

      INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
      INSERT INTO media_fts(media_fts) VALUES ('rebuild');
    `);
  }

  /**
   * Passo 3: apaga as mensagens de sincronização entre aparelhos (`protocolMessage` de
   * histórico, chaves e configurações) que versões anteriores gravavam como `unknown` na
   * conversa do usuário com ele mesmo. O `raw_json` guarda o tipo pelo nome; o número
   * cobre gravações sem essa conversão. `raw_json` inválido fica como está.
   *
   * Essa conversa só aparecia na lista por causa delas: se fica sem mensagem, sai de
   * `chats`; se ainda tem outras, a última atividade volta a ser a dessas.
   */
  private migrateDropDeviceSyncMessages(): void {
    const types: Array<string | number> = [
      ...Object.keys(DEVICE_SYNC_PROTOCOL_TYPES),
      ...Object.values(DEVICE_SYNC_PROTOCOL_TYPES),
    ];
    const match = `type = 'unknown'
      AND CASE WHEN json_valid(raw_json)
               THEN json_extract(raw_json, '$.message.protocolMessage.type') END
          IN (${types.map(() => '?').join(', ')})`;
    const chats = this.db
      .prepare(`SELECT DISTINCT chat_jid AS jid FROM messages WHERE ${match}`)
      .all(...types) as unknown as Array<{ jid: string }>;
    this.db.prepare(`DELETE FROM messages WHERE ${match}`).run(...types);

    const dropEmpty = this.db.prepare(
      'DELETE FROM chats WHERE jid = ? AND NOT EXISTS (SELECT 1 FROM messages WHERE chat_jid = ?)',
    );
    const refresh = this.db.prepare(
      'UPDATE chats SET last_message_at = (SELECT MAX(ts) FROM messages WHERE chat_jid = ?) WHERE jid = ?',
    );
    for (const { jid } of chats) {
      dropEmpty.run(jid, jid);
      refresh.run(jid, jid);
    }
  }

  /** Passo 4: `sends.first_contact`, que o limite diário de conversas novas conta. */
  private migrateSendFirstContact(): void {
    const columns = this.db.prepare('PRAGMA table_info(sends)').all() as unknown as Array<{ name: string }>;
    if (columns.some((c) => c.name === 'first_contact')) return;
    this.db.exec('ALTER TABLE sends ADD COLUMN first_contact INTEGER NOT NULL DEFAULT 0');
  }

  /**
   * Passo 5: apaga os cabeçalhos de álbum (`albumMessage`) e as cópias de mídia
   * (`associatedChildMessage` de versão HD ou foto com movimento) que versões anteriores
   * gravavam como `unknown`. A foto ou o vídeo de verdade de cada uma já está no banco como
   * mensagem própria. `raw_json` inválido fica como está.
   */
  private migrateDropRedundantMessages(): void {
    const copies: Array<string | number> = [
      ...Object.keys(MEDIA_COPY_ASSOCIATION_TYPES),
      ...Object.values(MEDIA_COPY_ASSOCIATION_TYPES),
    ];
    this.db
      .prepare(
        `DELETE FROM messages
          WHERE type = 'unknown'
            AND CASE WHEN json_valid(raw_json) THEN
                  json_type(raw_json, '$.message.albumMessage') IS NOT NULL
                  OR (json_type(raw_json, '$.message.associatedChildMessage') IS NOT NULL
                      AND json_extract(raw_json, '$.message.messageContextInfo.messageAssociation.associationType')
                          IN (${copies.map(() => '?').join(', ')}))
                ELSE 0 END`,
      )
      .run(...copies);
  }

  /**
   * Passo 6: `messages.edited_at` e `messages.deleted_at` (idempotente), para edição e
   * "apagar para todos". As que versões anteriores gravaram como `unknown` são reaplicadas
   * na subida do daemon (`WhatsAppConnection.reapplyStoredChanges`), que sabe ler o
   * conteúdo da mensagem.
   */
  private migrateMessageChanges(): void {
    this.addColumnIfMissing('messages', 'edited_at', 'INTEGER');
    this.addColumnIfMissing('messages', 'deleted_at', 'INTEGER');
  }

  /** Fecha o banco. Depois disto nenhum método do Store funciona. */
  close(): void {
    this.stmts.clear();
    this.db.close();
  }

  /**
   * Adiciona uma coluna a uma tabela já existente, se ainda não estiver lá.
   * O SQLite não tem `ADD COLUMN IF NOT EXISTS`, e bancos criados antes desta
   * versão precisam evoluir sem perder a sessão pareada.
   */
  private addColumnIfMissing(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  // ------------------------------------------------------------- mensagens

  /**
   * Insere ou substitui uma mensagem, guardando o JSON bruto do Baileys. A reentrega da
   * original não desfaz uma edição (o texto editado fica) nem traz de volta uma apagada.
   */
  upsertMessage(m: StoredMessage, rawJson: string): void {
    this.prepare(
      `INSERT INTO messages (id, chat_jid, sender_jid, sender_name, from_me, ts, type,
         text, caption, view_once, quoted_text, has_media, media_state, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         chat_jid = excluded.chat_jid, sender_jid = excluded.sender_jid,
         sender_name = excluded.sender_name, from_me = excluded.from_me, ts = excluded.ts,
         type = excluded.type,
         text = CASE WHEN messages.edited_at IS NULL THEN excluded.text ELSE messages.text END,
         caption = CASE WHEN messages.edited_at IS NULL THEN excluded.caption ELSE messages.caption END,
         view_once = excluded.view_once, quoted_text = excluded.quoted_text,
         has_media = excluded.has_media,
         -- Reentrega da mesma mensagem não pode "desprocessar" uma mídia já materializada.
         media_state = CASE WHEN messages.media_state IN ('ready', 'failed', 'expired')
                            THEN messages.media_state ELSE excluded.media_state END,
         raw_json = excluded.raw_json
       WHERE messages.deleted_at IS NULL`,
    ).run(
      m.id,
      m.chatJid,
      m.senderJid,
      m.senderName,
      m.fromMe ? 1 : 0,
      m.ts,
      m.type,
      m.text,
      m.caption,
      m.viewOnce ? 1 : 0,
      m.quotedText,
      m.hasMedia ? 1 : 0,
      m.mediaState,
      rawJson,
    );
  }

  /**
   * Insere a mensagem só se o id ainda não existir; devolve `true` se inseriu.
   * Para entradas que podem repetir o que já está no banco (ex.: a fila offline): nada de
   * sobrescrever, e quem chama só mexe em contadores quando a mensagem é nova.
   */
  insertMessageIfNew(m: StoredMessage, rawJson: string): boolean {
    const result = this.prepare(
      `INSERT INTO messages (id, chat_jid, sender_jid, sender_name, from_me, ts, type,
         text, caption, view_once, quoted_text, has_media, media_state, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      m.id,
      m.chatJid,
      m.senderJid,
      m.senderName,
      m.fromMe ? 1 : 0,
      m.ts,
      m.type,
      m.text,
      m.caption,
      m.viewOnce ? 1 : 0,
      m.quotedText,
      m.hasMedia ? 1 : 0,
      m.mediaState,
      rawJson,
    );
    return Number(result.changes) > 0;
  }

  /**
   * Busca textual (FTS5) no texto das mensagens e nas transcrições de áudio/vídeo, mais
   * recentes primeiro. Transcrição só existe para mídia já processada por `wa_media`.
   * Não devolve telefone cru: o resultado vai direto para o agente via MCP.
   */
  searchMessages(opts: { query: string; chatJid?: string; since?: number; limit: number }): SearchHit[] {
    const fts = toFtsQuery(opts.query);
    if (!fts) return [];
    const rows = this.prepare(
      `WITH hits AS (
         SELECT m.id AS message_id, 'text' AS source,
                snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet
           FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
          WHERE messages_fts MATCH ?1
         UNION ALL
         SELECT md.message_id, 'transcript',
                snippet(media_fts, 0, '«', '»', '…', 12)
           FROM media_fts JOIN media md ON md.rowid = media_fts.rowid
          WHERE media_fts MATCH ?1)
       SELECT h.source AS hit_source, h.snippet AS hit_snippet,
              m.id, m.chat_jid, m.sender_jid, m.sender_name, m.from_me, m.ts, m.type,
              m.text, m.caption, m.view_once, m.quoted_text, m.has_media, m.media_state,
              m.edited_at, m.deleted_at,
              NULL AS raw_json, COALESCE(c.name, ct.push_name) AS chat_name
         FROM hits h
         JOIN messages m ON m.id = h.message_id
         LEFT JOIN chats c ON c.jid = m.chat_jid
         LEFT JOIN contacts ct ON ct.jid = m.chat_jid
        WHERE (?2 IS NULL OR m.chat_jid = ?2) AND (?3 IS NULL OR m.ts >= ?3)
        ORDER BY m.ts DESC
        LIMIT ?4`,
    ).all(fts, opts.chatJid ?? null, opts.since ?? null, opts.limit) as unknown as Array<
      MessageRow & { hit_source: SearchSource; hit_snippet: string | null; chat_name: string | null }
    >;
    return rows.map((row) => ({
      message: rowToMessage(row),
      chatName: row.chat_name,
      source: row.hit_source,
      snippet: row.hit_snippet ?? '',
    }));
  }

  /**
   * Lista mensagens de uma conversa, mais recentes primeiro, com corte opcional por `since`.
   * Cada mensagem traz `senderPhoneJid`: o telefone real quando o remetente é LID e o
   * número é conhecido (`contacts.phone_jid`), senão `null`.
   */
  listMessages(opts: { chatJid: string; limit: number; since?: number }): StoredMessage[] {
    const base = `
      SELECT m.*,
             CASE WHEN m.sender_jid LIKE '%@lid' THEN ct.phone_jid END AS sender_phone_jid
        FROM messages m
        LEFT JOIN contacts ct ON ct.jid = m.sender_jid`;
    const rows = opts.since !== undefined
      ? (this.prepare(
          `${base} WHERE m.chat_jid = ? AND m.ts >= ? ORDER BY m.ts DESC LIMIT ?`,
        ).all(opts.chatJid, opts.since, opts.limit) as unknown as MessageWithPhoneRow[])
      : (this.prepare(
          `${base} WHERE m.chat_jid = ? ORDER BY m.ts DESC LIMIT ?`,
        ).all(opts.chatJid, opts.limit) as unknown as MessageWithPhoneRow[]);
    return rows.map((row) => ({ ...rowToMessage(row), senderPhoneJid: row.sender_phone_jid ?? null }));
  }

  /** Busca uma mensagem pelo id; `null` se não existir. */
  getMessage(id: string): StoredMessage | null {
    const row = this.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as
      | MessageRow
      | undefined;
    return row ? rowToMessage(row) : null;
  }

  /**
   * Aplica uma edição ou um "apagar para todos" na mensagem original.
   *
   * Só vale na mesma conversa e vinda de quem escreveu a original (o Baileys avisa que esses
   * tipos podem vir de qualquer um, então quem confere é a gente). A exceção é apagar em
   * grupo: admin pode apagar mensagem dos outros. Apagada perde texto, legenda, citação,
   * mídia e o conteúdo do `raw_json` (fica só a `key`), como no celular; os arquivos da
   * mídia voltam em `mediaFiles` para quem chamou remover do disco.
   */
  applyMessageChange(c: MessageChange): MessageChangeResult {
    const row = this.prepare(
      'SELECT chat_jid, sender_jid, from_me, has_media, deleted_at FROM messages WHERE id = ?',
    ).get(c.targetId) as unknown as
      | { chat_jid: string; sender_jid: string | null; from_me: number; has_media: number; deleted_at: number | null }
      | undefined;
    if (!row) return { outcome: 'missing', mediaFiles: null };
    if (row.chat_jid !== c.chatJid || row.deleted_at !== null) return { outcome: 'ignored', mediaFiles: null };
    if (!this.canChangeMessage(row, c)) return { outcome: 'ignored', mediaFiles: null };

    if (c.kind === 'edit') {
      if (c.text === null) return { outcome: 'ignored', mediaFiles: null };
      this.prepare(
        `UPDATE messages SET text = ?, caption = CASE WHEN has_media = 1 THEN ? ELSE caption END,
                edited_at = ?
          WHERE id = ?`,
      ).run(c.text, c.caption, c.at, c.targetId);
      return { outcome: 'applied', mediaFiles: null };
    }

    const media = this.prepare('SELECT path, frames_json FROM media WHERE message_id = ?').get(c.targetId) as unknown as
      | { path: string | null; frames_json: string | null }
      | undefined;
    this.prepare('DELETE FROM media WHERE message_id = ?').run(c.targetId);
    this.prepare(
      `UPDATE messages SET text = NULL, caption = NULL, quoted_text = NULL, has_media = 0,
              media_state = 'none', deleted_at = ?,
              raw_json = CASE WHEN json_valid(raw_json) AND json_type(raw_json, '$.key') = 'object'
                              THEN json_object('key', json(json_extract(raw_json, '$.key'))) END
        WHERE id = ?`,
    ).run(c.at, c.targetId);
    const mediaFiles = media?.path
      ? { messageId: c.targetId, path: media.path, framePaths: parseFramePaths(media.frames_json) }
      : null;
    return { outcome: 'applied', mediaFiles };
  }

  /** Quem fez a mudança pode mudar esta mensagem? (ver `applyMessageChange`) */
  private canChangeMessage(
    row: { chat_jid: string; sender_jid: string | null; from_me: number },
    c: MessageChange,
  ): boolean {
    const sameAuthor =
      row.from_me === 1
        ? c.fromMe
        : !c.fromMe && c.senderJid !== null && row.sender_jid !== null && this.samePerson(row.sender_jid, c.senderJid);
    if (sameAuthor) return true;
    if (c.kind !== 'revoke' || !row.chat_jid.endsWith('@g.us')) return false;
    // O usuário apagando a mensagem de outra pessoa num grupo onde é admin: vem dos
    // aparelhos dele, e o WhatsApp já recusaria se ele não fosse.
    if (c.fromMe) return true;
    if (c.senderJid === null) return false;
    const admin = this.prepare(
      `SELECT 1 FROM group_participants
        WHERE group_jid = ? AND is_admin = 1 AND (jid = ? OR (phone_jid IS NOT NULL AND phone_jid = ?))`,
    ).get(row.chat_jid, c.senderJid, this.phoneFor(c.senderJid));
    return admin !== undefined;
  }

  /** Dois JIDs são a mesma pessoa? Mesmo JID, ou LID e telefone ligados em `contacts`. */
  private samePerson(a: string, b: string): boolean {
    return a === b || this.phoneFor(a) === this.phoneFor(b);
  }

  /**
   * Edições e exclusões que versões anteriores gravaram como mensagem `unknown`, da mais
   * antiga para a mais nova, para a conexão reaplicar (`reapplyStoredChanges`).
   */
  listStoredMessageChanges(): Array<{ id: string; rawJson: string }> {
    const rows = this.prepare(
      `SELECT id, raw_json FROM messages
        WHERE type = 'unknown'
          AND CASE WHEN json_valid(raw_json)
                   THEN json_extract(raw_json, '$.message.protocolMessage.type') END
              IN ('REVOKE', 'MESSAGE_EDIT', 0, 14)
        ORDER BY ts`,
    ).all() as unknown as Array<{ id: string; raw_json: string }>;
    return rows.map((r) => ({ id: r.id, rawJson: r.raw_json }));
  }

  /**
   * Apaga uma linha de `messages` (ex.: uma edição gravada como `unknown`) e acerta a
   * conversa: sai da lista se ficou vazia, senão a última atividade volta a ser a das outras.
   */
  dropMessage(id: string): void {
    const row = this.prepare('SELECT chat_jid FROM messages WHERE id = ?').get(id) as unknown as
      | { chat_jid: string }
      | undefined;
    if (!row) return;
    this.prepare('DELETE FROM messages WHERE id = ?').run(id);
    this.prepare('DELETE FROM chats WHERE jid = ? AND NOT EXISTS (SELECT 1 FROM messages WHERE chat_jid = ?)').run(
      row.chat_jid,
      row.chat_jid,
    );
    this.prepare('UPDATE chats SET last_message_at = (SELECT MAX(ts) FROM messages WHERE chat_jid = ?) WHERE jid = ?').run(
      row.chat_jid,
      row.chat_jid,
    );
  }

  // ------------------------------------------------------------------ chats

  /**
   * Insere ou atualiza o resumo de uma conversa. `unreadCount` é tratado como
   * DELTA a somar, não como valor absoluto: o chamador não sabe o total atual, e
   * sobrescrever faria o contador nunca passar de 1 (e zerar numa mensagem própria).
   * Para zerar de verdade, use `clearUnread`. `name` só é sobrescrito quando vem
   * preenchido, para um upsert sem nome não apagar o nome já conhecido.
   */
  upsertChat(c: ChatSummary): void {
    this.prepare(
      `INSERT INTO chats (jid, name, is_group, last_message_at, unread_count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         name = COALESCE(excluded.name, chats.name), is_group = excluded.is_group,
         last_message_at = MAX(COALESCE(chats.last_message_at, 0), COALESCE(excluded.last_message_at, 0)),
         unread_count = chats.unread_count + excluded.unread_count`,
    ).run(c.jid, c.name, c.isGroup ? 1 : 0, c.lastMessageAt, c.unreadCount);
  }

  /** Nome de exibição de uma conversa (nome do grupo ou do contato), ou `null`. */
  getChatName(jid: string): string | null {
    const row = this.prepare(
      `SELECT COALESCE(c.name, ct.push_name) AS name
         FROM (SELECT ? AS jid) q
         LEFT JOIN chats c ON c.jid = q.jid
         LEFT JOIN contacts ct ON ct.jid = q.jid`,
    ).get(jid) as unknown as { name: string | null } | undefined;
    return row?.name ?? null;
  }

  /**
   * Lista conversas ordenadas pela última mensagem, com filtro opcional de não lidas.
   * Cada conversa traz `phoneJid`: o telefone real quando o `jid` é LID e o número é
   * conhecido (`contacts.phone_jid`), senão `null`.
   */
  listChats(opts: { limit: number; onlyUnread: boolean }): ChatSummary[] {
    // O nome da conversa individual não vem no evento de mensagem — quem tem o nome é o
    // contato (`pushName`). Sem este COALESCE a listagem vira uma parede de "(sem nome)",
    // que é inútil justamente para quem precisa reconhecer com quem está falando.
    const base = `
      SELECT c.jid, COALESCE(c.name, ct.push_name) AS name, c.is_group,
             c.last_message_at, c.unread_count,
             CASE WHEN c.jid LIKE '%@lid' THEN ct.phone_jid END AS phone_jid
        FROM chats c
        LEFT JOIN contacts ct ON ct.jid = c.jid`;
    const rows = opts.onlyUnread
      ? (this.prepare(
          `${base} WHERE c.unread_count > 0 ORDER BY c.last_message_at DESC LIMIT ?`,
        ).all(opts.limit) as unknown as ChatWithPhoneRow[])
      : (this.prepare(
          `${base} ORDER BY c.last_message_at DESC LIMIT ?`,
        ).all(opts.limit) as unknown as ChatWithPhoneRow[]);
    return rows.map((row) => ({ ...rowToChat(row), phoneJid: row.phone_jid ?? null }));
  }

  // ----------------------------------------------------------------- grupos

  /**
   * Substitui a lista de membros de um grupo pela recém-obtida do WhatsApp.
   *
   * É replace-all, não upsert: quem sai do grupo tem que sair daqui também, senão
   * continuaria mencionável — e mencionar um ex-membro vaza o número dele no grupo.
   * Roda em transação para uma falha no meio não deixar o grupo sem membros.
   */
  replaceGroupParticipants(
    groupJid: string,
    participants: { jid: string; phoneJid: string | null; name: string | null; isAdmin: boolean }[],
    now: number,
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.prepare('DELETE FROM group_participants WHERE group_jid = ?').run(groupJid);
      const insert = this.prepare(
        `INSERT INTO group_participants (group_jid, jid, phone_jid, name, is_admin, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_jid, jid) DO UPDATE SET
           phone_jid = COALESCE(excluded.phone_jid, group_participants.phone_jid),
           name = COALESCE(excluded.name, group_participants.name),
           is_admin = excluded.is_admin, updated_at = excluded.updated_at`,
      );
      for (const p of participants) {
        insert.run(groupJid, p.jid, p.phoneJid, p.name, p.isAdmin ? 1 : 0, now);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Lista os membros conhecidos de um grupo, admins primeiro (uso interno: traz `phoneJid` cru). */
  listGroupParticipants(groupJid: string): GroupParticipant[] {
    const rows = this.prepare(
      'SELECT * FROM group_participants WHERE group_jid = ? ORDER BY is_admin DESC, jid',
    ).all(groupJid) as unknown as GroupParticipantRow[];
    return rows.map(rowToGroupParticipant);
  }

  /**
   * Lista os membros de um grupo para a API: nome resolvido e número mascarado.
   *
   * O nome tem que vir de `contacts` — o `groupMetadata` do WhatsApp não manda nome de
   * participante, então sem o JOIN a lista seria uma parede de LIDs opacos, inútil para
   * quem precisa achar "o Allan".
   */
  listGroupMembers(groupJid: string): GroupMember[] {
    const rows = this.prepare(
      `${GROUP_PARTICIPANT_SELECT} ORDER BY gp.is_admin DESC, gp.jid`,
    ).all(groupJid) as unknown as GroupParticipantNamedRow[];
    return rows.map((row) => ({
      jid: row.jid,
      name: row.name ?? row.push_name,
      alias: row.alias,
      maskedNumber: maskNumber(row.phone_jid ?? row.jid),
      isAdmin: row.is_admin === 1,
    }));
  }

  /** Instante da última sincronização de membros de um grupo, ou `null` se nunca houve. */
  groupParticipantsSyncedAt(groupJid: string): number | null {
    const row = this.prepare(
      'SELECT MAX(updated_at) AS updated_at FROM group_participants WHERE group_jid = ?',
    ).get(groupJid) as unknown as { updated_at: number | null } | undefined;
    return row?.updated_at ?? null;
  }

  /**
   * Resolve uma query (nome, apelido, número ou JID) em membros DAQUELE grupo,
   * ordenados por confiança. Escopo de grupo é o ponto: mencionar alguém de fora
   * é vazamento, e "Allan" pode ser outro Allan em outro grupo.
   *
   * O nome vem de `contacts` (pushName/alias), não do metadata do grupo — o
   * WhatsApp não manda nome de participante. Quem nunca falou no grupo e não está
   * nos contatos só é encontrável por número.
   */
  resolveGroupParticipant(groupJid: string, query: string): GroupParticipantMatch[] {
    const rows = this.prepare(GROUP_PARTICIPANT_SELECT).all(
      groupJid,
    ) as unknown as GroupParticipantNamedRow[];

    const normalizedQuery = normalizeText(query);
    const queryDigits = onlyDigits(query);
    const looksLikeNumber = query.includes('@') || queryDigits.length >= 8;
    const matches: GroupParticipantMatch[] = [];

    for (const row of rows) {
      const names = [row.name, row.push_name].filter((n): n is string => typeof n === 'string' && n.length > 0);

      if (looksLikeNumber) {
        const jidMatches =
          query.includes('@') &&
          (normalizeText(row.jid) === normalizedQuery ||
            (row.phone_jid !== null && normalizeText(row.phone_jid) === normalizedQuery));
        const candidateDigits = [onlyDigits(row.jid), row.phone_jid ? onlyDigits(row.phone_jid) : ''];
        const numberMatches =
          queryDigits.length >= 8 &&
          candidateDigits.some(
            (d) => d.length >= 8 && (d.endsWith(queryDigits) || queryDigits.endsWith(d)),
          );
        if (jidMatches || numberMatches) matches.push(this.toParticipantMatch(row, 0.95, 'number'));
        continue;
      }

      if (row.alias && normalizeText(row.alias) === normalizedQuery) {
        matches.push(this.toParticipantMatch(row, 1.0, 'alias'));
        continue;
      }

      if (normalizedQuery.length === 0) continue;

      let best: { score: number; reason: MatchReason } | null = null;
      for (const name of names) {
        const normalizedName = normalizeText(name);
        if (normalizedName === normalizedQuery) {
          best = { score: 0.9, reason: 'exact-name' };
          break;
        }
        // Primeiro nome conta como exato: ninguém diz "marque o Allan Pereira da Silva".
        const firstToken = normalizedName.split(/\s+/)[0] ?? '';
        if (firstToken === normalizedQuery) {
          if (!best || best.score < 0.85) best = { score: 0.85, reason: 'exact-name' };
          continue;
        }
        if (normalizedName.includes(normalizedQuery)) {
          const ratio = normalizedQuery.length / normalizedName.length;
          const score = Math.min(0.75, 0.5 + 0.25 * ratio);
          if (!best || score > best.score) best = { score, reason: 'partial-name' };
        }
      }
      if (best) matches.push(this.toParticipantMatch(row, best.score, best.reason));
    }

    return matches.sort((a, b) => b.score - a.score);
  }

  /** Monta um `GroupParticipantMatch` a partir da linha já enriquecida com nome/alias. */
  private toParticipantMatch(
    row: GroupParticipantNamedRow,
    score: number,
    reason: MatchReason,
  ): GroupParticipantMatch {
    return {
      jid: row.jid,
      phoneJid: row.phone_jid,
      name: row.name ?? row.push_name,
      alias: row.alias,
      // Mascara o telefone real quando conhecido; o LID mascarado viraria número falso.
      maskedNumber: maskNumber(row.phone_jid ?? row.jid),
      isAdmin: row.is_admin === 1,
      score,
      reason,
    };
  }

  // --------------------------------------------------------------- contatos

  /**
   * Insere ou atualiza um contato, preservando alias já definido quando não informado.
   * As datas de contato só avançam: uma mensagem antiga que chega depois de uma nova
   * não pode recuar `last_*_at` (o `MAX` escalar do SQLite devolve NULL se um dos lados
   * for NULL, daí o COALESCE em volta).
   */
  upsertContact(c: ContactRecord): void {
    this.prepare(
      `INSERT INTO contacts (jid, push_name, alias, phone_jid, last_inbound_at, last_outbound_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         push_name = COALESCE(excluded.push_name, contacts.push_name),
         alias = COALESCE(excluded.alias, contacts.alias),
         phone_jid = COALESCE(excluded.phone_jid, contacts.phone_jid),
         last_inbound_at = COALESCE(MAX(excluded.last_inbound_at, contacts.last_inbound_at),
                                    excluded.last_inbound_at, contacts.last_inbound_at),
         last_outbound_at = COALESCE(MAX(excluded.last_outbound_at, contacts.last_outbound_at),
                                     excluded.last_outbound_at, contacts.last_outbound_at)`,
    ).run(c.jid, c.pushName, c.alias, c.phoneJid, c.lastInboundAt, c.lastOutboundAt);
  }

  /**
   * Devolve o JID de telefone de um contato, se conhecido. Serve para o preview do
   * gate mascarar o número real em vez do LID opaco. Cai para o próprio `jid`.
   */
  phoneFor(jid: string): string {
    const row = this.prepare('SELECT phone_jid FROM contacts WHERE jid = ?').get(jid) as unknown as
      | { phone_jid: string | null }
      | undefined;
    return row?.phone_jid ?? jid;
  }

  /** Define (ou substitui) o apelido de um JID. */
  setAlias(alias: string, jid: string): void {
    this.prepare(
      `INSERT INTO contacts (jid, push_name, alias, last_inbound_at, last_outbound_at)
       VALUES (?, NULL, ?, NULL, NULL)
       ON CONFLICT(jid) DO UPDATE SET alias = excluded.alias`,
    ).run(jid, alias);
  }

  /** Retorna o instante do último contato (inbound ou outbound), ou `null`. */
  lastContactAt(jid: string): number | null {
    const row = this.prepare(
      'SELECT last_inbound_at, last_outbound_at FROM contacts WHERE jid = ?',
    ).get(jid) as unknown as { last_inbound_at: number | null; last_outbound_at: number | null } | undefined;
    if (!row) return null;
    const { last_inbound_at, last_outbound_at } = row;
    if (last_inbound_at === null && last_outbound_at === null) return null;
    return Math.max(last_inbound_at ?? 0, last_outbound_at ?? 0);
  }

  /**
   * Resolve uma query de contato (apelido, nome, número ou JID) em candidatos
   * ordenados por confiança. Nunca colapsa ambiguidade — devolve todos os
   * candidatos plausíveis para o gate de envio decidir.
   */
  resolveContact(query: string): ContactMatch[] {
    const rows = this.prepare('SELECT * FROM contacts').all() as unknown as ContactRow[];
    const normalizedQuery = normalizeText(query);
    const queryDigits = onlyDigits(query);
    const looksLikeNumber = query.includes('@') || queryDigits.length >= 8;

    let matches: ContactMatch[] = [];
    /** Contato LID que casou pelo número → telefone real dele (para desduplicar abaixo). */
    const lidPhones = new Map<string, string>();

    for (const row of rows) {
      const contact = rowToContact(row);

      if (looksLikeNumber) {
        // Contato LID guarda o telefone real em `phone_jid`: buscar pelo telefone tem que
        // achá-lo, como `resolveGroupParticipant` já faz.
        const jidMatches =
          query.includes('@') &&
          (normalizeText(contact.jid) === normalizedQuery ||
            (contact.phoneJid !== null && normalizeText(contact.phoneJid) === normalizedQuery));
        const candidateDigits = [onlyDigits(contact.jid), contact.phoneJid ? onlyDigits(contact.phoneJid) : ''];
        const numberMatches =
          queryDigits.length >= 8 &&
          candidateDigits.some((d) => d.length >= 8 && (d.endsWith(queryDigits) || queryDigits.endsWith(d)));
        if (jidMatches || numberMatches) {
          matches.push(this.toContactMatch(contact, 0.95, 'number'));
          if (contact.phoneJid && contact.phoneJid !== contact.jid) lidPhones.set(contact.jid, contact.phoneJid);
        }
        continue;
      }

      if (contact.alias && normalizeText(contact.alias) === normalizedQuery) {
        matches.push(this.toContactMatch(contact, 1.0, 'alias'));
        continue;
      }

      if (contact.pushName) {
        const normalizedName = normalizeText(contact.pushName);
        if (normalizedName === normalizedQuery) {
          matches.push(this.toContactMatch(contact, 0.9, 'exact-name'));
          continue;
        }
        if (normalizedQuery.length > 0 && normalizedName.includes(normalizedQuery)) {
          const ratio = normalizedQuery.length / normalizedName.length;
          const score = Math.min(0.75, 0.5 + 0.25 * ratio);
          matches.push(this.toContactMatch(contact, score, 'partial-name'));
        }
      }
    }

    // Grupos também são destinos válidos de leitura e de envio, e ninguém se refere a um
    // grupo por JID — a referência natural é o nome ("o grupo do condomínio"). Sem isto o
    // agente enxerga o nome em `listChats` mas não consegue resolvê-lo de volta.
    if (!looksLikeNumber && normalizedQuery.length > 0) {
      const groups = this.prepare(
        "SELECT jid, name FROM chats WHERE is_group = 1 AND name IS NOT NULL",
      ).all() as unknown as { jid: string; name: string }[];

      for (const g of groups) {
        const normalizedName = normalizeText(g.name);
        let score: number | null = null;
        if (normalizedName === normalizedQuery) score = 0.9;
        else if (normalizedName.includes(normalizedQuery)) {
          score = Math.min(0.75, 0.5 + 0.25 * (normalizedQuery.length / normalizedName.length));
        }
        if (score === null) continue;
        matches.push({
          jid: g.jid,
          name: g.name,
          alias: null,
          maskedNumber: maskNumber(g.jid), // devolve "grupo", nunca um número falso
          score,
          reason: score === 0.9 ? 'exact-name' : 'partial-name',
          lastContactAt: this.lastContactAt(g.jid),
        });
      }
    }

    // A mesma pessoa costuma existir duas vezes: pelo telefone e pelo LID (com o telefone
    // em `phone_jid`). Casar as duas pelo mesmo número não é ambiguidade, e devolvê-las
    // faria o gate recusar com AMBIGUOUS_CONTACT: fica o JID de telefone.
    if (lidPhones.size > 0) {
      const matched = new Set(matches.map((m) => m.jid));
      matches = matches.filter((m) => {
        const phone = lidPhones.get(m.jid);
        return !(phone && matched.has(phone));
      });
    }

    return matches.sort((a, b) => b.score - a.score);
  }

  /** Monta um `ContactMatch` a partir de um `ContactRecord` já carregado. */
  private toContactMatch(contact: ContactRecord, score: number, reason: MatchReason): ContactMatch {
    return {
      jid: contact.jid,
      name: contact.pushName,
      alias: contact.alias,
      // Mascara o telefone real quando conhecido; o LID mascarado viraria número falso.
      maskedNumber: maskNumber(contact.phoneJid ?? contact.jid),
      score,
      reason,
      lastContactAt:
        contact.lastInboundAt === null && contact.lastOutboundAt === null
          ? null
          : Math.max(contact.lastInboundAt ?? 0, contact.lastOutboundAt ?? 0),
    };
  }

  // ------------------------------------------------------------------ mídia

  /** Persiste (ou substitui) o artefato de mídia materializado para uma mensagem. */
  saveMedia(a: MediaArtifact): void {
    this.prepare(
      `INSERT INTO media (message_id, kind, mime, path, bytes, duration_ms, transcript,
         frames_json, view_once, error, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         kind = excluded.kind, mime = excluded.mime, path = excluded.path,
         bytes = excluded.bytes, duration_ms = excluded.duration_ms,
         transcript = excluded.transcript, frames_json = excluded.frames_json,
         view_once = excluded.view_once, error = excluded.error,
         processed_at = excluded.processed_at`,
    ).run(
      a.messageId,
      a.kind,
      a.mime,
      a.path,
      a.bytes,
      a.durationMs,
      a.transcript,
      JSON.stringify(a.framePaths),
      a.viewOnce ? 1 : 0,
      a.error,
      Date.now(),
    );

    // `messages.media_state` é derivado do artefato: sem isso a coluna fica presa em
    // 'none' para sempre e `listMessages` mente sobre o que já foi materializado.
    this.prepare('UPDATE messages SET media_state = ? WHERE id = ?').run(
      mediaStateFor(a.error),
      a.messageId,
    );
  }

  /** Devolve o JSON cru do Baileys persistido para uma mensagem; `null` se não houver. */
  getRawJson(messageId: string): string | null {
    const row = this.prepare('SELECT raw_json FROM messages WHERE id = ?').get(messageId) as unknown as
      | { raw_json: string | null }
      | undefined;
    return row?.raw_json ?? null;
  }

  /** Zera o contador de não lidas de um chat (chamado quando a conversa é marcada como lida). */
  clearUnread(chatJid: string): void {
    this.prepare('UPDATE chats SET unread_count = 0 WHERE jid = ?').run(chatJid);
  }

  /** Busca o artefato de mídia de uma mensagem; `null` se ainda não materializado. */
  getMedia(messageId: string): MediaArtifact | null {
    const row = this.prepare('SELECT * FROM media WHERE message_id = ?').get(messageId) as unknown as
      | MediaRow
      | undefined;
    return row ? rowToMedia(row) : null;
  }

  // ----------------------------------------------------------------- drafts

  /** Insere um novo rascunho de envio, com status `pending`. */
  insertDraft(d: DraftRecord): void {
    this.prepare(
      `INSERT INTO drafts (confirm_token, chat_jid, payload_json, agent, trace_id,
         created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(d.confirmToken, d.chatJid, d.payloadJson, d.agent, d.traceId, d.createdAt, d.expiresAt, d.status);
  }

  /** Busca um rascunho pelo token, em qualquer status. */
  getDraft(confirmToken: string): DraftRecord | null {
    const row = this.prepare('SELECT * FROM drafts WHERE confirm_token = ?').get(confirmToken) as unknown as
      | DraftRow
      | undefined;
    return row ? rowToDraft(row) : null;
  }

  /**
   * Consome um rascunho atomicamente: só marca `consumed` se ainda estiver
   * `pending` e não expirado. Devolve o rascunho consumido, ou `null` se outro
   * consumidor já ganhou a corrida (ou o token não existe / já expirou).
   */
  consumeDraft(confirmToken: string, now: number): DraftRecord | null {
    const result = this.prepare(
      `UPDATE drafts SET status = 'consumed'
       WHERE confirm_token = ? AND status = 'pending' AND expires_at > ?`,
    ).run(confirmToken, now);
    if (result.changes !== 1) return null;
    return this.getDraft(confirmToken);
  }

  /** Marca como `expired` todos os rascunhos `pending` vencidos; devolve quantos. */
  expireDrafts(now: number): number {
    const result = this.prepare(
      `UPDATE drafts SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`,
    ).run(now);
    return Number(result.changes);
  }

  /** Cancela um rascunho `pending`; devolve `true` se de fato cancelou. */
  cancelDraft(confirmToken: string): boolean {
    const result = this.prepare(
      `UPDATE drafts SET status = 'cancelled' WHERE confirm_token = ? AND status = 'pending'`,
    ).run(confirmToken);
    return result.changes === 1;
  }

  /** Devolve o rascunho `pending` ativo de um chat, se houver (regra de 1 draft por chat). */
  activeDraftForChat(chatJid: string): DraftRecord | null {
    // `expires_at > ?` é obrigatório: um rascunho vencido continua com status 'pending'
    // até alguém rodar `expireDrafts`, e sem este filtro ele bloquearia novos rascunhos
    // para o chat PARA SEMPRE — com o agravante de o erro devolver um token já morto.
    const row = this.prepare(
      `SELECT * FROM drafts
        WHERE chat_jid = ? AND status = 'pending' AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1`,
    ).get(chatJid, Date.now()) as unknown as DraftRow | undefined;
    return row ? rowToDraft(row) : null;
  }

  /** Rascunhos ainda pendentes e não expirados, mais antigos primeiro (para o painel). */
  listPendingDrafts(now: number): DraftRecord[] {
    const rows = this.prepare(
      `SELECT * FROM drafts WHERE status = 'pending' AND expires_at > ? ORDER BY created_at`,
    ).all(now) as unknown as DraftRow[];
    return rows.map(rowToDraft);
  }

  // ------------------------------------------------------------------ sends

  /** Registra o início de um envio (plano de delay humano). */
  insertSend(s: SendRecord): void {
    this.prepare(
      `INSERT INTO sends (send_id, chat_jid, agent, trace_id, started_at, finished_at,
         stage, bubbles_total, bubbles_sent, cancelled, message_ids_json, first_contact)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      s.sendId,
      s.chatJid,
      s.agent,
      s.traceId,
      s.startedAt,
      s.finishedAt,
      s.stage,
      s.bubblesTotal,
      s.bubblesSent,
      s.cancelled ? 1 : 0,
      s.messageIdsJson,
      s.firstContact ? 1 : 0,
    );
  }

  /** Atualiza campos mutáveis de um envio em andamento (estágio, progresso, cancelamento). */
  updateSend(
    sendId: string,
    patch: Partial<Pick<SendRecord, 'finishedAt' | 'stage' | 'bubblesSent' | 'cancelled' | 'messageIdsJson'>>,
  ): void {
    const current = this.getSend(sendId);
    if (!current) return;
    const merged: SendRecord = { ...current, ...patch };
    this.prepare(
      `UPDATE sends SET finished_at = ?, stage = ?, bubbles_sent = ?, cancelled = ?, message_ids_json = ?
       WHERE send_id = ?`,
    ).run(merged.finishedAt, merged.stage, merged.bubblesSent, merged.cancelled ? 1 : 0, merged.messageIdsJson, sendId);
  }

  /** Busca um envio pelo id; `null` se não existir. */
  getSend(sendId: string): SendRecord | null {
    const row = this.prepare('SELECT * FROM sends WHERE send_id = ?').get(sendId) as unknown as
      | SendRow
      | undefined;
    return row ? rowToSend(row) : null;
  }

  /**
   * Fecha como `failed` os envios que ficaram sem `finished_at`. Só acontece quando o
   * daemon morre no meio de um envio: o plano em memória morreu junto, então esses
   * registros ficariam para sempre em `sending` e o painel mostraria envio "em andamento".
   * Chamado uma vez no boot, antes de qualquer envio novo existir.
   */
  failOrphanSends(now: number): number {
    const result = this.prepare(
      `UPDATE sends SET stage = 'failed', finished_at = ? WHERE finished_at IS NULL`,
    ).run(now);
    return Number(result.changes);
  }

  /** Conta quantos envios foram iniciados desde `since` (para o rate limit de 10/hora). */
  countSendsSince(since: number): number {
    const row = this.prepare('SELECT COUNT(*) AS n FROM sends WHERE started_at >= ?').get(since) as unknown as {
      n: number;
    };
    return row.n;
  }

  /** Envios de primeiro contato (`first_contact`) desde `since`. */
  countFirstContactSendsSince(since: number): number {
    const row = this.prepare('SELECT COUNT(*) AS n FROM sends WHERE started_at >= ? AND first_contact = 1').get(
      since,
    ) as unknown as { n: number };
    return row.n;
  }

  /** Início do envio mais recente para a conversa, ou `null` se nunca houve. */
  lastSendToChatAt(chatJid: string): number | null {
    const row = this.prepare('SELECT MAX(started_at) AS ts FROM sends WHERE chat_jid = ?').get(chatJid) as unknown as {
      ts: number | null;
    };
    return row.ts ?? null;
  }

  // ------------------------------------------------------------------ audit

  /** Insere um evento de auditoria. Append-only: nunca é alterado ou removido. */
  insertAudit(e: AuditEvent): void {
    this.prepare(
      `INSERT INTO audit (ts, trace_id, agent, action, chat_jid, outcome, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(e.ts, e.traceId, e.agent, e.action, e.chatJid, e.outcome, JSON.stringify(e.detail));
  }

  /** Lista os eventos de auditoria mais recentes, do mais novo para o mais antigo. */
  recentAudit(limit: number): AuditEvent[] {
    const rows = this.prepare('SELECT * FROM audit ORDER BY ts DESC LIMIT ?').all(limit) as unknown as AuditRow[];
    return rows.map(rowToAudit);
  }

  /** Eventos de auditoria desde um instante, por consulta indexada (usado pelas métricas). */
  auditSince(since: number): AuditEvent[] {
    const rows = this.prepare('SELECT * FROM audit WHERE ts >= ? ORDER BY ts DESC').all(
      since,
    ) as unknown as AuditRow[];
    return rows.map(rowToAudit);
  }

  // --------------------------------------------------------------- retenção

  /**
   * Apaga as mensagens anteriores a `before` e a mídia delas (o índice de busca sai junto,
   * por trigger). Devolve os arquivos que estavam em disco, para quem chama removê-los.
   */
  deleteMessagesBefore(before: number): { deleted: number; files: MediaFiles[] } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.prepare(
        `SELECT md.message_id, md.path, md.frames_json
           FROM media md JOIN messages m ON m.id = md.message_id
          WHERE m.ts < ?`,
      ).all(before) as unknown as Array<{ message_id: string; path: string | null; frames_json: string | null }>;
      this.prepare('DELETE FROM media WHERE message_id IN (SELECT id FROM messages WHERE ts < ?)').run(before);
      const result = this.prepare('DELETE FROM messages WHERE ts < ?').run(before);
      this.db.exec('COMMIT');
      return {
        deleted: Number(result.changes),
        files: rows.map((r) => ({ messageId: r.message_id, path: r.path ?? '', framePaths: parseFramePaths(r.frames_json) })),
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Mídias com arquivo em disco processadas antes de `before`: candidatas à retenção. */
  mediaFilesProcessedBefore(before: number, limit: number): MediaFiles[] {
    const rows = this.prepare(
      `SELECT message_id, path, frames_json FROM media
        WHERE path IS NOT NULL AND path != '' AND processed_at < ?
        ORDER BY processed_at LIMIT ?`,
    ).all(before, limit) as unknown as Array<{ message_id: string; path: string; frames_json: string | null }>;
    return rows.map((r) => ({ messageId: r.message_id, path: r.path, framePaths: parseFramePaths(r.frames_json) }));
  }

  /**
   * Marca a mídia como podada: o arquivo saiu do disco, a transcrição fica (e continua
   * buscável). `messages.media_state` volta a `pending`, porque `wa_media` ainda pode
   * baixar de novo enquanto o WhatsApp tiver o arquivo.
   */
  markMediaPruned(messageId: string): void {
    this.prepare(
      `UPDATE media SET path = '', bytes = 0, frames_json = '[]', error = 'PRUNED'
        WHERE message_id = ?`,
    ).run(messageId);
    this.prepare('UPDATE messages SET media_state = ? WHERE id = ?').run(mediaStateFor('PRUNED'), messageId);
  }

  /** Apaga registros de chamada anteriores a `before`; devolve quantos saíram. */
  deleteCallsBefore(before: number): number {
    return Number(this.prepare('DELETE FROM metrics_calls WHERE ts < ?').run(before).changes);
  }

  /** Apaga rascunhos que expiraram antes de `before` (o payload guarda o texto); devolve quantos. */
  deleteDraftsExpiredBefore(before: number): number {
    return Number(this.prepare('DELETE FROM drafts WHERE expires_at < ?').run(before).changes);
  }

  // ---------------------------------------------------------------- métricas

  /** Insere o registro de uma chamada de tool/rota, para as métricas do dashboard. */
  insertCall(c: CallRecord): void {
    this.prepare(
      `INSERT INTO metrics_calls (ts, trace_id, agent, tool, duration_ms, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.ts, c.traceId, c.agent, c.tool, c.durationMs, c.status, c.error);
  }

  /** Lista as chamadas mais recentes, do mais novo para o mais antigo. */
  recentCalls(limit: number): CallRecord[] {
    const rows = this.prepare('SELECT * FROM metrics_calls ORDER BY ts DESC LIMIT ?').all(
      limit,
    ) as unknown as CallRow[];
    return rows.map(rowToCall);
  }

  /** Lista todas as chamadas desde `since` (para agregação de janela do `Metrics.summary`). */
  callsSince(since: number): CallRecord[] {
    const rows = this.prepare('SELECT * FROM metrics_calls WHERE ts >= ? ORDER BY ts DESC').all(
      since,
    ) as unknown as CallRow[];
    return rows.map(rowToCall);
  }
}
