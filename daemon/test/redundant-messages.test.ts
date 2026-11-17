/**
 * Cabeçalho de álbum e cópias de mídia (versão HD, foto com movimento) não viram mensagem:
 * a foto ou o vídeo de verdade chega como mensagem própria. A migração 5 apaga os que
 * versões anteriores gravaram como `unknown`.
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
import { isMediaCopyAssociation, MEDIA_COPY_ASSOCIATION_TYPES } from '../src/whatsapp/protocol.js';

const ANA = '5551999998888@s.whatsapp.net';
const Assoc = proto.MessageAssociation.AssociationType;

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-bridge-redundant-'));
});

after(() => rmSync(dir, { recursive: true, force: true }));

/** Mensagem bruta com o conteúdo dado. */
function raw(id: string, message: Record<string, unknown>): WAMessage {
  return { key: { remoteJid: ANA, id, fromMe: false }, message, messageTimestamp: 1_800_000_000 } as unknown as WAMessage;
}

/** Filho associado a `parentId` com o tipo de associação dado. */
function child(id: string, associationType: number, inner: Record<string, unknown>): WAMessage {
  return raw(id, {
    messageContextInfo: { messageAssociation: { associationType, parentMessageKey: { remoteJid: ANA, id: 'foto', fromMe: false } } },
    associatedChildMessage: { message: inner },
  });
}

test('os números batem com o enum do Baileys', () => {
  for (const [name, id] of Object.entries(MEDIA_COPY_ASSOCIATION_TYPES)) {
    assert.equal((Assoc as unknown as Record<string, number>)[name], id, name);
  }
  assert.equal(isMediaCopyAssociation('HD_IMAGE_DUAL_UPLOAD'), true);
  assert.equal(isMediaCopyAssociation(Assoc.MEDIA_ALBUM), false, 'foto de álbum é conteúdo');
  assert.equal(isMediaCopyAssociation(undefined), false);
});

test('cabeçalho de álbum e cópias não entram; a foto do álbum e associação desconhecida entram', () => {
  const store = new Store(join(dir, 'entrada.db'));
  store.migrate();
  try {
    const wa = new WhatsAppConnection({
      store, log: pino({ level: 'silent' }), metrics: { recordCall: () => {} },
      home: dir, historyDays: 7, deviceName: 'wa-bridge',
    });
    const ingest = (m: WAMessage) =>
      (wa as unknown as { handleIncomingMessage(raw: WAMessage, source: 'live'): boolean }).handleIncomingMessage(m, 'live');

    assert.equal(ingest(raw('album', { albumMessage: { expectedImageCount: 3 } })), false);
    assert.equal(ingest(child('hd', Assoc.HD_IMAGE_DUAL_UPLOAD, { imageMessage: { mimetype: 'image/jpeg' } })), false);
    assert.equal(ingest(child('hd-video', Assoc.HD_VIDEO_DUAL_UPLOAD, { videoMessage: { mimetype: 'video/mp4' } })), false);
    assert.equal(ingest(child('movimento', Assoc.MOTION_PHOTO, { videoMessage: { mimetype: 'video/mp4' } })), false);
    for (const id of ['album', 'hd', 'hd-video', 'movimento']) assert.equal(store.getMessage(id), null, id);

    const fotoDoAlbum = raw('foto', {
      imageMessage: { mimetype: 'image/jpeg' },
      messageContextInfo: { messageAssociation: { associationType: Assoc.MEDIA_ALBUM, parentMessageKey: { id: 'album' } } },
    });
    assert.equal(ingest(fotoDoAlbum), true);
    assert.equal(store.getMessage('foto')?.type, 'image');

    assert.equal(ingest(child('figurinha', Assoc.STICKER_ANNOTATION, { stickerMessage: {} })), true, 'associação fora da lista continua entrando');
    assert.equal(store.listChats({ limit: 10, onlyUnread: false })[0]?.unreadCount, 2, 'só a foto e a desconhecida contam como não lidas');
  } finally {
    store.close();
  }
});

/** Mensagem `unknown` no formato do `Store`. */
function stored(id: string): StoredMessage {
  return {
    id, chatJid: ANA, senderJid: ANA, senderName: 'Ana', fromMe: false, ts: 1000, type: 'unknown', text: null,
    caption: null, viewOnce: false, quotedText: null, hasMedia: false, mediaState: 'none',
  };
}

/** `raw_json` de um filho como o `toJSON` do protobuf grava (enum pelo nome). */
function rawChild(associationType: string | number): string {
  return JSON.stringify({
    message: {
      messageContextInfo: { messageAssociation: { associationType, parentMessageKey: { id: 'foto' } } },
      associatedChildMessage: { message: { imageMessage: {} } },
    },
  });
}

test('migração 5 apaga cabeçalhos e cópias já gravados e preserva o resto', () => {
  const path = join(dir, 'legado.db');
  const store = new Store(path);
  store.migrate();
  store.upsertMessage(stored('album'), JSON.stringify({ message: { albumMessage: { expectedImageCount: 2 } } }));
  store.upsertMessage(stored('hd'), rawChild('HD_IMAGE_DUAL_UPLOAD'));
  store.upsertMessage(stored('movimento'), rawChild('MOTION_PHOTO'));
  store.upsertMessage(stored('hevc-numero'), rawChild(19));
  store.upsertMessage(stored('figurinha'), rawChild('STICKER_ANNOTATION'));
  store.upsertMessage(stored('quebrado'), '{nao e json');
  store.upsertMessage({ ...stored('foto'), type: 'image', hasMedia: true, mediaState: 'pending' }, rawChild('HD_IMAGE_DUAL_UPLOAD'));
  store.close();

  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version = 4');
  db.close();

  const migrated = new Store(path);
  try {
    migrated.migrate();
    assert.equal(migrated.schemaVersion(), 5);
    for (const id of ['album', 'hd', 'movimento', 'hevc-numero']) assert.equal(migrated.getMessage(id), null, id);
    for (const id of ['figurinha', 'quebrado', 'foto']) assert.notEqual(migrated.getMessage(id), null, id);
  } finally {
    migrated.close();
  }
});
