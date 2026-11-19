/**
 * O celular só notifica enquanto nenhum aparelho vinculado está "em uso". O envio não mostra
 * "digitando" nem assina presença, e enviar, reagir, editar, apagar e marcar como lido
 * terminam avisando `unavailable` de novo. Socket e WhatsApp falsos: nada sai para a rede.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pino from 'pino';
import type { Config } from '../src/config.js';
import { Audit } from '../src/obs/audit.js';
import { Metrics } from '../src/obs/metrics.js';
import { SendGate } from '../src/send/gate.js';
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

test('envio não mostra digitando nem assina presença, e termina avisando offline', async () => {
  const chamadas: string[] = [];
  const fakeWa = {
    getGroupParticipants: async () => [],
    getNewChatQuota: () => null,
    buildQuoted: () => undefined,
    sendText: async (_jid: string, text: string) => {
      chamadas.push(`texto ${text}`);
      return `id-${chamadas.length}`;
    },
    markOffline: async () => {
      chamadas.push('offline');
    },
  } as unknown as WhatsAppConnection;
  const config = {
    home: dir,
    blocklistPath: join(dir, 'blocklist.json'),
    quietHours: { startMinute: 0, endMinute: 0, raw: '00:00-00:00' },
    sendMaxDelayMs: 1000,
    draftTtlMs: 60_000,
    sendsPerHour: 10,
    sendsPerDay: 40,
    newContactsPerDay: 3,
    chatMinIntervalMs: 0,
  } as Config;
  const gate = new SendGate({
    wa: fakeWa, store, log: pino({ level: 'silent' }), metrics: new Metrics(store), audit: new Audit(store), config,
  });

  const draft = await gate.draft({ to: ANA, text: 'oi, tudo bem?' });
  const { sendId } = await gate.confirm(draft.confirmToken, 'teste', { acknowledge: draft.warnings });
  for (let i = 0; i < 100 && store.getSend(sendId)?.stage !== 'done'; i++) await new Promise((r) => setTimeout(r, 50));
  // Sem `setPresence` no WhatsApp falso: se o gate ainda mandasse "digitando", o envio falharia.
  assert.equal(store.getSend(sendId)?.stage, 'done');
  assert.deepEqual(chamadas, ['texto oi, tudo bem?', 'offline']);
});

test('markOffline manda unavailable, e a conexão não tem mais como assinar presença', async () => {
  calls.length = 0;
  await wa.markOffline();
  assert.deepEqual(calls, ['unavailable']);
  assert.equal((wa as unknown as { setPresence?: unknown }).setPresence, undefined);
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
