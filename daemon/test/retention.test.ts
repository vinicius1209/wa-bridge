/**
 * Retenção: apaga mensagens velhas e os arquivos delas, poda arquivos de mídia mantendo
 * a transcrição, limpa métricas e rascunhos vencidos, e nunca toca na auditoria.
 */
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pino from 'pino';
import type { Config } from '../src/config.js';
import { runRetention } from '../src/store/retention.js';
import { Store } from '../src/store/store.js';
import type { MediaArtifact, StoredMessage } from '../src/types.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const CHAT = '5551999998888@s.whatsapp.net';

let dir: string;
let mediaDir: string;
let store: Store;
const log = pino({ level: 'silent' });

/** Mensagem de áudio recebida em `ts`. */
function msg(id: string, ts: number): StoredMessage {
  return {
    id, chatJid: CHAT, senderJid: CHAT, senderName: 'Ana', fromMe: false, ts, type: 'audio',
    text: '[Áudio enviado]', caption: null, viewOnce: false, quotedText: null,
    hasMedia: true, mediaState: 'pending',
  };
}

/** Cria no disco o arquivo, a transcrição e os keyframes de uma mídia, e grava o artefato. */
function materialized(id: string, transcript: string): MediaArtifact {
  const chatDir = join(mediaDir, 'chat');
  mkdirSync(join(chatDir, `${id}.frames`), { recursive: true });
  const path = join(chatDir, `${id}.ogg`);
  writeFileSync(path, 'audio');
  writeFileSync(join(chatDir, `${id}.transcript.txt`), transcript);
  writeFileSync(join(chatDir, `${id}.frames`, 'frame-001.jpg'), 'jpg');
  return {
    messageId: id, kind: 'audio', mime: 'audio/ogg', path, bytes: 5, durationMs: 1000,
    transcript, framePaths: [join(chatDir, `${id}.frames`, 'frame-001.jpg')], viewOnce: false, error: null,
  };
}

/** Config mínima com as janelas de retenção do teste. */
function config(retention: Config['retention']): Config {
  return { mediaDir, retention } as Config;
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-bridge-retention-'));
  mediaDir = join(dir, 'media');
  store = new Store(join(dir, 'wa.db'));
  store.migrate();
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('janelas em 0 não apagam nada', async () => {
  store.upsertMessage(msg('antiga-0', NOW - 1000 * DAY), '{}');
  const result = await runRetention({ store, log, config: config({ messagesDays: 0, mediaDays: 0, metricsDays: 0 }) }, NOW);
  assert.deepEqual(result, { messages: 0, mediaFiles: 0, calls: 0, drafts: 0 });
  assert.ok(store.getMessage('antiga-0'));
  store.deleteMessagesBefore(Number.MAX_SAFE_INTEGER);
});

test('arquivo de mídia velho sai do disco, a transcrição fica e continua buscável', async () => {
  store.upsertMessage(msg('a1', NOW - 40 * DAY), '{}');
  const artifact = materialized('a1', 'combinado o treino de quinta');
  store.saveMedia(artifact);
  // `processed_at` é gravado como agora; a retenção roda "no futuro" para enxergá-lo velho.
  const future = Date.now() + 31 * DAY;

  const result = await runRetention({ store, log, config: config({ messagesDays: 0, mediaDays: 30, metricsDays: 0 }) }, future);
  assert.equal(result.mediaFiles, 1);
  assert.equal(existsSync(artifact.path), false);
  assert.equal(existsSync(join(mediaDir, 'chat', 'a1.transcript.txt')), false);
  assert.equal(existsSync(join(mediaDir, 'chat', 'a1.frames')), false);

  const pruned = store.getMedia('a1');
  assert.equal(pruned?.path, '');
  assert.equal(pruned?.error, 'PRUNED');
  assert.equal(pruned?.transcript, 'combinado o treino de quinta');
  assert.equal(store.getMessage('a1')?.mediaState, 'pending', 'wa_media ainda pode baixar de novo');
  assert.equal(store.searchMessages({ query: 'treino quinta', limit: 5 })[0]?.message.id, 'a1');

  const again = await runRetention({ store, log, config: config({ messagesDays: 0, mediaDays: 30, metricsDays: 0 }) }, future);
  assert.equal(again.mediaFiles, 0, 'mídia já podada não volta para a fila');
});

test('mensagem mais velha que a janela sai do banco junto com a mídia e os arquivos', async () => {
  store.upsertMessage(msg('velha', NOW - 400 * DAY), '{}');
  store.upsertMessage(msg('nova', NOW - 10 * DAY), '{}');
  const artifact = materialized('velha', 'texto antigo');
  store.saveMedia(artifact);

  const result = await runRetention({ store, log, config: config({ messagesDays: 365, mediaDays: 0, metricsDays: 0 }) }, NOW);
  assert.ok(result.messages >= 1);
  assert.equal(store.getMessage('velha'), null);
  assert.equal(store.getMedia('velha'), null);
  assert.equal(existsSync(artifact.path), false);
  assert.ok(store.getMessage('nova'));
});

test('métricas e rascunhos vencidos saem; auditoria nunca', async () => {
  const old = NOW - 60 * DAY;
  store.insertCall({ ts: old, traceId: 't', agent: 'a', tool: '/chats', durationMs: 1, status: 'ok', error: null });
  store.insertCall({ ts: NOW, traceId: 't', agent: 'a', tool: '/chats', durationMs: 1, status: 'ok', error: null });
  store.insertDraft({
    confirmToken: 'tok-velho', chatJid: CHAT, payloadJson: '{"text":"oi"}', agent: 'a', traceId: 't',
    createdAt: old, expiresAt: old + 300_000, status: 'expired',
  });
  store.insertAudit({ ts: old, traceId: 't', agent: 'a', action: 'send.confirmed', chatJid: CHAT, outcome: 'ok', detail: {} });

  const result = await runRetention({ store, log, config: config({ messagesDays: 0, mediaDays: 0, metricsDays: 30 }) }, NOW);
  assert.equal(result.calls, 1);
  assert.equal(result.drafts, 1);
  assert.equal(store.getDraft('tok-velho'), null);
  assert.equal(store.callsSince(0).length, 1);
  assert.equal(store.auditSince(0).length, 1);
});

test('nunca apaga arquivo fora da pasta de mídia', async () => {
  const outside = join(dir, 'fora.ogg');
  writeFileSync(outside, 'x');
  store.upsertMessage(msg('fora', NOW - 400 * DAY), '{}');
  store.saveMedia({
    messageId: 'fora', kind: 'audio', mime: 'audio/ogg', path: outside, bytes: 1, durationMs: null,
    transcript: null, framePaths: [], viewOnce: false, error: null,
  });
  await runRetention({ store, log, config: config({ messagesDays: 365, mediaDays: 0, metricsDays: 0 }) }, NOW);
  assert.equal(existsSync(outside), true);
});
