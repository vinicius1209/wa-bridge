/**
 * O shim manda o nome da tool em `X-WA-Tool` só quando a chamada nasce dentro de uma
 * tool, e chamadas simultâneas de tools diferentes não misturam os nomes.
 */
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { currentTool, requestDaemon } from '../src/client.js';

const realFetch = globalThis.fetch;
const seen: Array<Record<string, string>> = [];

before(() => {
  process.env.WA_BRIDGE_TOKEN = 'token-de-teste';
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen.push({ ...(init?.headers as Record<string, string>) });
    await new Promise((r) => setTimeout(r, 5));
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.WA_BRIDGE_TOKEN;
});

test('dentro de uma tool manda X-WA-Tool; fora, não', async () => {
  seen.length = 0;
  await currentTool.run('wa_search', () => requestDaemon({ method: 'GET', path: '/search' }));
  await requestDaemon({ method: 'GET', path: '/health' });
  assert.equal(seen[0]?.['X-WA-Tool'], 'wa_search');
  assert.equal(seen[1]?.['X-WA-Tool'], undefined);
});

test('tools simultâneas não misturam o nome', async () => {
  seen.length = 0;
  await Promise.all([
    currentTool.run('wa_list_chats', () => requestDaemon({ method: 'GET', path: '/chats' })),
    currentTool.run('wa_read_messages', () => requestDaemon({ method: 'GET', path: '/messages' })),
  ]);
  assert.deepEqual(seen.map((h) => h['X-WA-Tool']).sort(), ['wa_list_chats', 'wa_read_messages']);
});
