import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { forceRemove } from '../fixtures/cleanup.ts';
import {
  acquireLock,
  readLock,
  cleanupLock,
  isPidAlive,
  type LockRecord,
} from '../../src/daemon/lock.ts';

const LOCK_TS_PATH = fileURLToPath(new URL('../../src/daemon/lock.ts', import.meta.url));

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-lock-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

function makeRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    pid: process.pid,
    port: 4321,
    version: '0.1.0',
    startedAt: new Date().toISOString(),
    healthToken: 'test-token',
    ...overrides,
  };
}

test('acquireLock on a fresh path returns acquired and round-trips via readLock', async () => {
  await withTempDir(async (dir) => {
    // nested subdir proves acquireLock creates the parent directory itself
    const lockPath = join(dir, 'sub', 'lock.json');
    const record = makeRecord();
    const result = await acquireLock(lockPath, record);
    assert.strictEqual(result, 'acquired');
    const read = await readLock(lockPath);
    assert.deepStrictEqual(read, record);
  });
});

test('acquireLock called a second time on the same path returns exists and does not overwrite', async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, 'lock.json');
    const first = makeRecord({ port: 1111 });
    const second = makeRecord({ port: 2222 });
    // Real fs.open('wx') atomicity under test — no mocking. Two calls in
    // immediate sequence on the same real filesystem path.
    const firstResult = await acquireLock(lockPath, first);
    const secondResult = await acquireLock(lockPath, second);
    assert.strictEqual(firstResult, 'acquired');
    assert.strictEqual(secondResult, 'exists');
    const read = await readLock(lockPath);
    assert.deepStrictEqual(read, first, 'the second call must not overwrite the first record');
  });
});

test('readLock on a path with no file returns null, not a throw', async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, 'never-created.json');
    const read = await readLock(lockPath);
    assert.strictEqual(read, null);
  });
});

test('cleanupLock removes an existing lockfile', async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, 'lock.json');
    await acquireLock(lockPath, makeRecord());
    await cleanupLock(lockPath);
    const read = await readLock(lockPath);
    assert.strictEqual(read, null);
  });
});

test('cleanupLock on an already-removed path does not throw', async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, 'never-existed.json');
    await assert.doesNotReject(() => cleanupLock(lockPath));
  });
});

test('isPidAlive returns true for the current process', () => {
  assert.strictEqual(isPidAlive(process.pid), true);
});

test('isPidAlive returns false for a pid that has genuinely exited', async () => {
  // Real OS proof, not a guessed-invalid pid: spawn a trivial child, await
  // its actual termination, then check the now-dead pid's ESRCH path.
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const childPid = child.pid;
  assert.ok(childPid, 'child process must have a pid');
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  assert.strictEqual(isPidAlive(childPid), false);
});

// The EPERM branch models a real POSIX/Windows outcome (process exists, but
// signalling it is denied) that isn't reproducible on demand in CI. This is
// the ONE deliberately-injected/mocked branch in this entire suite — every
// other test in this file exercises real, unmocked OS behavior.
test('isPidAlive treats an injected EPERM as alive (fail toward not reclaiming)', () => {
  const fakeKillFn = () => {
    const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
    err.code = 'EPERM';
    throw err;
  };
  assert.strictEqual(isPidAlive(999999, fakeKillFn), true);
});

test('lock.ts never shells out to lsof, ps, tasklist, or wmic', () => {
  // Automated assertion over the actual source, not a manual promise.
  const source = readFileSync(LOCK_TS_PATH, 'utf8');
  assert.doesNotMatch(source, /lsof|tasklist|wmic|\bps\b/i);
});

test('registerCleanupHandlers removes the lockfile on normal process exit', async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, 'lock.json');
    const scriptPath = join(dir, 'child.mjs');
    const lockModuleUrl = pathToFileURL(LOCK_TS_PATH).href;
    const script = [
      `import { acquireLock, registerCleanupHandlers } from ${JSON.stringify(lockModuleUrl)};`,
      `const lockPath = ${JSON.stringify(lockPath)};`,
      `await acquireLock(lockPath, {`,
      `  pid: process.pid, port: 1, version: '0.0.0',`,
      `  startedAt: new Date().toISOString(), healthToken: 't',`,
      `});`,
      `registerCleanupHandlers(lockPath);`,
      `process.exit(0);`,
    ].join('\n');
    await writeFile(scriptPath, script, 'utf8');
    const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    const read = await readLock(lockPath);
    assert.strictEqual(read, null, 'the exit handler must have unlinked the lockfile');
  });
});

test('importing lock.ts alone attaches zero exit/SIGINT/SIGTERM listeners', () => {
  // registerCleanupHandlers must be an explicit opt-in the daemon entry
  // point calls once, never a module-level side effect — otherwise every
  // test file in this suite that merely imports lock.ts for its pure
  // functions would silently leak process listeners. Proven in a fresh
  // subprocess where the ONLY action is the import itself.
  const script = [
    `import ${JSON.stringify(pathToFileURL(LOCK_TS_PATH).href)};`,
    `console.log(JSON.stringify({`,
    `  exit: process.listenerCount('exit'),`,
    `  sigint: process.listenerCount('SIGINT'),`,
    `  sigterm: process.listenerCount('SIGTERM'),`,
    `}));`,
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  const counts = JSON.parse(result.stdout.trim()) as { exit: number; sigint: number; sigterm: number };
  assert.strictEqual(counts.exit, 0);
  assert.strictEqual(counts.sigint, 0);
  assert.strictEqual(counts.sigterm, 0);
});
