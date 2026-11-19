/**
 * Limites de volume do gate: teto por dia, intervalo por conversa (só no confirm, sem
 * queimar o token), conversas novas por dia e a cota de conversas novas que o próprio
 * WhatsApp informa. SQLite temporário e conexão falsa: nada sai para a rede.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import pino from 'pino';
import type { Config } from '../src/config.js';
import { Audit } from '../src/obs/audit.js';
import { Metrics } from '../src/obs/metrics.js';
import { AppError } from '../src/send/errors.js';
import { newChatQuotaExhausted, SendGate } from '../src/send/gate.js';
import { Store } from '../src/store/store.js';
import type { NewChatQuota } from '../src/types.js';
import type { WhatsAppConnection } from '../src/whatsapp/connection.js';
import { toNewChatQuota } from '../src/whatsapp/connection.js';

const CONHECIDA = '5551999990001@s.whatsapp.net';
const NOVA = '5551999990002@s.whatsapp.net';
const OUTRA = '5551999990003@s.whatsapp.net';
const HORA = 3_600_000;

let dir: string;
let store: Store;
let quota: NewChatQuota | null;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-bridge-limits-'));
});

after(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  store?.close();
  store = new Store(join(dir, `wa-${Math.random().toString(36).slice(2)}.db`));
  store.migrate();
  store.upsertContact({
    jid: CONHECIDA, pushName: 'Bia', alias: null, phoneJid: null,
    lastInboundAt: Date.now() - 1000, lastOutboundAt: null,
  });
  quota = null;
});

/** Gate com limites ajustáveis; o resto da config não interfere. */
function gate(limits: Partial<Pick<Config, 'sendsPerDay' | 'newContactsPerDay' | 'chatMinIntervalMs'>> = {}): SendGate {
  const config = {
    home: dir,
    blocklistPath: join(dir, 'blocklist.json'),
    quietHours: { startMinute: 0, endMinute: 0, raw: '00:00-00:00' },
    sendMaxDelayMs: 200,
    draftTtlMs: 60_000,
    sendsPerHour: 100,
    sendsPerDay: 100,
    newContactsPerDay: 10,
    chatMinIntervalMs: 0,
    ...limits,
  } as Config;
  const wa = {
    getGroupParticipants: async () => [],
    buildQuoted: () => undefined,
    markOffline: async () => {},
    getNewChatQuota: () => quota,
    sendText: async () => 'id',
    sendMedia: async () => 'id-media',
  } as unknown as WhatsAppConnection;
  return new SendGate({ wa, store, log: pino({ level: 'silent' }), metrics: new Metrics(store), audit: new Audit(store), config });
}

/** Envio já feito, para encher os contadores. */
function envioFeito(chatJid: string, startedAt: number, firstContact = false): void {
  store.insertSend({
    sendId: `s-${Math.random().toString(36).slice(2)}`, chatJid, agent: 'teste', traceId: null,
    startedAt, finishedAt: startedAt + 1000, stage: 'done', bubblesTotal: 1, bubblesSent: 1,
    cancelled: false, messageIdsJson: '[]', firstContact,
  });
}

/** Espera o envio em segundo plano terminar, para o teste não fechar o banco no meio. */
async function esperarEnvio(sendId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const stage = store.getSend(sendId)?.stage;
    if (stage === 'done' || stage === 'failed' || stage === 'cancelled') return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('envio não terminou');
}

/** Espera recusa `RATE_LIMITED` com o escopo dado e devolve o `detail`. */
async function recusado(promessa: Promise<unknown>, scope: string): Promise<{ scope: string; retryAfterMs?: number }> {
  try {
    await promessa;
  } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    assert.equal(error.code, 'RATE_LIMITED');
    const detail = error.detail as { scope: string; retryAfterMs?: number };
    assert.equal(detail.scope, scope);
    return detail;
  }
  throw new Error(`esperava RATE_LIMITED (${scope})`);
}

test('teto diário: conta as últimas 24h, não só a última hora', async () => {
  const g = gate({ sendsPerDay: 2 });
  envioFeito(OUTRA, Date.now() - 5 * HORA);
  envioFeito(OUTRA, Date.now() - 20 * HORA);
  await recusado(g.draft({ to: CONHECIDA, text: 'oi' }, { agent: 'teste' }), 'day');

  const folgado = gate({ sendsPerDay: 3 });
  assert.ok((await folgado.draft({ to: CONHECIDA, text: 'oi' }, { agent: 'teste' })).confirmToken);
});

test('intervalo por conversa: o rascunho passa, o confirm espera e o token continua valendo', async () => {
  const g = gate({ chatMinIntervalMs: 400 });
  envioFeito(CONHECIDA, Date.now());
  const draft = await g.draft({ to: CONHECIDA, text: 'só mais uma coisa' }, { agent: 'teste' });
  const detail = await recusado(g.confirm(draft.confirmToken, 'teste'), 'chat');
  assert.ok(detail.retryAfterMs !== undefined && detail.retryAfterMs > 0 && detail.retryAfterMs <= 400);

  await new Promise((r) => setTimeout(r, 450));
  const { sendId } = await g.confirm(draft.confirmToken, 'teste');
  assert.ok(sendId, 'o mesmo token confirma depois do intervalo');
  assert.equal(store.getSend(sendId)?.firstContact, false);
  await esperarEnvio(sendId);
});

test('outra conversa não espera o intervalo', async () => {
  const g = gate({ chatMinIntervalMs: 60_000 });
  envioFeito(OUTRA, Date.now());
  const draft = await g.draft({ to: CONHECIDA, text: 'oi' }, { agent: 'teste' });
  const { sendId } = await g.confirm(draft.confirmToken, 'teste');
  await esperarEnvio(sendId);
});

test('conversas novas por dia: barra quem nunca conversou, deixa passar contato conhecido', async () => {
  const g = gate({ newContactsPerDay: 1 });
  envioFeito(OUTRA, Date.now() - 2 * HORA, true);
  await recusado(g.draft({ to: NOVA, text: 'oi, tudo bem?' }, { agent: 'teste' }), 'new_contacts');
  assert.ok((await g.draft({ to: CONHECIDA, text: 'oi' }, { agent: 'teste' })).confirmToken);

  const desligado = gate({ newContactsPerDay: 0 });
  await recusado(desligado.draft({ to: OUTRA, text: 'oi' }, { agent: 'teste' }), 'new_contacts');
});

test('primeiro contato confirmado conta no limite do dia', async () => {
  const g = gate({ newContactsPerDay: 1 });
  const draft = await g.draft({ to: NOVA, text: 'oi, prazer' }, { agent: 'teste' });
  const { sendId } = await g.confirm(draft.confirmToken, 'teste', { acknowledge: ['NEVER_CONTACTED'] });
  assert.equal(store.getSend(sendId)?.firstContact, true);
  await esperarEnvio(sendId);
  await recusado(g.draft({ to: OUTRA, text: 'oi' }, { agent: 'teste' }), 'new_contacts');
});

test('cota do WhatsApp: CAPPED ou na reserva barra conversa nova, não conversa conhecida', async () => {
  const g = gate();
  quota = { total: null, used: null, status: 'CAPPED', cycleEndsAt: null, receivedAt: Date.now() };
  await recusado(g.draft({ to: NOVA, text: 'oi' }, { agent: 'teste' }), 'whatsapp_quota');
  assert.ok((await g.draft({ to: CONHECIDA, text: 'oi' }, { agent: 'teste' })).confirmToken);

  quota = { total: 20, used: 18, status: 'SECOND_WARNING', cycleEndsAt: null, receivedAt: Date.now() };
  await recusado(g.draft({ to: NOVA, text: 'oi' }, { agent: 'teste' }), 'whatsapp_quota');
});

test('reserva da cota: 10% do total, no mínimo 1', () => {
  const q = (total: number | null, used: number | null, status: string | null = 'NONE'): NewChatQuota =>
    ({ total, used, status, cycleEndsAt: null, receivedAt: 0 });
  assert.equal(newChatQuotaExhausted(q(10, 8)), false, 'sobram 2, reserva 1');
  assert.equal(newChatQuotaExhausted(q(10, 9)), true);
  assert.equal(newChatQuotaExhausted(q(50, 44)), false, 'sobram 6, reserva 5');
  assert.equal(newChatQuotaExhausted(q(50, 45)), true);
  assert.equal(newChatQuotaExhausted(q(null, null, 'FIRST_WARNING')), false, 'aviso sem números não barra');
  assert.equal(newChatQuotaExhausted(q(null, null, 'CAPPED')), true);
});

test('cota do WhatsApp normalizada: números em texto e fim do ciclo em segundos', () => {
  const quota = toNewChatQuota(
    { total_quota: '30', used_quota: 4, capping_status: 'FIRST_WARNING', cycle_end_timestamp: '1800000000' },
    123,
  );
  assert.deepEqual(quota, { total: 30, used: 4, status: 'FIRST_WARNING', cycleEndsAt: 1_800_000_000_000, receivedAt: 123 });
  assert.equal(toNewChatQuota({}, 1).total, null);
});
