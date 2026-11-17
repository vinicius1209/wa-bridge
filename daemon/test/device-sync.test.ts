/**
 * Mensagens de sincronização entre os aparelhos da conta (histórico, chaves,
 * configurações): não entram no banco, e a migração 3 apaga as que versões anteriores
 * gravaram como `unknown` na conversa do usuário com ele mesmo.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { Store } from '../src/store/store.js';
import type { StoredMessage } from '../src/types.js';
import { WhatsAppConnection } from '../src/whatsapp/connection.js';
import { DEVICE_SYNC_PROTOCOL_TYPES, isDeviceSyncProtocolType } from '../src/whatsapp/protocol.js';

const EU = '100000000000001@lid';
const ANA = '5551999998888@s.whatsapp.net';

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-bridge-device-sync-'));
});

after(() => rmSync(dir, { recursive: true, force: true }));

/** Mensagem mínima no formato do `Store`. */
function stored(id: string, type: StoredMessage['type'], text: string | null): StoredMessage {
  return {
    id, chatJid: EU, senderJid: null, senderName: null, fromMe: true, ts: 1000, type, text,
    caption: null, viewOnce: false, quotedText: null, hasMedia: false, mediaState: 'none',
  };
}

/** `raw_json` como o daemon gravava: o `toJSON` do protobuf troca o enum pelo nome. */
function rawProtocol(type: string): string {
  return JSON.stringify({ key: { remoteJid: EU, fromMe: true }, message: { protocolMessage: { type } } });
}

test('os números batem com o enum do Baileys', () => {
  for (const [name, id] of Object.entries(DEVICE_SYNC_PROTOCOL_TYPES)) {
    assert.equal(
      (proto.Message.ProtocolMessage.Type as unknown as Record<string, number>)[name],
      id,
      name,
    );
  }
  assert.equal(isDeviceSyncProtocolType(proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION), true);
  assert.equal(isDeviceSyncProtocolType('APP_STATE_SYNC_KEY_SHARE'), true);
  assert.equal(isDeviceSyncProtocolType(proto.Message.ProtocolMessage.Type.MESSAGE_EDIT), false, 'edição é conversa');
  assert.equal(isDeviceSyncProtocolType(proto.Message.ProtocolMessage.Type.REVOKE), false, 'apagar para todos é conversa');
  assert.equal(isDeviceSyncProtocolType(undefined), false);
});

test('notificação de histórico não vira mensagem nem atualiza a conversa', () => {
  const store = new Store(join(dir, 'entrada.db'));
  store.migrate();
  try {
    const wa = new WhatsAppConnection({
      store,
      log: pino({ level: 'silent' }),
      metrics: { recordCall: () => {} },
      home: dir,
      historyDays: 7,
      deviceName: 'wa-bridge',
    });
    const internals = wa as unknown as { handleIncomingMessage(raw: WAMessage, source: 'live'): boolean };
    const sync = {
      key: { remoteJid: EU, id: 'sync-1', fromMe: true },
      message: {
        protocolMessage: {
          type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
          historySyncNotification: { syncType: 3, chunkOrder: 1 },
        },
      },
      messageTimestamp: 1_800_000_000,
    } as unknown as WAMessage;
    assert.equal(internals.handleIncomingMessage(sync, 'live'), false);
    assert.equal(store.getMessage('sync-1'), null);
    assert.equal(store.listChats({ limit: 10, onlyUnread: false }).length, 0, 'a conversa comigo mesmo não aparece');

    const texto = {
      key: { remoteJid: ANA, id: 'txt-1', fromMe: false },
      message: { conversation: 'oi' },
      messageTimestamp: 1_800_000_000,
    } as unknown as WAMessage;
    assert.equal(internals.handleIncomingMessage(texto, 'live'), true);
  } finally {
    store.close();
  }
});

test('migração 3 apaga as notificações já gravadas e preserva o resto', () => {
  const path = join(dir, 'legado.db');
  const store = new Store(path);
  store.migrate();
  store.upsertMessage(stored('hist', 'unknown', null), rawProtocol('HISTORY_SYNC_NOTIFICATION'));
  store.upsertMessage(stored('chave', 'unknown', null), rawProtocol('APP_STATE_SYNC_KEY_SHARE'));
  store.upsertMessage(stored('numero', 'unknown', null), JSON.stringify({ message: { protocolMessage: { type: 5 } } }));
  store.upsertMessage(stored('edicao', 'unknown', null), rawProtocol('MESSAGE_EDIT'));
  store.upsertMessage(stored('quebrado', 'unknown', null), '{nao e json');
  store.upsertMessage(stored('texto', 'text', 'reunião amanhã'), rawProtocol('HISTORY_SYNC_NOTIFICATION'));
  // Conversa só com notificações (sai da lista) e conversa com nota + notificação mais nova.
  const SO_SYNC = '100000000000002@lid';
  const COM_NOTA = '100000000000003@lid';
  store.upsertChat({ jid: SO_SYNC, name: null, isGroup: false, lastMessageAt: 9000, unreadCount: 0 });
  store.upsertMessage({ ...stored('so-sync', 'unknown', null), chatJid: SO_SYNC, ts: 9000 }, rawProtocol('HISTORY_SYNC_NOTIFICATION'));
  store.upsertChat({ jid: COM_NOTA, name: null, isGroup: false, lastMessageAt: 8000, unreadCount: 0 });
  store.upsertMessage({ ...stored('nota', 'text', 'lembrar do pix'), chatJid: COM_NOTA, ts: 2000 }, '{}');
  store.upsertMessage({ ...stored('nota-sync', 'unknown', null), chatJid: COM_NOTA, ts: 8000 }, rawProtocol('APP_STATE_SYNC_KEY_SHARE'));
  store.close();

  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version = 2');
  db.close();

  const migrated = new Store(path);
  try {
    migrated.migrate();
    assert.equal(migrated.schemaVersion(), 5);
    for (const id of ['hist', 'chave', 'numero']) assert.equal(migrated.getMessage(id), null, id);
    for (const id of ['edicao', 'quebrado', 'texto']) assert.notEqual(migrated.getMessage(id), null, id);
    assert.equal(migrated.searchMessages({ query: 'reuniao', limit: 5 })[0]?.message.id, 'texto');
    const chats = migrated.listChats({ limit: 50, onlyUnread: false });
    assert.equal(chats.find((c) => c.jid === SO_SYNC), undefined, 'conversa só com notificações sai da lista');
    assert.equal(chats.find((c) => c.jid === COM_NOTA)?.lastMessageAt, 2000, 'última atividade volta a ser a da nota');
  } finally {
    migrated.close();
  }
});
