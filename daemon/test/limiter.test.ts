/**
 * Limite de concorrência do processamento de mídia: nunca passa do teto, atende em
 * ordem de chegada e libera a vaga mesmo quando a tarefa falha.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ConcurrencyLimiter } from '../src/media/limiter.js';

/** Promise que o teste resolve na mão. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test('nunca roda mais que o teto ao mesmo tempo', async () => {
  const limiter = new ConcurrencyLimiter(3);
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 10 }, () =>
    limiter.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    }),
  );
  await Promise.all(tasks);
  assert.equal(peak, 3);
  assert.equal(limiter.running, 0);
  assert.equal(limiter.queued, 0);
});

test('fila é atendida na ordem de chegada', async () => {
  const limiter = new ConcurrencyLimiter(1);
  const gate = deferred();
  const order: number[] = [];
  const first = limiter.run(async () => {
    await gate.promise;
    order.push(0);
  });
  const rest = [1, 2, 3].map((n) => limiter.run(async () => void order.push(n)));
  assert.equal(limiter.queued, 3);
  gate.resolve();
  await Promise.all([first, ...rest]);
  assert.deepEqual(order, [0, 1, 2, 3]);
});

test('tarefa que falha libera a vaga e propaga o erro', async () => {
  const limiter = new ConcurrencyLimiter(1);
  await assert.rejects(limiter.run(async () => Promise.reject(new Error('boom'))), /boom/);
  assert.equal(await limiter.run(async () => 'ok'), 'ok');
  assert.equal(limiter.running, 0);
});

test('teto inválido falha na criação', () => {
  assert.throws(() => new ConcurrencyLimiter(0));
  assert.throws(() => new ConcurrencyLimiter(1.5));
});
