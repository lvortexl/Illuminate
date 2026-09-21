import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStalenessRegistry } from '../../src/daemon/staleness-registry.ts';
import type { WatchFn, WatchHandle } from '../../src/daemon/staleness-watch.ts';
import { getRepoContext } from '../../src/router/pool-registry.ts';
import { FindingsStoreFile } from '../../src/store/findings-store.ts';
import { createFixtureRepo } from '../fixtures/git-repo.ts';
import type { FixtureRepo } from '../fixtures/git-repo.ts';
import { anchorHash } from '../../src/provenance/hash.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

/**
 * Plan 08-04's own composition-root proof: `createStalenessRegistry` wires
 * Plan 08-01's `FindingsStoreFile`, Plan 08-02's `runStalenessScan`, and
 * Plan 08-03's `StalenessWatcher` together without reimplementing any of
 * them. Lifecycle tests (idempotent start, real handle close() on
 * stop/closeAll, unknown-key posture) use a plain, git-free temp directory
 * with an injected fake `watchFn` -- directory-watching is derived from an
 * artifact's own anchors regardless of git availability (resolve()'s own
 * no-git branch never touches the pool `getRepoContext` still harmlessly
 * constructs), so no real repository is needed to prove the lifecycle
 * itself. The one real-detection test at the bottom uses a real fixture
 * repo, mirroring test/daemon/staleness.test.ts's own `writeArtifact`
 * convention, to prove `startForSession`'s fire-and-forget initial scan
 * really lands a finding in the sidecar -- this IS the "passive inbox
 * nobody can reach is not an inbox" claim, proven end to end.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function pollUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  assert.ok(await check(), `condition not met within ${String(timeoutMs)}ms`);
}

// ---------------------------------------------------------------------------
// Fake WatchHandle/WatchFn -- mirrors test/daemon/staleness-watch.test.ts's
// own FakeWatchHandle/createFakeWatchFn precedent, duplicated locally per
// this codebase's established per-test-file helper-duplication convention.
// ---------------------------------------------------------------------------

class FakeWatchHandle extends EventEmitter implements WatchHandle {
  closeCallCount = 0;
  close(): void {
    this.closeCallCount++;
  }
}

function createFakeWatchFn(): {
  watchFn: WatchFn;
  callCountFor: (dir: string) => number;
  handlesFor: (dir: string) => readonly FakeWatchHandle[];
} {
  const handlesByDir = new Map<string, FakeWatchHandle[]>();
  const watchFn: WatchFn = (dir) => {
    const handle = new FakeWatchHandle();
    const existing = handlesByDir.get(dir) ?? [];
    existing.push(handle);
    handlesByDir.set(dir, existing);
    return handle;
  };
  return {
    watchFn,
    callCountFor: (dir) => handlesByDir.get(dir)?.length ?? 0,
    handlesFor: (dir) => handlesByDir.get(dir) ?? [],
  };
}

/** A plain temp directory (no git init) carrying one artifact.html with one
 * data-src anchor into a `sub/` subdirectory -- enough for the registry's
 * own directory-derivation logic, without needing a real repository. */
async function withTempArtifactDir<T>(fn: (dir: string, artifactPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illum-staleness-registry-test-'));
  try {
    const artifactPath = join(dir, 'artifact.html');
    await writeFile(
      artifactPath,
      '<!doctype html><html><body><div data-src="sub/file.ts#L1-L2" data-anchor-hash="deadbeef">rendered</div></body></html>',
      'utf8',
    );
    return await fn(dir, artifactPath);
  } finally {
    const { pool } = getRepoContext(dir);
    pool.close();
    await forceRemove(dir);
  }
}

// ---------------------------------------------------------------------------
// startForSession: idempotency
// ---------------------------------------------------------------------------

test('a second startForSession call for the same key is a no-op -- only one set of watch calls happens for the anchored directory', async () => {
  await withTempArtifactDir(async (dir, artifactPath) => {
    const fake = createFakeWatchFn();
    const registry = createStalenessRegistry({ watchFn: fake.watchFn, reconcileIntervalMs: 100_000 });
    const watchedDir = join(dir, 'sub');

    registry.startForSession('key-1', artifactPath, dir);
    await pollUntil(() => fake.callCountFor(watchedDir) >= 1, 3000);

    registry.startForSession('key-1', artifactPath, dir); // repeat -- must be a no-op
    await sleep(500); // give a wrongly-constructed second watcher's own immediate rescan time to land

    assert.strictEqual(fake.callCountFor(watchedDir), 1, 'a repeat startForSession must not construct a second watcher');
    registry.closeAll();
  });
});

// ---------------------------------------------------------------------------
// stopForSession / closeAll: real handle close() lifecycle
// ---------------------------------------------------------------------------

test('stopForSession closes every currently-watched handle for that session exactly once', async () => {
  await withTempArtifactDir(async (dir, artifactPath) => {
    const fake = createFakeWatchFn();
    const registry = createStalenessRegistry({ watchFn: fake.watchFn, reconcileIntervalMs: 100_000 });
    const watchedDir = join(dir, 'sub');

    registry.startForSession('key-1', artifactPath, dir);
    await pollUntil(() => fake.callCountFor(watchedDir) >= 1, 3000);
    const [handle] = fake.handlesFor(watchedDir);
    assert.ok(handle);

    registry.stopForSession('key-1');
    assert.strictEqual(handle.closeCallCount, 1);
  });
});

test('stopForSession is a no-op for an unknown key -- no throw', () => {
  const registry = createStalenessRegistry();
  assert.doesNotThrow(() => registry.stopForSession('never-started'));
});

test('closeAll closes every currently-tracked session watched handle', async () => {
  await withTempArtifactDir(async (dirA, artifactPathA) => {
    await withTempArtifactDir(async (dirB, artifactPathB) => {
      const fake = createFakeWatchFn();
      const registry = createStalenessRegistry({ watchFn: fake.watchFn, reconcileIntervalMs: 100_000 });
      const watchedDirA = join(dirA, 'sub');
      const watchedDirB = join(dirB, 'sub');

      registry.startForSession('key-a', artifactPathA, dirA);
      registry.startForSession('key-b', artifactPathB, dirB);
      await pollUntil(() => fake.callCountFor(watchedDirA) >= 1 && fake.callCountFor(watchedDirB) >= 1, 3000);

      registry.closeAll();

      const [handleA] = fake.handlesFor(watchedDirA);
      const [handleB] = fake.handlesFor(watchedDirB);
      assert.strictEqual(handleA?.closeCallCount, 1);
      assert.strictEqual(handleB?.closeCallCount, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// isWatcherHealthy
// ---------------------------------------------------------------------------

test('isWatcherHealthy is true for a key with no tracked watcher at all -- fail open', () => {
  const registry = createStalenessRegistry();
  assert.strictEqual(registry.isWatcherHealthy('never-started'), true);
});

test('forceUnhealthy: true makes a freshly-started session report unhealthy immediately, with no real fs.watch ever needed', async () => {
  await withTempArtifactDir(async (dir, artifactPath) => {
    const fake = createFakeWatchFn();
    const registry = createStalenessRegistry({
      watchFn: fake.watchFn,
      forceUnhealthy: true,
      reconcileIntervalMs: 100_000,
    });

    registry.startForSession('key-1', artifactPath, dir);
    assert.strictEqual(registry.isWatcherHealthy('key-1'), false);

    registry.closeAll();
  });
});

// ---------------------------------------------------------------------------
// Real end-to-end: startForSession's fire-and-forget initial scan lands a
// real finding in the sidecar, against a real fixture repo -- this plan's
// own must_haves.truths: findings become reachable because SOMETHING inside
// the live daemon actually triggers Plan 08-01/08-02's machinery.
// ---------------------------------------------------------------------------

function block(lines: readonly string[]): string {
  return lines.join('\n') + '\n';
}
test('startForSession triggers an immediate scan that lands a real finding for an in-place-edited anchor', async (t) => {
  const repo: FixtureRepo = createFixtureRepo(false);
  t.after(async () => {
    const { pool } = getRepoContext(repo.root);
    pool.close();
    await forceRemove(repo.root);
  });

  const region = Array.from({ length: 20 }, (_, i) => `registry line ${i + 1}`);
  const dataRev = repo.commitFile('src/registry-touched.ts', block(['ctx 0', ...region, 'tail 0']), 'add file');
  const editedRegion = [...region];
  editedRegion[9] = 'registry line 10 EDITED';
  repo.commitFile('src/registry-touched.ts', block(['ctx 0', ...editedRegion, 'tail 0']), 'edit in place');

  const artifactPath = join(repo.root, 'report.html');
  await writeFile(
    artifactPath,
    `<!doctype html><html><body><div data-src="src/registry-touched.ts#L2-L21" data-rev="${dataRev}" data-anchor-hash="${anchorHash(region.join('\n'))}">rendered</div></body></html>`,
    'utf8',
  );

  const registry = createStalenessRegistry({ reconcileIntervalMs: 100_000 });
  registry.startForSession('key-1', artifactPath, repo.root);

  await pollUntil(async () => {
    const store = await new FindingsStoreFile(artifactPath).read();
    return store.findings.length === 1;
  }, 5000);

  const store = await new FindingsStoreFile(artifactPath).read();
  assert.strictEqual(store.findings.length, 1);
  assert.strictEqual(store.findings[0]?.status, 'open');

  registry.closeAll();
});
