import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { join } from 'node:path';
import { createFixtureRepo } from '../../test/fixtures/git-repo.ts';
import type { FixtureRepo } from '../../test/fixtures/git-repo.ts';
import { GitBatchPool, GitBatchContext, detectBatchMode } from './git-batch-pool.ts';
import type { GitBatchPoolOptions } from './git-batch-pool.ts';
import { forceRemove, forceRemoveSync } from '../../test/fixtures/cleanup.ts';
/**
 * Every test builds its own fixture repo AND its own pool. Teardown order
 * matters on Windows: the pool MUST be closed (killing its subprocess)
 * BEFORE the fixture directory is removed, since that subprocess has the
 * directory as its cwd. `t.after` hooks run in registration order, so both
 * are registered together, in the correct order, from one place.
 */
function useRepoAndPool(
  t: import('node:test').TestContext,
  autocrlf: boolean,
  opts?: GitBatchPoolOptions,
): { repo: FixtureRepo; pool: GitBatchPool } {
  const repo = createFixtureRepo(autocrlf);
  const pool = new GitBatchPool(repo.root, opts);
  t.after(async () => {
    pool.close();
    await forceRemove(repo.root);
  });
  return { repo, pool };
}

function independentGitShow(repo: FixtureRepo, revPath: string): Buffer {
  return execFileSync('git', ['show', revPath], {
    cwd: repo.root,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(repo.root, '.empty-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

// `<rev>:<path>` resolves to the BLOB object, not the commit — the batch
// response's `sha` field is the blob's oid. Derived independently (via
// `git rev-parse`, never re-derived from the pool itself) for assertions
// below so they don't silently assume the commit sha.
function independentBlobSha(repo: FixtureRepo, revPath: string): string {
  return repo.git(['rev-parse', revPath]);
}

// Independent, OS-level check (via `tasklist`, not the pool's own bookkeeping)
// that a given pid is no longer a running process. Windows-only, matching
// this plan's Windows-first constraint.
function independentlyConfirmDead(pid: number): void {
  const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`]).toString();
  assert.ok(!out.includes(String(pid)), `expected pid ${pid} to be dead, but tasklist still reports it`);
}

test('contents() on an existing blob is byte-identical to an independent `git show`', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const content = 'independent verification content\n';
  const sha = repo.commitFile('verify.txt', content, 'add verify.txt');

  const result = await pool.contents(`${sha}:verify.txt`);
  assert.strictEqual(result.found, true);
  if (!result.found) return;

  const independent = independentGitShow(repo, `${sha}:verify.txt`);
  assert.ok(result.content.equals(independent), 'pool content must byte-match independent git show');
});

test('contents() on a missing path resolves found:false', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const sha = repo.commitFile('a.txt', 'hello\n', 'init');

  const result = await pool.contents(`${sha}:does-not-exist.txt`);
  assert.deepStrictEqual(result, { found: false });
});

test('info() on an existing blob resolves metadata only, no content bytes follow', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const content = 'info metadata check\n';
  const sha = repo.commitFile('info.txt', content, 'add info.txt');

  const result = await pool.info(`${sha}:info.txt`);
  assert.strictEqual(result.found, true);
  if (!result.found) return;
  assert.strictEqual(result.sha, independentBlobSha(repo, `${sha}:info.txt`));
  assert.strictEqual(result.type, 'blob');
  assert.strictEqual(result.size, Buffer.byteLength(content));
  assert.strictEqual(result.content.length, 0);
});

test('Pitfall 1 regression: embedded-newline content parses as one response by declared size, not by splitting on \\n', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const lines = ['line one', 'line two', 'line three', 'line four', 'line five'];
  const content = lines.join('\n') + '\n';
  const sha = repo.commitFile('multiline.txt', content, 'add multiline.txt');

  const result = await pool.contents(`${sha}:multiline.txt`);
  assert.strictEqual(result.found, true);
  if (!result.found) return;
  assert.strictEqual(result.content.length, Buffer.byteLength(content));
  const resultLines = result.content.toString('utf8').split('\n').filter((l) => l.length > 0);
  assert.deepStrictEqual(resultLines, lines);
});

test('Pitfall 2 regression: FIFO correlation holds when a symbolic rev resolves to a different SHA than typed, interleaved with a missing lookup', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const content = 'hello\n';
  const sha = repo.commitFile('a.txt', content, 'init');

  // Both written synchronously, before either is awaited.
  const headPromise = pool.contents(`HEAD:a.txt`);
  const missingPromise = pool.contents(`${sha}:does-not-exist.txt`);

  const [headResult, missingResult] = await Promise.all([headPromise, missingPromise]);

  assert.strictEqual(headResult.found, true);
  if (headResult.found) {
    const blobSha = independentBlobSha(repo, `${sha}:a.txt`);
    assert.strictEqual(headResult.sha, blobSha, 'must carry the resolved SHA, not the literal "HEAD" token');
    assert.notStrictEqual(headResult.sha, 'HEAD');
    assert.deepStrictEqual(headResult.content, Buffer.from(content));
  }
  assert.deepStrictEqual(missingResult, { found: false });
});

test('a batch of 6 mixed contents/info/missing requests, all written before any await, each resolves to its correct result', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const shaA = repo.commitFile('a.txt', 'alpha\n', 'add a');
  const betaContent = 'beta content\nsecond line\n';
  const shaB = repo.commitFile('b.txt', betaContent, 'add b');
  const blobShaA = independentBlobSha(repo, `${shaA}:a.txt`);
  const blobShaB = independentBlobSha(repo, `${shaB}:b.txt`);

  const p1 = pool.contents(`${shaA}:a.txt`);
  const p2 = pool.info(`${shaA}:a.txt`);
  const p3 = pool.contents(`${shaA}:missing.txt`);
  const p4 = pool.contents(`${shaB}:b.txt`);
  const p5 = pool.info(`${shaB}:b.txt`);
  const p6 = pool.contents(`${shaB}:also-missing.txt`);

  const [r1, r2, r3, r4, r5, r6] = await Promise.all([p1, p2, p3, p4, p5, p6]);

  assert.deepStrictEqual(r1, { found: true, sha: blobShaA, type: 'blob', size: 6, content: Buffer.from('alpha\n') });

  assert.strictEqual(r2.found, true);
  if (r2.found) {
    assert.strictEqual(r2.sha, blobShaA);
    assert.strictEqual(r2.type, 'blob');
    assert.strictEqual(r2.size, 6);
    assert.strictEqual(r2.content.length, 0);
  }

  assert.deepStrictEqual(r3, { found: false });

  assert.deepStrictEqual(r4, {
    found: true,
    sha: blobShaB,
    type: 'blob',
    size: Buffer.byteLength(betaContent),
    content: Buffer.from(betaContent),
  });

  assert.strictEqual(r5.found, true);
  if (r5.found) {
    assert.strictEqual(r5.sha, blobShaB);
    assert.strictEqual(r5.size, Buffer.byteLength(betaContent));
    assert.strictEqual(r5.content.length, 0);
  }

  assert.deepStrictEqual(r6, { found: false });
});

test('two sequential single requests (no batching) both resolve correctly', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const sha = repo.commitFile('a.txt', 'hello\n', 'init');
  const blobSha = independentBlobSha(repo, `${sha}:a.txt`);

  const first = await pool.contents(`${sha}:a.txt`);
  assert.deepStrictEqual(first, { found: true, sha: blobSha, type: 'blob', size: 6, content: Buffer.from('hello\n') });

  const second = await pool.contents(`${sha}:a.txt`);
  assert.deepStrictEqual(second, { found: true, sha: blobSha, type: 'blob', size: 6, content: Buffer.from('hello\n') });
});

// --- Task 3: lifecycle hardening ------------------------------------------

test('a process killed externally while a request is pending rejects that pending promise with an Error, not a silent hang', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const sha = repo.commitFile('a.txt', 'hello\n', 'init');

  const promise = pool.contents(`${sha}:a.txt`);
  const pid = pool.pid;
  assert.ok(pid, 'pool must have a pid once a request has been enqueued');
  process.kill(pid, 'SIGKILL');

  await assert.rejects(promise, Error);
});

test('a fresh call after a fatal error automatically spawns a new process (self-heals)', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const sha = repo.commitFile('a.txt', 'hello\n', 'init');
  const blobSha = independentBlobSha(repo, `${sha}:a.txt`);

  const first = pool.contents(`${sha}:a.txt`);
  const firstPid = pool.pid;
  assert.ok(firstPid, 'pool must have a pid once the first request has been enqueued');
  process.kill(firstPid, 'SIGKILL');
  await assert.rejects(first, Error);

  const result = await pool.contents(`${sha}:a.txt`);
  assert.deepStrictEqual(result, { found: true, sha: blobSha, type: 'blob', size: 6, content: Buffer.from('hello\n') });

  const secondPid = pool.pid;
  assert.ok(secondPid, 'pool must have re-spawned a process for the post-crash request');
  assert.notStrictEqual(secondPid, firstPid, 'the pool must not still be pointing at the dead process');
});

test('after idleReapMs elapses with zero pending requests, the underlying process is killed', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false, { idleReapMs: 50 });
  const sha = repo.commitFile('a.txt', 'hello\n', 'init');

  await pool.contents(`${sha}:a.txt`);
  const pid = pool.pid;
  assert.ok(pid, 'pool must have a pid right after a request resolves');

  // Comfortably longer than idleReapMs, with zero requests pending since we
  // awaited the only request above.
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.strictEqual(pool.pid, null, 'pool must have reaped (and forgotten) its idle process');
  independentlyConfirmDead(pid);
});

test('an idle timer that elapses while a request is still pending re-arms rather than killing the process (no fire-while-pending)', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false, { idleReapMs: 1 });
  const sha = repo.commitFile('a.txt', 'hello\n', 'init');
  const blobSha = independentBlobSha(repo, `${sha}:a.txt`);

  // idleReapMs=1ms is far shorter than a freshly spawned subprocess's
  // spawn+respond latency, so the reap timer is virtually guaranteed to
  // elapse at least once while this very first request is still in
  // `#pending`. If `#reap` killed the process instead of re-arming when
  // pending is non-empty, this promise would reject via `#onFatal` instead
  // of resolving — this is the regression the test is actually checking.
  const result = await pool.contents(`${sha}:a.txt`);
  assert.deepStrictEqual(result, { found: true, sha: blobSha, type: 'blob', size: 6, content: Buffer.from('hello\n') });
});

// --- Plan 06: batch-mode detection and legacy (<2.36) `--batch` fallback --

test('detectBatchMode: git 2.53.0.windows.1 (this machine) resolves batch-command', () => {
  assert.strictEqual(detectBatchMode('git version 2.53.0.windows.1'), 'batch-command');
});

test('detectBatchMode: git 2.36.0 (minimum supporting version) resolves batch-command (boundary inclusive)', () => {
  assert.strictEqual(detectBatchMode('git version 2.36.0'), 'batch-command');
});

test('detectBatchMode: git 2.35.1 (just below minimum) resolves batch', () => {
  assert.strictEqual(detectBatchMode('git version 2.35.1'), 'batch');
});

test('detectBatchMode: git 2.9.5 (old) resolves batch', () => {
  assert.strictEqual(detectBatchMode('git version 2.9.5'), 'batch');
});

test('detectBatchMode: a malformed/unparseable version string resolves batch (fail toward the conservative mode)', () => {
  assert.strictEqual(detectBatchMode('not a version string at all'), 'batch');
});

test('[forced batch mode] contents() on an existing blob is byte-identical to an independent `git show`', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false, { mode: 'batch' });
  const content = 'forced batch mode verification content\n';
  const sha = repo.commitFile('verify-batch.txt', content, 'add verify-batch.txt');

  const result = await pool.contents(`${sha}:verify-batch.txt`);
  assert.strictEqual(result.found, true);
  if (!result.found) return;

  const independent = independentGitShow(repo, `${sha}:verify-batch.txt`);
  assert.ok(result.content.equals(independent), 'forced batch-mode content must byte-match independent git show');
});

test('[forced batch mode] contents() on a missing path resolves found:false', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false, { mode: 'batch' });
  const sha = repo.commitFile('a-batch.txt', 'hello\n', 'init');

  const result = await pool.contents(`${sha}:does-not-exist-batch.txt`);
  assert.deepStrictEqual(result, { found: false });
});

test('[forced batch mode] info() returns sha/type/size correctly via the short-lived --batch-check fallback', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false, { mode: 'batch' });
  const content = 'forced batch mode info check\n';
  const sha = repo.commitFile('info-batch.txt', content, 'add info-batch.txt');

  const result = await pool.info(`${sha}:info-batch.txt`);
  assert.strictEqual(result.found, true);
  if (!result.found) return;
  assert.strictEqual(result.sha, independentBlobSha(repo, `${sha}:info-batch.txt`));
  assert.strictEqual(result.type, 'blob');
  assert.strictEqual(result.size, Buffer.byteLength(content));
  assert.strictEqual(result.content.length, 0);
});

test('[forced batch mode] Pitfall 1 regression: embedded-newline content parses by declared size, not by splitting on \\n', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false, { mode: 'batch' });
  const lines = ['line one', 'line two', 'line three', 'line four', 'line five'];
  const content = lines.join('\n') + '\n';
  const sha = repo.commitFile('multiline-batch.txt', content, 'add multiline-batch.txt');

  const result = await pool.contents(`${sha}:multiline-batch.txt`);
  assert.strictEqual(result.found, true);
  if (!result.found) return;
  assert.strictEqual(result.content.length, Buffer.byteLength(content));
  const resultLines = result.content.toString('utf8').split('\n').filter((l) => l.length > 0);
  assert.deepStrictEqual(resultLines, lines);
});

test('[forced batch mode] a mixed batch of contents/info/missing requests, all written before any await, each resolves correctly', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false, { mode: 'batch' });
  const shaA = repo.commitFile('a-mixed-batch.txt', 'alpha\n', 'add a');
  const betaContent = 'beta content\nsecond line\n';
  const shaB = repo.commitFile('b-mixed-batch.txt', betaContent, 'add b');
  const blobShaA = independentBlobSha(repo, `${shaA}:a-mixed-batch.txt`);
  const blobShaB = independentBlobSha(repo, `${shaB}:b-mixed-batch.txt`);

  const p1 = pool.contents(`${shaA}:a-mixed-batch.txt`);
  const p2 = pool.info(`${shaA}:a-mixed-batch.txt`);
  const p3 = pool.contents(`${shaA}:missing-mixed.txt`);
  const p4 = pool.contents(`${shaB}:b-mixed-batch.txt`);
  const p5 = pool.info(`${shaB}:b-mixed-batch.txt`);
  const p6 = pool.contents(`${shaB}:also-missing-mixed.txt`);

  const [r1, r2, r3, r4, r5, r6] = await Promise.all([p1, p2, p3, p4, p5, p6]);

  assert.deepStrictEqual(r1, { found: true, sha: blobShaA, type: 'blob', size: 6, content: Buffer.from('alpha\n') });

  assert.strictEqual(r2.found, true);
  if (r2.found) {
    assert.strictEqual(r2.sha, blobShaA);
    assert.strictEqual(r2.type, 'blob');
    assert.strictEqual(r2.size, 6);
    assert.strictEqual(r2.content.length, 0);
  }

  assert.deepStrictEqual(r3, { found: false });

  assert.deepStrictEqual(r4, {
    found: true,
    sha: blobShaB,
    type: 'blob',
    size: Buffer.byteLength(betaContent),
    content: Buffer.from(betaContent),
  });

  assert.strictEqual(r5.found, true);
  if (r5.found) {
    assert.strictEqual(r5.sha, blobShaB);
    assert.strictEqual(r5.size, Buffer.byteLength(betaContent));
    assert.strictEqual(r5.content.length, 0);
  }

  assert.deepStrictEqual(r6, { found: false });
});

test('auto mode falls back to batch when the version probe is forced to fail (simulated pre-2.36 git), and stays in batch mode for the rest of the pool lifetime', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false, { mode: 'auto', __testForceProbeFailure: true });
  const content = 'auto-fallback verification\n';
  const sha = repo.commitFile('auto-fallback.txt', content, 'add auto-fallback.txt');

  const result = await pool.contents(`${sha}:auto-fallback.txt`);
  assert.strictEqual(result.found, true);
  assert.strictEqual(pool.resolvedMode, 'batch', 'auto mode must have resolved to batch after the forced probe failure');

  const infoResult = await pool.info(`${sha}:auto-fallback.txt`);
  assert.strictEqual(infoResult.found, true);
  assert.strictEqual(pool.resolvedMode, 'batch', 'resolved mode must remain batch for the rest of the pool lifetime');
});

// --- Plan 10 (authorized scope addition): a submodule gitlink's cat-file
// response has no size field at all (`<sha> submodule`, empirically verified
// against this machine's real git — see 02-09's SUMMARY), a wire shape the
// header parser previously had no case for; and `#onFatal`, the sole path
// any parse failure funnels through, previously abandoned the underlying OS
// process on any such failure instead of killing it, orphaning it
// indefinitely. Both are regression-tested here, against a real submodule
// added via the fixture builder's own `addSubmodule`, not a synthetic byte
// sequence. -------------------------------------------------------------

function addSubmoduleFixture(t: import('node:test').TestContext, repo: FixtureRepo): { rev: string; expectedSha: string } {
  const subRepo = createFixtureRepo(false);
  t.after(() => forceRemoveSync(subRepo.root));
  subRepo.commitFile('lib.txt', 'library content\n', 'add lib.txt');
  const rev = repo.addSubmodule(subRepo, 'vendor/sub');
  const expectedSha = repo.git(['rev-parse', `${rev}:vendor/sub`]);
  return { rev, expectedSha };
}

test('contents() on a submodule (gitlink) path resolves found:true with the sizeless "submodule" shape, not a fatal parse error', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const { rev, expectedSha } = addSubmoduleFixture(t, repo);

  const result = await pool.contents(`${rev}:vendor/sub`);
  assert.deepStrictEqual(result, { found: true, sha: expectedSha, type: 'submodule', size: 0, content: Buffer.alloc(0) });
});

test('info() on a submodule (gitlink) path resolves found:true with the sizeless "submodule" shape', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const { rev, expectedSha } = addSubmoduleFixture(t, repo);

  const result = await pool.info(`${rev}:vendor/sub`);
  assert.deepStrictEqual(result, { found: true, sha: expectedSha, type: 'submodule', size: 0, content: Buffer.alloc(0) });
});

test('a sizeless submodule response is not fatal: it neither kills nor respawns the pool\'s process, and the request queue stays in sync', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const { rev } = addSubmoduleFixture(t, repo);

  // Force the process to spawn on an ordinary request first, so `pid` below
  // reflects the SAME process instance across the submodule request.
  await pool.info(`${rev}:.gitmodules`);
  const pidBefore = pool.pid;
  assert.ok(pidBefore, 'pool must have a pid after an ordinary request');

  await pool.contents(`${rev}:vendor/sub`);
  assert.strictEqual(pool.pid, pidBefore, "a sizeless response must not trigger #onFatal (no kill, no respawn)");

  // A follow-up ordinary request on the SAME process must still resolve
  // correctly — proving the pending FIFO queue was never desynced by the
  // sizeless response consuming the wrong number of bytes/entries.
  const followUp = await pool.info(`${rev}:.gitmodules`);
  assert.strictEqual(followUp.found, true);
  assert.strictEqual(pool.pid, pidBefore);
});

test('[forced batch mode] contents()/info() on a submodule path resolve found:true with the sizeless shape via the legacy --batch/--batch-check fallback', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false, { mode: 'batch' });
  const { rev, expectedSha } = addSubmoduleFixture(t, repo);

  const contentsResult = await pool.contents(`${rev}:vendor/sub`);
  assert.deepStrictEqual(contentsResult, {
    found: true,
    sha: expectedSha,
    type: 'submodule',
    size: 0,
    content: Buffer.alloc(0),
  });

  const infoResult = await pool.info(`${rev}:vendor/sub`);
  assert.deepStrictEqual(infoResult, {
    found: true,
    sha: expectedSha,
    type: 'submodule',
    size: 0,
    content: Buffer.alloc(0),
  });
});

test("close() — which now shares #onFatal's single kill path — leaves no live OS process behind, independently verified via tasklist", async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const sha = repo.commitFile('a.txt', 'hello\n', 'init');
  await pool.contents(`${sha}:a.txt`);
  const pid = pool.pid;
  assert.ok(pid, 'pool must have a pid after a request resolves');

  pool.close();
  // Comfortably longer than OS process-teardown latency, mirroring the
  // idle-reap test's own timing tolerance, before an independent (not the
  // pool's own bookkeeping) check confirms the process is actually gone.
  await new Promise((resolve) => setTimeout(resolve, 200));
  independentlyConfirmDead(pid);
  // t.after's own pool.close() (registered by useRepoAndPool) runs after
  // this and must be a safe no-op against an already-closed pool.
});

// ---------------------------------------------------------------------------
// GitBatchContext (ANCH-03 second follow-up): the optional, per-repository,
// batch-scoped cache resolve.ts's new `batchContext` parameter threads
// through. These tests exercise GitBatchContext directly, independent of
// resolve.ts, proving its own caching and coalescing contracts in
// isolation.
// ---------------------------------------------------------------------------

test('GitBatchContext.isGitAvailable: computed at most once, regardless of call count', () => {
  let calls = 0;
  const context = new GitBatchContext({
    isGitAvailable: () => {
      calls += 1;
      return true;
    },
    findRepoRoot: () => null,
  });

  assert.strictEqual(context.isGitAvailable(), true);
  assert.strictEqual(context.isGitAvailable(), true);
  assert.strictEqual(context.isGitAvailable(), true);
  assert.strictEqual(calls, 1);
});

test('GitBatchContext.findRepoRoot: cached per distinct startPath, recomputed for a genuinely different startPath', () => {
  const calls: string[] = [];
  const context = new GitBatchContext({
    isGitAvailable: () => true,
    findRepoRoot: (startPath) => {
      calls.push(startPath);
      return `${startPath}-root`;
    },
  });

  assert.strictEqual(context.findRepoRoot('/repo/a'), '/repo/a-root');
  assert.strictEqual(context.findRepoRoot('/repo/a'), '/repo/a-root');
  assert.strictEqual(context.findRepoRoot('/repo/b'), '/repo/b-root');
  assert.deepStrictEqual(calls, ['/repo/a', '/repo/b']);
});

test('GitBatchContext.findRepoRoot: a cached null (no .git ancestor) is served from cache too, not recomputed as if uncached', () => {
  let calls = 0;
  const context = new GitBatchContext({
    isGitAvailable: () => true,
    findRepoRoot: () => {
      calls += 1;
      return null;
    },
  });

  assert.strictEqual(context.findRepoRoot('/no/git/here'), null);
  assert.strictEqual(context.findRepoRoot('/no/git/here'), null);
  assert.strictEqual(calls, 1);
});

test('GitBatchContext.isWorkingTreeDirtyAt: N concurrent calls collapse into exactly ONE underlying batch invocation covering all N entries', async () => {
  let batchCalls = 0;
  let lastEntryCount = 0;
  const context = new GitBatchContext(undefined, (repoRoot, entries) => {
    batchCalls += 1;
    lastEntryCount = entries.length;
    return entries.map((e) => e.blobSha !== 'matches');
  });

  const results = await Promise.all([
    context.isWorkingTreeDirtyAt('/repo', 'a.txt', 'matches'),
    context.isWorkingTreeDirtyAt('/repo', 'b.txt', 'does-not-match'),
    context.isWorkingTreeDirtyAt('/repo', 'c.txt', 'matches'),
  ]);

  assert.deepStrictEqual(results, [false, true, false]);
  assert.strictEqual(batchCalls, 1, 'three concurrently-issued calls must produce exactly one batch invocation');
  assert.strictEqual(lastEntryCount, 3);
});

test('GitBatchContext.isWorkingTreeDirtyAt: calls separated by a real await (not concurrent) still each resolve correctly, in separate flushes', async () => {
  let batchCalls = 0;
  const context = new GitBatchContext(undefined, (repoRoot, entries) => {
    batchCalls += 1;
    return entries.map((e) => e.blobSha !== 'clean-sha');
  });

  const first = await context.isWorkingTreeDirtyAt('/repo', 'a.txt', 'clean-sha');
  const second = await context.isWorkingTreeDirtyAt('/repo', 'b.txt', 'dirty-sha');

  assert.strictEqual(first, false);
  assert.strictEqual(second, true);
  assert.strictEqual(batchCalls, 2, 'two genuinely sequential calls (each awaited before the next starts) must not be merged');
});

test('GitBatchContext.isWorkingTreeDirtyAt: a flush that throws rejects every pending entry in that flush, never silently resolves clean', async () => {
  const context = new GitBatchContext(undefined, () => {
    throw new Error('simulated hash-object failure');
  });

  await assert.rejects(
    () => context.isWorkingTreeDirtyAt('/repo', 'a.txt', 'sha'),
    /simulated hash-object failure/,
  );
});

test('GitBatchContext.isWorkingTreeDirtyAt: end-to-end against a real fixture repo (no injected batch fn), matching isWorkingTreeDirtyAt\'s own answer', async (t) => {
  const repo = createFixtureRepo(false);
  t.after(() => forceRemoveSync(repo.root));
  const rev = repo.commitFile('real.txt', 'original\n', 'add real.txt');
  const sha = repo.git(['rev-parse', `${rev}:real.txt`]);
  repo.writeDirty('real.txt', 'edited without committing\n');

  const context = new GitBatchContext();
  const dirty = await context.isWorkingTreeDirtyAt(repo.root, 'real.txt', sha);
  assert.strictEqual(dirty, true);
});
