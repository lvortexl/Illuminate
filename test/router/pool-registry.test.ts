import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureRepo } from '../fixtures/git-repo.ts';
import type { FixtureRepo } from '../fixtures/git-repo.ts';
import { GitBatchPool } from '../../src/provenance/git-batch-pool.ts';
import { getRepoContext } from '../../src/router/pool-registry.ts';
import type { PoolRegistryDeps } from '../../src/router/pool-registry.ts';
import { forceRemoveSync } from '../fixtures/cleanup.ts';

function usingFixture(t: import('node:test').TestContext, autocrlf = false): FixtureRepo {
  const repo = createFixtureRepo(autocrlf);
  t.after(() => forceRemoveSync(repo.root));
  return repo;
}

/** A plain directory with no `.git` ancestor at all. */
function usePlainDir(t: import('node:test').TestContext): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'illum-pool-registry-no-git-')));
  t.after(() => forceRemoveSync(root));
  return root;
}

// ---------------------------------------------------------------------------
// Task 1: repo-root discovery, real fixture repo
// ---------------------------------------------------------------------------

test('getRepoContext: resolves the TRUE repo root from a directory nested two levels below it, never the nested directory itself', (t) => {
  const repo = usingFixture(t);
  repo.commitFile('a/b/nested.txt', 'nested\n', 'add nested file');
  const nested = join(repo.root, 'a', 'b');

  const { repoRoot, pool } = getRepoContext(nested);
  t.after(() => pool.close());

  assert.strictEqual(repoRoot, realpathSync.native(repo.root));
  assert.notStrictEqual(repoRoot, nested);
});

test('getRepoContext: two different subdirectories of the SAME real repo share the SAME cached pool', (t) => {
  const repo = usingFixture(t);
  repo.commitFile('one/a.txt', 'a\n', 'add a');
  repo.commitFile('two/b.txt', 'b\n', 'add b');

  const first = getRepoContext(join(repo.root, 'one'));
  const second = getRepoContext(join(repo.root, 'two'));
  t.after(() => first.pool.close());

  assert.strictEqual(first.repoRoot, second.repoRoot);
  assert.strictEqual(first.pool, second.pool, 'two subdirectories of one repo must share one GitBatchPool instance');
});

test('getRepoContext: a directory with no git repo above it falls back to {repoRoot: artifactDir}, still constructing a pool', (t) => {
  const plain = usePlainDir(t);
  const { repoRoot, pool } = getRepoContext(plain);
  t.after(() => pool.close());

  assert.strictEqual(repoRoot, plain);
  assert.ok(pool instanceof GitBatchPool, 'a pool must still be constructed, even with no git repo above artifactDir');
});

// ---------------------------------------------------------------------------
// Task 1: pool caching proven via dependency injection -- no real nested
// directories needed to prove "shared repo root -> shared pool instance".
// ---------------------------------------------------------------------------

test('getRepoContext: caching is keyed by the RESOLVED repo root, not by the input directory (proven via DI)', (t) => {
  const fakeRepoRoot = join(tmpdir(), `illum-di-fake-repo-${String(Date.now())}`);
  const deps: PoolRegistryDeps = { findRepoRoot: () => fakeRepoRoot };

  const first = getRepoContext(join(fakeRepoRoot, 'sub', 'a'), deps);
  const second = getRepoContext(join(fakeRepoRoot, 'sub', 'b'), deps);
  t.after(() => {
    first.pool.close();
  });

  assert.strictEqual(first.repoRoot, fakeRepoRoot);
  assert.strictEqual(second.repoRoot, fakeRepoRoot);
  assert.strictEqual(first.pool, second.pool, 'different input directories resolving to the SAME repo root must share one pool');
});

test('getRepoContext: two DIFFERENT resolved repo roots get two DIFFERENT pool instances', (t) => {
  const rootA = join(tmpdir(), `illum-di-fake-repo-a-${String(Date.now())}`);
  const rootB = join(tmpdir(), `illum-di-fake-repo-b-${String(Date.now())}`);

  const a = getRepoContext(join(rootA, 'x'), { findRepoRoot: () => rootA });
  const b = getRepoContext(join(rootB, 'x'), { findRepoRoot: () => rootB });
  t.after(() => {
    a.pool.close();
    b.pool.close();
  });

  assert.notStrictEqual(a.pool, b.pool);
});

test('getRepoContext: a fake repo root differing only in case still resolves to the SAME cached pool (NTFS case-insensitivity)', (t) => {
  const mixedCaseRoot = join(tmpdir(), `Illum-Di-Fake-Repo-Case-${String(Date.now())}`);
  const lowerCaseRoot = mixedCaseRoot.toLowerCase();

  const first = getRepoContext('irrelevant-a', { findRepoRoot: () => mixedCaseRoot });
  const second = getRepoContext('irrelevant-b', { findRepoRoot: () => lowerCaseRoot });
  t.after(() => {
    first.pool.close();
  });

  assert.strictEqual(first.pool, second.pool);
});
