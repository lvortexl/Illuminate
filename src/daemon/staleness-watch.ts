/**
 * The generic trigger mechanism behind STAL-05's non-interruption promise: a
 * debounced, multi-directory file watcher plus an independent reconcile-
 * interval timer, with observable health -- deliberately knowing NOTHING
 * about anchors, git, or findings. This module answers exactly one
 * question, "when should a rescan happen, and can I currently trust the
 * watch path to tell me that", and hands the answer to a caller-supplied
 * `onTrigger` callback. Plan 08-04 wires `onTrigger` to `runStalenessScan`
 * (staleness.ts) and computes the watched-directory set from an artifact's
 * own current anchors -- this module never imports either.
 *
 * Built on `node:fs.watch` with an injectable `watchFn`, never chokidar:
 * PITFALLS.md's Pitfall 10 documents chokidar's Windows EPERM-on-delete,
 * UNC-path silent failure, and `ignorePermissionErrors: true` silently
 * suppressing exactly the errors this module needs to surface as an
 * explicit, queryable `isHealthy()` fact. The reconcile-interval timer
 * built here is Pitfall 10's own prescribed compensating control for
 * `fs.watch`'s documented cross-platform flakiness -- a liveness heartbeat
 * that catches what the watch path silently missed, not a gap this module
 * is pretending doesn't exist. No new npm dependency is added.
 */

import { watch as fsWatch } from 'node:fs';

/**
 * The exact narrow slice of `fs.watch`'s real return value this module
 * needs -- `close()` plus an `'error'` listener. Hand-rolled, not
 * `Pick<fs.FSWatcher, ...>`, mirroring `active-polls.ts`'s own `ProbeChild`
 * precedent: `fs.FSWatcher`'s own `on()` overloads return `this`, which
 * binds the return type to `FSWatcher` itself and would make a `Pick` of it
 * unsatisfiable by a test double built on a plain `EventEmitter` subclass.
 */
export interface WatchHandle {
  close(): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

export type WatchFn = (dir: string, listener: (eventType: string, filename: string | null) => void) => WatchHandle;

export type TriggerReason = 'watch' | 'reconcile';

export interface StalenessWatcherOptions {
  readonly debounceMs: number;
  readonly reconcileIntervalMs: number;
  readonly onTrigger: (reason: TriggerReason) => void;
  /** Defaults to a thin wrapper over the real `node:fs.watch`. Injected for
   * every unit test except the real-fs integration test. */
  readonly watchFn?: WatchFn;
}

export interface StalenessWatcher {
  /**
   * Reconciles the watched-directory set to exactly `dirs`: closes any
   * currently-watched directory NOT in `dirs`, opens any directory in
   * `dirs` NOT already watched, and leaves directories present in both
   * untouched (no needless close+reopen). Safe to call repeatedly with the
   * same set (a no-op diff). Call with `[]` to stop watching everything
   * while leaving the reconcile timer running.
   */
  setWatchedDirectories(dirs: readonly string[]): void;
  /**
   * `false` after ANY currently-watched handle's `'error'` listener has
   * fired, after `forceUnhealthy()`, or after `close()`. `true` otherwise,
   * including the initial state before `setWatchedDirectories` has ever
   * been called (there is nothing unhealthy about watching zero
   * directories by choice). Never cleared automatically by a later
   * successful `setWatchedDirectories` call -- ANCH-05's "never silently
   * clear a recorded problem" discipline, applied here: a caller that
   * wants to retry must construct a fresh watcher.
   */
  isHealthy(): boolean;
  /** Test/ops-only escape hatch -- Plan 08-04 wires this to a documented
   * env var (mirroring `ILLUMINATE_DISABLE_SELF_DISPATCH`) so a black-box
   * real-daemon test can prove the "visible degraded state" UI without
   * needing to reach into a live subprocess's real fs.watch internals. */
  forceUnhealthy(): void;
  /** Stops the reconcile interval timer and closes every currently-watched
   * handle. Idempotent. No further `onTrigger` call happens after this
   * returns, from either the debounce path or the reconcile timer. */
  close(): void;
}

/** Thin wrapper over the real `node:fs.watch` -- returns a real
 * `fs.FSWatcher`, which structurally satisfies `WatchHandle` (`close()` plus
 * a compatible `on('error', ...)` overload), exactly mirroring
 * `active-polls.ts`'s own `defaultProbeSpawnFn` (`spawn(...)` assigned
 * directly as a `ProbeSpawnFn`'s return value). */
const defaultWatchFn: WatchFn = (dir, listener) => fsWatch(dir, listener);

export function createStalenessWatcher(options: StalenessWatcherOptions): StalenessWatcher {
  const watchFn = options.watchFn ?? defaultWatchFn;
  const watched = new Map<string, WatchHandle>();

  let healthy = true;
  let closed = false;
  let debounceTimer: NodeJS.Timeout | null = null;

  /**
   * Cancel-and-reschedule on every new watch event, never accumulate
   * parallel pending timers -- mirrors `idle.ts`'s own `IdleController#armIfIdle`
   * discipline exactly. `.unref()`'d (T-08-08): this timer alone must never
   * keep the Node process alive.
   */
  function armDebounce(): void {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      options.onTrigger('watch');
    }, options.debounceMs);
    debounceTimer.unref();
  }

  /**
   * Fully independent of watch health/activity by construction -- started
   * once at construction time, never re-armed by a watch event, never torn
   * down by anything except `close()`. `.unref()`'d for the same reason as
   * the debounce timer.
   */
  let reconcileTimer: NodeJS.Timeout | null = setInterval(() => {
    options.onTrigger('reconcile');
  }, options.reconcileIntervalMs);
  reconcileTimer.unref();

  function watchDirectory(dir: string): WatchHandle {
    const handle = watchFn(dir, () => {
      armDebounce();
    });
    handle.on('error', () => {
      healthy = false;
    });
    return handle;
  }

  return {
    setWatchedDirectories(dirs: readonly string[]): void {
      if (closed) return;
      const next = new Set(dirs);

      for (const [dir, handle] of watched) {
        if (!next.has(dir)) {
          handle.close();
          watched.delete(dir);
        }
      }

      for (const dir of next) {
        if (!watched.has(dir)) {
          watched.set(dir, watchDirectory(dir));
        }
      }
    },

    isHealthy(): boolean {
      return healthy;
    },

    forceUnhealthy(): void {
      healthy = false;
    },

    close(): void {
      if (closed) return;
      closed = true;
      healthy = false;

      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = null;
      }

      for (const handle of watched.values()) {
        handle.close();
      }
      watched.clear();
    },
  };
}
