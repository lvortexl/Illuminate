import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertSession, sessionStorePathFor, SessionStore } from '../../src/store/session-store.ts';
import type { IlluminateState, SessionRecord } from '../../src/store/session-store.ts';
import type { DispatchEnvelope } from '../../src/router/types.ts';
import { forceRemove } from '../fixtures/cleanup.ts';
import {
  enqueueDispatch,
  drainQueue,
  restoreToQueue,
  recordHeartbeat,
  isBrowserConnected,
  endSession,
} from '../../src/daemon/dispatch-ledger.ts';

const KEY = 'session-key-1';
const FILE = 'artifact.html';

/** The two constant answers the `isWorkInFlight` predicate can give. The
 * production caller (server.ts) passes the real one: "a poll is open for this
 * session, or a self-dispatch for this dispatch id has not come back yet". */
const WORK_IN_FLIGHT = (): boolean => true;
const NOTHING_IN_FLIGHT = (): boolean => false;

/** A state with exactly one freshly upserted session under KEY. */
function stateWithSession(): IlluminateState {
  const { next } = upsertSession({ sessions: {} }, KEY, FILE);
  return next;
}

/** A DispatchEnvelope fixture. Each id gets its own element uid by default,
 * so two different ids never accidentally collide on the dedupe key --
 * dedupe-specific tests override `element`/`source` explicitly to force a
 * collision on purpose. */
function makeEnvelope(id: string, overrides: Partial<DispatchEnvelope> = {}): DispatchEnvelope {
  return {
    protocol: 'illuminate.dispatch/2',
    dispatch_id: id,
    intent: 'explain',
    role: 'tutor',
    model_tier: 'haiku',
    deadline_ms: 30000,
    targets: [
      { element: { uid: `elem-${id}`, selector: `#${id}`, tag: 'p', text: 'some text', prefixContext: null, suffixContext: null }, source: null },
    ],
    return_to: `illuminate answer ${id}`,
    return_contract: 'run the command above, piping your markdown answer to stdin',
    tools: [],
    depth: 1,
    parent_dispatch: null,
    learnerNote: null,
    note: null,
    attachments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// enqueueDispatch: brand-new envelopes
// ---------------------------------------------------------------------------

test('enqueueDispatch on a brand-new envelope adds it to dispatches as open and appends its id to the queue', () => {
  const state = stateWithSession();
  const envelope = makeEnvelope('d1');

  const { next, result } = enqueueDispatch(state, KEY, envelope);

  assert.deepStrictEqual(result, { status: 'ok', dispatchId: 'd1', envelope });
  const record = next.sessions[KEY];
  assert.ok(record);
  assert.deepStrictEqual(record?.queue, ['d1']);
  assert.strictEqual(record?.dispatches['d1']?.status, 'open');
  assert.strictEqual(record?.dispatches['d1']?.envelope, envelope);
  assert.strictEqual(record?.dispatches['d1']?.deliveredAt, null);
  assert.strictEqual(record?.dispatches['d1']?.answer, null);
});

test('enqueueDispatch on an unknown key returns not-found and performs no mutation', () => {
  const state = stateWithSession();
  const { next, result } = enqueueDispatch(state, 'no-such-key', makeEnvelope('d1'));

  assert.deepStrictEqual(result, { status: 'not-found' });
  assert.strictEqual(next, state);
});

test('enqueueDispatch appends multiple distinct envelopes to the END of the queue, in call order', () => {
  const state0 = stateWithSession();
  const e1 = enqueueDispatch(state0, KEY, makeEnvelope('d1'));
  const e2 = enqueueDispatch(e1.next, KEY, makeEnvelope('d2'));
  const e3 = enqueueDispatch(e2.next, KEY, makeEnvelope('d3'));

  assert.deepStrictEqual(e3.next.sessions[KEY]?.queue, ['d1', 'd2', 'd3']);
});

// ---------------------------------------------------------------------------
// enqueueDispatch: dedupe
// ---------------------------------------------------------------------------

test('enqueueDispatch dedupes a second envelope with the same (element uid, intent, source content) against an OPEN entry SOMETHING IS WORKING ON', () => {
  // T-06-06: two clicks in quick succession yield one card and one bill.
  // `WORK_IN_FLIGHT` is what makes this the in-flight case rather than the
  // abandoned one -- see the retry tests further down for the difference.
  const state0 = stateWithSession();
  const first = enqueueDispatch(state0, KEY, makeEnvelope('d1', { targets: [{ element: { uid: 'same-elem', selector: '#x', tag: 'p', text: 't', prefixContext: null, suffixContext: null }, source: null }] }));
  assert.strictEqual(first.result.status, 'ok');

  const second = enqueueDispatch(
    first.next,
    KEY,
    makeEnvelope('d2', { targets: [{ element: { uid: 'same-elem', selector: '#x', tag: 'p', text: 't', prefixContext: null, suffixContext: null }, source: null }] }),
    WORK_IN_FLIGHT,
  );

  assert.deepStrictEqual(second.result, { status: 'duplicate', dispatchId: 'd1' });
  // No second entry created, no second id queued.
  assert.deepStrictEqual(second.next.sessions[KEY]?.queue, ['d1']);
  assert.strictEqual(second.next.sessions[KEY]?.dispatches['d2'], undefined);
  assert.strictEqual(second.next, first.next, 'a duplicate is a true no-op -- no new state object at all');
});

test('enqueueDispatch dedupes against a DELIVERED entry (still non-terminal, still a duplicate)', () => {
  const state0 = stateWithSession();
  const elem = { uid: 'same-elem', selector: '#x', tag: 'p', text: 't', prefixContext: null, suffixContext: null };
  const first = enqueueDispatch(state0, KEY, makeEnvelope('d1', { targets: [{ element: elem, source: null }] }));
  const drained = drainQueue(first.next, KEY);
  assert.strictEqual(drained.result.status, 'ok');
  assert.strictEqual(drained.next.sessions[KEY]?.dispatches['d1']?.status, 'delivered');

  const second = enqueueDispatch(drained.next, KEY, makeEnvelope('d2', { targets: [{ element: elem, source: null }] }));
  assert.deepStrictEqual(second.result, { status: 'duplicate', dispatchId: 'd1' });
});

test('enqueueDispatch dedupes against an ANSWERED entry (still non-terminal, still a duplicate)', () => {
  const state0 = stateWithSession();
  const elem = { uid: 'same-elem', selector: '#x', tag: 'p', text: 't', prefixContext: null, suffixContext: null };
  const first = enqueueDispatch(state0, KEY, makeEnvelope('d1', { targets: [{ element: elem, source: null }] }));
  const record = first.next.sessions[KEY];
  assert.ok(record);
  const answeredEntry = record.dispatches['d1'];
  assert.ok(answeredEntry);
  const stateWithAnswered: IlluminateState = {
    ...first.next,
    sessions: {
      ...first.next.sessions,
      [KEY]: {
        ...record,
        dispatches: { ...record.dispatches, d1: { ...answeredEntry, status: 'answered' } },
      },
    },
  };

  const second = enqueueDispatch(stateWithAnswered, KEY, makeEnvelope('d2', { targets: [{ element: elem, source: null }] }));
  assert.deepStrictEqual(second.result, { status: 'duplicate', dispatchId: 'd1' });
});

test('enqueueDispatch does NOT dedupe against a CANCELLED entry -- re-asking after cancellation creates a genuinely new entry', () => {
  const state0 = stateWithSession();
  const elem = { uid: 'same-elem', selector: '#x', tag: 'p', text: 't', prefixContext: null, suffixContext: null };
  const first = enqueueDispatch(state0, KEY, makeEnvelope('d1', { targets: [{ element: elem, source: null }] }));
  const record = first.next.sessions[KEY];
  assert.ok(record);
  const entry = record.dispatches['d1'];
  assert.ok(entry);
  const stateWithCancelled: IlluminateState = {
    ...first.next,
    sessions: {
      ...first.next.sessions,
      [KEY]: {
        ...record,
        dispatches: { ...record.dispatches, d1: { ...entry, status: 'cancelled' } },
      },
    },
  };

  const cancelledRetry = makeEnvelope('d2', { targets: [{ element: elem, source: null }] });
  const second = enqueueDispatch(stateWithCancelled, KEY, cancelledRetry);
  assert.deepStrictEqual(second.result, { status: 'ok', dispatchId: 'd2', envelope: cancelledRetry });
  assert.strictEqual(second.next.sessions[KEY]?.dispatches['d2']?.status, 'open');
});

test('enqueueDispatch does NOT dedupe against an EXPIRED entry -- re-asking after expiry creates a genuinely new entry', () => {
  const state0 = stateWithSession();
  const elem = { uid: 'same-elem', selector: '#x', tag: 'p', text: 't', prefixContext: null, suffixContext: null };
  const first = enqueueDispatch(state0, KEY, makeEnvelope('d1', { targets: [{ element: elem, source: null }] }));
  const record = first.next.sessions[KEY];
  assert.ok(record);
  const entry = record.dispatches['d1'];
  assert.ok(entry);
  const stateWithExpired: IlluminateState = {
    ...first.next,
    sessions: {
      ...first.next.sessions,
      [KEY]: {
        ...record,
        dispatches: { ...record.dispatches, d1: { ...entry, status: 'expired' } },
      },
    },
  };

  const expiredRetry = makeEnvelope('d2', { targets: [{ element: elem, source: null }] });
  const second = enqueueDispatch(stateWithExpired, KEY, expiredRetry);
  assert.deepStrictEqual(second.result, { status: 'ok', dispatchId: 'd2', envelope: expiredRetry });
});

test('enqueueDispatch does not dedupe two envelopes that differ only in source.content', () => {
  const state0 = stateWithSession();
  const elem = { uid: 'same-elem', selector: '#x', tag: 'p', text: 't', prefixContext: null, suffixContext: null };
  const sourceA = { path: 'a.ts', rev: null, range: null, status: 'unchanged' as const, content: 'content A' };
  const sourceB = { path: 'a.ts', rev: null, range: null, status: 'unchanged' as const, content: 'content B' };

  const first = enqueueDispatch(state0, KEY, makeEnvelope('d1', { targets: [{ element: elem, source: sourceA }] }));
  const differentContent = makeEnvelope('d2', { targets: [{ element: elem, source: sourceB }] });
  const second = enqueueDispatch(first.next, KEY, differentContent);

  assert.deepStrictEqual(second.result, { status: 'ok', dispatchId: 'd2', envelope: differentContent });
});

// ---------------------------------------------------------------------------
// 07-07: a self-explanation (learnerNote set) must NOT dedupe against the
// SAME element/intent/content's already-answered ordinary explain -- EDU-06's
// whole mechanism is a second `explain` dispatch on the identical element it
// was already explained on (same uid, same resolved source.content), the
// exact shape `computeDedupeKey`'s pre-07-07 formula (element uid : intent :
// source.content) could not distinguish from a genuine duplicate click.
// Without `learnerNote` in the key, a reader's typed explanation would
// silently collide with -- and be discarded in favor of -- the original,
// already-answered explain dispatch, exactly the "passes every unit test,
// dead in a real click" failure class this phase keeps surfacing.
// ---------------------------------------------------------------------------

test('enqueueDispatch does NOT dedupe a self-explanation (learnerNote set) against an already-answered ORDINARY explain on the same element/content', () => {
  const state0 = stateWithSession();
  const elem = { uid: 'same-elem', selector: '#x', tag: 'p', text: 't', prefixContext: null, suffixContext: null };
  const source = { path: 'a.ts', rev: null, range: null, status: 'unchanged' as const, content: 'content A' };

  const first = enqueueDispatch(state0, KEY, makeEnvelope('d1', { targets: [{ element: elem, source }], learnerNote: null }));
  assert.strictEqual(first.result.status, 'ok');

  const selfExplanation = makeEnvelope('d2', { targets: [{ element: elem, source }], learnerNote: 'my own guess', parent_dispatch: 'd1' });
  const second = enqueueDispatch(first.next, KEY, selfExplanation);

  assert.deepStrictEqual(
    second.result,
    { status: 'ok', dispatchId: 'd2', envelope: selfExplanation },
    'a learner-initiated self-explanation must create a genuinely new dispatch, never dedupe against the original explain it is chained from',
  );
});

test('enqueueDispatch DOES still dedupe two identical self-explanation submissions (same element/intent/content/learnerNote)', () => {
  const state0 = stateWithSession();
  const elem = { uid: 'same-elem', selector: '#x', tag: 'p', text: 't', prefixContext: null, suffixContext: null };
  const source = { path: 'a.ts', rev: null, range: null, status: 'unchanged' as const, content: 'content A' };

  const first = enqueueDispatch(state0, KEY, makeEnvelope('d1', { targets: [{ element: elem, source }], learnerNote: 'same guess' }));
  const second = enqueueDispatch(first.next, KEY, makeEnvelope('d2', { targets: [{ element: elem, source }], learnerNote: 'same guess' }), WORK_IN_FLIGHT);

  assert.deepStrictEqual(second.result, { status: 'duplicate', dispatchId: 'd1' });
});

test('two identical self-explanation submissions with NOTHING working on the first re-open it -- still one entry, still one bill', () => {
  // The retry rule applies to a self-explanation exactly as it does to an
  // ordinary explain: a graded follow-up whose grader never came back is just
  // as stuck, and just as un-retryable, as any other abandoned dispatch.
  const state0 = stateWithSession();
  const elem = { uid: 'same-elem', selector: '#x', tag: 'p', text: 't', prefixContext: null, suffixContext: null };
  const source = { path: 'a.ts', rev: null, range: null, status: 'unchanged' as const, content: 'content A' };

  const original = makeEnvelope('d1', { targets: [{ element: elem, source }], learnerNote: 'same guess' });
  const first = enqueueDispatch(state0, KEY, original);
  const second = enqueueDispatch(first.next, KEY, makeEnvelope('d2', { targets: [{ element: elem, source }], learnerNote: 'same guess' }), NOTHING_IN_FLIGHT);

  assert.deepStrictEqual(second.result, { status: 'ok', dispatchId: 'd1', envelope: original });
  assert.deepStrictEqual(second.next.sessions[KEY]?.queue, ['d1']);
  assert.strictEqual(second.next.sessions[KEY]?.dispatches['d2'], undefined);
});

// ---------------------------------------------------------------------------
// drainQueue
// ---------------------------------------------------------------------------

test('drainQueue on an unknown key returns not-found', () => {
  const state = stateWithSession();
  const { next, result } = drainQueue(state, 'no-such-key');
  assert.deepStrictEqual(result, { status: 'not-found' });
  assert.strictEqual(next, state);
});

test('drainQueue on an empty queue returns ok with an empty drained array -- not an error', () => {
  const state = stateWithSession();
  const { result } = drainQueue(state, KEY);
  assert.deepStrictEqual(result, { status: 'ok', drained: [] });
});

test('drainQueue atomically empties the queue, marks every drained entry delivered, and returns envelopes in original queue order', () => {
  const state0 = stateWithSession();
  const eA = enqueueDispatch(state0, KEY, makeEnvelope('a'));
  const eB = enqueueDispatch(eA.next, KEY, makeEnvelope('b'));
  const eC = enqueueDispatch(eB.next, KEY, makeEnvelope('c'));

  const drained = drainQueue(eC.next, KEY);
  assert.strictEqual(drained.result.status, 'ok');
  if (drained.result.status !== 'ok') throw new Error('unreachable');
  assert.deepStrictEqual(
    drained.result.drained.map((e) => e.dispatch_id),
    ['a', 'b', 'c'],
  );

  const record = drained.next.sessions[KEY];
  assert.ok(record);
  assert.deepStrictEqual(record.queue, [], 'queue is empty after drain');
  for (const id of ['a', 'b', 'c']) {
    assert.strictEqual(record.dispatches[id]?.status, 'delivered');
    assert.ok(typeof record.dispatches[id]?.deliveredAt === 'string');
  }
});

// ---------------------------------------------------------------------------
// restoreToQueue -- Pattern 2, drain-verify-restore
// ---------------------------------------------------------------------------

test('restoreToQueue on an unknown key returns not-found', () => {
  const state = stateWithSession();
  const { next, result } = restoreToQueue(state, 'no-such-key', ['a']);
  assert.deepStrictEqual(result, { status: 'not-found' });
  assert.strictEqual(next, state);
});

test('restoreToQueue reverts restored entries back to open and clears deliveredAt', () => {
  const state0 = stateWithSession();
  const eA = enqueueDispatch(state0, KEY, makeEnvelope('a'));
  const drained = drainQueue(eA.next, KEY);
  assert.strictEqual(drained.result.status, 'ok');

  const restored = restoreToQueue(drained.next, KEY, ['a']);
  assert.deepStrictEqual(restored.result, { status: 'ok' });
  const record = restored.next.sessions[KEY];
  assert.ok(record);
  assert.deepStrictEqual(record.queue, ['a']);
  assert.strictEqual(record.dispatches['a']?.status, 'open');
  assert.strictEqual(record.dispatches['a']?.deliveredAt, null);
});

test('drain-verify-restore: enqueue A,B,C; drain (queue empty); enqueue D (queue:[D]); restore [A,B,C] -> queue MUST be [A,B,C,D], never [D,A,B,C]', () => {
  const state0 = stateWithSession();
  const eA = enqueueDispatch(state0, KEY, makeEnvelope('A'));
  const eB = enqueueDispatch(eA.next, KEY, makeEnvelope('B'));
  const eC = enqueueDispatch(eB.next, KEY, makeEnvelope('C'));

  const drained = drainQueue(eC.next, KEY);
  assert.strictEqual(drained.result.status, 'ok');
  assert.deepStrictEqual(drained.next.sessions[KEY]?.queue, [], 'queue is empty right after drain');

  const eD = enqueueDispatch(drained.next, KEY, makeEnvelope('D'));
  assert.deepStrictEqual(eD.next.sessions[KEY]?.queue, ['D'], 'D queued while A/B/C were in flight to a (soon to fail) poller');

  const restored = restoreToQueue(eD.next, KEY, ['A', 'B', 'C']);
  assert.deepStrictEqual(
    restored.next.sessions[KEY]?.queue,
    ['A', 'B', 'C', 'D'],
    'restored ids are PREPENDED, in original order -- ordering is never scrambled by a failed delivery',
  );
});

// ---------------------------------------------------------------------------
// Concurrency: mutex serialization must hold for queue/ledger mutation too --
// mirrors test/store/session-store.test.ts's own "25 concurrent mutate()
// calls" proof, but exercising enqueueDispatch as the real-world reducer a
// route handler calls through store.mutate().
// ---------------------------------------------------------------------------

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-dispatch-ledger-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

async function withStore<T>(fn: (store: SessionStore, artifactRoot: string) => Promise<T>): Promise<T> {
  return withTempDir(async (artifactRoot) => {
    const store = new SessionStore(artifactRoot);
    try {
      return await fn(store, artifactRoot);
    } finally {
      await rm(sessionStorePathFor(artifactRoot), { force: true });
    }
  });
}

test('25 concurrent store.mutate(enqueueDispatch) calls, each a uniquely-keyed envelope, all land -- no lost update', async () => {
  await withStore(async (store) => {
    await store.mutate((state) => upsertSession(state, KEY, FILE));

    const calls = Array.from({ length: 25 }, (_, i) =>
      store.mutate((state) => enqueueDispatch(state, KEY, makeEnvelope(`concurrent-${i}`))),
    );
    const results = await Promise.all(calls);
    for (const r of results) assert.strictEqual(r.status, 'ok', 'every concurrent enqueue reports ok, none silently lost');

    const final = await store.read();
    const record = final.sessions[KEY];
    assert.ok(record);
    assert.strictEqual(record.queue.length, 25, 'no queued id was lost to a race');
    assert.strictEqual(Object.keys(record.dispatches).length, 25, 'no ledger entry was lost to a race');
    for (let i = 0; i < 25; i++) {
      assert.ok(record.queue.includes(`concurrent-${i}`), `concurrent-${i} present in queue`);
      assert.ok(record.dispatches[`concurrent-${i}`], `concurrent-${i} present in dispatches`);
    }
  });
});

// ---------------------------------------------------------------------------
// recordHeartbeat / isBrowserConnected / endSession
//
// isBrowserConnected is pure and takes nowMs as an explicit parameter --
// no Date.now(), no setTimeout, no sleep anywhere in these tests. This is
// the deliberate design that lets Plan 05's long-poll layer prove
// presence/disconnect-grace behavior without a single flaky real-time test.
// ---------------------------------------------------------------------------

test('recordHeartbeat sets browserLastSeenAt to the given timestamp', () => {
  const state = stateWithSession();
  const { next, result } = recordHeartbeat(state, KEY, '2026-01-01T00:00:00.000Z');

  assert.deepStrictEqual(result, { status: 'ok' });
  assert.strictEqual(next.sessions[KEY]?.browserLastSeenAt, '2026-01-01T00:00:00.000Z');
});

test('recordHeartbeat on an unknown key returns not-found and performs no mutation', () => {
  const state = stateWithSession();
  const { next, result } = recordHeartbeat(state, 'no-such-key', '2026-01-01T00:00:00.000Z');

  assert.deepStrictEqual(result, { status: 'not-found' });
  assert.strictEqual(next, state);
});

test('recordHeartbeat overwrites a previous heartbeat -- last-writer-wins', () => {
  const state0 = stateWithSession();
  const first = recordHeartbeat(state0, KEY, '2026-01-01T00:00:00.000Z');
  const second = recordHeartbeat(first.next, KEY, '2026-01-01T00:00:10.000Z');

  assert.strictEqual(second.next.sessions[KEY]?.browserLastSeenAt, '2026-01-01T00:00:10.000Z');
});

test('isBrowserConnected: null browserLastSeenAt is treated as connected -- unknown presence is not yet proven disconnected', () => {
  assert.strictEqual(isBrowserConnected(null, 1_000_000, 5_000), true);
});

test('isBrowserConnected: a fresh timestamp well within the grace period is connected', () => {
  const lastSeenMs = Date.parse('2026-01-01T00:00:00.000Z');
  const nowMs = lastSeenMs + 1_000; // 1s later
  assert.strictEqual(isBrowserConnected('2026-01-01T00:00:00.000Z', nowMs, 5_000), true);
});

test('isBrowserConnected: a timestamp past the grace period is disconnected', () => {
  const lastSeenMs = Date.parse('2026-01-01T00:00:00.000Z');
  const nowMs = lastSeenMs + 5_001; // 1ms past a 5000ms grace
  assert.strictEqual(isBrowserConnected('2026-01-01T00:00:00.000Z', nowMs, 5_000), false);
});

test('isBrowserConnected: exactly at the grace boundary is INCLUSIVE -- still connected', () => {
  const lastSeenMs = Date.parse('2026-01-01T00:00:00.000Z');
  const nowMs = lastSeenMs + 5_000; // exactly the grace period, not past it
  assert.strictEqual(isBrowserConnected('2026-01-01T00:00:00.000Z', nowMs, 5_000), true);
});

test('endSession sets sessionEndedAt to the given timestamp', () => {
  const state = stateWithSession();
  const { next, result } = endSession(state, KEY, '2026-01-01T00:05:00.000Z');

  assert.deepStrictEqual(result, { status: 'ok' });
  assert.strictEqual(next.sessions[KEY]?.sessionEndedAt, '2026-01-01T00:05:00.000Z');
});

test('endSession on an unknown key returns not-found and performs no mutation', () => {
  const state = stateWithSession();
  const { next, result } = endSession(state, 'no-such-key', '2026-01-01T00:05:00.000Z');

  assert.deepStrictEqual(result, { status: 'not-found' });
  assert.strictEqual(next, state);
});

test('endSession is idempotent -- ending an already-ended session is not an error, last write wins', () => {
  const state0 = stateWithSession();
  const first = endSession(state0, KEY, '2026-01-01T00:05:00.000Z');
  const second = endSession(first.next, KEY, '2026-01-01T00:06:00.000Z');

  assert.deepStrictEqual(second.result, { status: 'ok' });
  assert.strictEqual(second.next.sessions[KEY]?.sessionEndedAt, '2026-01-01T00:06:00.000Z');
});

// ---------------------------------------------------------------------------
// enqueueDispatch: retry after a failed dispatch
//
// A dispatch nobody answered stayed `open` forever, and an identical
// element+intent deduped against it -- so every retry was a silent no-op and
// the card could never resolve, even once the underlying cause was fixed.
// Recovery meant deleting the session store by hand.
// ---------------------------------------------------------------------------

/** The element every test below collides on, so two different dispatch ids
 * share one dedupe key. */
const POISONED_ELEMENT = { uid: 'same-elem', selector: '#x', tag: 'p', text: 't', prefixContext: null, suffixContext: null };

/** The exact poisoned state: one open, queued, never-delivered,
 * never-answered dispatch with nothing listening and nothing in flight --
 * what a self-dispatch that failed to spawn leaves behind. */
function stateWithAbandonedOpenDispatch(): IlluminateState {
  const { next, result } = enqueueDispatch(stateWithSession(), KEY, makeEnvelope('d1', { targets: [{ element: POISONED_ELEMENT, source: null }] }));
  assert.strictEqual(result.status, 'ok');
  return next;
}

/** Rewrites one session record, so a test can construct a ledger state that
 * no reducer can reach on its own (an answered entry, an emptied queue). */
function withSessionRecord(state: IlluminateState, fn: (record: SessionRecord) => SessionRecord): IlluminateState {
  const record = state.sessions[KEY];
  assert.ok(record, 'expected a session under KEY');
  return { ...state, sessions: { ...state.sessions, [KEY]: fn(record) } };
}

test('a retry re-opens an abandoned open dispatch (no answer, nothing in flight) instead of silently deduping against it', () => {
  const poisoned = stateWithAbandonedOpenDispatch();

  const retry = enqueueDispatch(poisoned, KEY, makeEnvelope('d2', { targets: [{ element: POISONED_ELEMENT, source: null }] }), NOTHING_IN_FLIGHT);

  // `ok`, not `duplicate`, is the whole fix: server.ts only wakes a waiting
  // poll and re-fires self-dispatch on `ok`, so `duplicate` here is exactly
  // what made every retry after a failure a no-op.
  assert.deepStrictEqual(
    retry.result,
    { status: 'ok', dispatchId: 'd1', envelope: poisoned.sessions[KEY]?.dispatches['d1']?.envelope },
    'a retry must re-open the stuck dispatch, not dedupe against it, and must hand back the envelope the LEDGER holds -- self-dispatching the retry envelope would post its answer at an id no session holds',
  );
});

test('a re-opened dispatch keeps its ORIGINAL id and creates no second ledger entry or queue slot -- one card, one bill', () => {
  const poisoned = stateWithAbandonedOpenDispatch();

  const retry = enqueueDispatch(poisoned, KEY, makeEnvelope('d2', { targets: [{ element: POISONED_ELEMENT, source: null }] }), NOTHING_IN_FLIGHT);
  const record = retry.next.sessions[KEY];

  assert.strictEqual(record?.dispatches['d2'], undefined, 'a retry must not mint a second ledger entry');
  assert.deepStrictEqual(record?.queue, ['d1'], 'a retry must not queue the same work twice');
  assert.strictEqual(record?.dispatches['d1']?.status, 'open');
  assert.strictEqual(record?.dispatches['d1']?.answer, null);
});

test('a re-opened dispatch that had fallen OUT of the queue is put back on it', () => {
  // A delivered dispatch whose harness died leaves `open` with an empty queue
  // once restoreToQueue has run and the queue has since been drained again;
  // constructed directly here rather than via that four-step dance.
  const abandoned = withSessionRecord(stateWithAbandonedOpenDispatch(), (record) => ({ ...record, queue: [] }));

  const retry = enqueueDispatch(abandoned, KEY, makeEnvelope('d2', { targets: [{ element: POISONED_ELEMENT, source: null }] }), NOTHING_IN_FLIGHT);

  assert.strictEqual(retry.result.status, 'ok');
  assert.deepStrictEqual(retry.next.sessions[KEY]?.queue, ['d1'], 'a re-opened dispatch must be deliverable again');
});

test('a retry while a poll is open or a self-dispatch is in flight still dedupes -- the double-dispatch guard is intact', () => {
  const poisoned = stateWithAbandonedOpenDispatch();

  const retry = enqueueDispatch(poisoned, KEY, makeEnvelope('d2', { targets: [{ element: POISONED_ELEMENT, source: null }] }), WORK_IN_FLIGHT);

  assert.deepStrictEqual(retry.result, { status: 'duplicate', dispatchId: 'd1' });
  assert.strictEqual(retry.next, poisoned, 'a genuine duplicate stays a true no-op -- no new state object at all');
});

test('isWorkInFlight is asked about the EXISTING dispatch id, not the retry id', () => {
  const poisoned = stateWithAbandonedOpenDispatch();
  const asked: string[] = [];

  enqueueDispatch(poisoned, KEY, makeEnvelope('d2', { targets: [{ element: POISONED_ELEMENT, source: null }] }), (id) => {
    asked.push(id);
    return false;
  });

  assert.deepStrictEqual(asked, ['d1'], 'an unrelated in-flight dispatch must never block this retry');
});

test('a retry against an ANSWERED dispatch still dedupes -- an answer came back, so there is nothing to retry', () => {
  const answered = withSessionRecord(stateWithAbandonedOpenDispatch(), (record) => {
    const entry = record.dispatches['d1'];
    assert.ok(entry);
    return {
      ...record,
      dispatches: {
        ...record.dispatches,
        d1: {
          ...entry,
          status: 'answered',
          answer: {
            markdown: 'an answer',
            model: 'test-model',
            tier: 'haiku',
            tokensIn: 1,
            tokensOut: 1,
            cacheReadInputTokens: 0,
            costUsd: 0,
            wallMs: 1,
            answeredAt: '2020-01-01T00:00:00.000Z',
            verdict: null,
            decidingLines: null,
          },
        },
      },
    };
  });

  const retry = enqueueDispatch(answered, KEY, makeEnvelope('d2', { targets: [{ element: POISONED_ELEMENT, source: null }] }), NOTHING_IN_FLIGHT);

  assert.deepStrictEqual(retry.result, { status: 'duplicate', dispatchId: 'd1' });
});

test('a retry against a DELIVERED dispatch still dedupes -- a harness took it, and re-queueing would hand out the same work twice', () => {
  const first = enqueueDispatch(stateWithSession(), KEY, makeEnvelope('d1', { targets: [{ element: POISONED_ELEMENT, source: null }] }));
  const drained = drainQueue(first.next, KEY);
  assert.strictEqual(drained.next.sessions[KEY]?.dispatches['d1']?.status, 'delivered');

  const retry = enqueueDispatch(drained.next, KEY, makeEnvelope('d2', { targets: [{ element: POISONED_ELEMENT, source: null }] }), NOTHING_IN_FLIGHT);

  assert.deepStrictEqual(retry.result, { status: 'duplicate', dispatchId: 'd1' });
});
