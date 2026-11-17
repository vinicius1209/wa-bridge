/**
 * Variáveis novas da config (histórico, concorrência de mídia, retenção, nome do aparelho) e o chmod 700
 * da pasta de estado.
 */
import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { loadConfig, restrictStateDirs } from '../src/config.js';

const VARS = [
  'WA_BRIDGE_HOME',
  'WA_BRIDGE_TOKEN',
  'WA_HISTORY_DAYS',
  'WA_MEDIA_CONCURRENCY',
  'WA_RETENTION_MESSAGES_DAYS',
  'WA_RETENTION_MEDIA_DAYS',
  'WA_RETENTION_METRICS_DAYS',
  'WA_DEVICE_NAME',
  'WA_SENDS_PER_DAY',
  'WA_NEW_CONTACTS_PER_DAY',
  'WA_CHAT_MIN_INTERVAL_SECONDS',
] as const;
const saved = new Map<string, string | undefined>();
let dir: string;

before(() => {
  for (const v of VARS) saved.set(v, process.env[v]);
  dir = mkdtempSync(join(tmpdir(), 'wa-bridge-config-'));
});

afterEach(() => {
  for (const v of VARS) {
    const value = saved.get(v);
    if (value === undefined) delete process.env[v];
    else process.env[v] = value;
  }
});

after(() => rmSync(dir, { recursive: true, force: true }));

/** Aponta a config para uma pasta de estado descartável. */
function useHome(name: string): string {
  const home = join(dir, name);
  process.env.WA_BRIDGE_HOME = home;
  process.env.WA_BRIDGE_TOKEN = 'token-de-teste';
  for (const v of VARS.slice(2)) delete process.env[v];
  return home;
}

test('defaults: 7 dias de histórico, 10 mídias em paralelo, retenção 0/30/30', () => {
  useHome('defaults');
  const config = loadConfig();
  assert.equal(config.historyDays, 7);
  assert.equal(config.mediaConcurrency, 10);
  assert.deepEqual(config.retention, { messagesDays: 0, mediaDays: 30, metricsDays: 30 }, 'apagar mensagens vem desligado');
});

test('variáveis válidas são respeitadas, e 0 desliga histórico e retenção', () => {
  useHome('custom');
  process.env.WA_HISTORY_DAYS = '0';
  process.env.WA_MEDIA_CONCURRENCY = '4';
  process.env.WA_RETENTION_MESSAGES_DAYS = '365';
  process.env.WA_RETENTION_MEDIA_DAYS = '0';
  const config = loadConfig();
  assert.equal(config.historyDays, 0);
  assert.equal(config.mediaConcurrency, 4);
  assert.equal(config.retention.messagesDays, 365);
  assert.equal(config.retention.mediaDays, 0);
});

test('valor inválido falha o boot em vez de virar NaN', () => {
  useHome('invalid');
  process.env.WA_HISTORY_DAYS = 'sete';
  assert.throws(() => loadConfig(), /WA_HISTORY_DAYS inválido/);
  process.env.WA_HISTORY_DAYS = '7';
  process.env.WA_MEDIA_CONCURRENCY = '0';
  assert.throws(() => loadConfig(), /WA_MEDIA_CONCURRENCY inválido/);
});

test('nome do aparelho: wa-bridge por padrão, aparado, e longo demais falha o boot', () => {
  useHome('device');
  assert.equal(loadConfig().deviceName, 'wa-bridge');
  process.env.WA_DEVICE_NAME = '   ';
  assert.equal(loadConfig().deviceName, 'wa-bridge', 'vazio cai no padrão');
  process.env.WA_DEVICE_NAME = '  wa-bridge (Mac)  ';
  assert.equal(loadConfig().deviceName, 'wa-bridge (Mac)');
  process.env.WA_DEVICE_NAME = 'x'.repeat(41);
  assert.throws(() => loadConfig(), /WA_DEVICE_NAME inválido/);
});

test('limites de envio: 40 por dia, 3 conversas novas, 30s por conversa; 0 desliga conversa nova e intervalo', () => {
  useHome('limites');
  let config = loadConfig();
  assert.equal(config.sendsPerDay, 40);
  assert.equal(config.newContactsPerDay, 3);
  assert.equal(config.chatMinIntervalMs, 30_000);
  process.env.WA_NEW_CONTACTS_PER_DAY = '0';
  process.env.WA_CHAT_MIN_INTERVAL_SECONDS = '0';
  config = loadConfig();
  assert.equal(config.newContactsPerDay, 0);
  assert.equal(config.chatMinIntervalMs, 0);
  process.env.WA_SENDS_PER_DAY = '0';
  assert.throws(() => loadConfig(), /WA_SENDS_PER_DAY inválido/);
});

test('restrictStateDirs corrige pasta que já existia com 755', () => {
  const home = useHome('perms');
  mkdirSync(join(home, 'auth'), { recursive: true });
  chmodSync(home, 0o755);
  chmodSync(join(home, 'auth'), 0o755);
  const warnings = restrictStateDirs({ home, authDir: join(home, 'auth') });
  assert.deepEqual(warnings, []);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'auth')).mode & 0o777, 0o700);
});

test('restrictStateDirs devolve aviso em vez de lançar quando o chmod falha', () => {
  const warnings = restrictStateDirs({ home: join(dir, 'nao-existe'), authDir: join(dir, 'nao-existe', 'auth') });
  assert.equal(warnings.length, 2);
});
