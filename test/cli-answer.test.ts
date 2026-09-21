// NOTE: this test spawns the BUILT cli (`dist/cli.mjs`), so `npm run build`
// must run before `npm test` -- same ordering requirement as smoke.test.ts.
//
// ROUT-04: `illuminate answer` closes the dispatch loop with ONLY
// `--dispatch`/`--port` -- no session key anywhere, matching
// `POST /api/dispatches/:id/answer`'s own key-free design (06-06/06-07).
// The daemon itself is started directly via `ensureDaemonRunning` from
// THIS test process (mirrors cli-stop.test.ts's own "against a real
// running daemon" precedent) rather than via a spawned CLI subprocess --
// `answer` never spawns a daemon itself, so there is no child-process-
// survival concern to work around here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDaemonRunning } from '../src/daemon/orchestrate.ts';
import { readLock, isPidAlive } from '../src/daemon/lock.ts';
import { lockPathFor } from '../src/daemon/state-dir.ts';
import { sessionKey } from '../src/store/session-store.ts';
import { anchorHash } from '../src/provenance/hash.ts';
import { forceRemove } from './fixtures/cleanup.ts';

const ARTIFACT_CONTENT = '<!doctype html><html><body><p>hi</p></body></html>';

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-cli-answer-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

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

/** Bootstraps a real daemon + real session (via the real /api/sessions
 * route) directly from this test process -- no CLI subprocess involved. */
async function setUpSession(dir: string): Promise<{ port: number; key: string }> {
  const file = join(dir, 'artifact.html');
  await writeFile(file, ARTIFACT_CONTENT);
  // ensureDaemonRunning spawns a REAL, separate daemon subprocess
  // (dist/daemon-entry.mjs) with no way to pass DaemonServerOptions
  // directly -- ILLUMINATE_DISABLE_SELF_DISPATCH is the env-gated seam
  // daemon-entry.ts reads instead (see its own doc comment), closing the
  // gap 06-11's deferred-items.md documented: on any machine with a real
  // `claude` binary on PATH (true on this dev host), every dispatch this
  // file enqueues would otherwise silently spawn a real, costly,
  // non-deterministic `claude -p` subprocess as a side effect.
  const { port } = await ensureDaemonRunning(dir, { env: { ILLUMINATE_DISABLE_SELF_DISPATCH: '1' } });
  const realFile = await realpath(file);
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: realFile }),
  });
  assert.strictEqual(res.status, 200);
  return { port, key: sessionKey(realFile) };
}

/** `anchor` defaults to `null` (unanchored) for every existing call site.
 * 07-04's deterministic EDU-07 verify-shortcut now auto-answers an
 * unanchored (or otherwise ungroundable) `verify` dispatch synchronously,
 * at zero cost, before it can ever reach this file's own manual
 * `illuminate answer` CLI path -- so THIS file's one `verify` call site
 * below passes a real, groundable anchor instead, keeping that dispatch
 * genuinely exercising the manual-answer path this test targets. */
async function enqueueDispatch(
  port: number,
  key: string,
  uid: string,
  intent: string,
  anchor: { src: string; rev: string | null; anchorHash: string } | null = null,
): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/${key}/dispatches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intent,
      targets: [{ element: { uid, selector: `#${uid}`, tag: 'p', text: `task text for ${uid}` }, anchor }],
    }),
  });
  const text = await res.text();
  assert.strictEqual(res.status, 200, `enqueue failed: ${text}`);
  const body = JSON.parse(text) as { dispatch_id: string };
  return body.dispatch_id;
}

function runAnswer(args: readonly string[], stdin: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['dist/cli.mjs', 'answer', ...args], {
    encoding: 'utf8',
    input: stdin,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('illuminate answer: a matching-tier answer prints exactly the fixed-shape receipt (formatReceipt) and exits 0, no session key given', async () => {
  await withTempDir(async (dir) => {
    try {
      const { port, key } = await setUpSession(dir);
      // Anchored to the real, on-disk artifact.html (whole file, no git
      // repo needed -- resolve()'s no-git degraded path serves real
      // working-tree content directly) so isUngroundable is false and this
      // dispatch is NOT auto-answered by the EDU-07 shortcut -- this test's
      // own point is the manual `illuminate answer` CLI path.
      const dispatchId = await enqueueDispatch(port, key, 'e-answer-1', 'verify', {
        src: 'artifact.html',
        rev: null,
        anchorHash: anchorHash(ARTIFACT_CONTENT),
      });

      const result = runAnswer(
        ['--dispatch', dispatchId, '--port', String(port), '--model', 'test-model', '--tier', 'sonnet', '--stdin'],
        '# some real markdown answer\n\nwith **content**.',
      );

      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.match(
        result.stdout,
        new RegExp(`^ok ${dispatchId} verifier/sonnet 0 tokens 0\\.0s -> artifact\\.html\\n$`),
        `unexpected receipt: ${JSON.stringify(result.stdout)}`,
      );
      assert.strictEqual(result.stderr, '');
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('illuminate answer: token/cost/wall-ms metadata flags are carried through into the printed receipt', async () => {
  await withTempDir(async (dir) => {
    try {
      const { port, key } = await setUpSession(dir);
      const dispatchId = await enqueueDispatch(port, key, 'e-answer-2', 'explain');

      const result = runAnswer(
        [
          '--dispatch',
          dispatchId,
          '--port',
          String(port),
          '--model',
          'test-model',
          '--tier',
          'haiku',
          '--input-tokens',
          '120',
          '--output-tokens',
          '80',
          '--cache-read-input-tokens',
          '5',
          '--cost-usd',
          '0.002',
          '--wall-ms',
          '2500',
          '--stdin',
        ],
        'a real answer body',
      );

      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`^ok ${dispatchId} tutor/haiku 200 tokens 2\\.5s -> artifact\\.html\\n$`));
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('illuminate answer: a fix-code dispatch answered below the opus floor is refused (403), prints only a short reason to stderr, never a stack trace or the submitted markdown', async () => {
  await withTempDir(async (dir) => {
    try {
      const { port, key } = await setUpSession(dir);
      const dispatchId = await enqueueDispatch(port, key, 'e-answer-3', 'fix-code');
      const secretMarkdown = 'THIS MARKDOWN MUST NEVER APPEAR ON STDERR OR STDOUT';

      const result = runAnswer(
        ['--dispatch', dispatchId, '--port', String(port), '--model', 'test-model', '--tier', 'sonnet', '--stdin'],
        secretMarkdown,
      );

      assert.strictEqual(result.status, 1);
      assert.strictEqual(result.stdout, '');
      assert.match(result.stderr, /illuminate answer:/);
      assert.match(result.stderr, /opus/);
      assert.ok(!result.stderr.includes(secretMarkdown), 'stderr must never leak the submitted answer markdown');
      assert.ok(!/at \S+ \(/.test(result.stderr), `stderr looks like it contains a stack trace: ${JSON.stringify(result.stderr)}`);
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('illuminate answer: an unknown dispatch id is a 404, short reason on stderr, exit 1', async () => {
  await withTempDir(async (dir) => {
    try {
      const { port } = await setUpSession(dir);

      const result = runAnswer(
        ['--dispatch', 'this-dispatch-id-does-not-exist', '--port', String(port), '--model', 'm', '--tier', 'haiku', '--stdin'],
        'irrelevant',
      );

      assert.strictEqual(result.status, 1);
      assert.strictEqual(result.stdout, '');
      assert.match(result.stderr, /illuminate answer:/);
      assert.match(result.stderr, /unknown dispatch/);
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('illuminate answer: answering an already-terminal dispatch a second time is a 409, short reason on stderr, exit 1', async () => {
  await withTempDir(async (dir) => {
    try {
      const { port, key } = await setUpSession(dir);
      const dispatchId = await enqueueDispatch(port, key, 'e-answer-5', 'explain');

      const first = runAnswer(
        ['--dispatch', dispatchId, '--port', String(port), '--model', 'm', '--tier', 'haiku', '--stdin'],
        'first answer',
      );
      assert.strictEqual(first.status, 0, `stderr: ${first.stderr}`);

      const second = runAnswer(
        ['--dispatch', dispatchId, '--port', String(port), '--model', 'm', '--tier', 'haiku', '--stdin'],
        'second answer, should be rejected',
      );
      assert.strictEqual(second.status, 1);
      assert.strictEqual(second.stdout, '');
      assert.match(second.stderr, /illuminate answer:/);
      assert.match(second.stderr, /answered/);
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('illuminate answer: missing --dispatch/--port/--model/--tier prints a usage message and exits 1, no daemon contacted', () => {
  const result = spawnSync(process.execPath, ['dist/cli.mjs', 'answer', '--stdin'], { encoding: 'utf8', input: 'x' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /usage: illuminate answer/);
});

test('illuminate answer: missing --stdin prints a short reason and exits 1', async () => {
  await withTempDir(async (dir) => {
    try {
      const { port } = await setUpSession(dir);
      const result = spawnSync(
        process.execPath,
        ['dist/cli.mjs', 'answer', '--dispatch', 'whatever', '--port', String(port), '--model', 'm', '--tier', 'haiku'],
        { encoding: 'utf8' },
      );
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /--stdin/);
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('illuminate answer: an invalid --tier value is rejected before any network call, exit 1', async () => {
  await withTempDir(async (dir) => {
    try {
      const { port } = await setUpSession(dir);
      const result = runAnswer(
        ['--dispatch', 'whatever', '--port', String(port), '--model', 'm', '--tier', 'not-a-real-tier', '--stdin'],
        'x',
      );
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /--tier must be one of/);
    } finally {
      await stopDaemon(dir);
    }
  });
});

/** Reads the real GET /api/:key/annotations route -- the durable, card-
 * visible proof that a submitted answer's verdict/decidingLines actually
 * landed, rather than trusting only the printed receipt (formatReceipt's
 * fixed-shape line deliberately carries neither field). */
async function readLatestVerdict(
  port: number,
  key: string,
  dispatchId: string,
): Promise<{ verdict: string | null; decidingLines: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/${key}/annotations`);
  assert.strictEqual(res.status, 200);
  const store = (await res.json()) as {
    cards: { thread: { dispatchId: string; verdict: string | null; decidingLines: string | null }[] }[];
  };
  for (const card of store.cards) {
    const entry = card.thread.find((e) => e.dispatchId === dispatchId);
    if (entry) return { verdict: entry.verdict, decidingLines: entry.decidingLines };
  }
  throw new Error(`no annotation-store thread entry found for dispatch ${dispatchId}`);
}

test('illuminate answer --verdict/--deciding-lines: round-trips through the real answer request into the annotation store', async () => {
  await withTempDir(async (dir) => {
    try {
      const { port, key } = await setUpSession(dir);
      const dispatchId = await enqueueDispatch(port, key, 'e-answer-verdict-1', 'verify', {
        src: 'artifact.html',
        rev: null,
        anchorHash: anchorHash(ARTIFACT_CONTENT),
      });

      const result = runAnswer(
        [
          '--dispatch',
          dispatchId,
          '--port',
          String(port),
          '--model',
          'test-model',
          '--tier',
          'sonnet',
          '--verdict',
          'supported',
          '--deciding-lines',
          'line 42 confirms this',
          '--stdin',
        ],
        '# verified',
      );

      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      const recorded = await readLatestVerdict(port, key, dispatchId);
      assert.strictEqual(recorded.verdict, 'supported');
      assert.strictEqual(recorded.decidingLines, 'line 42 confirms this');
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('illuminate answer: omitting --verdict/--deciding-lines sends verdict:null, decidingLines:null -- ordinary explain answers are unaffected', async () => {
  await withTempDir(async (dir) => {
    try {
      const { port, key } = await setUpSession(dir);
      const dispatchId = await enqueueDispatch(port, key, 'e-answer-verdict-2', 'explain');

      const result = runAnswer(
        ['--dispatch', dispatchId, '--port', String(port), '--model', 'm', '--tier', 'haiku', '--stdin'],
        'a plain explanation, no verdict flags at all',
      );

      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      const recorded = await readLatestVerdict(port, key, dispatchId);
      assert.strictEqual(recorded.verdict, null);
      assert.strictEqual(recorded.decidingLines, null);
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('illuminate answer: an invalid --verdict value is rejected before any network call, exit 1', async () => {
  await withTempDir(async (dir) => {
    try {
      const { port } = await setUpSession(dir);
      const result = runAnswer(
        ['--dispatch', 'whatever', '--port', String(port), '--model', 'm', '--tier', 'haiku', '--verdict', 'maybe', '--stdin'],
        'x',
      );
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /--verdict must be one of/);
    } finally {
      await stopDaemon(dir);
    }
  });
});
