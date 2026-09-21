/**
 * ROUT-03's git-plumbing entry point: one cached `GitBatchPool` per resolved
 * repository, shared by every dispatch resolved against that repository --
 * never one pool per artifact directory, never one process spawned per
 * dispatch. `envelope.ts` (this plan's Task 2) is the only intended caller;
 * this module owns exactly the "which pool for this artifact" question and
 * nothing about anchors, policy, or envelopes.
 *
 * `findRepoRoot` (src/provenance/git-meta.ts) is imported, never
 * reimplemented -- this module's only job on top of it is caching the
 * `GitBatchPool` it hands back per resolved root.
 */

import { findRepoRoot } from '../provenance/git-meta.ts';
import { GitBatchPool } from '../provenance/git-batch-pool.ts';

/** Overridable subset of this module's environment dependency, defaulting to
 * the real `findRepoRoot` -- mirrors `resolve.ts`'s own `ResolveDeps`
 * injection pattern, so "shared repo, shared pool" is provable without
 * needing two real nested directories inside one real fixture repo (a
 * real-fixture-repo proof also exists, in test/router/pool-registry.test.ts). */
export type PoolRegistryDeps = {
  readonly findRepoRoot: (startPath: string) => string | null;
};

const REAL_DEPS: PoolRegistryDeps = { findRepoRoot };

export type RepoContext = {
  readonly repoRoot: string;
  readonly pool: GitBatchPool;
};

/**
 * Keyed by the RESOLVED repo root, lower-cased -- this codebase's
 * established NTFS-case-insensitivity convention for using a path as a
 * cache/lock key (see `state-dir.ts`'s `lockPathFor` / `session-store.ts`'s
 * `sessionKey`). A module-level cache: it lives for the process's lifetime,
 * shared across every `getRepoContext` call, exactly like `GitBatchPool`
 * itself is meant to be shared per repository rather than per call site.
 */
const poolCache = new Map<string, GitBatchPool>();

/**
 * Resolves `artifactDir` to its enclosing git repo root and returns the one
 * `GitBatchPool` cached for that root, constructing it on first use. When no
 * git repo is found above `artifactDir` at all, `repoRoot` falls back to
 * `artifactDir` itself and a pool is still constructed (harmlessly unused --
 * `resolve()`'s own no-git branch never touches the pool parameter it is
 * handed regardless of what it is), so this function never needs to
 * special-case "no git" itself.
 */
export function getRepoContext(artifactDir: string, deps: PoolRegistryDeps = REAL_DEPS): RepoContext {
  const found = deps.findRepoRoot(artifactDir);
  const repoRoot = found ?? artifactDir;
  const cacheKey = repoRoot.toLowerCase();
  const cached = poolCache.get(cacheKey);
  if (cached) return { repoRoot, pool: cached };
  const pool = new GitBatchPool(repoRoot);
  poolCache.set(cacheKey, pool);
  return { repoRoot, pool };
}
