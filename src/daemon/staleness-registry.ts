/**
 * The per-session composition root wiring Plans 08-01/08-02/08-03's
 * already-built, already-proven machinery into something the live daemon
 * can actually start and stop: one `StalenessWatcher` (08-03) plus one
 * `FindingsStoreFile` (08-01) per open session, driven by `runStalenessScan`
 * (08-02) on every watch/reconcile trigger. This module owns exactly the
 * "which session gets which watcher, and when does it start/stop" question
 * -- it never reimplements any part of the scan ladder, the store's
 * reducers, or the watcher's own debounce/health machinery.
 *
 * STAL-04's "findings land in a passive inbox" promise needs this file to
 * exist: Plan 08-01's store and Plan 08-02's scanner are both real and both
 * proven, but neither is triggered by anything running inside a live
 * daemon process until `startForSession` is actually called (server.ts,
 * this same plan).
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { createStalenessWatcher } from './staleness-watch.ts';
import type { StalenessWatcher, WatchFn } from './staleness-watch.ts';
import { runStalenessScan } from './staleness.ts';
import { extractAnchorInputs } from '../html/anchors.ts';
import { getRepoContext } from '../router/pool-registry.ts';
import { FindingsStoreFile } from '../store/findings-store.ts';

/** 1 second -- frequent enough that an edit lands as a finding well within
 * an interactive session, never so frequent it competes meaningfully with
 * ANCH-03's own git-batch-pool cost. Overridable per-registry (test-scale)
 * and, in production, via `ILLUMINATE_STALENESS_DEBOUNCE_MS` (daemon-entry.ts). */
const DEFAULT_DEBOUNCE_MS = 1_000;

/** 30 seconds -- Pitfall 10's own prescribed compensating control for
 * `fs.watch`'s cross-platform flakiness (staleness-watch.ts's own doc
 * comment), on a cadence that costs nothing noticeable for an idle session.
 * Overridable per-registry and, in production, via
 * `ILLUMINATE_STALENESS_RECONCILE_MS`. */
const DEFAULT_RECONCILE_MS = 30_000;

export interface StalenessRegistryOptions {
  readonly debounceMs?: number;
  readonly reconcileIntervalMs?: number;
  /** Mirrors daemon-entry.ts's existing ILLUMINATE_DISABLE_SELF_DISPATCH
   * precedent -- when true, every session's watcher is forced unhealthy at
   * creation, without ever calling real fs.watch. */
  readonly forceUnhealthy?: boolean;
  /** Test-only escape hatch, additive beyond this plan's own <interfaces>
   * block: threaded straight through to every `createStalenessWatcher` call
   * this registry makes, mirroring `DaemonServerOptions.selfDispatchSpawnFn`'s
   * own "omit in production, inject in tests" shape. Omitted (the default)
   * reproduces real production behavior exactly -- staleness-watch.ts's own
   * default `node:fs.watch` wrapper. */
  readonly watchFn?: WatchFn;
}

export interface StalenessRegistry {
  /** Idempotent -- a repeat call for an already-tracked `key` is a no-op.
   * Fire-and-forget internally: triggers an immediate scan and does not
   * block the caller on it. */
  startForSession(key: string, artifactPath: string, artifactDir: string): void;
  /** Closes that session's watcher (timers + watch handles) and stops
   * tracking it. A no-op for an unknown key. */
  stopForSession(key: string): void;
  /** `true` for a key with no tracked watcher at all (nothing has reported
   * a problem -- fail-open, mirroring `isSameOriginRequest`'s own "absent
   * means trusted" posture) as well as for a genuinely healthy watcher;
   * `false` only once that session's own watcher has actually reported
   * unhealthy. */
  isWatcherHealthy(key: string): boolean;
  /** The SAME `FindingsStoreFile` instance `rescan()` mutates for this
   * session, or `null` for an untracked key -- callers (server.ts's
   * findings routes) MUST reuse this instance rather than constructing a
   * fresh one: `FindingsStoreFile.mutate()` serializes writes through an
   * IN-PROCESS, PER-INSTANCE `AsyncMutex` (findings-store.ts), which only
   * protects callers sharing the same instance. Two separate instances
   * pointed at the same on-disk sidecar can still interleave a
   * read-modify-write and lose an update -- exactly the race a dismiss
   * landing concurrently with a reconcile-interval rescan can hit. */
  getFindingsStoreFile(key: string): FindingsStoreFile | null;
  /** Closes every currently-tracked session's watcher -- called from
   * server.ts's shutdown(). */
  closeAll(): void;
}

interface TrackedSession {
  readonly watcher: StalenessWatcher;
  readonly findingsStoreFile: FindingsStoreFile;
}

export function createStalenessRegistry(options: StalenessRegistryOptions = {}): StalenessRegistry {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_MS;
  const forceUnhealthy = options.forceUnhealthy ?? false;
  const watchFn = options.watchFn;

  const sessions = new Map<string, TrackedSession>();

  return {
    startForSession(key: string, artifactPath: string, artifactDir: string): void {
      if (sessions.has(key)) return;

      const findingsStoreFile = new FindingsStoreFile(artifactPath);

      /**
       * Runs a full scan pass (08-02, delegated verbatim -- never
       * reimplemented here), then independently re-derives the CURRENT set
       * of watched directories from the artifact's OWN current anchors, so
       * a regenerated artifact with different anchors re-points the watcher
       * rather than leaving it watching stale directories. Never throws out
       * of `onTrigger`: a failure anywhere in this sequence (the artifact
       * vanished mid-scan, a transient read error) leaves the watcher's
       * PRIOR directory set in place -- fail open -- and the next reconcile
       * tick tries again on its own schedule.
       */
      async function rescan(): Promise<void> {
        try {
          await runStalenessScan(artifactPath, artifactDir, findingsStoreFile);
          const html = await readFile(artifactPath, 'utf8');
          const inputs = extractAnchorInputs(html);
          const { repoRoot } = getRepoContext(artifactDir);
          const dirs = [...new Set(inputs.map((input) => dirname(resolvePath(repoRoot, input.path))))];
          watcher.setWatchedDirectories(dirs);
        } catch {
          // Fail open -- see this function's own doc comment above.
        }
      }

      // Reentrancy guard: `resolve()` (Phase 2) spawns several real git
      // subprocesses per anchor, some synchronous -- a single scan pass can
      // take longer than an aggressive `reconcileIntervalMs` (this plan's
      // own test-scale env vars deliberately push this far below the real
      // 30s production default). Without this guard, `onTrigger` firing
      // again mid-scan would launch a SECOND, fully overlapping `rescan()`
      // sharing the SAME `pool`/`findingsStoreFile`, and every further tick
      // compounds the pile-up -- a real, unbounded backlog, not just a
      // theoretical one (confirmed against a real fixture repo: dozens of
      // overlapping passes delayed a real reopen by tens of seconds). At
      // most ONE scan ever runs at a time per session; a trigger arriving
      // while one is in flight is coalesced into exactly ONE follow-up
      // pass, never a second concurrent one.
      let scanInFlight = false;
      let rescanRequested = false;

      async function runRescanLoop(): Promise<void> {
        if (scanInFlight) {
          rescanRequested = true;
          return;
        }
        scanInFlight = true;
        try {
          do {
            rescanRequested = false;
            await rescan();
          } while (rescanRequested);
        } finally {
          scanInFlight = false;
        }
      }

      const watcher = createStalenessWatcher({
        debounceMs,
        reconcileIntervalMs,
        onTrigger: () => {
          void runRescanLoop();
        },
        ...(watchFn !== undefined ? { watchFn } : {}),
      });

      if (forceUnhealthy) watcher.forceUnhealthy();

      sessions.set(key, { watcher, findingsStoreFile });

      // Fire-and-forget: the caller (server.ts's begin-handshake route) must
      // not wait out however long the first scan pass takes.
      void runRescanLoop();
    },

    stopForSession(key: string): void {
      const entry = sessions.get(key);
      if (!entry) return;
      entry.watcher.close();
      sessions.delete(key);
    },

    isWatcherHealthy(key: string): boolean {
      const entry = sessions.get(key);
      return entry ? entry.watcher.isHealthy() : true;
    },

    getFindingsStoreFile(key: string): FindingsStoreFile | null {
      return sessions.get(key)?.findingsStoreFile ?? null;
    },

    closeAll(): void {
      for (const entry of sessions.values()) {
        entry.watcher.close();
      }
      sessions.clear();
    },
  };
}
