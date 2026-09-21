import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDaemonRunning, shouldRestartForVersion } from '../../src/daemon/orchestrate.ts';
import { readLock, isPidAlive } from '../../src/daemon/lock.ts';
import { lockPathFor } from '../../src/daemon/state-dir.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

const HOST = '127.0.0.1';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illum-version-restart-'));
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

test('shouldRestartForVersion', () => {
  assert.strictEqual(shouldRestartForVersion('0.1.0', '0.1.0'), false);
  assert.strictEqual(shouldRestartForVersion('0.1.0', '0.2.0'), true);
});

test('a version mismatch shuts the old daemon down and spawns a fresh one', async () => {
  await withTempDir(async (dir) => {
    try {
      await ensureDaemonRunning(dir); // no version check -- real spawn, real version written
      const lockPath = lockPathFor(dir);
      const originalRecord = await readLock(lockPath);
      assert.ok(originalRecord);

      // Deliberately tamper with the on-disk record to simulate "a previous
      // install's daemon is still running" -- the daemon process itself is
      // real and alive; only the recorded version string is faked.
      const tampered = { ...originalRecord, version: '0.0.0-simulated-old' };
      await writeFile(lockPath, JSON.stringify(tampered, null, 2));

      const restarted = await ensureDaemonRunning(dir, { currentVersion: '9.9.9-simulated-new' });

      assert.strictEqual(isPidAlive(originalRecord.pid), false); // old process is actually gone
      assert.strictEqual(restarted.attached, false); // a fresh spawn, not an attach to a zombie

      const health = await fetch(`http://${HOST}:${restarted.port}/health`);
      assert.strictEqual(health.status, 200); // new daemon is real and healthy

      const newRecord = await readLock(lockPath);
      assert.ok(newRecord);
      assert.notStrictEqual(newRecord.pid, originalRecord.pid); // a genuinely different process
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('a matching version attaches without restarting', async () => {
  await withTempDir(async (dir) => {
    try {
      const first = await ensureDaemonRunning(dir);
      const record = await readLock(lockPathFor(dir));
      assert.ok(record);

      const second = await ensureDaemonRunning(dir, { currentVersion: record.version });
      assert.strictEqual(second.attached, true);
      assert.strictEqual(second.port, first.port);

      const unchangedRecord = await readLock(lockPathFor(dir));
      assert.ok(unchangedRecord);
      assert.strictEqual(unchangedRecord.pid, record.pid); // same process, never touched
    } finally {
      await stopDaemon(dir);
    }
  });
});
