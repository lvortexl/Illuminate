import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertSession, sessionStorePathFor, SessionStore } from '../../src/store/session-store.ts';
import { enqueueDispatch, recordHeartbeat, endSession } from '../../src/daemon/dispatch-ledger.ts';
import type { DispatchEnvelope } from '../../src/router/types.ts';
import { forceRemove } from '../fixtures/cleanup.ts';
import {
  resolvePoll,
  createPollEvents,
  type PollConnection,
  type PollEvents,
  type PollOutcome,
  type ResolvePollOptions,
} from '../../src/daemon/poll.ts';

const KEY = 'session-key-1';
const FILE = 'artifact.html';

// ---------------------------------------------------------------------------
// Fixtures -- mirrors test/daemon/dispatch-ledger.test.ts's own
// withTempDir/withStore pattern: resolvePoll takes a real SessionStore
// (not a plain IlluminateState), so every test here exercises the real
// mutex-serialized, atomic-write store, exactly as 06-07's real route
// handlers will.
// ---------------------------------------------------------------------------

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-poll-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

async function withStore<T>(fn: (store: SessionStore) => Promise<T>): Promise<T> {
  return withTempDir(async (artifactRoot) => {
    const store = new SessionStore(artifactRoot);
    try {
      await store.mutate((state) => upsertSession(state, KEY, FILE));
      return await fn(store);
    } finally {
      await rm(sessionStorePathFor(artifactRoot), { force: true });
    }
  });
}

let envelopeCounter = 0;
function makeEnvelope(id: string): DispatchEnvelope {
  envelopeCounter += 1;
  return {
    protocol: 'illuminate.dispatch/1',
    dispatch_id: id,
    intent: 'explain',
    role: 'tutor',
    model_tier: 'haiku',
    deadline_ms: 30000,
    element: {
      uid: `elem-${id}-${envelopeCounter}`,
      selector: `#${id}`,
      tag: 'p',
      text: 'some text',
      prefixContext: null,
      suffixContext: null,
    },
    source: null,
    return_to: `illuminate answer ${id}`,
    return_contract: 'run the command above, piping your markdown answer to stdin',
    tools: [],
    depth: 1,
    parent_dispatch: null,
    learnerNote: null,
    note: null,
    attachments: [],
  };
}

function defaultOpts(overrides: Partial<ResolvePollOptions> = {}): ResolvePollOptions {
  return {
    timeoutMs: 60_000,
    heartbeatMs: 1000,
    disconnectGraceMs: 1_000_000,
    now: () => Date.now(),
    writeHeartbeat: () => {},
    ...overrides,
  };
}

/** A hand-written fake `PollConnection`. `onCloseRegistered` resolves the
 * instant `resolvePoll` has actually registered its close handler -- an
 * await-ordering hook so tests can trigger a close deterministically
 * without racing against a guessed number of ticks. */
function fakeConn(closed: boolean): PollConnection & { triggerClose(): void; onCloseRegistered: Promise<void> } {
  let onCloseCb: (() => void) | null = null;
  let markRegistered!: () => void;
  const onCloseRegistered = new Promise<void>((resolve) => {
    markRegistered = resolve;
  });
  return {
    isClosed: () => closed,
    onClose(cb: () => void): void {
      onCloseCb = cb;
      markRegistered();
    },
    triggerClose(): void {
      onCloseCb?.();
    },
    onCloseRegistered,
  };
}

/** A `PollEvents` built on a real `node:events.EventEmitter` (kept, not a
 * hand-rolled fake, as the plan itself encourages for integration sanity),
 * plus `onceListenerAttached` -- an await-ordering hook using
 * EventEmitter's own synchronous `'newListener'` signal, so a test can
 * `await` the exact moment `resolvePoll` has subscribed its wake listener
 * before emitting, with zero timers of any kind. */
function syncedEvents(): PollEvents & { onceListenerAttached(key: string): Promise<void> } {
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
    onceListenerAttached(key: string): Promise<void> {
      return new Promise((resolve) => {
        emitter.once('newListener', (eventName: string) => {
          if (eventName === key) resolve();
        });
      });
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Task 1: immediate delivery, wake-on-enqueue, drain-verify-restore,
// session-ended, not-found. Every test in this section touches ZERO real
// timers -- resolution is driven entirely by direct async ordering
// (mutex-serialized store calls and event emission), never a setTimeout.
// ---------------------------------------------------------------------------

test('resolvePoll on an unknown key resolves not-found immediately, no waiting registered', async () => {
  await withStore(async (store) => {
    const outcome = await resolvePoll(store, 'no-such-key', fakeConn(false), createPollEvents(), defaultOpts());
    assert.deepStrictEqual(outcome, { status: 'not-found' });
  });
});

test('a session with sessionEndedAt set resolves ended immediately, regardless of queued dispatches', async () => {
  await withStore(async (store) => {
    await store.mutate((state) => enqueueDispatch(state, KEY, makeEnvelope('d1')));
    await store.mutate((state) => endSession(state, KEY, new Date().toISOString()));

    const outcome = await resolvePoll(store, KEY, fakeConn(false), createPollEvents(), defaultOpts());
    assert.deepStrictEqual(outcome, { status: 'ended' }, 'ended is checked before the queue is ever looked at');
  });
});

test('a poll with dispatches already queued resolves immediately, in original order, with zero waiting registered', async () => {
  await withStore(async (store) => {
    const e1 = makeEnvelope('d1');
    const e2 = makeEnvelope('d2');
    await store.mutate((state) => enqueueDispatch(state, KEY, e1));
    await store.mutate((state) => enqueueDispatch(state, KEY, e2));

    // A `PollEvents` that throws if resolvePoll ever subscribes to it --
    // proves no waiter is registered on the immediate-delivery path.
    const noWaiterEvents: PollEvents = {
      on: () => {
        throw new Error('resolvePoll must not register a waiter when the queue is already non-empty');
      },
      off: () => {},
      emit: () => {},
    };

    const outcome = await resolvePoll(store, KEY, fakeConn(false), noWaiterEvents, defaultOpts());
    assert.deepStrictEqual(outcome, { status: 'dispatch', dispatches: [e1, e2] });
  });
});

test('a poll waiting when a dispatch is enqueued elsewhere wakes and resolves via the emitted event, never a timer', async () => {
  await withStore(async (store) => {
    const events = syncedEvents();
    const listenerReady = events.onceListenerAttached(KEY);

    // A huge, never-fired timeoutMs/disconnectGraceMs: present only so the
    // type is satisfied and the overall-timeout/disconnect-grace branches
    // are exercised without ever actually elapsing before the wake settles
    // this promise -- resolution below is proven to come from the emit,
    // not from either timer (both get cleared, unfired, on settle()).
    const opts = defaultOpts({ timeoutMs: 10 * 60 * 1000, disconnectGraceMs: 10 * 60 * 1000 });
    const pollPromise = resolvePoll(store, KEY, fakeConn(false), events, opts);

    await listenerReady; // resolvePoll has subscribed its wake listener -- safe to enqueue now
    const envelope = makeEnvelope('d1');
    await store.mutate((state) => enqueueDispatch(state, KEY, envelope));
    events.emit(KEY);

    const outcome = await pollPromise;
    assert.deepStrictEqual(outcome, { status: 'dispatch', dispatches: [envelope] });
  });
});

test('a poll whose connection is already closed drains, restores to the FRONT of the queue, and resolves aborted -- then a follow-up poll sees the same dispatches again, in the same order', async () => {
  await withStore(async (store) => {
    const e1 = makeEnvelope('d1');
    const e2 = makeEnvelope('d2');
    await store.mutate((state) => enqueueDispatch(state, KEY, e1));
    await store.mutate((state) => enqueueDispatch(state, KEY, e2));

    const deadConn = fakeConn(true); // already closed by the time resolvePoll checks it
    const outcome1 = await resolvePoll(store, KEY, deadConn, createPollEvents(), defaultOpts());
    assert.deepStrictEqual(outcome1, { status: 'aborted' }, 'a dead connection must produce aborted, never a dispatch response');

    const midState = await store.read();
    assert.deepStrictEqual(
      midState.sessions[KEY]?.queue,
      ['d1', 'd2'],
      'restoreToQueue prepends the drained ids back in their original order',
    );

    // The next real poll (a fresh, live connection) must see them
    // delivered normally -- nothing was lost by the aborted poll.
    const liveConn = fakeConn(false);
    const outcome2 = await resolvePoll(store, KEY, liveConn, createPollEvents(), defaultOpts());
    assert.deepStrictEqual(outcome2, { status: 'dispatch', dispatches: [e1, e2] });
  });
});

test('a poll waiting with an empty queue resolves aborted, with nothing to restore, if the connection closes before anything is enqueued', async () => {
  await withStore(async (store) => {
    const conn = fakeConn(false);
    const opts = defaultOpts({ timeoutMs: 10 * 60 * 1000, disconnectGraceMs: 10 * 60 * 1000 });
    const pollPromise = resolvePoll(store, KEY, conn, createPollEvents(), opts);

    await conn.onCloseRegistered; // resolvePoll has registered its close handler
    conn.triggerClose();

    const outcome = await pollPromise;
    assert.deepStrictEqual(outcome, { status: 'aborted' });

    const state = await store.read();
    assert.deepStrictEqual(state.sessions[KEY]?.queue, [], 'nothing was ever drained, so there is nothing to restore');
  });
});

test('a spurious wake with nothing actually queued keeps the poll waiting instead of resolving early', async () => {
  await withStore(async (store) => {
    const events = syncedEvents();
    const listenerReady = events.onceListenerAttached(KEY);
    const opts = defaultOpts({ timeoutMs: 10 * 60 * 1000, disconnectGraceMs: 10 * 60 * 1000 });
    const pollPromise = resolvePoll(store, KEY, fakeConn(false), events, opts);

    await listenerReady;
    events.emit(KEY); // nothing was actually enqueued -- a spurious wake

    // Prove it did NOT resolve from the spurious wake: enqueue for real
    // afterward and confirm the SAME still-pending poll now resolves with
    // the real dispatch, driven by a second emit.
    const envelope = makeEnvelope('d1');
    await store.mutate((state) => enqueueDispatch(state, KEY, envelope));
    events.emit(KEY);

    const outcome = await pollPromise;
    assert.deepStrictEqual(outcome, { status: 'dispatch', dispatches: [envelope] });
  });
});

// ---------------------------------------------------------------------------
// Task 2: heartbeat cadence and browser-disconnect-grace. These are the
// two genuinely time-based branches this plan's own design calls out --
// small, real timer values, threshold-asserted ("at least N by a generous
// deadline"), never asserted against an exact fire time.
// ---------------------------------------------------------------------------

test('a no-timeout poll writes at least two heartbeats within a generous window when the queue stays empty', async () => {
  await withStore(async (store) => {
    const events = createPollEvents();
    const heartbeats: number[] = [];
    const opts = defaultOpts({
      timeoutMs: null,
      heartbeatMs: 5,
      disconnectGraceMs: 10 * 60 * 1000,
      writeHeartbeat: () => heartbeats.push(Date.now()),
    });

    const pollPromise = resolvePoll(store, KEY, fakeConn(false), events, opts);
    await sleep(200); // generous: ~40x heartbeatMs -- only "did N happen", never "at exactly T"
    assert.ok(heartbeats.length >= 2, `expected at least 2 heartbeats in 200ms at heartbeatMs=5, got ${heartbeats.length}`);

    // Clean shutdown so the poll (and its interval) settles before the test ends.
    await store.mutate((state) => endSession(state, KEY, new Date().toISOString()));
    events.emit(KEY);
    const outcome = await pollPromise;
    assert.deepStrictEqual(outcome, { status: 'ended' });
  });
});

test('heartbeat writes stop firing once a no-timeout poll resolves -- no heartbeat after resolution', async () => {
  await withStore(async (store) => {
    const events = syncedEvents();
    const listenerReady = events.onceListenerAttached(KEY);
    const heartbeats: number[] = [];
    const opts = defaultOpts({
      timeoutMs: null,
      heartbeatMs: 5,
      disconnectGraceMs: 10 * 60 * 1000,
      writeHeartbeat: () => heartbeats.push(Date.now()),
    });

    const pollPromise = resolvePoll(store, KEY, fakeConn(false), events, opts);
    await listenerReady;
    await sleep(60); // let a real handful of heartbeats land first

    const envelope = makeEnvelope('d1');
    await store.mutate((state) => enqueueDispatch(state, KEY, envelope));
    events.emit(KEY);
    const outcome = await pollPromise;
    assert.deepStrictEqual(outcome, { status: 'dispatch', dispatches: [envelope] });

    const countAtResolution = heartbeats.length;
    assert.ok(countAtResolution > 0, 'sanity: at least one heartbeat must have landed before resolution');
    await sleep(60); // generous window past resolution -- a leaked interval would fire again here
    assert.strictEqual(heartbeats.length, countAtResolution, 'no heartbeat may fire after the poll has resolved');
  });
});

test('browser_disconnected re-arms on a fresh heartbeat instead of firing at the original stale deadline, and still eventually fires once heartbeats truly stop', async () => {
  await withStore(async (store) => {
    await store.mutate((state) => recordHeartbeat(state, KEY, new Date().toISOString()));

    const graceMs = 60;
    const opts = defaultOpts({ timeoutMs: 10 * 60 * 1000, disconnectGraceMs: graceMs });

    let outcome: PollOutcome | undefined;
    const pollPromise = resolvePoll(store, KEY, fakeConn(false), createPollEvents(), opts).then((o) => {
      outcome = o;
      return o;
    });

    await sleep(20); // t=20, well before the original ~60ms deadline
    await store.mutate((state) => recordHeartbeat(state, KEY, new Date().toISOString())); // fresh heartbeat -- pushes the deadline to ~t=20+60=80

    await sleep(50); // t=70 -- past the ORIGINAL 60ms deadline, but before the re-armed ~80ms one
    assert.strictEqual(outcome, undefined, 'must not have fired at the original, now-stale deadline -- proves re-arm, not a one-shot schedule');

    await sleep(60); // t=130 -- safely past the re-armed ~80ms deadline
    assert.deepStrictEqual(await pollPromise, { status: 'browser_disconnected' });
    assert.deepStrictEqual(outcome, { status: 'browser_disconnected' });
  });
});

test('a poll with an explicit timeout and nothing queued resolves waiting once the timeout elapses', async () => {
  await withStore(async (store) => {
    const opts = defaultOpts({ timeoutMs: 20, disconnectGraceMs: 10 * 60 * 1000 });
    const started = Date.now();

    const outcome = await resolvePoll(store, KEY, fakeConn(false), createPollEvents(), opts);

    assert.deepStrictEqual(outcome, { status: 'waiting' });
    assert.ok(Date.now() - started >= 20, 'waiting must not resolve before its own timeoutMs has elapsed');
  });
});

// ---------------------------------------------------------------------------
// Task 3: outcome / requirement traceability.
//
// ROADMAP.md, Phase 6, Success Criterion #1 (quoted verbatim so this file
// stays self-documenting):
//
//   "illuminate poll stays silent until there is feedback, the session
//   ends, or the browser exceeds its grace period; a killed or timed-out
//   poll loses nothing and an interrupted drain re-queues prepended so
//   order survives; a no-timeout poll keeps alive on a whitespace
//   heartbeat and still terminates as valid JSON; a browser gone past its
//   reconnect grace surfaces as a distinct resumable state, not an error."
//
// Clause -> proving test(s) in this file:
//
//   "stays silent until there is feedback"
//     -> 'a poll waiting when a dispatch is enqueued elsewhere wakes and
//        resolves via the emitted event, never a timer'
//     -> 'a spurious wake with nothing actually queued keeps the poll
//        waiting instead of resolving early'
//   "...the session ends..."
//     -> 'a session with sessionEndedAt set resolves ended immediately,
//        regardless of queued dispatches'
//   "...or the browser exceeds its grace period"
//     -> 'browser_disconnected re-arms on a fresh heartbeat instead of
//        firing at the original stale deadline, and still eventually
//        fires once heartbeats truly stop'
//   "a killed or timed-out poll loses nothing and an interrupted drain
//   re-queues prepended so order survives"
//     -> 'a poll whose connection is already closed drains, restores to
//        the FRONT of the queue, and resolves aborted -- then a follow-up
//        poll sees the same dispatches again, in the same order'
//     -> 'a poll waiting with an empty queue resolves aborted, with
//        nothing to restore, if the connection closes before anything is
//        enqueued'
//   "a no-timeout poll keeps alive on a whitespace heartbeat and still
//   terminates as valid JSON"
//     -> 'a no-timeout poll writes at least two heartbeats within a
//        generous window when the queue stays empty' (the actual
//        whitespace-byte writing and JSON termination are 06-07's wire-
//        level concern; this file proves the CADENCE resolvePoll drives
//        via opts.writeHeartbeat())
//     -> 'heartbeat writes stop firing once a no-timeout poll resolves --
//        no heartbeat after resolution'
//   "a browser gone past its reconnect grace surfaces as a distinct
//   resumable state, not an error"
//     -> 'browser_disconnected re-arms on a fresh heartbeat instead of
//        firing at the original stale deadline, and still eventually
//        fires once heartbeats truly stop' (PollOutcome's
//        'browser_disconnected' is its own named status, never a thrown
//        error or rejected promise)
//
// PollOutcome variant -> at least one dedicated test:
//   'dispatch'            -> immediate-delivery and wake-on-enqueue tests above
//   'waiting'              -> 'a poll with an explicit timeout and nothing
//                             queued resolves waiting once the timeout elapses'
//   'ended'                -> 'a session with sessionEndedAt set resolves
//                             ended immediately...'
//   'browser_disconnected' -> the re-arm test above
//   'aborted'              -> the drain-verify-restore and
//                             waiting-then-closed tests above
//   'not-found'            -> 'resolvePoll on an unknown key resolves
//                             not-found immediately, no waiting registered'
// ---------------------------------------------------------------------------
