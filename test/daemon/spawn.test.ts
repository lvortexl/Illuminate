import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnDaemon } from '../../src/daemon/spawn.ts';
import { isPidAlive } from '../../src/daemon/lock.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

const LONG_RUNNING_CHILD = fileURLToPath(new URL('../fixtures/long-running-child.mjs', import.meta.url));
const SPAWN_WRAPPER = fileURLToPath(new URL('../fixtures/spawn-wrapper.mjs', import.meta.url));

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-spawn-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Terminates a spawnDaemon-launched pid and waits (bounded) for it to
 * actually die, so no test can leak a live detached process into the rest
 * of the suite or outlive this session. Escalates to SIGKILL if SIGTERM
 * doesn't take effect within the budget.
 */
async function killAndWait(pid: number, timeoutMs = 3000): Promise<void> {
  if (!isPidAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // already gone
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await sleep(25);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

test('spawnDaemon returns a numeric pid immediately, without waiting for the child', async () => {
  await withTempDir(async (dir) => {
    const pidFilePath = join(dir, 'child.pid');
    const pid = spawnDaemon(LONG_RUNNING_CHILD, [pidFilePath]);
    try {
      assert.strictEqual(typeof pid, 'number');
      assert.ok(pid > 0, 'pid must be a positive number');
    } finally {
      await killAndWait(pid);
    }
  });
});

test('the child launched by spawnDaemon is alive shortly after the call returns', async () => {
  await withTempDir(async (dir) => {
    const pidFilePath = join(dir, 'child.pid');
    const pid = spawnDaemon(LONG_RUNNING_CHILD, [pidFilePath]);
    try {
      await sleep(100);
      assert.strictEqual(isPidAlive(pid), true);
    } finally {
      await killAndWait(pid);
    }
  });
});

test('a daemon spawned via a wrapper subprocess survives that subprocess genuinely exiting (parent-exit survival)', async () => {
  await withTempDir(async (dir) => {
    const pidFilePath = join(dir, 'grandchild.pid');

    // The wrapper is the "parent" from spawnDaemon's perspective. It is
    // spawned normally (attached) here so the test can await its real
    // 'exit' event — proving the wrapper has genuinely terminated before
    // asserting anything about the grandchild it launched.
    const wrapper = spawn(process.execPath, [SPAWN_WRAPPER, pidFilePath], {
      stdio: 'ignore',
      windowsHide: true,
    });

    await new Promise<void>((resolve, reject) => {
      wrapper.once('exit', () => resolve());
      wrapper.once('error', reject);
    });

    const pidText = await readFile(pidFilePath, 'utf8');
    const grandchildPid = Number(pidText.trim());
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, 'pid file must contain a real pid');

    // This assertion used to be guarded by a `t.skip` whenever the child did
    // NOT survive, on the theory that a non-surviving child proved a hardened
    // host policy rather than a spawnDaemon defect. That guard made the test
    // vacuous on exactly the condition it exists to detect, and it hid a real
    // bug: win32 was spawning with `detached: false`, which ties the daemon's
    // lifetime to its parent, so `illuminate <file>` printed a healthy URL and
    // the daemon died the instant the CLI exited (LIFE-05).
    //
    // A direct probe on this same machine showed `detached: true` +
    // `windowsHide: true` survives here while `detached: false` +
    // `windowsHide: true` does not — so this host supports real OS-level
    // detachment, and a non-surviving child is a defect, not host policy.
    // Never reintroduce the skip: if this fails, spawnDaemon is wrong.
    const survived = isPidAlive(grandchildPid);
    try {
      assert.strictEqual(
        survived,
        true,
        'grandchild must still be alive after the wrapper (its parent) has fully exited',
      );
    } finally {
      if (survived) await killAndWait(grandchildPid);
    }
  });
});
