/**
 * A versão tem fonte única: o `version` do package.json da raiz. O daemon lê de lá, e
 * os package.json dos workspaces não podem ter o campo (seria a segunda fonte).
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { VERSION } from '../src/version.js';

/** Lê um package.json relativo à raiz do repo. */
function pkg(relative: string): { version?: unknown } {
  return JSON.parse(readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')) as { version?: unknown };
}

test('o daemon lê a versão do package.json da raiz', () => {
  const root = pkg('package.json');
  assert.equal(typeof root.version, 'string');
  assert.equal(VERSION, root.version);
});

test('os workspaces não guardam versão própria', () => {
  assert.equal(pkg('daemon/package.json').version, undefined);
  assert.equal(pkg('mcp/package.json').version, undefined);
});
