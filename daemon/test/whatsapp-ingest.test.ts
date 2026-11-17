/**
 * Entrada de mensagens na conexão: histórico do pareamento (só os últimos N dias, sem
 * contar como não lida e sem disparar `onMessage`), fila offline (`append`, que antes era
 * descartada) e o `getMessage` que o Baileys usa para reenviar. Sem socket: os métodos
 * privados são chamados direto sobre um Store temporário.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type { WAMessage, WAMessageContent } from '@whiskeysockets/baileys';
import pino from 'pino';
import { Store } from '../src/store/store.js';
import type { StoredMessage } from '../src/types.js';
import { WhatsAppConnection } from '../src/whatsapp/connection.js';

const DAY = 86_400_000;
const ANA = '5551999998888@s.whatsapp.net';
const GRUPO = '120363000000000000@g.us';

/** Acesso aos métodos privados que o teste exercita. */
interface Internals {
  importHistory(messages: WAMessage[], chats: unknown[], meta: { syncType: number | null; progress: number | null }): void;
  handleIncomingMessage(raw: WAMessage, source: 'live' | 'offline' | 'history'): boolean;
  lookupMessageContent(id: string | null | undefined): WAMessageContent | undefined;
  scheduleReconnect(): void;
  reconnectTimer: NodeJS.Timeout | null;
}

let dir: string;
let store: Store;
let received: StoredMessage[];

/** Conexão sem socket sobre o Store do teste. */
function connection(historyDays = 7): { wa: WhatsAppConnection; internals: Internals } {
  const wa = new WhatsAppConnection({
    store,
    log: pino({ level: 'silent' }),
    metrics: { recordCall: () => {} },
    home: dir,
    historyDays,
  });
  wa.onMessage((m) => received.push(m));
  return { wa, internals: wa as unknown as Internals };
}

/** `Long` mínimo, no formato que o histórico do WhatsApp entrega o timestamp. */
function long(seconds: number): WAMessage['messageTimestamp'] {
  return { low: seconds, high: 0, unsigned: true, toNumber: () => seconds } as unknown as WAMessage['messageTimestamp'];
}

/** Mensagem bruta do Baileys com texto simples. */
function raw(id: string, remoteJid: string, text: string, tsMs: number, fromMe = false): WAMessage {
  return {
    key: { remoteJid, id, fromMe },
    message: { conversation: text },
    messageTimestamp: Math.floor(tsMs / 1000),
    pushName: 'Ana',
  } as WAMessage;
}

/** Não lidas de uma conversa. */
function unread(jid: string): number {
  return store.listChats({ limit: 100, onlyUnread: false }).find((c) => c.jid === jid)?.unreadCount ?? 0;
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-bridge-ingest-'));
});

beforeEach(() => {
  store?.close();
  store = new Store(join(dir, `wa-${Math.random().toString(36).slice(2)}.db`));
  store.migrate();
  received = [];
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('histórico: entra só o que está na janela, sem status e sem contar como não lida', () => {
  const { internals } = connection(7);
  const now = Date.now();
  const recente = raw('h1', ANA, 'mensagem de ontem', now - DAY);
  recente.messageTimestamp = long(Math.floor((now - DAY) / 1000));
  internals.importHistory(
    [
      recente,
      raw('h2', ANA, 'mensagem de 10 dias atrás', now - 10 * DAY),
      raw('h3', 'status@broadcast', 'status de alguém', now - DAY),
      raw('h4', '123@newsletter', 'canal', now - DAY),
    ],
    [
      { id: GRUPO, name: 'Padel de segunda', conversationTimestamp: Math.floor((now - DAY) / 1000) },
      { id: '120363999@g.us', name: 'Grupo parado', conversationTimestamp: Math.floor((now - 30 * DAY) / 1000) },
    ],
    { syncType: 0, progress: 100 },
  );

  const h1 = store.getMessage('h1');
  assert.ok(h1, 'mensagem dentro da janela entra');
  assert.equal(Math.abs((h1?.ts ?? 0) - (now - DAY)) < 1000, true, 'timestamp Long vira a data certa, não a hora do import');
  assert.equal(store.getMessage('h2'), null, 'fora da janela não entra');
  assert.equal(store.getMessage('h3'), null);
  assert.equal(store.getMessage('h4'), null);
  assert.equal(unread(ANA), 0, 'histórico não soma em não lidas');
  assert.equal(received.length, 0, 'histórico não dispara onMessage (nem o stream de eventos)');

  const chats = store.listChats({ limit: 100, onlyUnread: false });
  assert.equal(chats.find((c) => c.jid === GRUPO)?.name, 'Padel de segunda');
  assert.equal(chats.some((c) => c.jid === '120363999@g.us'), false);
  assert.equal(store.searchMessages({ query: 'ontem', limit: 5 })[0]?.message.id, 'h1', 'histórico fica buscável');
});

test('histórico não sobrescreve mensagem que já existe', () => {
  const { internals } = connection(7);
  const now = Date.now();
  internals.handleIncomingMessage(raw('x1', ANA, 'versão ao vivo', now), 'live');
  internals.importHistory([raw('x1', ANA, 'versão do histórico', now)], [], { syncType: null, progress: null });
  assert.equal(store.getMessage('x1')?.text, 'versão ao vivo');
});

test('WA_HISTORY_DAYS=0 desliga a importação', () => {
  const { internals } = connection(0);
  internals.importHistory([raw('z1', ANA, 'oi', Date.now())], [], { syncType: null, progress: null });
  assert.equal(store.getMessage('z1'), null);
});

test('fila offline (append) entra, conta como não lida e notifica, sem duplicar', () => {
  const { internals } = connection();
  const now = Date.now();
  assert.equal(internals.handleIncomingMessage(raw('o1', ANA, 'chegou com o daemon parado', now), 'offline'), true);
  assert.equal(internals.handleIncomingMessage(raw('o1', ANA, 'chegou com o daemon parado', now), 'offline'), false);
  assert.ok(store.getMessage('o1'));
  assert.equal(unread(ANA), 1);
  assert.deepEqual(received.map((m) => m.id), ['o1']);
});

test('fila offline não sobrescreve mensagem que já existe', () => {
  const { internals } = connection();
  const now = Date.now();
  internals.handleIncomingMessage(raw('d1', ANA, 'versão ao vivo', now), 'live');
  assert.equal(internals.handleIncomingMessage(raw('d1', ANA, 'versão reentregue', now), 'offline'), false);
  assert.equal(store.getMessage('d1')?.text, 'versão ao vivo');
  assert.equal(unread(ANA), 1, 'reentrega não soma de novo em não lidas');
});

test('mensagem ao vivo repetida não "desprocessa" a mídia', () => {
  const { internals } = connection();
  const audio: WAMessage = {
    key: { remoteJid: ANA, id: 'a1', fromMe: false },
    message: { audioMessage: { mimetype: 'audio/ogg', seconds: 3 } },
    messageTimestamp: Math.floor(Date.now() / 1000),
  } as WAMessage;
  internals.handleIncomingMessage(audio, 'live');
  store.saveMedia({
    messageId: 'a1', kind: 'audio', mime: 'audio/ogg', path: '/tmp/a1.ogg', bytes: 1, durationMs: 3000,
    transcript: 'oi', framePaths: [], viewOnce: false, error: null,
  });
  internals.handleIncomingMessage(audio, 'live');
  assert.equal(store.getMessage('a1')?.mediaState, 'ready');
});

test('getMessage do Baileys: devolve o conteúdo salvo, com os bytes de volta a Buffer', () => {
  const { internals } = connection();
  const mediaKey = Buffer.from([1, 2, 3, 4]);
  const sent = {
    key: { remoteJid: ANA, id: 'enviada', fromMe: true },
    message: { imageMessage: { mimetype: 'image/jpeg', mediaKey } },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
  store.upsertMessage(
    {
      id: 'enviada', chatJid: ANA, senderJid: null, senderName: null, fromMe: true, ts: Date.now(),
      type: 'image', text: null, caption: null, viewOnce: false, quotedText: null, hasMedia: true, mediaState: 'pending',
    },
    JSON.stringify(sent),
  );
  const content = internals.lookupMessageContent('enviada');
  assert.ok(Buffer.isBuffer(content?.imageMessage?.mediaKey));
  assert.deepEqual([...(content?.imageMessage?.mediaKey ?? [])], [1, 2, 3, 4]);
  assert.equal(internals.lookupMessageContent('nao-existe'), undefined);
  assert.equal(internals.lookupMessageContent(undefined), undefined);
});

test('datas de contato só avançam: mensagem antiga não recua o último contato', () => {
  store.upsertContact({ jid: ANA, pushName: 'Ana', alias: null, phoneJid: null, lastInboundAt: 5000, lastOutboundAt: null });
  store.upsertContact({ jid: ANA, pushName: null, alias: null, phoneJid: null, lastInboundAt: 1000, lastOutboundAt: 2000 });
  assert.equal(store.lastContactAt(ANA), 5000);
});

test('close() impede reconexão', () => {
  const { wa, internals } = connection();
  wa.close();
  internals.scheduleReconnect();
  assert.equal(internals.reconnectTimer, null);
});
