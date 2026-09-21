import { EventEmitter } from 'node:events';
import type { SessionStore } from '../store/session-store.ts';
import type { DispatchEnvelope } from '../router/types.ts';
import { drainQueue, restoreToQueue, isBrowserConnected } from './dispatch-ledger.ts';

/**
 * POLL-01..04's state machine, built to be provable with zero real sockets
 * and (for the correctness-critical branches) zero real elapsed time.
 * `resolvePoll` never touches `node:http` directly -- it takes an ABSTRACT
 * `PollConnection` that a real `req`/`res` pair satisfies (wired in 06-07)
 * and that a hand-written fake satisfies just as well in this file's own
 * tests, plus an injectable clock (`ResolvePollOptions.now`) so the two
 * genuinely time-based branches (heartbeat cadence, disconnect grace) stay
 * testable with small, threshold-asserted real timers instead of a mocked
 * clock library.
 *
 * The queue/ledger mutations themselves are never reimplemented here --
 * every mutation goes through `./dispatch-ledger.ts`'s already-proven
 * `drainQueue`/`restoreToQueue`/`isBrowserConnected` reducers via
 * `SessionStore.mutate()`, mirroring this codebase's established
 * separation (session-store.ts stays a dumb schema + mutex + atomic-write
 * file; dispatch-ledger.ts owns the reducers; this file owns only the
 * async orchestration around them).
 */

/**
 * An abstraction over a real, possibly-adversarial-timed client
 * disconnect (see this plan's own threat model, T-06-09/T-06-10):
 * `isClosed()`/`onClose` are never assumed to fire in a convenient order
 * relative to the atomic drain below.
 */
export interface PollConnection {
  isClosed(): boolean;
  onClose(cb: () => void): void;
}

/**
 * The wake-on-enqueue channel: whoever enqueues a dispatch for `key`
 * (another request handler, in 06-07's real wiring) calls `emit(key)`,
 * and any `resolvePoll` call currently waiting on that same key re-checks
 * the queue. A thin per-key pub/sub -- not itself durable state.
 */
export interface PollEvents {
  on(key: string, cb: () => void): void;
  off(key: string, cb: () => void): void;
  emit(key: string): void;
}

/** A thin wrapper around `node:events.EventEmitter` for the real daemon
 * wiring (06-07). This file's own tests are free to use this directly for
 * integration-style sanity checks, or a small hand-written fake for
 * deterministic ordering control -- both satisfy the same 3-method
 * interface above. */
export function createPollEvents(): PollEvents {
  const emitter = new EventEmitter();
  return {
    on(key: string, cb: () => void): void {
      emitter.on(key, cb);
    },
    off(key: string, cb: () => void): void {
      emitter.off(key, cb);
    },
    emit(key: string): void {
      emitter.emit(key);
    },
  };
}

/**
 * Every outcome one `resolvePoll` call can settle to.
 *
 * `'dispatch'`/`'waiting'`/`'ended'`/`'browser_disconnected'` are the four
 * states an actual `PollResponse` (router/types.ts) can carry to the
 * orchestrator (POLL-01's "stays silent until feedback, session end, or
 * grace-period expiry", POLL-04's "distinct resumable state, not an
 * error"). `'aborted'`/`'not-found'` are internal-only outcomes 06-07's
 * route handler must interpret without ever writing a `PollResponse` body
 * at all: `'aborted'` means "the socket is already gone -- write nothing"
 * (POLL-02's drain-verify-restore guarantee), and `'not-found'` means no
 * such session exists (a 404, not a poll outcome).
 */
export type PollOutcome =
  | { status: 'dispatch'; dispatches: readonly DispatchEnvelope[] }
  | { status: 'waiting' }
  | { status: 'ended' }
  | { status: 'browser_disconnected' }
  | { status: 'aborted' }
  | { status: 'not-found' };

/**
 * `timeoutMs: null` is ARCHITECTURE.md's "no-timeout" mode -- POLL-03's
 * whitespace-heartbeat stream: `writeHeartbeat()` is called every
 * `heartbeatMs` while waiting, and the poll only ever ends via a wake,
 * session-end, or `browser_disconnected`. `timeoutMs: <number>` bounds the
 * wait, resolving `'waiting'` if nothing else happens first.
 * `disconnectGraceMs` and `now()` feed `isBrowserConnected` (POLL-04) --
 * `now()` is caller-supplied (not `Date.now()` called internally) so
 * disconnect-grace behavior stays provable against an injected clock the
 * same way `isBrowserConnected` itself already is.
 */
export interface ResolvePollOptions {
  readonly timeoutMs: number | null;
  readonly heartbeatMs: number;
  readonly disconnectGraceMs: number;
  now(): number;
  writeHeartbeat(): void;
}

/** The result of one atomic "is there anything to hand back right now"
 * check, combining the not-found/ended/empty-queue checks and the actual
 * drain into a SINGLE `store.mutate()` call so there is no read-then-drain
 * race window between peeking the queue and draining it. */
type DrainAttempt =
  | { kind: 'not-found' }
  | { kind: 'ended' }
  | { kind: 'empty' }
  | { kind: 'drained'; dispatches: readonly DispatchEnvelope[] };

async function attemptDrain(store: SessionStore, key: string): Promise<DrainAttempt> {
  return store.mutate<DrainAttempt>((state) => {
    const record = state.sessions[key];
    if (!record) return { next: state, result: { kind: 'not-found' } };
    if (record.sessionEndedAt !== null) return { next: state, result: { kind: 'ended' } };
    if (record.queue.length === 0) return { next: state, result: { kind: 'empty' } };

    const drained = drainQueue(state, key);
    if (drained.result.status !== 'ok') {
      // Unreachable: `record` was just proven to exist above, and
      // drainQueue's only 'not-found' path is a missing record.
      return { next: state, result: { kind: 'not-found' } };
    }
    return { next: drained.next, result: { kind: 'drained', dispatches: drained.result.drained } };
  });
}

/** Once something has actually been drained (either on the immediate path
 * or after a wake), the SAME drain-verify-restore check applies: if the
 * connection is already gone, restore the drained ids to the FRONT of the
 * queue (POLL-02) and resolve 'aborted' -- write nothing. Otherwise hand
 * the dispatches back. */
async function finalizeDrainResult(
  store: SessionStore,
  key: string,
  conn: PollConnection,
  dispatches: readonly DispatchEnvelope[],
): Promise<PollOutcome> {
  if (conn.isClosed()) {
    await store.mutate((state) =>
      restoreToQueue(
        state,
        key,
        dispatches.map((d) => d.dispatch_id),
      ),
    );
    return { status: 'aborted' };
  }
  return { status: 'dispatch', dispatches };
}

/**
 * POLL-01..04's entry point.
 *
 * - Not-found / already-ended is checked before the queue is ever looked
 *   at (POLL-01's "stays silent until... the session ends" -- an ended
 *   session never delivers stale dispatches).
 * - A non-empty queue drains and resolves immediately -- no waiter is
 *   ever registered on this path, so this is a pure async-ordering result
 *   with zero timers touched.
 * - An empty queue registers a waiter and races wake / disconnect-grace /
 *   (optionally) an overall timeout -- see `waitForWakeOrTimeout`.
 */
export async function resolvePoll(
  store: SessionStore,
  key: string,
  conn: PollConnection,
  events: PollEvents,
  opts: ResolvePollOptions,
): Promise<PollOutcome> {
  const attempt = await attemptDrain(store, key);
  if (attempt.kind === 'not-found') return { status: 'not-found' };
  if (attempt.kind === 'ended') return { status: 'ended' };
  if (attempt.kind === 'drained') return finalizeDrainResult(store, key, conn, attempt.dispatches);
  return waitForWakeOrTimeout(store, key, conn, events, opts);
}

/**
 * The empty-queue branch: register a wake listener, a self re-arming
 * disconnect-grace check, and (heartbeat xor overall-timeout) depending on
 * `opts.timeoutMs`. Every listener/timer registered here is torn down on
 * EVERY resolution path (T-06-09) -- a poll that resolves can never keep
 * a stray listener on `events` or a live timer referencing this closure.
 */
function waitForWakeOrTimeout(
  store: SessionStore,
  key: string,
  conn: PollConnection,
  events: PollEvents,
  opts: ResolvePollOptions,
): Promise<PollOutcome> {
  return new Promise<PollOutcome>((resolve) => {
    let settled = false;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let disconnectTimer: NodeJS.Timeout | null = null;
    let overallTimer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      events.off(key, wake);
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      if (disconnectTimer !== null) clearTimeout(disconnectTimer);
      if (overallTimer !== null) clearTimeout(overallTimer);
      heartbeatTimer = null;
      disconnectTimer = null;
      overallTimer = null;
    };

    const settle = (outcome: PollOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    function wake(): void {
      if (settled) return;
      void handleWake();
    }

    async function handleWake(): Promise<void> {
      const attempt = await attemptDrain(store, key);
      if (settled) return; // resolved by something else (e.g. onClose) while this awaited
      if (attempt.kind === 'not-found') return settle({ status: 'not-found' });
      if (attempt.kind === 'ended') return settle({ status: 'ended' });
      if (attempt.kind === 'empty') return; // spurious wake -- e.g. a sibling poll already drained it; keep waiting
      const outcome = await finalizeDrainResult(store, key, conn, attempt.dispatches);
      settle(outcome);
    }

    async function checkDisconnect(): Promise<void> {
      if (settled) return;
      const state = await store.read();
      if (settled) return;
      const record = state.sessions[key];
      if (!record) return settle({ status: 'not-found' });
      if (record.sessionEndedAt !== null) return settle({ status: 'ended' });

      const nowMs = opts.now();
      if (!isBrowserConnected(record.browserLastSeenAt, nowMs, opts.disconnectGraceMs)) {
        return settle({ status: 'browser_disconnected' });
      }

      // Re-arm for exactly when the CURRENT browserLastSeenAt would next
      // expire, then recompute from scratch when it fires -- never resolve
      // off a value captured back when the timer was scheduled. This is
      // IdleController's (idle.ts) own "recheck at fire time, not just at
      // schedule time" discipline, one layer up: a heartbeat landing in
      // the gap between "scheduled" and "fires" must not produce a stale
      // disconnect.
      const lastSeenMs = record.browserLastSeenAt === null ? nowMs : Date.parse(record.browserLastSeenAt);
      const remaining = Math.max(opts.disconnectGraceMs - (nowMs - lastSeenMs), 0);
      disconnectTimer = setTimeout(() => void checkDisconnect(), remaining);
      disconnectTimer.unref();
    }

    conn.onClose(() => {
      // The socket died while this wait cycle had drained nothing yet --
      // there is nothing to restore (drainQueue was never invoked this
      // cycle); the caller writes nothing to a dead connection either way,
      // the same 'aborted' outcome as the drain-then-closed race handled
      // by finalizeDrainResult.
      settle({ status: 'aborted' });
    });

    events.on(key, wake);
    void checkDisconnect();

    if (opts.timeoutMs === null) {
      // ARCHITECTURE.md's whitespace-heartbeat stream (POLL-03): leading
      // whitespace is legal JSON, so writing " " on a cadence and later
      // ending with the real JSON body needs no custom client protocol.
      // `opts.writeHeartbeat()` is the caller's (06-07's) hook to perform
      // that actual socket write; this file only owns the cadence.
      heartbeatTimer = setInterval(() => {
        if (!settled) opts.writeHeartbeat();
      }, opts.heartbeatMs);
      heartbeatTimer.unref();
    } else {
      overallTimer = setTimeout(() => settle({ status: 'waiting' }), opts.timeoutMs);
      overallTimer.unref();
    }
  });
}
