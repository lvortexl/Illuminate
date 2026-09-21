import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-taskkill-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

/**
 * Mirrors orchestrate.test.ts's own cleanup helper -- token-checked
 * /shutdown, SIGTERM fallback. Used in `finally` blocks so no test can leak
 * a live daemon process into the rest of the suite.
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

/**
 * Forces a hard kill with NO signal handling whatsoever -- the exact
 * failure mode `registerCleanupHandlers` (lock.ts) cannot intercept, and
 * the whole point of this test file (RESEARCH.md's "Testing a Daemon
 * Lifecycle" pattern, Success Criterion 1 / LIFE-01 / LIFE-03).
 *
 * win32: `taskkill /PID <pid> /F` -- an unconditional forced termination,
 * bypassing any handler exactly like an unresponsive-app kill from Task
 * Manager would. POSIX: `SIGKILL`, which cannot be caught or ignored either.
 * Both branches exercise the identical claim ("survives an unhandled
 * kill"), sharing this one test file/name across the CI matrix's two legs
 * per RESEARCH.md's explicit guidance.
 */
function forceKill(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/F']);
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

test('reclaims port after taskkill /F kills the daemon with no signal handling', async () => {
  await withTempDir(async (dir) => {
    try {
      const { port } = await ensureDaemonRunning(dir);

      // Read the pid back from the lockfile rather than assuming it equals
      // any value captured earlier -- ensureDaemonRunning's own return
      // type doesn't expose a pid.
      const lockPath = lockPathFor(dir);
      const firstRecord = await readLock(lockPath);
      assert.ok(firstRecord, 'a lockfile must exist after a fresh spawn');
      const pid = firstRecord.pid;
      assert.strictEqual(isPidAlive(pid), true, 'daemon must genuinely be alive before the forced kill');

      forceKill(pid);

      // Bounded poll for the kill to actually take effect -- never a fixed
      // sleep and a hope, matching orchestrate.ts's own polling pattern.
      const killDeadline = Date.now() + 5000;
      while (Date.now() < killDeadline && isPidAlive(pid)) {
        await sleep(50);
      }
      assert.strictEqual(isPidAlive(pid), false, 'forceKill must have actually terminated the daemon process');

      // No signal handler ran -- the stale lockfile from the killed daemon
      // is still on disk, exactly like a real taskkill'd/crashed session.
      const staleRecord = await readLock(lockPath);
      assert.ok(staleRecord, 'a hard kill must leave the lockfile behind -- no handler ran to clean it up');

      const { port: secondPort, attached } = await ensureDaemonRunning(dir);
      assert.strictEqual(secondPort, port, 'must reclaim the *same* port, not a random fallback');
      assert.strictEqual(attached, false, 'this must be a fresh spawn, not an attach to a zombie');

      // Confirm the reclaimed daemon is genuinely healthy, not just that
      // ensureDaemonRunning returned without throwing.
      const health = await fetch(`http://${HOST}:${secondPort}/health`);
      assert.strictEqual(health.status, 200);
    } finally {
      await stopDaemon(dir);
    }
  });
});
