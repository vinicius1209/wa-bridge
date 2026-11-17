/**
 * Gate de envio: um confirm recusado por falta de `acknowledge` não pode queimar o
 * token, e o token continua valendo uma única vez. Usa SQLite temporário e uma conexão
 * WhatsApp falsa — nada sai para a rede.
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
import { AppError } from '../src/send/errors.js';
import { SendGate } from '../src/send/gate.js';
import { Store } from '../src/store/store.js';
import type { WhatsAppConnection } from '../src/whatsapp/connection.js';

const DESTINO = '5551999998888@s.whatsapp.net';

let dir: string;
let store: Store;
let gate: SendGate;
const enviados: string[] = [];

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-bridge-gate-'));
  store = new Store(join(dir, 'wa.db'));
  store.migrate();

  const config = {
    home: dir,
    blocklistPath: join(dir, 'blocklist.json'),
    // Janela vazia (00:00-00:00): nunca é horário de silêncio, o teste não depende do relógio.
    quietHours: { startMinute: 0, endMinute: 0, raw: '00:00-00:00' },
    sendMaxDelayMs: 1000,
    draftTtlMs: 60_000,
    sendsPerHour: 10,
  } as Config;

  const wa = {
    getGroupParticipants: async () => [],
    buildQuoted: () => undefined,
    setPresence: async () => {},
    getNewChatQuota: () => null,
    sendText: async (_jid: string, text: string) => {
      enviados.push(text);
      return `id-${enviados.length}`;
    },
    sendMedia: async () => 'id-media',
  } as unknown as WhatsAppConnection;

  gate = new SendGate({
    wa,
    store,
    log: pino({ level: 'silent' }),
    metrics: new Metrics(store),
    audit: new Audit(store),
    config,
  });
});

after(() => rmSync(dir, { recursive: true, force: true }));

/** Espera o envio em background terminar (o plano comprimido dura ~1s). */
async function esperarEnvio(sendId: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const stage = store.getSend(sendId)?.stage;
    if (stage === 'done' || stage === 'failed' || stage === 'cancelled') return stage;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('envio não terminou em 10s');
}

test('confirm sem acknowledge recusa sem queimar o token; com acknowledge envia uma vez só', async () => {
  const draft = await gate.draft({ to: DESTINO, text: 'oi, tudo bem?' }, { agent: 'teste' });
  assert.ok(draft.warnings.includes('NEVER_CONTACTED'));

  await assert.rejects(
    gate.confirm(draft.confirmToken, 'teste'),
    (e: unknown) => e instanceof AppError && e.code === 'CONFIRMATION_REQUIRED',
  );
  assert.equal(store.getDraft(draft.confirmToken)?.status, 'pending', 'o token tem que sobreviver à recusa');

  const { sendId } = await gate.confirm(draft.confirmToken, 'teste', { acknowledge: ['NEVER_CONTACTED'] });
  await assert.rejects(
    gate.confirm(draft.confirmToken, 'teste', { acknowledge: ['NEVER_CONTACTED'] }),
    (e: unknown) => e instanceof AppError && e.code === 'DRAFT_NOT_FOUND',
  );

  assert.equal(await esperarEnvio(sendId), 'done');
  assert.deepEqual(enviados, ['oi, tudo bem?']);
});

test('dois confirms simultâneos do mesmo token: só um passa', async () => {
  const draft = await gate.draft({ to: DESTINO, text: 'segunda mensagem' }, { agent: 'teste' });
  const opts = { acknowledge: ['NEVER_CONTACTED'] };
  const results = await Promise.allSettled([
    gate.confirm(draft.confirmToken, 'teste', opts),
    gate.confirm(draft.confirmToken, 'teste', opts),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const ok = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ sendId: string }>;
  assert.equal(await esperarEnvio(ok.value.sendId), 'done');
});
