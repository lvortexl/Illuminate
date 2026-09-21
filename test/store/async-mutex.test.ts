import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncMutex } from '../../src/store/async-mutex.ts';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('runExclusive serializes two overlapping calls strictly in order', async () => {
  const mutex = new AsyncMutex();
  const order: string[] = [];
  const gate = deferred<void>();

  // Fired back-to-back with no await in between -- both calls start in the
  // same synchronous tick. A's function does not resolve until we release
  // `gate`, so if the mutex fails to serialize, B's function would start
  // before A finishes.
  const a = mutex.runExclusive(async () => {
    order.push('A-start');
    await gate.promise;
    order.push('A-end');
  });
  const b = mutex.runExclusive(async () => {
    order.push('B-start');
    order.push('B-end');
  });

  // Give the event loop a tick to prove B has NOT started yet.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepStrictEqual(order, ['A-start']);

  gate.resolve();
  await a;
  await b;

  assert.deepStrictEqual(order, ['A-start', 'A-end', 'B-start', 'B-end']);
});

test('a rejecting task does not wedge the mutex -- rejection is scoped to its own caller', async () => {
  const mutex = new AsyncMutex();
  const boom = new Error('boom');

  await assert.rejects(
    mutex.runExclusive(async () => {
      throw boom;
    }),
    boom,
  );

  // A subsequent call still runs and resolves normally.
  const result = await mutex.runExclusive(async () => 'still works');
  assert.strictEqual(result, 'still works');
});

test('runExclusive resolves to exactly the return value of the given function', async () => {
  const mutex = new AsyncMutex();
  const result = await mutex.runExclusive(() => 42);
  assert.strictEqual(result, 42);

  const asyncResult = await mutex.runExclusive(async () => ({ ok: true }));
  assert.deepStrictEqual(asyncResult, { ok: true });
});

test('25 concurrent runExclusive calls each execute exactly once, in some serial order', async () => {
  const mutex = new AsyncMutex();
  let active = 0;
  let maxActive = 0;
  const executed: number[] = [];

  const calls = Array.from({ length: 25 }, (_, i) =>
    mutex.runExclusive(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      // Yield to let any wrongly-concurrent call interleave.
      await new Promise((r) => setTimeout(r, 0));
      executed.push(i);
      active -= 1;
    }),
  );

  await Promise.all(calls);

  assert.strictEqual(maxActive, 1, 'no two calls ran concurrently');
  assert.strictEqual(executed.length, 25);
  assert.deepStrictEqual(
    [...executed].sort((x, y) => x - y),
    Array.from({ length: 25 }, (_, i) => i),
    'every call executed exactly once, none skipped or duplicated',
  );
});
