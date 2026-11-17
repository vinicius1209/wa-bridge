/**
 * Variáveis novas da config (histórico, concorrência de mídia, retenção) e o chmod 700
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
