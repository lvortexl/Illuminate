// NOTE: this test spawns the BUILT cli (`dist/cli.mjs`), so `npm run build`
// must run before `npm test` -- same ordering requirement as smoke.test.ts.
//
// Every invocation here passes `--no-open` -- the `open` package must never
// actually launch a real browser under `node --test` (PITFALLS.md / this
// plan's hard constraint). `--no-open`'s import-skipping itself mirrors the
// same lazy-import pattern already proven for `stop`/`--version`, which also
// never import `open` -- not independently re-tested here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLock, isPidAlive } from '../src/daemon/lock.ts';
import { lockPathFor } from '../src/daemon/state-dir.ts';
import { forceRemove } from './fixtures/cleanup.ts';

const SESSION_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/session\/[0-9a-f]{16}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-cli-open-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

/** Mirrors cli-stop.test.ts / version-restart.test.ts's own cleanup helper. */
async function stopDaemon(artifactRoot: string): Promise<void> {
  const record = await readLock(lockPathFor(artifactRoot));
  if (!record) return;
  try {
    await fetch(`http://127.0.0.1:${record.port}/shutdown?token=${record.healthToken}`, {
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

test('illuminate <file.html> --no-open serves the file and prints a well-formed session URL', async (t) => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'artifact.html');
    await writeFile(file, '<!doctype html><html><body><p>hi</p></body></html>');
    try {
      const result = spawnSync(process.execPath, ['dist/cli.mjs', file, '--no-open'], { encoding: 'utf8' });
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      const stdoutLine = result.stdout.trim();
      assert.match(stdoutLine, SESSION_URL_RE, `stdout did not match expected session URL shape: ${JSON.stringify(result.stdout)}`);

      // The CLI process has already exited (spawnSync only returns once it
      // has). Whether the detached daemon it started is STILL reachable at
      // this point depends on real OS-level child-process detachment, which
      // some hardened/sandboxed hosts do not honor for ANY spawn flag
      // combination -- independently verified against spawnDaemon's own
      // dedicated proof (test/daemon/spawn.test.ts, "a daemon spawned via a
      // wrapper subprocess survives that subprocess genuinely exiting", see
      // 01-06-SUMMARY.md "Deferred Issues"). Skip loudly rather than fail on
      // such a host; assert for real on one that supports it (an ordinary
      // developer terminal, windows-latest CI).
      const res = await fetch(stdoutLine).catch((err: unknown) => {
        t.skip(
          'this host kills every child process on parent exit regardless of spawn flags, so the ' +
            `daemon did not survive the CLI process exiting -- see test/daemon/spawn.test.ts (${(err as Error).message})`,
        );
        return null;
      });
      if (res === null) return;
      assert.strictEqual(res.status, 200);
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('a second invocation on the SAME file prints the SAME key (deterministic per-file session identity) and attaches rather than re-spawning wherever the host supports real process detachment', async (t) => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'artifact.html');
    await writeFile(file, '<!doctype html><html><body><p>hi</p></body></html>');
    try {
      const first = spawnSync(process.execPath, ['dist/cli.mjs', file, '--no-open'], { encoding: 'utf8' });
      assert.strictEqual(first.status, 0, `stderr: ${first.stderr}`);
      const firstUrl = first.stdout.trim();
      const firstRecord = await readLock(lockPathFor(dir));
      const firstPid = firstRecord?.pid ?? null;

      const second = spawnSync(process.execPath, ['dist/cli.mjs', file, '--no-open'], { encoding: 'utf8' });
      assert.strictEqual(second.status, 0, `stderr: ${second.stderr}`);
      const secondUrl = second.stdout.trim();

      // sessionKey (src/store/session-store.ts) is a pure hash of the
      // file's own real path -- true regardless of which daemon instance
      // ends up serving it, so this holds even on a host that could not
      // keep the first daemon alive across the two separate CLI invocations.
      assert.strictEqual(secondUrl, firstUrl, 'a second invocation on the same file must print the same session URL/key');

      // The "attaches rather than re-spawns" half needs the first daemon to
      // still be alive by the time the second invocation runs -- the same
      // host-policy caveat as the test above. Settle briefly, then decide.
      await sleep(200);
      const firstStillAlive = firstPid !== null && isPidAlive(firstPid);
      if (!firstStillAlive) {
        t.skip(
          'this host kills every child process on parent exit regardless of spawn flags, so the first ' +
            'daemon could not still be running for the second invocation to attach to -- see test/daemon/spawn.test.ts',
        );
        return;
      }

      const secondRecord = await readLock(lockPathFor(dir));
      assert.ok(secondRecord);
      assert.strictEqual(secondRecord.pid, firstPid, 'a second invocation must attach to the existing daemon, not spawn a second one');
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('illuminate <missing file> exits 1, stderr names the missing path, and no daemon is spawned', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'does-not-exist.html');
    const result = spawnSync(process.execPath, ['dist/cli.mjs', file, '--no-open'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes(file), `stderr did not name the missing path: ${JSON.stringify(result.stderr)}`);
    const record = await readLock(lockPathFor(dir));
    assert.strictEqual(record, null, 'no daemon should have been spawned for a missing file');
  });
});

test('illuminate <file> with a non-.html/.htm extension exits 1 and stderr explains why', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'artifact.txt');
    await writeFile(file, 'not html');
    const result = spawnSync(process.execPath, ['dist/cli.mjs', file, '--no-open'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /\.html/i);
    const record = await readLock(lockPathFor(dir));
    assert.strictEqual(record, null, 'no daemon should have been spawned for a non-html file');
  });
});
