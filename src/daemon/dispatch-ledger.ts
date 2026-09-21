import { createHash } from 'node:crypto';
import type { IlluminateState, SessionRecord } from '../store/session-store.ts';
import type { MutateResult } from './load-token.ts';
import type { DispatchEnvelope, DispatchLedgerEntry, DispatchStatus } from '../router/types.ts';

/**
 * 06-03's queue/dedupe/drain/restore/presence reducers -- Phase 6's
 * `dispatches`/`queue`/`browserLastSeenAt`/`sessionEndedAt` fields
 * (session-store.ts) are mutated exclusively from here, mirroring
 * load-token.ts's own separation: session-store.ts stays a dumb schema +
 * mutex + atomic-write file. Every exported reducer below matches
 * `MutateResult<T>`'s exact shape, so `store.mutate(state =>
 * enqueueDispatch(state, key, envelope))` needs no adapter.
 *
 * This file's `dispatches` bookkeeping (status, cost, the raw answer for
 * internal wiring) is explicitly NOT Phase 7's durable, portable,
 * human-readable annotation record -- see session-store.ts's own
 * ARCHITECTURE.md-derived separation note. Do not conflate the two.
 */

/** Statuses a dedupe check treats as "still live" -- an in-flight duplicate
 * click must not spawn a second dispatch. `refused`/`cancelled`/`expired`
 * are the terminal statuses (mirrors router/types.ts's own DISPATCH_STATUSES
 * comment); re-asking after any of them creates a genuinely new entry. */
const ACTIVE_DISPATCH_STATUSES: readonly DispatchStatus[] = ['open', 'delivered', 'answered'];

/**
 * The mechanism behind "clicking the same element/intent/anchor-state
 * twice in quick succession yields one card and one bill" (T-06-06). Keyed
 * on the element uid, the intent, the RESOLVED source content (not just
 * the element uid), and `learnerNote` -- two different intents/anchors/
 * content states cannot collide without an actual sha256 collision. Same
 * hash primitive, same house style as session-store.ts's own sessionKey;
 * no new hashing dependency.
 *
 * `learnerNote` (07-07): EDU-06's self-explanation dispatch is a SECOND
 * `explain` intent on the exact same element/content an ordinary Explain
 * click already produced -- without `learnerNote` in this key, the two
 * would be indistinguishable, and a reader's typed explanation would
 * silently dedupe against (and be discarded in favor of) the original,
 * already-answered explain it is meant to chain a graded follow-up onto.
 * `?? ''` matches every OTHER field's own "absent collapses to empty
 * string" convention above -- every ordinary (non-self-explanation)
 * dispatch keeps `learnerNote: null`, so this segment is a constant empty
 * string for them and the key is otherwise unchanged from before.
 */
export function computeDedupeKey(envelope: DispatchEnvelope): string {
  const raw = `${envelope.element.uid}:${envelope.intent}:${envelope.source?.content ?? ''}:${envelope.learnerNote ?? ''}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** Scans for a non-terminal entry whose own dedupe key matches `dedupeKey`.
 * Returns its dispatch id, or null if none is live. */
function findDuplicate(dispatches: Record<string, DispatchLedgerEntry>, dedupeKey: string): string | null {
  for (const [id, entry] of Object.entries(dispatches)) {
    if (!ACTIVE_DISPATCH_STATUSES.includes(entry.status)) continue;
    if (computeDedupeKey(entry.envelope) === dedupeKey) return id;
  }
  return null;
}

/**
 * "Is anything actually working on this dispatch right now?", asked about the
 * ALREADY-EXISTING dispatch a retry collided with -- never about the retry's
 * own id, which by definition nothing has started on yet.
 *
 * This reducer cannot answer that itself: both signals are in-memory,
 * per-daemon-process presence (an open long poll; a fire-and-forget
 * `maybeSelfDispatch` that has not come back), and neither is in the durable
 * state this file reduces over. server.ts owns both and supplies the real
 * predicate; the default below answers "nothing", which is the honest answer
 * for a caller with no presence tracking at all.
 */
export type IsWorkInFlight = (dispatchId: string) => boolean;

/** `enqueueDispatch`'s three outcomes. `envelope` on `ok` is the one the
 * ledger now holds for `dispatchId` -- see enqueueDispatch's doc comment for
 * why a caller must never substitute its own. */
export type EnqueueResult =
  | { status: 'ok'; dispatchId: string; envelope: DispatchEnvelope }
  | { status: 'duplicate'; dispatchId: string }
  | { status: 'not-found' };

const NOTHING_IN_FLIGHT: IsWorkInFlight = () => false;

/**
 * Whether a retry that collided with `entry` should RE-OPEN it rather than
 * dedupe against it.
 *
 * The defect this answers: an unanswered dispatch stays `open` forever --
 * `maybeSelfDispatch` deliberately leaves the ledger untouched when `claude`
 * fails to spawn -- and dedupe matched every subsequent retry against it. Each
 * retry returned `duplicate`, server.ts re-fires self-dispatch only on `ok`,
 * and so the card could never resolve even after the underlying cause was
 * fixed. The only recovery was deleting the session store by hand.
 *
 * The rule is "no answer AND nobody working on it", and all three conditions
 * are load-bearing:
 *
 *  - `status === 'open'` and NOT `'delivered'`. A delivered dispatch was
 *    genuinely handed to a harness, which then closed its poll to go and do
 *    the work -- the `illuminate poll` / `illuminate answer` shape. Re-queueing
 *    it would hand the same work out twice. A harness that drains and then
 *    dies is a real, separate stuck state; `restoreToQueue` covers the case
 *    where the poll itself dies mid-delivery, and nothing here tries to guess
 *    at the rest.
 *  - `answer === null`. Belt and braces against `status` alone: an answered
 *    dispatch has an answer, so there is nothing to retry.
 *  - `!isWorkInFlight(id)`. Without this, a second click landing while the
 *    first `claude -p` is still running would re-open and spawn a second one
 *    -- double-billing precisely the double-click T-06-06 exists to prevent.
 *
 * Age-based expiry was considered and rejected: a dispatch is not stuck
 * because it is old, it is stuck because nothing is coming back for it, and
 * any age threshold both abandons slow-but-live work and leaves fast failures
 * poisoned until the clock catches up.
 */
function shouldReopen(entry: DispatchLedgerEntry, id: string, isWorkInFlight: IsWorkInFlight): boolean {
  return entry.status === 'open' && entry.answer === null && !isWorkInFlight(id);
}

/**
 * The router's one write path into the ledger. Three outcomes:
 *
 *  - A genuinely new (non-duplicate) envelope: stored as `status:'open'`, its
 *    id appended to the END of `queue` (FIFO -- drainQueue below never
 *    reorders), returning `{status:'ok', dispatchId}`.
 *  - A duplicate of something still being worked on: NO mutation at all --
 *    `next` is the SAME state object -- returning `{status:'duplicate',
 *    dispatchId: <the existing id>}` so the caller can point the second click
 *    at the first dispatch instead of billing a second one.
 *  - A duplicate of an ABANDONED dispatch (see `shouldReopen`): the existing
 *    entry is re-opened in place and put back on the queue if it had fallen
 *    off, returning `{status:'ok', dispatchId: <the EXISTING id>}`.
 *
 * That third case returns the existing id, not the retry's, on purpose. The
 * card in the browser is already bound to it, so re-opening keeps one card and
 * one ledger entry where minting a fresh dispatch would orphan the first and
 * leave a second queued alongside it. `ok` is also what makes the retry
 * actually do something: server.ts wakes a waiting poll and re-fires
 * self-dispatch on `ok` and only on `ok`.
 *
 * `ok` therefore also carries the envelope that is ACTUALLY in the ledger --
 * the argument on a fresh enqueue, the pre-existing one on a re-open. Callers
 * must use it rather than the envelope they passed in: a self-dispatch or a
 * deterministic shortcut keyed off the wrong `dispatch_id` posts its answer at
 * an id no session holds, and the answer is dropped as `not-found`.
 */
export function enqueueDispatch(
  state: IlluminateState,
  key: string,
  envelope: DispatchEnvelope,
  isWorkInFlight: IsWorkInFlight = NOTHING_IN_FLIGHT,
): MutateResult<EnqueueResult> {
  const record = state.sessions[key];
  if (!record) return { next: state, result: { status: 'not-found' } };

  const dedupeKey = computeDedupeKey(envelope);
  const duplicateId = findDuplicate(record.dispatches, dedupeKey);
  const duplicate = duplicateId === null ? undefined : record.dispatches[duplicateId];
  if (duplicateId !== null && duplicate !== undefined) {
    if (!shouldReopen(duplicate, duplicateId, isWorkInFlight)) {
      return { next: state, result: { status: 'duplicate', dispatchId: duplicateId } };
    }
    const reopened: SessionRecord = {
      ...record,
      dispatches: { ...record.dispatches, [duplicateId]: { ...duplicate, status: 'open', deliveredAt: null } },
      queue: record.queue.includes(duplicateId) ? record.queue : [...record.queue, duplicateId],
    };
    return {
      next: { ...state, sessions: { ...state.sessions, [key]: reopened } },
      result: { status: 'ok', dispatchId: duplicateId, envelope: duplicate.envelope },
    };
  }

  const entry: DispatchLedgerEntry = {
    envelope,
    status: 'open',
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    answer: null,
    tierDeviation: false,
  };
  const nextRecord: SessionRecord = {
    ...record,
    dispatches: { ...record.dispatches, [envelope.dispatch_id]: entry },
    queue: [...record.queue, envelope.dispatch_id],
  };

  return {
    next: { ...state, sessions: { ...state.sessions, [key]: nextRecord } },
    result: { status: 'ok', dispatchId: envelope.dispatch_id, envelope },
  };
}

/**
 * The long-poll layer's atomic drain (Plan 05 calls this once per poll
 * response). Empties `queue` entirely and marks every drained entry
 * `status:'delivered'` with `deliveredAt` set, returning the envelopes in
 * their ORIGINAL queue order. An empty queue drains to `{status:'ok',
 * drained: []}` -- a legitimate "nothing to deliver" outcome, not an
 * error; callers distinguish it by array length, not by result status.
 */
export function drainQueue(
  state: IlluminateState,
  key: string,
): MutateResult<{ status: 'ok'; drained: readonly DispatchEnvelope[] } | { status: 'not-found' }> {
  const record = state.sessions[key];
  if (!record) return { next: state, result: { status: 'not-found' } };

  if (record.queue.length === 0) {
    return { next: state, result: { status: 'ok', drained: [] } };
  }

  const now = new Date().toISOString();
  const drained: DispatchEnvelope[] = [];
  const nextDispatches: Record<string, DispatchLedgerEntry> = { ...record.dispatches };
  for (const id of record.queue) {
    const entry = nextDispatches[id];
    if (!entry) continue; // defensive: queue and dispatches are kept in sync by construction
    drained.push(entry.envelope);
    nextDispatches[id] = { ...entry, status: 'delivered', deliveredAt: now };
  }

  const nextRecord: SessionRecord = { ...record, queue: [], dispatches: nextDispatches };
  return {
    next: { ...state, sessions: { ...state.sessions, [key]: nextRecord } },
    result: { status: 'ok', drained },
  };
}

/**
 * Pattern 2, drain-verify-restore: when a poll that already drained the
 * queue turns out to be dead (the connection is gone before delivery
 * landed), this PREPENDS the drained ids back onto the FRONT of whatever
 * `queue` holds NOW -- in the same relative order they were drained in --
 * and reverts each entry's status to `'open'`, clearing `deliveredAt`.
 * Anything enqueued in the meantime (while the failed poll was in flight)
 * stays behind the restored ids, never in front of them: ordering is never
 * scrambled by a failed delivery.
 */
export function restoreToQueue(
  state: IlluminateState,
  key: string,
  ids: readonly string[],
): MutateResult<{ status: 'ok' } | { status: 'not-found' }> {
  const record = state.sessions[key];
  if (!record) return { next: state, result: { status: 'not-found' } };

  const nextDispatches: Record<string, DispatchLedgerEntry> = { ...record.dispatches };
  for (const id of ids) {
    const entry = nextDispatches[id];
    if (!entry) continue;
    nextDispatches[id] = { ...entry, status: 'open', deliveredAt: null };
  }

  const nextRecord: SessionRecord = {
    ...record,
    queue: [...ids, ...record.queue],
    dispatches: nextDispatches,
  };
  return {
    next: { ...state, sessions: { ...state.sessions, [key]: nextRecord } },
    result: { status: 'ok' },
  };
}

/**
 * POLL-04's write half: records that the browser side of this session was
 * just observed alive (a poll arriving, or an explicit heartbeat).
 * Last-writer-wins, same posture as load-token.ts's chromeLoadToken --
 * there is no ordering conflict to resolve, only the most recent sighting
 * matters. `nowIso` is caller-supplied, never computed internally, so this
 * reducer stays as pure/testable as every other one in this file.
 */
export function recordHeartbeat(
  state: IlluminateState,
  key: string,
  nowIso: string,
): MutateResult<{ status: 'ok' } | { status: 'not-found' }> {
  const record = state.sessions[key];
  if (!record) return { next: state, result: { status: 'not-found' } };

  const nextRecord: SessionRecord = { ...record, browserLastSeenAt: nowIso };
  return {
    next: { ...state, sessions: { ...state.sessions, [key]: nextRecord } },
    result: { status: 'ok' },
  };
}

/**
 * POLL-04's read half, and the ONE function Plan 05's long-poll layer
 * calls to decide presence -- 100% pure, zero I/O, zero real elapsed time.
 * `browserLastSeenAt === null` means no poll/heartbeat has ever been
 * observed yet; this is treated as "not yet proven disconnected" (a poll
 * that starts before any browser has ever connected is not immediately
 * declared disconnected) -- a deliberate, documented simplification, not
 * an oversight. Otherwise: connected iff the elapsed time since the last
 * sighting is within `graceMs`, INCLUSIVE of the boundary itself (`<=`,
 * not `<`) -- an elapsed time exactly equal to the grace period is still
 * within grace, not yet expired.
 */
export function isBrowserConnected(browserLastSeenAt: string | null, nowMs: number, graceMs: number): boolean {
  if (browserLastSeenAt === null) return true;
  const lastSeenMs = Date.parse(browserLastSeenAt);
  return nowMs - lastSeenMs <= graceMs;
}

/**
 * Marks the session explicitly ended. `nowIso` is caller-supplied for the
 * same reason as recordHeartbeat. Idempotent: ending an already-ended
 * session is not an error -- last write wins, since nothing in this phase
 * reads `sessionEndedAt` as an audit trail.
 */
export function endSession(
  state: IlluminateState,
  key: string,
  nowIso: string,
): MutateResult<{ status: 'ok' } | { status: 'not-found' }> {
  const record = state.sessions[key];
  if (!record) return { next: state, result: { status: 'not-found' } };

  const nextRecord: SessionRecord = { ...record, sessionEndedAt: nowIso };
  return {
    next: { ...state, sessions: { ...state.sessions, [key]: nextRecord } },
    result: { status: 'ok' },
  };
}
