import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStalenessWatcher } from '../../src/daemon/staleness-watch.ts';
import type { WatchFn, WatchHandle } from '../../src/daemon/staleness-watch.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

const STALENESS_WATCH_TS_URL = pathToFileURL(
  fileURLToPath(new URL('../../src/daemon/staleness-watch.ts', import.meta.url)),
).href;

// ---------------------------------------------------------------------------
// Test-only fake WatchHandle/WatchFn -- built on a real `node:events.EventEmitter`,
// mirroring `active-polls.test.ts`'s `FakeProbeChild` / `self-dispatch.test.ts`'s
// `FakeChild` precedent for this codebase's own "narrow hand-rolled interface
// satisfied by an EventEmitter subclass" test-double convention. `on('error', ...)`
// is real EventEmitter registration; a test fires it with `.emit('error', err)`.
// ---------------------------------------------------------------------------

class FakeWatchHandle extends EventEmitter implements WatchHandle {
  closeCallCount = 0;

  close(): void {
    this.closeCallCount++;
  }
}

/**
 * Records every `watchFn(dir, listener)` call by directory (so tests can
 * assert call counts / identity) and every listener a real `watchDirectory`
 * call registered (so `fireWatchEvent` can simulate a real fs change without
 * this test file knowing anything about staleness-watch.ts's internals).
 */
function createFakeWatchFn(): {
  watchFn: WatchFn;
  callCountFor: (dir: string) => number;
  latestHandleFor: (dir: string) => FakeWatchHandle;
  fireWatchEvent: (dir: string) => void;
} {
  const handlesByDir = new Map<string, FakeWatchHandle[]>();
  const listenersByHandle = new Map<FakeWatchHandle, (eventType: string, filename: string | null) => void>();

  const watchFn: WatchFn = (dir, listener) => {
    const handle = new FakeWatchHandle();
    const existing = handlesByDir.get(dir) ?? [];
    existing.push(handle);
    handlesByDir.set(dir, existing);
    listenersByHandle.set(handle, listener);
    return handle;
  };

  function callCountFor(dir: string): number {
    return handlesByDir.get(dir)?.length ?? 0;
  }

  function latestHandleFor(dir: string): FakeWatchHandle {
    const list = handlesByDir.get(dir);
    const handle = list?.[list.length - 1];
    assert.ok(handle, `no handle recorded for ${dir}`);
    return handle;
  }

  function fireWatchEvent(dir: string): void {
    const handle = latestHandleFor(dir);
    const listener = listenersByHandle.get(handle);
    assert.ok(listener, `no listener captured for ${dir}`);
    listener('change', 'file.txt');
  }

  return { watchFn, callCountFor, latestHandleFor, fireWatchEvent };
}

// ---------------------------------------------------------------------------
// Task 1: setWatchedDirectories diffing, health tracking, close() lifecycle.
// Zero real filesystem access, zero real timers -- every assertion here is
// synchronous. The debounce/reconcile machinery is stubbed as a no-op at
// this point in the plan's history; none of these tests wait for or assert
// an `onTrigger` call.
// ---------------------------------------------------------------------------

test('setWatchedDirectories calls the injected watchFn exactly once per directory', () => {
  const fake = createFakeWatchFn();
  const watcher = createStalenessWatcher({
    debounceMs: 10,
    reconcileIntervalMs: 100_000,
    onTrigger: () => {},
    watchFn: fake.watchFn,
  });
  watcher.setWatchedDirectories(['a', 'b']);
  assert.strictEqual(fake.callCountFor('a'), 1);
  assert.strictEqual(fake.callCountFor('b'), 1);
  watcher.close();
});

test('reconciling to a new set closes the dropped directory, opens the added one, and leaves the shared directory untouched', () => {
  const fake = createFakeWatchFn();
  const watcher = createStalenessWatcher({
    debounceMs: 10,
    reconcileIntervalMs: 100_000,
    onTrigger: () => {},
    watchFn: fake.watchFn,
  });
  watcher.setWatchedDirectories(['a', 'b']);
  const aHandle = fake.latestHandleFor('a');
  const bHandleBefore = fake.latestHandleFor('b');

  watcher.setWatchedDirectories(['b', 'c']);

  assert.strictEqual(aHandle.closeCallCount, 1, "'a' must be closed via its own handle's close()");
  assert.strictEqual(fake.callCountFor('c'), 1, "'c' must be opened exactly once");
  assert.strictEqual(fake.callCountFor('b'), 1, "'b' must never be reopened (its watchFn call count stays 1)");
  assert.strictEqual(bHandleBefore.closeCallCount, 0, "'b's handle must never be closed");
  watcher.close();
});

test('reconciling to an identical set is a total no-op -- no close() calls, no new watchFn calls', () => {
  const fake = createFakeWatchFn();
  const watcher = createStalenessWatcher({
    debounceMs: 10,
    reconcileIntervalMs: 100_000,
    onTrigger: () => {},
    watchFn: fake.watchFn,
  });
  watcher.setWatchedDirectories(['b', 'c']);
  watcher.setWatchedDirectories(['b', 'c']);

  assert.strictEqual(fake.callCountFor('b'), 1);
  assert.strictEqual(fake.callCountFor('c'), 1);
  assert.strictEqual(fake.latestHandleFor('b').closeCallCount, 0);
  assert.strictEqual(fake.latestHandleFor('c').closeCallCount, 0);
  watcher.close();
});

test('isHealthy() is true before any setWatchedDirectories call', () => {
  const watcher = createStalenessWatcher({
    debounceMs: 10,
    reconcileIntervalMs: 100_000,
    onTrigger: () => {},
  });
  assert.strictEqual(watcher.isHealthy(), true);
  watcher.close();
});

test("firing a watched handle's 'error' listener makes isHealthy() false from then on, surviving a later successful setWatchedDirectories call", () => {
  const fake = createFakeWatchFn();
  const watcher = createStalenessWatcher({
    debounceMs: 10,
    reconcileIntervalMs: 100_000,
    onTrigger: () => {},
    watchFn: fake.watchFn,
  });
  watcher.setWatchedDirectories(['a']);
  fake.latestHandleFor('a').emit('error', new Error('fake watch error'));

  assert.strictEqual(watcher.isHealthy(), false);

  watcher.setWatchedDirectories(['a', 'b']); // a later successful call must NOT clear it
  assert.strictEqual(watcher.isHealthy(), false);
  watcher.close();
});

test('forceUnhealthy() makes isHealthy() false immediately, with no directories watched and no error fired', () => {
  const watcher = createStalenessWatcher({
    debounceMs: 10,
    reconcileIntervalMs: 100_000,
    onTrigger: () => {},
  });
  watcher.forceUnhealthy();
  assert.strictEqual(watcher.isHealthy(), false);
  watcher.close();
});

test('close() calls close() on every currently-watched handle, and isHealthy() returns false afterward', () => {
  const fake = createFakeWatchFn();
  const watcher = createStalenessWatcher({
    debounceMs: 10,
    reconcileIntervalMs: 100_000,
    onTrigger: () => {},
    watchFn: fake.watchFn,
  });
  watcher.setWatchedDirectories(['a', 'b']);
  const aHandle = fake.latestHandleFor('a');
  const bHandle = fake.latestHandleFor('b');

  watcher.close();

  assert.strictEqual(aHandle.closeCallCount, 1);
  assert.strictEqual(bHandle.closeCallCount, 1);
  assert.strictEqual(watcher.isHealthy(), false);
});

test('calling close() a second time does not throw and does not call any handle close() a second time', () => {
  const fake = createFakeWatchFn();
  const watcher = createStalenessWatcher({
    debounceMs: 10,
    reconcileIntervalMs: 100_000,
    onTrigger: () => {},
    watchFn: fake.watchFn,
  });
  watcher.setWatchedDirectories(['a']);
  const aHandle = fake.latestHandleFor('a');

  watcher.close();
  assert.doesNotThrow(() => watcher.close());
  assert.strictEqual(aHandle.closeCallCount, 1);
});

// ---------------------------------------------------------------------------
// Task 2: debounced watch-triggered rescans and the independent reconcile
// interval. REAL (small-value) timers, mirroring `idle.test.ts`/`poll.test.ts`'s
// own established real-small-timer convention for this class of timing test
// -- never an injected fake clock. No test here waits longer than roughly
// one second total.
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

test('a single fake watch event calls onTrigger("watch") exactly once, after debounceMs has elapsed, not synchronously', async () => {
  const fake = createFakeWatchFn();
  const triggers: string[] = [];
  const watcher = createStalenessWatcher({
    debounceMs: 20,
    reconcileIntervalMs: 100_000,
    onTrigger: (reason) => triggers.push(reason),
    watchFn: fake.watchFn,
  });
  watcher.setWatchedDirectories(['a']);

  fake.fireWatchEvent('a');
  assert.deepStrictEqual(triggers, [], 'must not fire synchronously');

  await sleep(120); // generous: ~6x debounceMs
  assert.deepStrictEqual(triggers, ['watch']);
  watcher.close();
});

test('three fake watch events fired in rapid succession collapse into exactly one onTrigger("watch") call', async () => {
  const fake = createFakeWatchFn();
  const triggers: string[] = [];
  const watcher = createStalenessWatcher({
    debounceMs: 30,
    reconcileIntervalMs: 100_000,
    onTrigger: (reason) => triggers.push(reason),
    watchFn: fake.watchFn,
  });
  watcher.setWatchedDirectories(['a']);

  fake.fireWatchEvent('a');
  fake.fireWatchEvent('a');
  fake.fireWatchEvent('a');

  await sleep(150); // generous: ~5x debounceMs
  assert.deepStrictEqual(triggers, ['watch']);
  watcher.close();
});

test('a watch event, a pause past debounceMs, then a second watch event produce two separate onTrigger("watch") calls -- the debounce timer is re-armable indefinitely, not a one-shot', async () => {
  const fake = createFakeWatchFn();
  const triggers: string[] = [];
  const watcher = createStalenessWatcher({
    debounceMs: 20,
    reconcileIntervalMs: 100_000,
    onTrigger: (reason) => triggers.push(reason),
    watchFn: fake.watchFn,
  });
  watcher.setWatchedDirectories(['a']);

  fake.fireWatchEvent('a');
  await sleep(100); // well past debounceMs
  fake.fireWatchEvent('a');
  await sleep(100);

  assert.deepStrictEqual(triggers, ['watch', 'watch']);
  watcher.close();
});

test('onTrigger("reconcile") fires on its own roughly every reconcileIntervalMs, with NO watch event ever having fired -- the reconcile path is fully independent of the watch path', async () => {
  const triggers: string[] = [];
  const watcher = createStalenessWatcher({
    debounceMs: 100_000,
    reconcileIntervalMs: 15,
    onTrigger: (reason) => triggers.push(reason),
  });

  await sleep(200); // generous: ~13x reconcileIntervalMs
  assert.ok(triggers.length >= 2, `expected at least 2 reconcile triggers in 200ms at reconcileIntervalMs=15, got ${triggers.length}`);
  assert.ok(
    triggers.every((reason) => reason === 'reconcile'),
    `expected every trigger to be 'reconcile' with no watch event ever fired, got ${JSON.stringify(triggers)}`,
  );
  watcher.close();
});

test('close() called mid-debounce (after a watch event fired but before debounceMs has elapsed) prevents the pending onTrigger("watch") call from ever happening', async () => {
  const fake = createFakeWatchFn();
  const triggers: string[] = [];
  const watcher = createStalenessWatcher({
    debounceMs: 30,
    reconcileIntervalMs: 100_000,
    onTrigger: (reason) => triggers.push(reason),
    watchFn: fake.watchFn,
  });
  watcher.setWatchedDirectories(['a']);

  fake.fireWatchEvent('a');
  watcher.close(); // fired well before debounceMs elapses

  await sleep(100);
  assert.deepStrictEqual(triggers, []);
});

test('close() stops the reconcile interval -- no further onTrigger("reconcile") calls happen after close(), verified by waiting past what would have been the next reconcile tick', async () => {
  const triggers: string[] = [];
  const watcher = createStalenessWatcher({
    debounceMs: 100_000,
    reconcileIntervalMs: 15,
    onTrigger: (reason) => triggers.push(reason),
  });

  await sleep(60); // let at least one real tick land
  watcher.close();
  const countAtClose = triggers.length;
  assert.ok(countAtClose > 0, 'sanity: at least one reconcile tick must have landed before close()');

  await sleep(150); // well past several more would-be ticks
  assert.strictEqual(triggers.length, countAtClose, 'no reconcile trigger may fire after close()');
});

// ---------------------------------------------------------------------------
// Task 3: real fs.watch integration proof. No injected watchFn anywhere in
// this section -- these tests exercise the real default `node:fs.watch`
// wrapper wired in Task 1, against a real `mkdtemp`'d directory.
//
// The "watcher died for this directory" simulation uses
// `setWatchedDirectories([])` (the second option the plan itself names),
// not a narrower test-only accessor: this module's own public interface
// already has an exact tool for "stop watching this directory" -- reaching
// past it into a private handle would test an implementation detail this
// module deliberately does not expose. A literal external-process-kill of
// a live fs.watch handle cannot be proven at this module's own unit-test
// boundary; that black-box proof belongs to Plan 08-05, via the
// `forceUnhealthy()`-backed env-var escape hatch this plan's interface
// reserves for exactly that purpose.
// ---------------------------------------------------------------------------

test('a real file write into a real watched directory triggers a real, debounced onTrigger("watch") call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-staleness-watch-test-'));
  try {
    const triggers: string[] = [];
    const watcher = createStalenessWatcher({
      debounceMs: 50,
      reconcileIntervalMs: 100_000,
      onTrigger: (reason) => triggers.push(reason),
      // No watchFn override -- exercises the real default node:fs.watch wrapper.
    });
    watcher.setWatchedDirectories([dir]);

    await writeFile(join(dir, 'file.txt'), 'hello');

    // Generous real-world window: real fs.watch latency plus debounceMs.
    await sleep(1500);
    assert.ok(triggers.includes('watch'), `expected a 'watch' trigger, got ${JSON.stringify(triggers)}`);

    watcher.close();
  } finally {
    await forceRemove(dir);
  }
});

test('the reconcile interval keeps firing on real timers after setWatchedDirectories([]) leaves nothing watched -- a real write into the now-unwatched directory produces no "watch" trigger, but "reconcile" still fires on schedule', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-staleness-watch-test-'));
  try {
    const triggers: string[] = [];
    const watcher = createStalenessWatcher({
      debounceMs: 50,
      reconcileIntervalMs: 60,
      onTrigger: (reason) => triggers.push(reason),
    });
    watcher.setWatchedDirectories([dir]);
    // Simulates "the watcher died for this directory" without tearing down
    // the whole StalenessWatcher -- see this section's header comment.
    watcher.setWatchedDirectories([]);

    await writeFile(join(dir, 'file-after-unwatch.txt'), 'hello again');
    await sleep(400); // generous: past debounceMs and several reconcileIntervalMs ticks

    assert.ok(!triggers.includes('watch'), `expected no 'watch' trigger against an unwatched directory, got ${JSON.stringify(triggers)}`);
    const reconcileCount = triggers.filter((reason) => reason === 'reconcile').length;
    assert.ok(reconcileCount >= 2, `expected the independent reconcile timer to keep firing, got ${JSON.stringify(triggers)}`);

    watcher.close();
  } finally {
    await forceRemove(dir);
  }
});

// T-08-08 (threat register): both timers must be .unref()'d -- this is what
// lets a StalenessWatcher coexist with the daemon's own IdleController
// (idle.ts) without ever keeping the process alive on its own. Mirrors
// idle.test.ts's own subprocess-based unref proof exactly, including its
// documented reason for the pattern: if the timer were not unref'd, this
// subprocess (and thus this test) would hang until `timeout` kills it, so a
// regression fails fast here instead of hanging the whole suite. Run BEFORE
// close() is ever called, proving the timers themselves (not close()'s own
// teardown) are what makes the process exit on its own.
test("both the debounce and reconcile timers are unref'd -- a StalenessWatcher never keeps the process alive on its own, even before close() is called", () => {
  const script = [
    `import { createStalenessWatcher } from ${JSON.stringify(STALENESS_WATCH_TS_URL)};`,
    `createStalenessWatcher({ debounceMs: 50, reconcileIntervalMs: 50, onTrigger: () => {} });`,
    `console.log('exited-on-its-own');`,
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /exited-on-its-own/);
});
