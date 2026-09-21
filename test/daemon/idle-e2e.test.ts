import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDaemonRunning } from '../../src/daemon/orchestrate.ts';
import { readLock, isPidAlive } from '../../src/daemon/lock.ts';
import { lockPathFor } from '../../src/daemon/state-dir.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

const HOST = '127.0.0.1';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-idle-e2e-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

/** Mirrors the shared cleanup helper used across this suite's other integration files. */
async function stopDaemon(artifactRoot: string): Promise<void> {
  const record = await readLock(lockPathFor(artifactRoot));
  if (!record) return;
  try {
    await fetch(`http://${HOST}:${record.port}/shutdown?token=${record.healthToken}`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // fall through to a direct signal below
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isPidAlive(record.pid)) {
    await sleep(25);
  }
  if (isPidAlive(record.pid)) {
    try {
      process.kill(record.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

test('a real daemon spawned with a short ILLUMINATE_IDLE_TIMEOUT_MS scoped via env self-stops once genuinely idle', async () => {
  await withTempDir(async (dir) => {
    try {
      // Threaded via ensureDaemonRunning's opts.env -> spawnDaemon's own
      // SpawnDaemonOptions.env (Plan 01-08's forcing function) -- scoped to
      // this one spawned child only, never mutating the shared test
      // process's own process.env (unsafe under node --test's concurrent
      // execution within a file, unlike orchestrate.test.ts's older
      // same-process-env-mutation idle test, which this end-to-end test
      // deliberately does not repeat).
      const { port } = await ensureDaemonRunning(dir, { env: { ILLUMINATE_IDLE_TIMEOUT_MS: '150' } });
      const record = await readLock(lockPathFor(dir));
      assert.ok(record);

      // Prove it's genuinely up first.
      const health = await fetch(`http://${HOST}:${port}/health`);
      assert.strictEqual(health.status, 200);

      // Bounded poll, never a fixed sleep and a hope.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && isPidAlive(record.pid)) {
        await sleep(50);
      }
      assert.strictEqual(
        isPidAlive(record.pid),
        false,
        'daemon must self-stop once genuinely idle past the configured timeout',
      );

      const afterLock = await readLock(lockPathFor(dir));
      assert.strictEqual(afterLock, null, 'idle self-stop must clean up the lockfile');
    } finally {
      await stopDaemon(dir); // no-op if already stopped
    }
  });
});

test('a request landing just before the idle deadline keeps the daemon alive past the original deadline', async () => {
  await withTempDir(async (dir) => {
    try {
      const idleMs = 300;
      const { port } = await ensureDaemonRunning(dir, { env: { ILLUMINATE_IDLE_TIMEOUT_MS: String(idleMs) } });
      const record = await readLock(lockPathFor(dir));
      assert.ok(record);
      const spawnedAt = Date.now();

      // Timed to land well before the original idleMs window elapses --
      // mirrors idle.test.ts's own IdleController race test, but end-to-end
      // through a real HTTP request (which brackets IdleController's
      // enter()/exit() via server.ts's 'request'/'close' handlers) instead
      // of a direct enter()/exit() call.
      await sleep(Math.floor(idleMs * 0.5));
      const midHealth = await fetch(`http://${HOST}:${port}/health`);
      assert.strictEqual(midHealth.status, 200, 'the mid-window request itself must succeed');

      // Just past the ORIGINAL deadline (spawnedAt + idleMs): the request
      // above must have re-armed a fresh idleMs window measured from its
      // own completion, so the daemon must still be alive here.
      const originalDeadline = spawnedAt + idleMs;
      const bufferMs = 80;
      if (Date.now() < originalDeadline + bufferMs) {
        await sleep(originalDeadline + bufferMs - Date.now());
      }
      assert.strictEqual(
        isPidAlive(record.pid),
        true,
        'a request that landed before the original deadline must have pushed the idle window out, keeping the daemon alive past it',
      );

      // It must still eventually self-stop once genuinely idle again.
      const finalDeadline = Date.now() + 5000;
      while (Date.now() < finalDeadline && isPidAlive(record.pid)) {
        await sleep(50);
      }
      assert.strictEqual(isPidAlive(record.pid), false, 'the daemon must still self-stop once truly idle again');
    } finally {
      await stopDaemon(dir);
    }
  });
});

function extractSessionData(html: string): { chrome_load_token: string } {
  const match = html.match(/<script id="illuminate-session-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!match || match[1] === undefined) throw new Error('session-data script tag not found in chrome shell HTML');
  return JSON.parse(match[1]) as { chrome_load_token: string };
}

/**
 * Plan 08-04's own end-to-end proof, requested directly by this plan's
 * brief: `IdleController` counts open CONNECTIONS, not request recency
 * (this file's own header doc comment), and Plan 08-03 already proved a
 * `StalenessWatcher`'s debounce/reconcile timers are `.unref()`'d at the
 * module boundary via a bare `spawnSync` subprocess. This plan is the one
 * that wires a REAL watcher into the live daemon for the first time
 * (server.ts's `handleBeginArtifactLoad` -> `staleness-registry.ts` ->
 * `createStalenessWatcher`) -- exactly where that unref'd-ness could be
 * silently lost (e.g. by an accidental extra reference kept alive by the
 * registry, or a debounce timer re-armed without `.unref()` somewhere along
 * that new wiring). A plain `GET /health` alone never starts a watcher; this
 * test performs a REAL session-open + begin handshake first (which DOES
 * start one, with a genuine watched directory so a real `fs.watch` handle
 * is held open, not just the reconcile-interval timer), then proves the
 * daemon still self-stops once idle, with no further requests ever made.
 */
test('a real daemon spawned with a genuinely active staleness watcher (real fs.watch handle + reconcile timer) for an open session still self-stops once idle -- the watcher never keeps the process alive on its own', async () => {
  await withTempDir(async (dir) => {
    try {
      await mkdir(join(dir, 'sub'), { recursive: true });
      const file = join(dir, 'artifact.html');
      await writeFile(
        file,
        '<!doctype html><html><body><div data-src="sub/whatever.ts#L1-L2" data-anchor-hash="deadbeef">rendered</div></body></html>',
        'utf8',
      );

      const { port } = await ensureDaemonRunning(dir, { env: { ILLUMINATE_IDLE_TIMEOUT_MS: '150' } });
      const record = await readLock(lockPathFor(dir));
      assert.ok(record);

      // Real session-open + begin handshake -- the ONLY thing that starts a
      // session's staleness watcher (server.ts's handleBeginArtifactLoad).
      const created = await fetch(`http://${HOST}:${port}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file }),
      });
      assert.strictEqual(created.status, 200);
      const { key } = (await created.json()) as { key: string };

      const opened = await fetch(`http://${HOST}:${port}/session/${key}`);
      const { chrome_load_token: chromeLoadToken } = extractSessionData(await opened.text());
      const begun = await fetch(`http://${HOST}:${port}/api/${key}/artifact-loads/begin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chromeLoadToken }),
      });
      assert.strictEqual(begun.status, 200);

      // Every one of the three requests above has already completed and
      // closed -- IdleController's own activeCount is back to zero the
      // instant each response finished, exactly as the first test in this
      // file proves for a bare /health call. From here, NO further request
      // is ever made -- if the watcher's own timers (or anything the
      // registry newly holds a reference to) kept the event loop alive
      // independently of IdleController, the daemon would never exit and
      // this bounded poll would time out.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && isPidAlive(record.pid)) {
        await sleep(50);
      }
      assert.strictEqual(
        isPidAlive(record.pid),
        false,
        'a real, actively-watching StalenessWatcher must never defeat idle self-stop',
      );

      const afterLock = await readLock(lockPathFor(dir));
      assert.strictEqual(afterLock, null, 'idle self-stop must clean up the lockfile even with a watcher having run');
    } finally {
      await stopDaemon(dir);
    }
  });
});
