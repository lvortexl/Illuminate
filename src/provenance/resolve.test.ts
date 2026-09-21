import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureRepo } from '../../test/fixtures/git-repo.ts';
import type { FixtureRepo } from '../../test/fixtures/git-repo.ts';
import { GitBatchPool, GitBatchContext } from './git-batch-pool.ts';
import { anchorHash } from './hash.ts';
import { resolve } from './resolve.ts';
import { forceRemove, forceRemoveSync } from '../../test/fixtures/cleanup.ts';

const HASH = 'abcdef0123456789';
function useRepoAndPool(t: import('node:test').TestContext, autocrlf = false): { repo: FixtureRepo; pool: GitBatchPool } {
  const repo = createFixtureRepo(autocrlf);
  const pool = new GitBatchPool(repo.root);
  t.after(async () => {
    pool.close();
    await forceRemove(repo.root);
  });
  return { repo, pool };
}

/** A plain directory with no `.git` ancestor at all, for the no-git degrade cases. */
function usePlainDir(t: import('node:test').TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'illum-resolve-no-git-')));
  t.after(() => forceRemoveSync(root));
  return root;
}

/** Joins lines with a single trailing newline, matching git's own convention. */
function block(lines: readonly string[]): string {
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Task 1: security refusal, unanchored degrade, and no-git serving
// ---------------------------------------------------------------------------

test('unanchored: input null has no path context, resolves to unanchored with content null, never throws', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  const result = await resolve(repo.root, null, pool);
  assert.strictEqual(result.status, 'unanchored');
  assert.strictEqual(result.content, null);
  assert.strictEqual(result.eligibleForStaleness, false);
  assert.notStrictEqual(result.reason, null);
});

test('refused: a path-traversal anchor (../../.ssh/id_rsa) is refused before any git call', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  let contentsCalled = false;
  const originalContents = pool.contents.bind(pool);
  pool.contents = (async (revPath: string) => {
    contentsCalled = true;
    return originalContents(revPath);
  }) as typeof pool.contents;
  let isGitAvailableCalled = false;

  const result = await resolve(
    repo.root,
    { path: '../../.ssh/id_rsa', anchorHash: HASH },
    pool,
    {
      isGitAvailable: () => {
        isGitAvailableCalled = true;
        return true;
      },
      findRepoRoot: () => repo.root,
    },
  );

  assert.strictEqual(result.status, 'refused');
  assert.strictEqual(result.content, null);
  assert.strictEqual(result.eligibleForStaleness, false);
  assert.notStrictEqual(result.reason, null);
  assert.strictEqual(contentsCalled, false, 'pool.contents must never be invoked for a refused path');
  assert.strictEqual(isGitAvailableCalled, false, 'isGitAvailable must never be invoked for a refused path');
});

test('refused: a path-traversal anchor (../.env) is refused before any git call', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  const result = await resolve(repo.root, { path: '../.env', anchorHash: HASH }, pool);
  assert.strictEqual(result.status, 'refused');
  assert.strictEqual(result.content, null);
});

test('refused: a malformed anchor is refused with a reason distinct from a path-escape refusal', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  repo.commitFile('file.txt', 'hello\n', 'add file.txt');

  const escapeResult = await resolve(repo.root, { path: '../.env', anchorHash: HASH }, pool);
  const malformedResult = await resolve(repo.root, { path: 'file.txt', range: 'banana', anchorHash: HASH }, pool);

  assert.strictEqual(malformedResult.status, 'refused');
  assert.notStrictEqual(malformedResult.reason, null);
  assert.notStrictEqual(malformedResult.reason, escapeResult.reason);
});

// ADR-001 changed this case deliberately. A missing data-anchor-hash USED to
// be refused, which meant a present, readable, correctly-named file was never
// opened and `verify` answered "no resolved source content is available"
// without looking. It is now the weaker file-level tier instead. The pinned
// tier's mandatory-hash rule is untouched -- see parseAnchor, which still
// refuses, and which this path deliberately routes around rather than
// relaxing.
test('file-level: a missing data-anchor-hash serves working-tree content instead of refusing', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  repo.commitFile('file.txt', 'hello\n', 'add file.txt');

  const result = await resolve(repo.root, { path: 'file.txt', anchorHash: '' }, pool);

  assert.strictEqual(result.status, 'file-level');
  assert.match(result.content ?? '', /hello/);
  // Weaker on purpose: no pinned rev, and never drift-checked.
  assert.strictEqual(result.resolvedRev, null);
  assert.strictEqual(result.eligibleForStaleness, false);
});

test('no-git: findRepoRoot returns null (no .git ancestor) serves content directly from the confined path', async (t) => {
  const root = usePlainDir(t);
  writeFileSync(join(root, 'plain.txt'), 'line one\nline two\nline three\n');
  const pool = new GitBatchPool(root);
  t.after(() => pool.close());

  const result = await resolve(root, { path: 'plain.txt', anchorHash: HASH }, pool);

  assert.strictEqual(result.status, 'no-git');
  assert.strictEqual(result.content, 'line one\nline two\nline three\n');
  assert.strictEqual(result.eligibleForStaleness, false);
  assert.notStrictEqual(result.reason, null);
});

test('no-git: containment is STILL enforced even though no git repo is involved', async (t) => {
  const root = usePlainDir(t);
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'inside.txt'), 'inside\n');
  writeFileSync(join(root, 'outside.txt'), 'outside\n');
  const pool = new GitBatchPool(root);
  t.after(() => pool.close());

  // Anchor rooted at `nested/`, path escapes back up to a sibling file.
  const result = await resolve(join(root, 'nested'), { path: '../outside.txt', anchorHash: HASH }, pool);

  assert.strictEqual(result.status, 'refused');
  assert.strictEqual(result.content, null);
});

test('no-git: git binary unavailable (injected via deps) resolves to no-git without touching the real PATH', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  repo.commitFile('file.txt', 'hello\n', 'add file.txt');

  const result = await resolve(repo.root, { path: 'file.txt', anchorHash: HASH }, pool, {
    isGitAvailable: () => false,
    findRepoRoot: () => repo.root,
  });

  assert.strictEqual(result.status, 'no-git');
  assert.strictEqual(result.content, 'hello\n');
});

// ---------------------------------------------------------------------------
// Task 2: git-present pre-checks, unpinned resolution, and drift delegation
// ---------------------------------------------------------------------------

test('cannot-determine: an unreachable data-rev', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  repo.commitFile('file.txt', 'hello\n', 'add file.txt');

  const result = await resolve(
    repo.root,
    { path: 'file.txt', rev: repo.unreachableRev(), anchorHash: HASH },
    pool,
  );

  assert.strictEqual(result.status, 'cannot-determine');
  assert.strictEqual(result.eligibleForStaleness, false);
  assert.strictEqual(result.content, null);
});

test('cannot-determine: a dirty working tree at the anchored path', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  const region = ['line 1', 'line 2', 'line 3'];
  const rev = repo.commitFile('dirty.txt', block(region), 'add dirty.txt');
  repo.writeDirty('dirty.txt', block(['line 1', 'line 2 EDITED', 'line 3']));

  const result = await resolve(
    repo.root,
    { path: 'dirty.txt', range: 'L1-L3', rev, anchorHash: anchorHash(region.join('\n')) },
    pool,
  );

  assert.strictEqual(result.status, 'cannot-determine');
  assert.strictEqual(result.eligibleForStaleness, false);
});

test('cannot-determine: an anchored path inside an added submodule', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  const subRepo = createFixtureRepo(false);
  t.after(async () => forceRemove(subRepo.root));
  subRepo.commitFile('lib.txt', 'library content\n', 'add lib.txt');

  const rev = repo.addSubmodule(subRepo, 'vendor/sub');

  const result = await resolve(repo.root, { path: 'vendor/sub', rev, anchorHash: HASH }, pool);

  assert.strictEqual(result.status, 'cannot-determine');
  assert.strictEqual(result.eligibleForStaleness, false);
});

test('cannot-determine: a shallow clone where data-rev predates the boundary, via the same isRevReachable path as plain unreachability', async (t) => {
  const { repo, pool: originalPool } = useRepoAndPool(t);
  const oldRev = repo.commitFile('a.txt', 'v1\n', 'add a.txt');
  repo.commitFile('a.txt', 'v2\n', 'edit a.txt');
  repo.commitFile('a.txt', 'v3\n', 'edit a.txt again');
  originalPool.close();

  const shallow = repo.cloneShallow(1);
  const pool = new GitBatchPool(shallow.root);
  // pool.close() MUST be registered (and therefore run) before forceRemove
  // — see this file's teardown-ordering comment above `forceRemove`. Before
  // Plan 10's ANCH-03 fix, `isRevReachable`'s execFileSync form never
  // touched `pool` at all on this code path (a plain unreachable rev short-
  // circuits before any pool call), so the pool's subprocess was never
  // actually spawned and this ordering bug was latent. Now that the
  // reachability pre-check legitimately spawns the pool's long-lived
  // process (the whole point of the fix), the wrong order raced a live
  // `git cat-file --batch-command` process (cwd = shallow.root) against
  // `rmSync`, intermittently EPERM-ing on Windows.
  t.after(() => pool.close());
  t.after(async () => forceRemove(shallow.root));

  const result = await resolve(shallow.root, { path: 'a.txt', rev: oldRev, anchorHash: HASH }, pool);

  assert.strictEqual(result.status, 'cannot-determine');
});

test('unpinned (A4): data-rev absent resolves against HEAD, marked ineligible for staleness even though the state is unchanged', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  const region = ['alpha', 'beta', 'gamma'];
  repo.commitFile('unpinned.txt', block(region), 'add unpinned.txt');
  const headSha = repo.git(['rev-parse', 'HEAD']);

  const result = await resolve(
    repo.root,
    { path: 'unpinned.txt', range: 'L1-L3', anchorHash: anchorHash(region.join('\n')) },
    pool,
  );

  assert.strictEqual(result.status, 'unchanged');
  assert.strictEqual(result.eligibleForStaleness, false);
  assert.strictEqual(result.resolvedRev, headSha);
  assert.strictEqual(result.content, region.join('\n'));
});

test('a fully normal, unmodified, pinned anchor resolves to unchanged with byte-exact content and staleness eligibility', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  const region = ['one', 'two', 'three', 'four'];
  const rev = repo.commitFile('pinned.txt', block(region), 'add pinned.txt');

  const result = await resolve(
    repo.root,
    { path: 'pinned.txt', range: 'L1-L4', rev, anchorHash: anchorHash(region.join('\n')) },
    pool,
  );

  const expected = execFileSync('git', ['show', `${rev}:pinned.txt`], { cwd: repo.root, encoding: 'utf8' });

  assert.strictEqual(result.status, 'unchanged');
  assert.strictEqual(result.content, region.join('\n'));
  assert.strictEqual(`${result.content}\n`, expected, 'must be byte-identical to `git show <rev>:<path>` (modulo the whole-file trailing newline)');
  assert.strictEqual(result.eligibleForStaleness, true);
});

// ---------------------------------------------------------------------------
// Task 3: end-to-end integration scenarios against ONE shared, richly built
// fixture repo (plus one second, git-less directory for the no-git case),
// proving the full wiring works together rather than each module in
// isolation the way Tasks 1/2's per-case fixtures do.
// ---------------------------------------------------------------------------

let sharedRepo: FixtureRepo;
let sharedPool: GitBatchPool;
let unchangedRev: string;
let movedRev: string;
let noGitRoot: string;

const unchangedRegion = Array.from({ length: 8 }, (_, i) => `shared unchanged line ${i + 1}`);
const movedRegion = Array.from({ length: 10 }, (_, i) => `shared moved region line ${i + 1}`);

before(() => {
  sharedRepo = createFixtureRepo(false);
  sharedPool = new GitBatchPool(sharedRepo.root);

  unchangedRev = sharedRepo.commitFile(
    'int-unchanged.txt',
    block(['ctx a', 'ctx b', ...unchangedRegion]),
    'add int-unchanged.txt',
  );

  movedRev = sharedRepo.commitFile(
    'int-moved.txt',
    block([...movedRegion, 'tail 1', 'tail 2']),
    'add int-moved.txt',
  );
  const inserted = Array.from({ length: 30 }, (_, i) => `inserted line ${i + 1}`);
  sharedRepo.commitFile(
    'int-moved.txt',
    block([...inserted, ...movedRegion, 'tail 1', 'tail 2']),
    'insert 30 unrelated lines above the moved region',
  );

  noGitRoot = realpathSync(mkdtempSync(join(tmpdir(), 'illum-resolve-int-no-git-')));
  writeFileSync(join(noGitRoot, 'standalone.txt'), 'standalone content, no git repository involved\n');
});

after(async () => {
  sharedPool.close();
  await forceRemove(sharedRepo.root);
  forceRemoveSync(noGitRoot);
});

test('integration (a): an unchanged anchor resolves with byte-exact content', async () => {
  const result = await resolve(
    sharedRepo.root,
    {
      path: 'int-unchanged.txt',
      range: 'L3-L10',
      rev: unchangedRev,
      anchorHash: anchorHash(unchangedRegion.join('\n')),
    },
    sharedPool,
  );

  assert.strictEqual(result.status, 'unchanged');
  assert.strictEqual(result.content, unchangedRegion.join('\n'));
  assert.strictEqual(result.eligibleForStaleness, true);
});

test('integration (b): a relocated region (Stage A line-shift) resolves to moved with the corrected range', async () => {
  const result = await resolve(
    sharedRepo.root,
    { path: 'int-moved.txt', range: 'L1-L10', rev: movedRev, anchorHash: anchorHash(movedRegion.join('\n')) },
    sharedPool,
  );

  assert.strictEqual(result.status, 'moved');
  assert.deepStrictEqual(result.resolvedRange, { startLine: 31, endLine: 40 });
  assert.strictEqual(result.content, movedRegion.join('\n'));
});

test('integration (c): a path-traversal anchor against this same repo is refused', async () => {
  const result = await resolve(sharedRepo.root, { path: '../../../../etc/passwd', anchorHash: HASH }, sharedPool);

  assert.strictEqual(result.status, 'refused');
  assert.strictEqual(result.content, null);
});

test('integration (d): a second, git-less directory degrades to no-git and serves real content', async () => {
  // Deliberately passes `sharedPool` (bound to `sharedRepo.root`, a
  // different directory entirely) rather than constructing a fresh pool for
  // `noGitRoot`: the no-git branch must never touch the pool at all, so
  // handing it one bound to an unrelated repository is itself part of the
  // proof — if this path ever mistakenly reached into the pool, it would be
  // asking the wrong repository entirely and this assertion would fail.
  const result = await resolve(noGitRoot, { path: 'standalone.txt', anchorHash: HASH }, sharedPool);

  assert.strictEqual(result.status, 'no-git');
  assert.strictEqual(result.content, 'standalone content, no git repository involved\n');
  assert.strictEqual(result.eligibleForStaleness, false);
});

// ---------------------------------------------------------------------------
// batchContext (ANCH-03 second follow-up): the optional 5th parameter. Every
// scenario below has an existing no-batchContext counterpart above (proving
// the SAME outcome either way) -- these tests exist specifically to prove
// resolve()'s own refusal semantics do not shift when a GitBatchContext is
// supplied, per this plan's explicit invariant.
// ---------------------------------------------------------------------------

test('batchContext: git binary unavailable (injected via a GitBatchContext) resolves to no-git, same as the deps-injection form', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  repo.commitFile('file.txt', 'hello\n', 'add file.txt');
  const batchContext = new GitBatchContext({ isGitAvailable: () => false, findRepoRoot: () => repo.root });

  const result = await resolve(repo.root, { path: 'file.txt', anchorHash: HASH }, pool, undefined, batchContext);

  assert.strictEqual(result.status, 'no-git');
  assert.strictEqual(result.content, 'hello\n');
});

test('batchContext: a dirty working tree at the anchored path resolves to cannot-determine, same as the no-context form', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  const region = ['line 1', 'line 2', 'line 3'];
  const rev = repo.commitFile('dirty.txt', block(region), 'add dirty.txt');
  repo.writeDirty('dirty.txt', block(['line 1', 'line 2 EDITED', 'line 3']));
  const batchContext = new GitBatchContext();

  const result = await resolve(
    repo.root,
    { path: 'dirty.txt', range: 'L1-L3', rev, anchorHash: anchorHash(region.join('\n')) },
    pool,
    undefined,
    batchContext,
  );

  assert.strictEqual(result.status, 'cannot-determine');
  assert.strictEqual(result.eligibleForStaleness, false);
});

test('batchContext: a clean pinned anchor resolves to unchanged with byte-exact content, same as the no-context form', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  const region = ['one', 'two', 'three', 'four'];
  const rev = repo.commitFile('pinned.txt', block(region), 'add pinned.txt');
  const batchContext = new GitBatchContext();

  const result = await resolve(
    repo.root,
    { path: 'pinned.txt', range: 'L1-L4', rev, anchorHash: anchorHash(region.join('\n')) },
    pool,
    undefined,
    batchContext,
  );

  assert.strictEqual(result.status, 'unchanged');
  assert.strictEqual(result.content, region.join('\n'));
  assert.strictEqual(result.eligibleForStaleness, true);
});

test('batchContext: concurrent anchors (clean, dirty, clean) sharing ONE GitBatchContext all classify correctly, proving no cross-anchor contamination from the shared flush', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  const cleanRegionA = ['alpha 1', 'alpha 2'];
  const cleanRevA = repo.commitFile('clean-a.txt', block(cleanRegionA), 'add clean-a.txt');
  const dirtyRegion = ['beta 1', 'beta 2'];
  const dirtyRev = repo.commitFile('dirty-b.txt', block(dirtyRegion), 'add dirty-b.txt');
  const cleanRegionC = ['gamma 1', 'gamma 2'];
  const cleanRevC = repo.commitFile('clean-c.txt', block(cleanRegionC), 'add clean-c.txt');
  // Written LAST, after every `commitFile` call above: `commitFile` stages
  // via `git add -A` (test/fixtures/git-repo.ts), which would otherwise
  // sweep this uncommitted edit into a LATER commit and silently turn this
  // into a "committed edit" (touched) scenario instead of the intended
  // "dirty working tree" one.
  repo.writeDirty('dirty-b.txt', block(['beta 1 EDITED', 'beta 2']));
  const batchContext = new GitBatchContext();

  const [resultA, resultB, resultC] = await Promise.all([
    resolve(
      repo.root,
      { path: 'clean-a.txt', range: 'L1-L2', rev: cleanRevA, anchorHash: anchorHash(cleanRegionA.join('\n')) },
      pool,
      undefined,
      batchContext,
    ),
    resolve(
      repo.root,
      { path: 'dirty-b.txt', range: 'L1-L2', rev: dirtyRev, anchorHash: anchorHash(dirtyRegion.join('\n')) },
      pool,
      undefined,
      batchContext,
    ),
    resolve(
      repo.root,
      { path: 'clean-c.txt', range: 'L1-L2', rev: cleanRevC, anchorHash: anchorHash(cleanRegionC.join('\n')) },
      pool,
      undefined,
      batchContext,
    ),
  ]);

  assert.strictEqual(resultA.status, 'unchanged');
  assert.strictEqual(resultA.content, cleanRegionA.join('\n'));
  assert.strictEqual(resultB.status, 'cannot-determine');
  assert.strictEqual(resultC.status, 'unchanged');
  assert.strictEqual(resultC.content, cleanRegionC.join('\n'));
});

// ---------------------------------------------------------------------------
// STAL-03: `lost` through the real public entry point.
//
// Before this, `resolve()` could never report `lost` for a genuinely deleted
// cited file: `parseAnchor` -> `confineToRepoRoot` -> `realpathSync` threw on
// the missing path and the anchor came back `refused: path escapes repo root`,
// so `classifyDrift`'s own correct `lost` branch was structurally unreachable.
// Phase 8's own audit found this and noted that `resolve.test.ts` had ZERO
// tests naming `lost` anywhere. These are those tests.
// ---------------------------------------------------------------------------

test('STAL-03: a cited file DELETED from HEAD resolves as lost through resolve(), not refused', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  const region = ['widget one', 'widget two', 'widget three'];
  const rev = repo.commitFile('widget.ts', block(region), 'add widget.ts');

  repo.deleteFile('widget.ts', 'delete widget.ts');

  const result = await resolve(
    repo.root,
    { path: 'widget.ts', range: 'L1-L3', rev, anchorHash: anchorHash(region.join('\n')) },
    pool,
  );

  assert.strictEqual(result.status, 'lost', `expected lost, got ${result.status} (${result.reason ?? 'no reason'})`);
  assert.strictEqual(result.eligibleForStaleness, true, 'a lost anchor must be eligible for staleness, or no finding is ever raised');
  assert.strictEqual(result.content, null);
  assert.strictEqual(result.resolvedRange, null);
});

test('STAL-03: deleting the file does NOT weaken containment -- an escaping path is still refused whether or not it exists', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  const region = ['alpha'];
  const rev = repo.commitFile('present.txt', block(region), 'add present.txt');

  const escaping = await resolve(
    repo.root,
    { path: '../../../etc/passwd', range: 'L1-L1', rev, anchorHash: anchorHash(region.join('\n')) },
    pool,
  );
  assert.strictEqual(escaping.status, 'refused');
  assert.strictEqual(escaping.reason, 'path escapes repo root');

  const escapingMissing = await resolve(
    repo.root,
    { path: '../../../nonexistent-sibling/gone.txt', range: 'L1-L1', rev, anchorHash: anchorHash(region.join('\n')) },
    pool,
  );
  assert.strictEqual(escapingMissing.status, 'refused', 'a MISSING escaping path must be refused too');
  assert.strictEqual(escapingMissing.reason, 'path escapes repo root');

  const absolute = await resolve(
    repo.root,
    { path: '/etc/passwd', range: 'L1-L1', rev, anchorHash: anchorHash(region.join('\n')) },
    pool,
  );
  assert.strictEqual(absolute.status, 'refused');
});

test('STAL-03: a file deleted and then RESTORED with identical content resolves back to unchanged', async (t) => {
  const { repo, pool } = useRepoAndPool(t);
  const region = ['restore me', 'second line'];
  const rev = repo.commitFile('restored.ts', block(region), 'add restored.ts');

  repo.deleteFile('restored.ts', 'delete restored.ts');
  const lost = await resolve(
    repo.root,
    { path: 'restored.ts', range: 'L1-L2', rev, anchorHash: anchorHash(region.join('\n')) },
    pool,
  );
  assert.strictEqual(lost.status, 'lost');

  repo.commitFile('restored.ts', block(region), 'restore restored.ts');
  const back = await resolve(
    repo.root,
    { path: 'restored.ts', range: 'L1-L2', rev, anchorHash: anchorHash(region.join('\n')) },
    pool,
  );
  assert.strictEqual(back.status, 'unchanged', 'restoring identical content must clear the lost state');
  assert.strictEqual(back.content, region.join('\n'));
});
