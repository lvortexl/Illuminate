import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createFixtureRepo } from './git-repo.ts';
import type { FixtureRepo } from './git-repo.ts';
import { forceRemoveSync } from './cleanup.ts';

/**
 * Every test builds its own fixture repo (never shared mutable state) and
 * removes its temp directory on success via `t.after`, so a green run never
 * leaves a stray `illum-fixture-*` directory in the OS temp folder.
 */
function usingFixture(t: import('node:test').TestContext, autocrlf: boolean): FixtureRepo {
  const repo = createFixtureRepo(autocrlf);
  t.after(() => forceRemoveSync(repo.root));
  return repo;
}

// --- Task 1: isolation + determinism -------------------------------------

test('Task1: fixture repo is isolated from the real ~/.gitconfig', (t) => {
  const repo = usingFixture(t, false);
  assert.throws(() => repo.git(['config', 'user.name']));
});

test('Task1: createFixtureRepo produces an initialized repo with a valid HEAD sha', (t) => {
  const repo = usingFixture(t, false);
  const sha = repo.commitFile('a.txt', 'hello\n', 'initial commit');
  assert.match(sha, /^[0-9a-f]{40}$/);
});

test('Task1: two independently built fixtures with identical commitFile calls produce the same sha', (t) => {
  const repoA = usingFixture(t, false);
  const repoB = usingFixture(t, false);
  const shaA = repoA.commitFile('a.txt', 'hello\n', 'initial commit');
  const shaB = repoB.commitFile('a.txt', 'hello\n', 'initial commit');
  assert.strictEqual(shaA, shaB);
});

test('Task1: running the same fixture construction twice in a row is still deterministic', () => {
  const repo1 = createFixtureRepo(false);
  const repo2 = createFixtureRepo(false);
  try {
    const sha1 = repo1.commitFile('a.txt', 'hello\n', 'initial commit');
    const sha2 = repo2.commitFile('a.txt', 'hello\n', 'initial commit');
    assert.strictEqual(sha1, sha2);
  } finally {
    forceRemoveSync(repo1.root);
    forceRemoveSync(repo2.root);
  }
});

test('Task1: commitFile with crlf writes literal CRLF bytes to disk', (t) => {
  const repo = usingFixture(t, false);
  repo.commitFile('a.txt', 'line1\nline2\n', 'crlf commit', { crlf: true });
  const raw = readFileSync(`${repo.root}/a.txt`);
  assert.ok(raw.includes(Buffer.from([0x0d, 0x0a])));
});

// --- Task 2: scenario helpers ---------------------------------------------

test('Task2: renameFile is reported as a single R status by git diff -M', (t) => {
  const repo = usingFixture(t, false);
  const before = repo.commitFile('old.txt', 'unchanged content\nline two\n', 'add old.txt');
  repo.renameFile('old.txt', 'new.txt', 'rename old.txt to new.txt');
  const diff = repo.git(['diff', '-M', '--name-status', before, 'HEAD']);
  const lines = diff.split('\n').filter((l) => l.length > 0);
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0] ?? '', /^R\d*\told\.txt\tnew\.txt$/);
});

test('Task2: deleteFile removes the path at HEAD and is recorded as a deletion commit', (t) => {
  const repo = usingFixture(t, false);
  repo.commitFile('gone.txt', 'bye\n', 'add gone.txt');
  repo.deleteFile('gone.txt', 'delete gone.txt');
  const status = repo.git(['status', '--porcelain']);
  assert.strictEqual(status, '');
  const deletions = repo.git(['log', '--diff-filter=D', '--name-only', '--format=']);
  assert.match(deletions, /gone\.txt/);
});

test('Task2: writeDirty leaves the change uncommitted', (t) => {
  const repo = usingFixture(t, false);
  repo.commitFile('tracked.txt', 'v1\n', 'add tracked.txt');
  repo.writeDirty('tracked.txt', 'v2 uncommitted\n');
  const status = repo.git(['status', '--porcelain']);
  assert.match(status, /tracked\.txt/);
  const lastCommitMessage = repo.git(['log', '-1', '--format=%s']);
  assert.strictEqual(lastCommitMessage, 'add tracked.txt');
});

test('Task2: unreachableRev fails cat-file -e in the repo it was generated against', (t) => {
  const repo = usingFixture(t, false);
  repo.commitFile('a.txt', 'hello\n', 'initial commit');
  const rev = repo.unreachableRev();
  assert.match(rev, /^[0-9a-f]{40}$/);
  assert.throws(() => repo.git(['cat-file', '-e', `${rev}^{commit}`]));
});

test('Task2: cloneShallow(1) makes an earlier rev unreachable in the clone but not the original', (t) => {
  const repo = usingFixture(t, false);
  const firstSha = repo.commitFile('a.txt', 'v1\n', 'commit 1');
  repo.commitFile('a.txt', 'v2\n', 'commit 2');
  repo.commitFile('a.txt', 'v3\n', 'commit 3');

  const clone = repo.cloneShallow(1);
  t.after(() => forceRemoveSync(clone.root));

  assert.doesNotThrow(() => repo.git(['cat-file', '-e', `${firstSha}^{commit}`]));
  assert.throws(() => clone.git(['cat-file', '-e', `${firstSha}^{commit}`]));
});

test('Task2: addSubmodule is listed by git submodule status in the parent repo', (t) => {
  const parent = usingFixture(t, false);
  const sub = usingFixture(t, false);
  parent.commitFile('README.md', 'parent repo\n', 'init parent');
  sub.commitFile('README.md', 'submodule repo\n', 'init submodule');

  parent.addSubmodule(sub, 'vendor/sub');
  const status = parent.git(['submodule', 'status']);
  assert.match(status, /vendor\/sub/);
});

// --- Task 3: additional isolation/determinism coverage --------------------

test('Task3: autocrlf=true and autocrlf=false fixtures both work and record the requested setting', (t) => {
  const repoTrue = usingFixture(t, true);
  const repoFalse = usingFixture(t, false);
  assert.strictEqual(repoTrue.git(['config', 'core.autocrlf']), 'true');
  assert.strictEqual(repoFalse.git(['config', 'core.autocrlf']), 'false');
});

test('Task3: no fixture directory is left behind after a passing test (self-check)', () => {
  const repo = createFixtureRepo(false);
  const root = repo.root;
  assert.ok(existsSync(root));
  forceRemoveSync(root);
  assert.ok(!existsSync(root));
});

test('Task3: git itself is real (not simulated) — HEAD sha matches independently computed rev-parse', (t) => {
  const repo = usingFixture(t, false);
  const sha = repo.commitFile('a.txt', 'hello\n', 'initial commit');
  const independentSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo.root,
    env: { ...process.env, GIT_CONFIG_GLOBAL: `${repo.root}/.empty-gitconfig`, GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  }).trim();
  assert.strictEqual(sha, independentSha);
});
