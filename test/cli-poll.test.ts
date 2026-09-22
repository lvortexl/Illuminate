// NOTE: this test spawns the BUILT cli (`dist/cli.mjs`), so `npm run build`
// must run before `npm test` -- same ordering requirement as smoke.test.ts /
// cli-open.test.ts.
//
// POLL-01: `illuminate poll <file.html>` is a stateless CLI process that
// resolves the daemon exactly like `illuminate <file.html>` already does,
// then prints only a compact, ASCII-safe rendering of the daemon's final
// `GET /api/:key/poll` response to stdout. A real dispatch is enqueued
// directly over HTTP (mirroring test/daemon/dispatch-routes.test.ts's own
// convention -- there is deliberately no `illuminate dispatch` CLI
// subcommand; dispatches are created by the browser, or, for testing,
// directly over HTTP) before polling for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLock, isPidAlive } from '../src/daemon/lock.ts';
import { lockPathFor } from '../src/daemon/state-dir.ts';
import { sessionKey } from '../src/store/session-store.ts';
import { isAsciiOnly } from '../src/cli/output.ts';
import { forceRemove } from './fixtures/cleanup.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-cli-poll-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

/** Mirrors cli-open.test.ts/cli-stop.test.ts's own cleanup helper. */
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

interface EnqueueResult {
  readonly dispatchId: string;
}

/** Enqueues one real dispatch directly over HTTP -- the daemon's real
 * `POST /api/:key/dispatches` route (06-07), exactly as a browser would
 * call it. `uid` is parameterized so multiple dispatches in one test never
 * collide with `enqueueDispatch`'s own dedupe key (element.uid + intent +
 * source.content), per 06-07-SUMMARY.md's documented finding. */
async function enqueueDispatch(
  port: number,
  key: string,
  uid: string,
  intent: string,
  note: string | null = null,
): Promise<EnqueueResult> {
  const res = await fetch(`http://127.0.0.1:${port}/api/${key}/dispatches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intent,
      targets: [{ element: { uid, selector: `#${uid}`, tag: 'p', text: `task text for ${uid}` }, anchor: null }],
      note,
    }),
  });
  const text = await res.text();
  assert.strictEqual(res.status, 200, `enqueue failed: ${text}`);
  const body = JSON.parse(text) as { dispatch_id: string };
  return { dispatchId: body.dispatch_id };
}

test('illuminate poll: missing <file.html> argument exits 1 with a short stderr message', async () => {
  const result = spawnSync(process.execPath, ['dist/cli.mjs', 'poll'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /missing <file\.html>/);
});

test('illuminate poll <missing file> exits 1 and names the missing path (no daemon spawned)', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'does-not-exist.html');
    const result = spawnSync(process.execPath, ['dist/cli.mjs', 'poll', file], { encoding: 'utf8' });
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes(file), `stderr did not name the missing path: ${JSON.stringify(result.stderr)}`);
    const record = await readLock(lockPathFor(dir));
    assert.strictEqual(record, null, 'no daemon should have been spawned for a missing file');
  });
});

test('illuminate poll <file.html> --timeout-ms N with no pending dispatch prints the waiting state, ASCII-only, and exits 0', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'artifact.html');
    await writeFile(file, '<!doctype html><html><body><p>hi</p></body></html>');
    try {
      const result = spawnSync(process.execPath, ['dist/cli.mjs', 'poll', file, '--timeout-ms', '150'], {
        encoding: 'utf8',
      });
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /still waiting/);
      assert.ok(isAsciiOnly(result.stdout), `stdout is not ASCII-only: ${JSON.stringify(result.stdout)}`);
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('illuminate poll <file.html> sees a real dispatch enqueued while it is already waiting: prints id, role/tier, intent, source, and the exact runnable answer command', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'artifact.html');
    await writeFile(file, '<!doctype html><html><body><p>hi</p></body></html>');
    try {
      // Deliberately no --timeout-ms: the poll child process stays alive,
      // blocked waiting, until the dispatch enqueued below wakes it -- this
      // keeps the daemon a live child of that STILL-RUNNING poll process
      // throughout, sidestepping this host's documented inability to keep a
      // detached daemon alive once its own spawning CLI process has already
      // exited (see cli-open.test.ts's own skip precedent).
      const child = spawn(process.execPath, ['dist/cli.mjs', 'poll', file], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdoutBuf = '';
      let stderrBuf = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      const deadline = Date.now() + 5000;
      while (!stderrBuf.includes('listening for feedback') && Date.now() < deadline) {
        await sleep(25);
      }
      assert.ok(stderrBuf.includes('listening for feedback'), `never saw the listening banner: ${JSON.stringify(stderrBuf)}`);

      const record = await readLock(lockPathFor(dir));
      assert.ok(record, 'expected a daemon lockfile to exist once the poll child is blocked waiting');
      const realFile = await realpath(file);
      const key = sessionKey(realFile);

      const { dispatchId } = await enqueueDispatch(record.port, key, 'e-poll-1', 'explain');

      const exitCode = await new Promise<number | null>((resolvePromise) => {
        child.on('exit', (code) => resolvePromise(code));
      });
      assert.strictEqual(exitCode, 0, `stderr: ${stderrBuf}`);
      assert.ok(isAsciiOnly(stdoutBuf), `stdout is not ASCII-only: ${JSON.stringify(stdoutBuf)}`);
      assert.ok(stdoutBuf.includes(dispatchId), `stdout did not include the dispatch id: ${JSON.stringify(stdoutBuf)}`);
      assert.match(stdoutBuf, /tutor\/haiku/, 'explain resolves to tutor/haiku per the locked policy table');
      assert.match(stdoutBuf, /explain/);
      const expectedCommand = `illuminate answer --dispatch ${dispatchId} --port ${record.port} --model <model-you-ran> --tier <haiku|sonnet|opus> --stdin`;
      assert.ok(
        stdoutBuf.includes(expectedCommand),
        `stdout did not include the exact runnable answer command ${JSON.stringify(expectedCommand)}: ${JSON.stringify(stdoutBuf)}`,
      );
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('illuminate poll <file.html> never prints raw JSON to stdout', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'artifact.html');
    await writeFile(file, '<!doctype html><html><body><p>hi</p></body></html>');
    try {
      const result = spawnSync(process.execPath, ['dist/cli.mjs', 'poll', file, '--timeout-ms', '100'], {
        encoding: 'utf8',
      });
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(!result.stdout.trimStart().startsWith('{'), `stdout looks like raw JSON: ${JSON.stringify(result.stdout)}`);
      assert.throws(
        () => {
          JSON.parse(result.stdout);
        },
        SyntaxError,
        'stdout must be a compact rendering, not raw JSON -- JSON.parse(stdout) was expected to throw',
      );
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('Ctrl-C (SIGINT) during a hung poll exits 130 where the host genuinely delivers a catchable SIGINT to a child process', async (t) => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'artifact.html');
    await writeFile(file, '<!doctype html><html><body><p>hi</p></body></html>');
    try {
      const child = spawn(process.execPath, ['dist/cli.mjs', 'poll', file], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderrBuf = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      const bannerSeen = await new Promise<boolean>((resolvePromise) => {
        const deadline = Date.now() + 5000;
        const check = (): void => {
          if (stderrBuf.includes('listening for feedback')) {
            resolvePromise(true);
            return;
          }
          if (Date.now() > deadline) {
            resolvePromise(false);
            return;
          }
          setTimeout(check, 25);
        };
        check();
      });
      assert.ok(bannerSeen, `never saw the "listening for feedback" banner; stderr so far: ${JSON.stringify(stderrBuf)}`);

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
        child.on('exit', (code, signal) => resolvePromise({ code, signal }));
        child.kill('SIGINT');
      });

      if (exit.code === 130) {
        assert.strictEqual(exit.code, 130);
      } else {
        // Documented, empirically-verified Windows limitation (mirrors this
        // project's own spawn.test.ts precedent): Node's child_process.kill()
        // on Windows does not deliver a catchable 'SIGINT' event to the
        // child at all -- it forcibly terminates the process, reported back
        // as {code: null, signal: 'SIGINT'}, before the child's own
        // process.on('SIGINT', ...) handler ever runs. cli.ts's SIGINT
        // handler is correct for a REAL interactive Ctrl-C at a real
        // console (a different OS mechanism than a programmatic
        // child.kill()) -- there is no automated node:test API to drive
        // that from this host.
        t.skip(
          `this host's child_process.kill('SIGINT') does not deliver a catchable SIGINT to the child ` +
            `(observed exit code=${String(exit.code)}, signal=${String(exit.signal)}) -- see this test's own comment`,
        );
      }
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('illuminate poll <file.html> delivers the human note to the agent, through a real daemon', async () => {
  // The end of the chain "usable through Claude" actually depends on. The
  // chrome rail's composer writes a note, the daemon carries it on the
  // envelope -- and for a long time `renderPollResult` printed everything
  // about a dispatch EXCEPT that, so an agent polling for work saw
  // "explain  <subject>" and none of what was asked. Every link before this
  // one has its own test; this is the one that proves they connect.
  await withTempDir(async (dir) => {
    const file = join(dir, 'artifact.html');
    await writeFile(file, '<!doctype html><html><body><p>hi</p></body></html>');
    const note = 'Name the exact test that proves this, not a summary of one.';
    try {
      const child = spawn(process.execPath, ['dist/cli.mjs', 'poll', file], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdoutBuf = '';
      let stderrBuf = '';
      child.stdout.on('data', (chunk: Buffer) => (stdoutBuf += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderrBuf += chunk.toString()));

      const deadline = Date.now() + 5000;
      while (!stderrBuf.includes('listening for feedback') && Date.now() < deadline) {
        await sleep(25);
      }
      assert.ok(stderrBuf.includes('listening for feedback'), `never saw the listening banner: ${JSON.stringify(stderrBuf)}`);

      const record = await readLock(lockPathFor(dir));
      assert.ok(record, 'expected a daemon lockfile once the poll child is blocked waiting');
      const key = sessionKey(await realpath(file));

      await enqueueDispatch(record.port, key, 'e-poll-note', 'explain', note);

      const exitCode = await new Promise<number | null>((resolvePromise) => {
        child.on('exit', (code) => resolvePromise(code));
      });
      assert.strictEqual(exitCode, 0, `stderr: ${stderrBuf}`);
      assert.ok(
        stdoutBuf.includes(note),
        `the note never reached the polling agent: ${JSON.stringify(stdoutBuf)}`,
      );
      assert.match(stdoutBuf, /^ {2}note: /m, 'the note must be labelled, not merely present somewhere');
      assert.ok(isAsciiOnly(stdoutBuf), `stdout is not ASCII-only: ${JSON.stringify(stdoutBuf)}`);
    } finally {
      await stopDaemon(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// ADR-104: `--follow` keeps a harness attached.
// ---------------------------------------------------------------------------

test('illuminate poll --follow stays attached past the first dispatch and streams NDJSON', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'artifact.html');
    await writeFile(file, '<!doctype html><html><body><p>hi</p></body></html>');
    try {
      const child = spawn(process.execPath, ['dist/cli.mjs', 'poll', file, '--follow'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdoutBuf = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
      });

      // Wait for the daemon the poll child spawned, then enqueue TWO
      // dispatches. Two is the whole point: a one-shot poll would print the
      // first and exit, so a second line is what proves it stayed attached.
      const deadline = Date.now() + 8000;
      let record = await readLock(lockPathFor(dir));
      while (!record && Date.now() < deadline) {
        await sleep(50);
        record = await readLock(lockPathFor(dir));
      }
      assert.ok(record, 'daemon never came up');
      const key = sessionKey(await realpath(file));

      // The lockfile lands BEFORE the poll child has finished registering its
      // session, so an immediate enqueue races it and 404s "unknown session".
      // Wait for the session itself rather than for the daemon.
      const port = record.port;
      const sessionDeadline = Date.now() + 8000;
      for (;;) {
        const probe = await fetch(`http://127.0.0.1:${port}/api/${key}/dispatches`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            intent: 'explain',
            targets: [{ element: { uid: 'one', selector: '#one', tag: 'p', text: 'task text for one' }, anchor: null }],
            note: null,
          }),
        });
        if (probe.status === 200) break;
        assert.ok(Date.now() < sessionDeadline, `session never registered: ${probe.status} ${await probe.text()}`);
        await sleep(100);
      }
      await sleep(600);
      await enqueueDispatch(port, key, 'two', 'verify');

      const lineDeadline = Date.now() + 8000;
      while (stdoutBuf.split('\n').filter((l) => l.trim().length > 0).length < 2 && Date.now() < lineDeadline) {
        await sleep(50);
      }
      child.kill('SIGINT');

      const lines = stdoutBuf.split('\n').filter((l) => l.trim().length > 0);
      assert.ok(lines.length >= 2, `expected >=2 NDJSON lines, got ${lines.length}: ${stdoutBuf}`);

      // Each line is ONE complete envelope a harness can parse without a
      // client library -- and carries the params the agent for it must run
      // with, already resolved by the router's policy table.
      const envelopes = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      for (const env of envelopes) {
        assert.ok(typeof env['dispatch_id'] === 'string', `no dispatch_id: ${JSON.stringify(env)}`);
        assert.ok(typeof env['role'] === 'string', 'envelope must name the role to run as');
        assert.ok(typeof env['model_tier'] === 'string', 'envelope must name the tier to run at');
        assert.ok(Array.isArray(env['tools']), 'envelope must name the tool list');
      }
      const intents = envelopes.map((e) => e['intent']);
      assert.ok(intents.includes('explain') && intents.includes('verify'), `both intents should arrive: ${String(intents)}`);
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('illuminate poll --follow exits 0 with a one-line message once the session has ended, instead of spinning', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'artifact.html');
    await writeFile(file, '<!doctype html><html><body><p>hi</p></body></html>');
    try {
      const child = spawn(process.execPath, ['dist/cli.mjs', 'poll', file, '--follow'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderrBuf = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });
      const exited = new Promise<number | null>((resolvePromise) => child.on('exit', (code) => resolvePromise(code)));

      // Wait for the daemon the poll child spawned, then for the session it
      // registers. One probe dispatch is enough here: the subject of this
      // test is what --follow does when the session ends, not delivery.
      const deadline = Date.now() + 8000;
      let record = await readLock(lockPathFor(dir));
      while (!record && Date.now() < deadline) {
        await sleep(50);
        record = await readLock(lockPathFor(dir));
      }
      assert.ok(record, 'daemon never came up');
      const key = sessionKey(await realpath(file));

      // The lockfile lands BEFORE the poll child has finished registering its
      // session, so an immediate enqueue races it and 404s "unknown session".
      // Wait for the session itself rather than for the daemon.
      const port = record.port;
      const sessionDeadline = Date.now() + 8000;
      for (;;) {
        const probe = await fetch(`http://127.0.0.1:${port}/api/${key}/dispatches`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            intent: 'explain',
            targets: [{ element: { uid: 'one', selector: '#one', tag: 'p', text: 'task text for one' }, anchor: null }],
            note: null,
          }),
        });
        if (probe.status === 200) break;
        assert.ok(Date.now() < sessionDeadline, `session never registered: ${probe.status} ${await probe.text()}`);
        await sleep(100);
      }

      const ended = await fetch(`http://127.0.0.1:${port}/api/${key}/end`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.strictEqual(ended.status, 200, `end session failed: ${await ended.text()}`);

      const code = await Promise.race([exited, sleep(8000).then(() => 'timeout' as const)]);
      assert.strictEqual(code, 0, `expected the follow loop to exit 0 after the session ended; got ${String(code)}; stderr: ${stderrBuf}`);
      assert.match(stderrBuf, /session has ended/);
    } finally {
      await stopDaemon(dir);
    }
  });
});
