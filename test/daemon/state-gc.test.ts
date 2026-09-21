import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectStateGarbage, STATE_GC_MIN_AGE_MS } from '../../src/daemon/state-gc.ts';
import { stateDir } from '../../src/daemon/state-dir.ts';
import { ensureDaemonRunning } from '../../src/daemon/orchestrate.ts';
import { readLock } from '../../src/daemon/lock.ts';
import { lockPathFor } from '../../src/daemon/state-dir.ts';
import { sessionStorePathFor } from '../../src/store/session-store.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

/**
 * `<stateDir>/servers/` was never swept: every `mkdtemp` fixture that started
 * a daemon left a `*.state.json` behind naming an artifact that no longer
 * exists, and `writeAtomic` leaves a `*.json.<hex>.tmp` behind whenever a
 * rename genuinely fails. A real machine had ~200 of the first and a handful
 * of the second.
 *
 * Every test below drives a REAL directory through the real function -- the
 * `dir`/`now`/`isAlive` seams exist so the suite need not sleep out a ten
 * minute threshold, guess at `stateDir()`'s platform branch, or kill a real
 * process to observe a dead pid.
 */

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const OLD = NOW - STATE_GC_MIN_AGE_MS - 60_000;
const RECENT = NOW - 1_000;

const DEAD_PID = 424242;
const LIVE_PID = 4242;
const aliveOnly = (pid: number): boolean => pid === LIVE_PID;

interface Fixture {
  readonly dir: string;
  /** Writes a file and back-dates its mtime, since every age decision here is
   * made on mtime and a just-written file is never old enough to collect. */
  write(name: string, contents: string, mtimeMs: number): Promise<string>;
  lock(key: string, pid: number, mtimeMs?: number): Promise<string>;
  state(key: string, files: readonly string[], mtimeMs?: number): Promise<string>;
  names(): Promise<string[]>;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'illuminate-state-gc-test-'));
  const dir = join(root, 'servers');
  await mkdir(dir, { recursive: true });
  const write = async (name: string, contents: string, mtimeMs: number): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, contents, 'utf8');
    await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
    return path;
  };
  try {
    await fn({
      dir,
      write,
      lock: (key, pid, mtimeMs = OLD) =>
        write(
          `${key}.json`,
          JSON.stringify({ pid, port: 4319, version: 'test', startedAt: new Date(OLD).toISOString(), healthToken: 'tok' }),
          mtimeMs,
        ),
      state: (key, files, mtimeMs = OLD) =>
        write(
          `${key}.state.json`,
          JSON.stringify({
            sessions: Object.fromEntries(
              files.map((file, i) => [
                `s${String(i)}`,
                {
                  key: `s${String(i)}`,
                  file,
                  createdAt: new Date(OLD).toISOString(),
                  artifactRevision: 0,
                  chromeLoadToken: null,
                  artifactLoadToken: null,
                  queue: [],
                  dispatches: {},
                  browserLastSeenAt: null,
                  sessionEndedAt: null,
                },
              ]),
            ),
          }),
          mtimeMs,
        ),
      names: () => readdir(dir),
    });
  } finally {
    await forceRemove(root);
  }
}

/** An artifact path that genuinely exists, so "the artifact survives" is a
 * real filesystem fact and not a fixture assumption. */
async function existingArtifact(): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-state-gc-artifact-'));
  const file = join(dir, 'artifact.html');
  await writeFile(file, '<html><body>hi</body></html>\n', 'utf8');
  return { file, cleanup: () => forceRemove(dir) };
}

// ---------------------------------------------------------------------------
// what gets collected
// ---------------------------------------------------------------------------

test('collects a state file whose daemon is dead and whose artifact is gone', async () => {
  await withFixture(async (f) => {
    await f.lock('aaaa000000000001', DEAD_PID);
    await f.state('aaaa000000000001', [join(tmpdir(), 'illuminate-long-gone', 'artifact.html')]);

    const result = await collectStateGarbage({ dir: f.dir, now: NOW, isAlive: aliveOnly });

    assert.strictEqual(result.removedStateFiles, 1);
    assert.strictEqual(result.removedLockFiles, 1);
    assert.deepStrictEqual(await f.names(), []);
  });
});

test('collects a state file with NO lockfile at all -- the overwhelmingly common orphan', async () => {
  await withFixture(async (f) => {
    // A daemon removes its lockfile on the way out and leaves the state file.
    await f.state('aaaa000000000002', [join(tmpdir(), 'illuminate-long-gone', 'artifact.html')]);

    const result = await collectStateGarbage({ dir: f.dir, now: NOW, isAlive: aliveOnly });

    assert.strictEqual(result.removedStateFiles, 1);
    assert.deepStrictEqual(await f.names(), []);
  });
});

test('collects a stray .tmp fragment older than the threshold', async () => {
  await withFixture(async (f) => {
    await f.write('aaaa000000000003.state.json.deadbeefcafe.tmp', '{"sessions":{}}', OLD);

    const result = await collectStateGarbage({ dir: f.dir, now: NOW, isAlive: aliveOnly });

    assert.strictEqual(result.removedTmpFiles, 1);
    assert.deepStrictEqual(await f.names(), []);
  });
});

// ---------------------------------------------------------------------------
// what must survive -- each of these is a way to lose a user's live session
// ---------------------------------------------------------------------------

test('KEEPS a state file whose lockfile names a LIVE pid, artifact gone or not', async () => {
  await withFixture(async (f) => {
    await f.lock('bbbb000000000001', LIVE_PID);
    await f.state('bbbb000000000001', [join(tmpdir(), 'illuminate-long-gone', 'artifact.html')]);

    const result = await collectStateGarbage({ dir: f.dir, now: NOW, isAlive: aliveOnly });

    assert.strictEqual(result.removedStateFiles, 0);
    assert.strictEqual(result.removedLockFiles, 0);
    assert.strictEqual((await f.names()).length, 2);
  });
});

test('KEEPS a state file whose artifact still exists, even with the daemon provably dead', async () => {
  const artifact = await existingArtifact();
  try {
    await withFixture(async (f) => {
      await f.lock('bbbb000000000002', DEAD_PID);
      await f.state('bbbb000000000002', [artifact.file]);

      const result = await collectStateGarbage({ dir: f.dir, now: NOW, isAlive: aliveOnly });

      assert.strictEqual(result.removedStateFiles, 0);
      assert.strictEqual((await f.names()).length, 2);
    });
  } finally {
    await artifact.cleanup();
  }
});

test('KEEPS a state file when only ONE of several artifacts survives', async () => {
  const artifact = await existingArtifact();
  try {
    await withFixture(async (f) => {
      await f.state('bbbb000000000003', [join(tmpdir(), 'illuminate-long-gone', 'a.html'), artifact.file]);

      const result = await collectStateGarbage({ dir: f.dir, now: NOW, isAlive: aliveOnly });

      assert.strictEqual(result.removedStateFiles, 0);
    });
  } finally {
    await artifact.cleanup();
  }
});

test('KEEPS a recently-written state file even when it is otherwise collectable', async () => {
  await withFixture(async (f) => {
    await f.state('bbbb000000000004', [join(tmpdir(), 'illuminate-long-gone', 'artifact.html')], RECENT);

    const result = await collectStateGarbage({ dir: f.dir, now: NOW, isAlive: aliveOnly });

    assert.strictEqual(result.removedStateFiles, 0, 'the age threshold is the guard against a daemon mid-startup');
  });
});

test('KEEPS an old state file whose LOCKFILE was just rewritten -- the newest of the pair decides', async () => {
  await withFixture(async (f) => {
    await f.lock('bbbb000000000005', DEAD_PID, RECENT);
    await f.state('bbbb000000000005', [join(tmpdir(), 'illuminate-long-gone', 'artifact.html')], OLD);

    const result = await collectStateGarbage({ dir: f.dir, now: NOW, isAlive: aliveOnly });

    assert.strictEqual(result.removedStateFiles, 0);
  });
});

test('KEEPS a recent .tmp fragment -- an atomic write in flight must survive', async () => {
  await withFixture(async (f) => {
    await f.write('bbbb000000000006.state.json.deadbeefcafe.tmp', '{"sessions":{}}', RECENT);

    const result = await collectStateGarbage({ dir: f.dir, now: NOW, isAlive: aliveOnly });

    assert.strictEqual(result.removedTmpFiles, 0);
    assert.strictEqual((await f.names()).length, 1);
  });
});

test('KEEPS an unparseable state file -- "cannot tell" is never treated as "no artifacts"', async () => {
  await withFixture(async (f) => {
    await f.write('bbbb000000000007.state.json', '{ this is not json', OLD);

    const result = await collectStateGarbage({ dir: f.dir, now: NOW, isAlive: aliveOnly });

    assert.strictEqual(result.removedStateFiles, 0);
  });
});

test('KEEPS files behind an unparseable lockfile -- a pid that cannot be read cannot be proven dead', async () => {
  await withFixture(async (f) => {
    await f.write('bbbb000000000008.json', '{ truncated', OLD);
    await f.state('bbbb000000000008', [join(tmpdir(), 'illuminate-long-gone', 'artifact.html')]);

    const result = await collectStateGarbage({ dir: f.dir, now: NOW, isAlive: aliveOnly });

    assert.strictEqual(result.removedStateFiles, 0);
    assert.strictEqual(result.removedLockFiles, 0);
  });
});

// ---------------------------------------------------------------------------
// shape and safety
// ---------------------------------------------------------------------------

test('a `<key>.state.json` is never mistaken for the `<key>.json` lockfile', async () => {
  // Both suffixes end in `.json`; keying on the wrong one would pair a state
  // file with itself and lose the liveness proof entirely.
  await withFixture(async (f) => {
    await f.lock('cccc000000000001', LIVE_PID);
    await f.state('cccc000000000001', [join(tmpdir(), 'illuminate-long-gone', 'artifact.html')]);

    await collectStateGarbage({ dir: f.dir, now: NOW, isAlive: aliveOnly });

    assert.deepStrictEqual((await f.names()).sort(), ['cccc000000000001.json', 'cccc000000000001.state.json']);
  });
});

test('one collectable key and one live key in the same sweep: exactly the dead one goes', async () => {
  await withFixture(async (f) => {
    await f.lock('dddd000000000001', DEAD_PID);
    await f.state('dddd000000000001', [join(tmpdir(), 'illuminate-long-gone', 'artifact.html')]);
    await f.lock('dddd000000000002', LIVE_PID);
    await f.state('dddd000000000002', [join(tmpdir(), 'illuminate-long-gone', 'artifact.html')]);

    const result = await collectStateGarbage({ dir: f.dir, now: NOW, isAlive: aliveOnly });

    assert.strictEqual(result.removedStateFiles, 1);
    assert.strictEqual(result.removedLockFiles, 1);
    assert.deepStrictEqual((await f.names()).sort(), ['dddd000000000002.json', 'dddd000000000002.state.json']);
  });
});

test('a missing servers directory is not an error', async () => {
  const result = await collectStateGarbage({ dir: join(tmpdir(), 'illuminate-state-gc-no-such-dir'), now: NOW });

  assert.deepStrictEqual(result, { removedStateFiles: 0, removedLockFiles: 0, removedTmpFiles: 0 });
});

test('unrecognized files in servers/ are left alone', async () => {
  await withFixture(async (f) => {
    await f.write('README.txt', 'not ours', OLD);
    await f.write('eeee000000000001.notjson', 'not ours either', OLD);

    const result = await collectStateGarbage({ dir: f.dir, now: NOW, isAlive: aliveOnly });

    assert.deepStrictEqual(result, { removedStateFiles: 0, removedLockFiles: 0, removedTmpFiles: 0 });
    assert.strictEqual((await f.names()).length, 2);
  });
});

test('STATE_GC_MIN_AGE_MS is the single threshold, and it genuinely gates both file kinds', async () => {
  // Pins that the exported constant is the one actually consulted: shifting
  // `now` by exactly the threshold flips both decisions together.
  await withFixture(async (f) => {
    const mtime = NOW - STATE_GC_MIN_AGE_MS;
    await f.state('ffff000000000001', [join(tmpdir(), 'illuminate-long-gone', 'artifact.html')], mtime);
    await f.write('ffff000000000002.state.json.abcdef123456.tmp', '{}', mtime);

    const atBoundary = await collectStateGarbage({ dir: f.dir, now: NOW, isAlive: aliveOnly });
    assert.deepStrictEqual(
      { state: atBoundary.removedStateFiles, tmp: atBoundary.removedTmpFiles },
      { state: 0, tmp: 0 },
      'exactly at the threshold is not yet old enough',
    );

    const pastBoundary = await collectStateGarbage({ dir: f.dir, now: NOW + 1, isAlive: aliveOnly });
    assert.deepStrictEqual({ state: pastBoundary.removedStateFiles, tmp: pastBoundary.removedTmpFiles }, { state: 1, tmp: 1 });
  });
});

// ---------------------------------------------------------------------------
// the wiring -- a sweep nothing calls collects nothing
// ---------------------------------------------------------------------------

test('a real spawned daemon sweeps the real state directory on startup', async () => {
  // Plants ONE orphan under a key no real path can hash to (not 16 hex
  // characters), in the real `<stateDir>/servers`, then starts a real daemon
  // subprocess and waits for it to disappear. Everything else in that
  // directory is either live (kept) or genuine litter this is meant to remove.
  const servers = join(stateDir(), 'servers');
  await mkdir(servers, { recursive: true });
  const planted = join(servers, 'zzzz-state-gc-e2e-probe.state.json');
  await writeFile(
    planted,
    JSON.stringify({
      sessions: {
        s0: {
          key: 's0',
          file: join(tmpdir(), 'illuminate-state-gc-e2e-never-existed', 'artifact.html'),
          createdAt: new Date(OLD).toISOString(),
          artifactRevision: 0,
          chromeLoadToken: null,
          artifactLoadToken: null,
          queue: [],
          dispatches: {},
          browserLastSeenAt: null,
          sessionEndedAt: null,
        },
      },
    }),
    'utf8',
  );
  await utimes(planted, new Date(OLD), new Date(OLD));

  const root = await mkdtemp(join(tmpdir(), 'illuminate-state-gc-e2e-'));
  try {
    const { port } = await ensureDaemonRunning(root, { env: { ILLUMINATE_DISABLE_SELF_DISPATCH: '1' } });
    try {
      const deadline = Date.now() + 5000;
      for (;;) {
        const stillThere = await readdir(servers).then((n) => n.includes('zzzz-state-gc-e2e-probe.state.json'));
        if (!stillThere) break;
        assert.ok(Date.now() < deadline, 'a daemon start must sweep the state directory');
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      const record = await readLock(lockPathFor(root));
      if (record) {
        await fetch(`http://127.0.0.1:${String(port)}/shutdown?token=${record.healthToken}`, { method: 'POST' }).catch(() => {});
      }
    }
  } finally {
    await forceRemove(planted);
    await forceRemove(sessionStorePathFor(root));
    await forceRemove(root);
  }
});
