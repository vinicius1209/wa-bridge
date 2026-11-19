/**
 * Peças do daemon que o painel consome: o filtro que tira o próprio painel das métricas,
 * o nome da tool vindo do shim, o retrato do gate (sem token de confirmação), o descarte
 * por id, os totais da janela anterior e o status da instalação.
 */
import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pino from 'pino';
import { sanitizeTool, shouldRecordCall } from '../src/api/server.js';
import type { Config } from '../src/config.js';
import type { EventHub } from '../src/events/hub.js';
import type { MediaProcessor } from '../src/media/processor.js';
import { Audit } from '../src/obs/audit.js';
import { Metrics } from '../src/obs/metrics.js';
import { detectService, StatusProvider } from '../src/obs/status.js';
import { AppError } from '../src/send/errors.js';
import { draftIdFor, SendGate } from '../src/send/gate.js';
import { Store } from '../src/store/store.js';
import type { WhatsAppConnection } from '../src/whatsapp/connection.js';

const ANA = '5551999998888@s.whatsapp.net';

let dir: string;
let store: Store;
let gate: SendGate;
let metrics: Metrics;
let config: Config;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-bridge-painel-'));
  store = new Store(join(dir, 'wa.db'));
  store.migrate();
  store.upsertContact({ jid: ANA, pushName: 'Ana', alias: null, phoneJid: null, lastInboundAt: 1, lastOutboundAt: null });
  store.upsertChat({ jid: ANA, name: null, isGroup: false, lastMessageAt: 1, unreadCount: 0 });

  mkdirSync(join(dir, 'media', 'chat'), { recursive: true });
  writeFileSync(join(dir, 'media', 'chat', 'a.ogg'), 'x'.repeat(100));
  writeFileSync(join(dir, 'media', 'chat', 'b.jpg'), 'y'.repeat(50));
  chmodSync(dir, 0o700);

  config = {
    home: dir,
    dbPath: join(dir, 'wa.db'),
    mediaDir: join(dir, 'media'),
    blocklistPath: join(dir, 'blocklist.json'),
    quietHours: { startMinute: 0, endMinute: 0, raw: '00:00-00:00' },
    sendMaxDelayMs: 1000,
    draftTtlMs: 60_000,
    sendsPerHour: 10,
    version: '9.9.9',
    historyDays: 7,
    mediaConcurrency: 10,
    retention: { messagesDays: 0, mediaDays: 30, metricsDays: 30 },
    whisperModel: join(dir, 'models', 'ggml-x.bin'),
  } as Config;

  const wa = {
    getGroupParticipants: async () => [],
    buildQuoted: () => undefined,
    markOffline: async () => {},
    getNewChatQuota: () => null,
    sendText: async () => 'id-1',
    sendMedia: async () => 'id-media',
  } as unknown as WhatsAppConnection;

  metrics = new Metrics(store);
  gate = new SendGate({ wa, store, log: pino({ level: 'silent' }), metrics, audit: new Audit(store), config });
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('métricas ignoram o painel, os estáticos, o healthcheck e o stream de eventos', () => {
  assert.equal(shouldRecordCall('/metrics/summary', 'dashboard'), false);
  assert.equal(shouldRecordCall('/dashboard/*', 'unknown'), false);
  assert.equal(shouldRecordCall('/dashboard', 'unknown'), false);
  assert.equal(shouldRecordCall('/health', 'unknown'), false);
  assert.equal(shouldRecordCall('/events', 'cli'), false);
  assert.equal(shouldRecordCall('/messages', 'claude-code'), true);
  assert.equal(shouldRecordCall('/session', 'cli'), true);
});

test('X-WA-Tool só aceita nome de tool do shim', () => {
  assert.equal(sanitizeTool('wa_read_messages'), 'wa_read_messages');
  assert.equal(sanitizeTool('wa_search'), 'wa_search');
  assert.equal(sanitizeTool('/messages'), null);
  assert.equal(sanitizeTool('wa_X; drop'), null);
  assert.equal(sanitizeTool(undefined), null);
  assert.equal(sanitizeTool(['wa_search']), null);
});

test('retrato do gate mostra o rascunho sem o token, e o id descarta', async () => {
  const draft = await gate.draft({ to: ANA, text: 'Chego às 21h.' }, { agent: 'claude-code' });
  const snap = gate.snapshot();
  assert.equal(snap.sendsPerHour, 10);
  assert.equal(snap.quietHours.active, false);
  assert.equal(snap.drafts.length, 1);
  const view = snap.drafts[0];
  assert.equal(view?.id, draftIdFor(draft.confirmToken));
  assert.equal(view?.name, 'Ana');
  assert.equal(view?.maskedNumber, '+55 51 ****-8888');
  assert.deepEqual(view?.bubbles, ['Chego às 21h.']);
  assert.equal(view?.agent, 'claude-code');
  assert.equal(JSON.stringify(snap).includes(draft.confirmToken), false, 'o token nunca sai no retrato');

  await assert.rejects(
    gate.discardDraftById('0000000000000000', { agent: 'dashboard' }),
    (e: unknown) => e instanceof AppError && e.code === 'DRAFT_NOT_FOUND',
  );
  assert.deepEqual(await gate.discardDraftById(view?.id ?? '', { agent: 'dashboard' }), { discarded: true });
  assert.equal(gate.snapshot().drafts.length, 0);
  assert.equal(store.getDraft(draft.confirmToken)?.status, 'cancelled');
});

test('resumo traz os totais da janela anterior e quando cada agente foi visto', () => {
  const now = Date.now();
  const hour = 3_600_000;
  const call = (ts: number, agent: string, status: 'ok' | 'error' = 'ok') =>
    metrics.recordCall({ ts, traceId: 't', agent, tool: 'wa_search', durationMs: 5, status, error: null });
  call(now - 30 * 60_000, 'claude-code');
  call(now - 10 * 60_000, 'claude-code', 'error');
  call(now - hour - 10 * 60_000, 'codex');
  call(now - hour - 20 * 60_000, 'codex');
  call(now - hour - 30 * 60_000, 'codex');

  const summary = metrics.summary(hour);
  assert.equal(summary.totals.calls, 2);
  assert.equal(summary.totals.errors, 1);
  assert.equal(summary.previousTotals.calls, 3);
  const claude = summary.byAgent.find((a) => a.agent === 'claude-code');
  assert.ok(claude && claude.lastCallAt !== null && Math.abs(claude.lastCallAt - (now - 10 * 60_000)) < 1000);
  assert.equal(summary.byAgent.some((a) => a.agent === 'codex'), false, 'agente da janela anterior não entra na atual');
});

test('status da instalação: versão, banco, mídia, retenção, fila e permissão', async () => {
  const media = { queueStats: () => ({ running: 1, queued: 2, max: 10 }) } as unknown as MediaProcessor;
  const events = { size: 3 } as unknown as EventHub;
  const status = new StatusProvider({ config, store, media, events });
  status.recordRetention({ messages: 0, mediaFiles: 4, calls: 9, drafts: 1 }, 1234);

  const snap = await status.snapshot();
  assert.equal(snap.version, '9.9.9');
  assert.equal(snap.schemaVersion, 6);
  assert.ok(snap.dbBytes > 0);
  assert.deepEqual({ bytes: snap.media.bytes, files: snap.media.files }, { bytes: 150, files: 2 });
  assert.deepEqual(snap.retention.last, { at: 1234, result: { messages: 0, mediaFiles: 4, calls: 9, drafts: 1 } });
  assert.equal(snap.retention.mediaDays, 30);
  assert.deepEqual(snap.mediaQueue, { running: 1, queued: 2, max: 10 });
  assert.equal(snap.eventStreams, 3);
  assert.deepEqual(snap.whisperModel, { name: 'ggml-x.bin', present: false });
  assert.equal(snap.stateDirMode, '700');
});

test('detecta quem supervisiona o processo pelo ambiente', () => {
  assert.equal(detectService({ XPC_SERVICE_NAME: 'local.wa-bridge' }), 'launchd (local.wa-bridge)');
  assert.equal(detectService({ XPC_SERVICE_NAME: 'local.wa-bridge.7789' }), 'launchd (local.wa-bridge.7789)');
  assert.equal(detectService({ INVOCATION_ID: 'abc' }), 'systemd');
});
