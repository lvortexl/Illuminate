import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureRepo } from '../../test/fixtures/git-repo.ts';
import type { FixtureRepo } from '../../test/fixtures/git-repo.ts';
import { forceRemoveSync } from '../../test/fixtures/cleanup.ts';
import {
  isRevReachable,
  getAutocrlf,
  isWorkingTreeDirtyAt,
  isWorkingTreeDirtyAtBatch,
  findRepoRoot,
  isGitAvailable,
  isSubmodulePath,
  detectRename,
  parseDiffHunks,
} from './git-meta.ts';

function usingFixture(t: import('node:test').TestContext, autocrlf: boolean): FixtureRepo {
  const repo = createFixtureRepo(autocrlf);
  t.after(() => forceRemoveSync(repo.root));
  return repo;
}

// ---------------------------------------------------------------------------
// Task 1: reachability, autocrlf, dirty-tree, repo-root, git-binary,
// submodule detection
// ---------------------------------------------------------------------------

test('isRevReachable: a real committed rev is reachable', (t) => {
  const repo = usingFixture(t, false);
  const rev = repo.commitFile('a.txt', 'hello\n', 'add a.txt');
  assert.strictEqual(isRevReachable(repo.root, rev), true);
});

test('isRevReachable: a rev that was never committed is unreachable', (t) => {
  const repo = usingFixture(t, false);
  repo.commitFile('a.txt', 'hello\n', 'add a.txt');
  assert.strictEqual(isRevReachable(repo.root, repo.unreachableRev()), false);
});

test('isRevReachable: a rev predating a shallow clone boundary is unreachable inside the clone, reachable in the original', (t) => {
  const repo = usingFixture(t, false);
  const oldRev = repo.commitFile('a.txt', 'first\n', 'commit 1');
  repo.commitFile('b.txt', 'second\n', 'commit 2');

  const shallow = repo.cloneShallow(1);
  t.after(() => forceRemoveSync(shallow.root));

  assert.strictEqual(isRevReachable(shallow.root, oldRev), false);
  assert.strictEqual(isRevReachable(repo.root, oldRev), true);
});

test('getAutocrlf: reports "true" for a fixture created with autocrlf true', (t) => {
  const repo = usingFixture(t, true);
  assert.strictEqual(getAutocrlf(repo.root), 'true');
});

test('getAutocrlf: reports "false" for a fixture created with autocrlf false', (t) => {
  const repo = usingFixture(t, false);
  assert.strictEqual(getAutocrlf(repo.root), 'false');
});

test('isWorkingTreeDirtyAt: a clean file (working tree === committed blob) is not dirty', (t) => {
  const repo = usingFixture(t, false);
  const rev = repo.commitFile('clean.txt', 'unchanged content\n', 'add clean.txt');
  const blobSha = repo.git(['rev-parse', `${rev}:clean.txt`]);
  assert.strictEqual(isWorkingTreeDirtyAt(repo.root, 'clean.txt', blobSha), false);
});

test('isWorkingTreeDirtyAt: a file modified without committing is dirty', (t) => {
  const repo = usingFixture(t, false);
  const rev = repo.commitFile('dirty.txt', 'original content\n', 'add dirty.txt');
  const blobSha = repo.git(['rev-parse', `${rev}:dirty.txt`]);
  repo.writeDirty('dirty.txt', 'modified content\n');
  assert.strictEqual(isWorkingTreeDirtyAt(repo.root, 'dirty.txt', blobSha), true);
});

test('isWorkingTreeDirtyAt (ANCH-06 proof): a freshly checked-out CRLF working-tree file is reported clean against its LF-normalized blob', (t) => {
  const repo = usingFixture(t, true);
  const rev = repo.commitFile('crlf.txt', 'line one\nline two\n', 'add crlf.txt', { crlf: true });
  const blobSha = repo.git(['rev-parse', `${rev}:crlf.txt`]);
  // Force git to regenerate the working-tree file from the blob via its own
  // smudge filter (core.autocrlf=true converts the LF blob back to CRLF on
  // checkout), rather than relying on the raw bytes this test process wrote —
  // this is the direct empirical ANCH-06 proof for this module.
  repo.git(['checkout', '--', 'crlf.txt']);
  assert.strictEqual(isWorkingTreeDirtyAt(repo.root, 'crlf.txt', blobSha), false);
});

// ---------------------------------------------------------------------------
// isWorkingTreeDirtyAtBatch: the ANCH-03 follow-up's batched form of
// isWorkingTreeDirtyAt above -- one `git hash-object --stdin-paths` call for
// many (relPath, blobSha) pairs, positionally correlated to the input.
// ---------------------------------------------------------------------------

test('isWorkingTreeDirtyAtBatch: matches the single-call form for a batch of clean and dirty files, in input order', (t) => {
  const repo = usingFixture(t, false);
  const cleanRev = repo.commitFile('clean.txt', 'unchanged content\n', 'add clean.txt');
  const cleanSha = repo.git(['rev-parse', `${cleanRev}:clean.txt`]);
  const dirtyRev = repo.commitFile('dirty.txt', 'original content\n', 'add dirty.txt');
  const dirtySha = repo.git(['rev-parse', `${dirtyRev}:dirty.txt`]);
  repo.writeDirty('dirty.txt', 'modified content\n');

  const results = isWorkingTreeDirtyAtBatch(repo.root, [
    { relPath: 'clean.txt', blobSha: cleanSha },
    { relPath: 'dirty.txt', blobSha: dirtySha },
  ]);

  assert.deepStrictEqual([...results], [false, true]);
});

test('isWorkingTreeDirtyAtBatch: a path missing from disk resolves true (dirty) WITHOUT poisoning sibling results in the same batch', (t) => {
  // Direct empirical proof of this plan's central finding: `git hash-object
  // --stdin-paths` aborts the ENTIRE remaining batch on the first missing
  // path (verified against this machine's git 2.53.0.windows.1 -- see this
  // plan's SUMMARY). The missing path is placed in the MIDDLE, with a real
  // file on EACH side, so a regression that fed every path straight through
  // (no existsSync pre-filter) would lose the file listed AFTER the missing
  // one, not just fail to answer for the missing one itself.
  const repo = usingFixture(t, false);
  const aRev = repo.commitFile('a.txt', 'AAA\n', 'add a.txt');
  const aSha = repo.git(['rev-parse', `${aRev}:a.txt`]);
  const cRev = repo.commitFile('c.txt', 'CCC\n', 'add c.txt');
  const cSha = repo.git(['rev-parse', `${cRev}:c.txt`]);
  // A syntactically valid relative path that was never written to disk at
  // all -- not committed, not dirty-written, genuinely absent.

  const results = isWorkingTreeDirtyAtBatch(repo.root, [
    { relPath: 'a.txt', blobSha: aSha },
    { relPath: 'missing-never-written.txt', blobSha: 'deadbeef' },
    { relPath: 'c.txt', blobSha: cSha },
  ]);

  assert.deepStrictEqual([...results], [false, true, false]);
});

test('isWorkingTreeDirtyAtBatch (ANCH-06 proof): a batch mixing a CRLF-checked-out file with a plain file both hash correctly against their LF-normalized blobs', (t) => {
  const repo = usingFixture(t, true);
  const crlfRev = repo.commitFile('crlf.txt', 'line one\nline two\n', 'add crlf.txt', { crlf: true });
  const crlfSha = repo.git(['rev-parse', `${crlfRev}:crlf.txt`]);
  repo.git(['checkout', '--', 'crlf.txt']);
  const plainRev = repo.commitFile('plain.txt', 'plain\n', 'add plain.txt');
  const plainSha = repo.git(['rev-parse', `${plainRev}:plain.txt`]);

  const results = isWorkingTreeDirtyAtBatch(repo.root, [
    { relPath: 'crlf.txt', blobSha: crlfSha },
    { relPath: 'plain.txt', blobSha: plainSha },
  ]);

  assert.deepStrictEqual([...results], [false, false]);
});

test('isWorkingTreeDirtyAtBatch: an empty entry list resolves an empty array without spawning git at all', (t) => {
  const repo = usingFixture(t, false);
  assert.deepStrictEqual([...isWorkingTreeDirtyAtBatch(repo.root, [])], []);
});

test('findRepoRoot: resolves the repo root from a path two directories below it', (t) => {
  const repo = usingFixture(t, false);
  repo.commitFile('a/b/nested.txt', 'nested\n', 'add nested file');
  const result = findRepoRoot(join(repo.root, 'a', 'b'));
  // realpathSync.native, not the JS-only realpathSync: on Windows the two can
  // disagree in case for a path with no symlinks (e.g. os.tmpdir()'s
  // `C:\Windows\TEMP` vs the true on-disk `C:\Windows\Temp`) — see the
  // matching comment in findRepoRoot's implementation.
  assert.strictEqual(result, realpathSync.native(repo.root));
});

test('findRepoRoot: returns null from a plain temp directory with no .git ancestor', (t) => {
  const plain = mkdtempSync(join(tmpdir(), 'illum-no-git-'));
  t.after(() => forceRemoveSync(plain));
  assert.strictEqual(findRepoRoot(plain), null);
});

test('isGitAvailable: reports true on this machine', () => {
  assert.strictEqual(isGitAvailable(), true);
});

test('isSubmodulePath: a path added via addSubmodule is reported as a submodule path', (t) => {
  const repo = usingFixture(t, false);
  const subRepo = usingFixture(t, false);
  subRepo.commitFile('lib.txt', 'library content\n', 'add lib.txt');

  const rev = repo.addSubmodule(subRepo, 'vendor/sub');
  assert.strictEqual(isSubmodulePath(repo.root, rev, 'vendor/sub'), true);
});

test('isSubmodulePath: a path nested under a submodule path is reported as a submodule path', (t) => {
  const repo = usingFixture(t, false);
  const subRepo = usingFixture(t, false);
  subRepo.commitFile('lib.txt', 'library content\n', 'add lib.txt');

  const rev = repo.addSubmodule(subRepo, 'vendor/sub');
  assert.strictEqual(isSubmodulePath(repo.root, rev, 'vendor/sub/lib.txt'), true);
});

test('isSubmodulePath: an ordinary tracked file path is not a submodule path', (t) => {
  const repo = usingFixture(t, false);
  const rev = repo.commitFile('plain.txt', 'plain content\n', 'add plain.txt');
  assert.strictEqual(isSubmodulePath(repo.root, rev, 'plain.txt'), false);
});

// ---------------------------------------------------------------------------
// Task 2: rename detection and diff-hunk parsing
// ---------------------------------------------------------------------------

test('detectRename: only in-place edits between the two revs is not a rename', (t) => {
  const repo = usingFixture(t, false);
  const rev = repo.commitFile('edited.txt', 'version one\n', 'add edited.txt');
  const headRev = repo.commitFile('edited.txt', 'version two\n', 'edit edited.txt');
  assert.deepStrictEqual(detectRename(repo.root, rev, headRev, 'edited.txt'), { kind: 'none' });
});

test('detectRename: a single unambiguous rename resolves to "single" with the new path', (t) => {
  const repo = usingFixture(t, false);
  const rev = repo.commitFile('old-name.txt', 'stable content across the rename\n', 'add old-name.txt');
  const headRev = repo.renameFile('old-name.txt', 'new-name.txt', 'rename old-name.txt to new-name.txt');
  assert.deepStrictEqual(detectRename(repo.root, rev, headRev, 'old-name.txt'), {
    kind: 'single',
    newPath: 'new-name.txt',
  });
});

test('detectRename: an unrelated deleted file (no rename detected) resolves to "none"', (t) => {
  const repo = usingFixture(t, false);
  const rev = repo.commitFile('gone.txt', 'ephemeral\n', 'add gone.txt');
  const headRev = repo.deleteFile('gone.txt', 'delete gone.txt');
  assert.deepStrictEqual(detectRename(repo.root, rev, headRev, 'gone.txt'), { kind: 'none' });
});

// The plan's Task 2 behavior block asks for a deliberately ambiguous
// construction: two ~90%-similar sources (fileX.ts, fileY.ts) both deleted
// in favor of a single new file (fileZ.ts) that overlaps both by roughly the
// same amount, expecting `git diff -M --name-status` to attribute the
// addition to BOTH deletions (two `R` lines sharing one destination) and
// `detectRename` to report `{ kind: "ambiguous", candidates: [...] }` with 2
// entries.
//
// LIMITATION (documented per the plan's own fallback instruction): this does
// NOT reproduce on git 2.53.0.windows.1. A destination path can occupy at
// most one entry in the ending tree, so `git diff --name-status` between two
// trees can never emit two `R` lines sharing a destination — diffcore-rename
// performs a proper 1:1 match and reports the loser as a plain `D`, never a
// second `R`. This was verified with two independent constructions before
// writing this test: (1) the ~90%-similarity construction below, and (2) an
// exact byte-identical tie between the two source files (to rule out a
// near-tie threshold effect) — both produced exactly one `R` line (a
// deterministic winner) and one `D` line (the loser), never two `R` lines.
// This is a structural property of git's tree-diff model, not merely an
// unverified empirical gap, so the test below asserts the REAL, observed
// outcome rather than a fabricated pass. `detectRename`'s ambiguous-grouping
// branch is implemented defensively per the plan's instruction (see its
// doc comment in git-meta.ts) but is not exercised by real git output here.
test('detectRename: a deliberately ambiguous rename construction (documented limitation — see comment above)', (t) => {
  const repo = usingFixture(t, false);
  const commonLines = Array.from({ length: 18 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');

  repo.commitFile('fileX.ts', `// fileX specific header\n${commonLines}\n// fileX tail\n`, 'add fileX.ts');
  const rev = repo.commitFile(
    'fileY.ts',
    `// fileY specific header\n${commonLines}\n// fileY tail\n`,
    'add fileY.ts',
  );

  execFileSync('git', ['rm', '-q', 'fileX.ts', 'fileY.ts'], { cwd: repo.root });
  const headRev = repo.commitFile(
    'fileZ.ts',
    `// fileZ specific header\n${commonLines}\n// fileZ tail\n`,
    'delete fileX.ts and fileY.ts, add fileZ.ts',
  );

  // Real, observed outcome on this machine's git: a single deterministic
  // winner (fileX.ts, the lexicographically-first / first-processed
  // candidate) resolves unambiguously; the loser (fileY.ts) has no R line at
  // all and resolves to "none", not "ambiguous".
  assert.deepStrictEqual(detectRename(repo.root, rev, headRev, 'fileX.ts'), {
    kind: 'single',
    newPath: 'fileZ.ts',
  });
  assert.deepStrictEqual(detectRename(repo.root, rev, headRev, 'fileY.ts'), { kind: 'none' });
});

test('parseDiffHunks: inserting lines above existing content produces one hunk with oldLines 0', (t) => {
  const repo = usingFixture(t, false);
  const rev = repo.commitFile('insert.txt', 'existing line one\nexisting line two\n', 'add insert.txt');
  const headRev = repo.commitFile(
    'insert.txt',
    'new line a\nnew line b\nnew line c\nnew line d\nnew line e\nexisting line one\nexisting line two\n',
    'insert 5 lines above',
  );
  const hunks = parseDiffHunks(repo.root, rev, headRev, 'insert.txt');
  assert.strictEqual(hunks.length, 1);
  assert.strictEqual(hunks[0]!.oldLines, 0);
  assert.strictEqual(hunks[0]!.newStart, 1);
  assert.strictEqual(hunks[0]!.newLines, 5);
});

test('parseDiffHunks: a single-line change parses the omitted count as 1', (t) => {
  const repo = usingFixture(t, false);
  const rev = repo.commitFile('single-line.txt', 'only line\n', 'add single-line.txt');
  const headRev = repo.commitFile('single-line.txt', 'changed line\n', 'change the only line');
  const hunks = parseDiffHunks(repo.root, rev, headRev, 'single-line.txt');
  assert.strictEqual(hunks.length, 1);
  assert.strictEqual(hunks[0]!.oldStart, 1);
  assert.strictEqual(hunks[0]!.oldLines, 1);
  assert.strictEqual(hunks[0]!.newStart, 1);
  assert.strictEqual(hunks[0]!.newLines, 1);
});

test('parseDiffHunks: two non-adjacent edits in the same file produce two separate hunks', (t) => {
  const repo = usingFixture(t, false);
  const original = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8'].join(
    '\n',
  );
  const rev = repo.commitFile('two-hunks.txt', `${original}\n`, 'add two-hunks.txt');
  const edited = ['line 1', 'CHANGED 2', 'line 3', 'line 4', 'line 5', 'line 6', 'CHANGED 7', 'line 8'].join(
    '\n',
  );
  const headRev = repo.commitFile('two-hunks.txt', `${edited}\n`, 'edit two non-adjacent lines');
  const hunks = parseDiffHunks(repo.root, rev, headRev, 'two-hunks.txt');
  assert.strictEqual(hunks.length, 2);
  assert.strictEqual(hunks[0]!.oldStart, 2);
  assert.strictEqual(hunks[0]!.oldLines, 1);
  assert.strictEqual(hunks[1]!.oldStart, 7);
  assert.strictEqual(hunks[1]!.oldLines, 1);
});
