/**
 * O celular só notifica enquanto nenhum aparelho vinculado está "em uso". Enviar, digitar,
 * reagir, editar, apagar e marcar como lido deixam o daemon em uso no servidor, então cada
 * uma dessas ações termina avisando `unavailable` de novo. Socket falso: nada sai para a rede.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pino from 'pino';
import { Store } from '../src/store/store.js';
import { WhatsAppConnection } from '../src/whatsapp/connection.js';

const ANA = '5551999998888@s.whatsapp.net';

let dir: string;
let store: Store;
let wa: WhatsAppConnection;
const calls: string[] = [];

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-bridge-presence-'));
  store = new Store(join(dir, 'wa.db'));
  store.migrate();
  wa = new WhatsAppConnection({
    store,
    log: pino({ level: 'silent' }),
    metrics: { recordCall: () => {} },
    home: dir,
    historyDays: 7,
    deviceName: 'wa-bridge',
  });
  const socket = {
    presenceSubscribe: async () => {},
    sendPresenceUpdate: async (type: string, jid?: string) => {
      calls.push(jid ? `${type} ${jid}` : type);
    },
    sendMessage: async (_jid: string, content: Record<string, unknown>) => {
      calls.push(`message ${Object.keys(content).join(',')}`);
      return { key: { id: 'novo' }, message: {} };
    },
    readMessages: async () => {
      calls.push('read');
    },
  };
  (wa as unknown as { socket: unknown }).socket = socket;
  store.upsertMessage(
    {
      id: 'm1', chatJid: ANA, senderJid: ANA, senderName: 'Ana', fromMe: false, ts: Date.now(), type: 'text',
      text: 'oi', caption: null, viewOnce: false, quotedText: null, hasMedia: false, mediaState: 'none',
    },
    '{}',
  );
  store.upsertMessage(
    {
      id: 'meu', chatJid: ANA, senderJid: null, senderName: null, fromMe: true, ts: Date.now(), type: 'text',
      text: 'tchau', caption: null, viewOnce: false, quotedText: null, hasMedia: false, mediaState: 'none',
    },
    '{}',
  );
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('digitando não muda a presença; parar de digitar avisa offline', async () => {
  calls.length = 0;
  await wa.setPresence(ANA, 'composing');
  assert.deepEqual(calls, [`composing ${ANA}`]);
  await wa.setPresence(ANA, 'paused');
  assert.deepEqual(calls, [`composing ${ANA}`, `paused ${ANA}`, 'unavailable']);
});

test('reagir, marcar como lido, editar e apagar terminam avisando offline', async () => {
  calls.length = 0;
  await wa.react(ANA, 'm1', '👍');
  assert.deepEqual(calls, ['message react', 'unavailable']);

  calls.length = 0;
  await wa.markRead(ANA);
  assert.deepEqual(calls, ['read', 'unavailable']);

  calls.length = 0;
  await wa.editMessage(ANA, 'meu', 'tchau!');
  assert.deepEqual(calls, ['message text,edit', 'unavailable']);

  calls.length = 0;
  await wa.deleteMessage(ANA, 'meu');
  assert.deepEqual(calls, ['message delete', 'unavailable']);
});
