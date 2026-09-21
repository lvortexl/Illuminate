import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
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
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-multiproject-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

/**
 * Reuses `illuminate stop`'s own logic directly (the token-checked
 * POST /shutdown with a SIGTERM fallback that cli.ts's `stop()` performs)
 * rather than shelling out to the built CLI -- mirrors the identical
 * helper already established in orchestrate.test.ts and
 * version-restart.test.ts, since that logic is not exposed as an
 * independently importable function from src/cli.ts.
 */
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

test('two concurrent projects get independent lockfiles, ports, and stop independently', async () => {
  await withTempDir(async (dirA) => {
    await withTempDir(async (dirB) => {
      try {
        const a = await ensureDaemonRunning(dirA);
        const b = await ensureDaemonRunning(dirB);

        assert.notStrictEqual(a.port, b.port, 'two distinct artifact roots must never share one port');
        assert.notStrictEqual(
          lockPathFor(dirA),
          lockPathFor(dirB),
          'two distinct artifact roots must never share one lockfile path',
        );

        const recordA = await readLock(lockPathFor(dirA));
        const recordB = await readLock(lockPathFor(dirB));
        assert.ok(recordA);
        assert.ok(recordB);
        assert.notStrictEqual(recordA.pid, recordB.pid, 'two distinct artifact roots must run two distinct processes');

        // Both healthy independently before either is touched.
        const healthA = await fetch(`http://${HOST}:${a.port}/health`);
        const healthB = await fetch(`http://${HOST}:${b.port}/health`);
        assert.strictEqual(healthA.status, 200);
        assert.strictEqual(healthB.status, 200);

        await stopDaemon(dirA);

        // A's process and lockfile must actually be gone.
        assert.strictEqual(isPidAlive(recordA.pid), false, "stopping A must not leave A's process alive");
        const afterA = await readLock(lockPathFor(dirA));
        assert.strictEqual(afterA, null, "stopping A must clean up A's lockfile");

        // B's daemon must still be healthy -- no cross-talk.
        const bHealth = await fetch(`http://${HOST}:${b.port}/health`);
        assert.strictEqual(bHealth.status, 200, "stopping A's daemon must never affect B's");
        assert.strictEqual(isPidAlive(recordB.pid), true, "B's process must still be alive after A is stopped");
      } finally {
        await stopDaemon(dirA);
        await stopDaemon(dirB);
      }
    });
  });
});
