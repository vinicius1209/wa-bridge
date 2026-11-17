/**
 * Entrada de mensagens na conexão: fila offline (`append`, que antes era descartada) e o
 * `getMessage` que o Baileys usa para reenviar. Sem socket: os métodos privados são
 * chamados direto sobre um Store temporário.
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

const ANA = '5551999998888@s.whatsapp.net';

/** Acesso aos métodos privados que o teste exercita. */
interface Internals {
  handleIncomingMessage(raw: WAMessage, source: 'live' | 'offline'): boolean;
  lookupMessageContent(id: string | null | undefined): WAMessageContent | undefined;
  scheduleReconnect(): void;
  reconnectTimer: NodeJS.Timeout | null;
}

let dir: string;
let store: Store;
let received: StoredMessage[];

/** Conexão sem socket sobre o Store do teste. */
function connection(): { wa: WhatsAppConnection; internals: Internals } {
  const wa = new WhatsAppConnection({
    store,
    log: pino({ level: 'silent' }),
    metrics: { recordCall: () => {} },
    home: dir,
  });
  wa.onMessage((m) => received.push(m));
  return { wa, internals: wa as unknown as Internals };
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
