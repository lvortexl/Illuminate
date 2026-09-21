// NOTE: this test spawns the BUILT cli (`dist/cli.mjs`), so `npm run build`
// must run before `npm test` -- same ordering requirement as smoke.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { ensureDaemonRunning } from '../src/daemon/orchestrate.ts';
import { readLock, isPidAlive } from '../src/daemon/lock.ts';
import { lockPathFor } from '../src/daemon/state-dir.ts';
import { forceRemove } from './fixtures/cleanup.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-cli-stop-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

test('illuminate stop against a directory with no lockfile prints "not running" and exits 0', async () => {
  await withTempDir(async (dir) => {
    const result = spawnSync(process.execPath, ['dist/cli.mjs', 'stop', dir], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /not running/);
  });
});

test('illuminate stop against a real running daemon actually stops it end to end (built CLI, real subprocess)', async () => {
  await withTempDir(async (dir) => {
    const { port } = await ensureDaemonRunning(dir);
    const record = await readLock(lockPathFor(dir));
    assert.ok(record);

    // Prove it's genuinely serving first.
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.strictEqual(health.status, 200);

    const result = spawnSync(process.execPath, ['dist/cli.mjs', 'stop', dir], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /stopped/);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && isPidAlive(record.pid)) {
      await sleep(25);
    }
    assert.strictEqual(isPidAlive(record.pid), false, 'illuminate stop must actually terminate the daemon process');

    const afterLock = await readLock(lockPathFor(dir));
    assert.strictEqual(afterLock, null, 'illuminate stop must result in the lockfile being cleaned up');
  });
});

// ---------------------------------------------------------------------------
// Every spelling of one directory must address the ONE daemon serving it.
//
// `illuminate <file.html>` keys its daemon off `dirname(realpath(resolve
// (file)))` -- absolute, canonical. `illuminate stop` used to hash whatever
// string it was handed, so a relative path, a trailing separator, a
// forward-slash win32 path, or the very file path the session was started
// with all hashed to a key no daemon had ever written. Each printed "not
// running" and exited 0 while the daemon kept serving, with no way to tell
// that from the genuine no-daemon case.
// ---------------------------------------------------------------------------

/** Starts a real daemon for `dir`, runs the built CLI's `stop` against
 * `spelling` (optionally from a different cwd), and asserts the daemon is
 * genuinely gone -- process dead AND lockfile cleaned up, never just the
 * word "stopped" on stdout. */
async function assertStopsVia(dir: string, spelling: string, cwd?: string): Promise<void> {
  const { port } = await ensureDaemonRunning(dir);
  const record = await readLock(lockPathFor(dir));
  assert.ok(record, 'the daemon must have written a lockfile before the stop attempt');

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.strictEqual(health.status, 200, 'the daemon must be genuinely serving before the stop attempt');

  const result = spawnSync(process.execPath, [join(process.cwd(), 'dist', 'cli.mjs'), 'stop', spelling], {
    encoding: 'utf8',
    ...(cwd === undefined ? {} : { cwd }),
  });
  assert.strictEqual(result.status, 0, `stop exited ${String(result.status)}: ${result.stderr}`);
  assert.match(
    result.stdout,
    /stopped/,
    `illuminate stop ${spelling} reported "${result.stdout.trim()}" at a daemon that was genuinely serving on port ${String(port)}`,
  );

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isPidAlive(record.pid)) {
    await sleep(25);
  }
  assert.strictEqual(isPidAlive(record.pid), false, 'the daemon process must actually be gone');
  assert.strictEqual(await readLock(lockPathFor(dir)), null, 'the lockfile must be cleaned up');
}

test('illuminate stop resolves a RELATIVE directory to the daemon started on its absolute path', async () => {
  await withTempDir(async (dir) => {
    // Run the CLI from the temp dir's parent and name the directory
    // relatively -- exactly `illuminate stop .demo` from the repo root.
    await assertStopsVia(dir, basename(dir), dirname(dir));
  });
});

test('illuminate stop accepts a trailing separator on the directory', async () => {
  await withTempDir(async (dir) => {
    await assertStopsVia(dir, dir + sep);
  });
});

test(
  'illuminate stop accepts a forward-slash win32 path',
  {
    skip:
      process.platform === 'win32'
        ? false
        : 'win32-only: on POSIX a backslash is an ordinary filename character, so there is no second spelling to test',
  },
  async () => {
    await withTempDir(async (dir) => {
      await assertStopsVia(dir, dir.split(sep).join('/'));
    });
  },
);

test('illuminate stop accepts the ARTIFACT FILE path the session was started with, not only its directory', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'artifact.html');
    await writeFile(file, '<html><body>hi</body></html>\n', 'utf8');
    await assertStopsVia(dir, file);
  });
});

test('illuminate stop on a never-served directory still prints "not running" -- canonicalization must not invent a daemon', async () => {
  // The negative control for every assertion above: if resolving the
  // argument could ever key an unrelated live daemon, this would print
  // "stopped" and take something else down.
  await withTempDir(async (dir) => {
    const result = spawnSync(process.execPath, ['dist/cli.mjs', 'stop', join(dir, 'never-served')], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /not running/);
  });
});
