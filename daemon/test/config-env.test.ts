/**
 * chmod 700 da pasta de estado: corrige pasta que já existia com 755 e nunca derruba o
 * boot quando o chmod é recusado.
 */
import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { restrictStateDirs } from '../src/config.js';

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-bridge-config-'));
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('restrictStateDirs corrige pasta que já existia com 755', () => {
  const home = join(dir, 'perms');
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
