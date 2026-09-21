/**
 * The answer-ingest path: `illuminate answer`'s server-side landing spot.
 * Validates a submitted `AnswerSubmission` against the dispatch ledger
 * (06-03's `SessionRecord.dispatches`), applies ROUT-06's ONE hard floor,
 * records ROUT-05's advisory tier deviations, records ROUT-08's exact
 * per-dispatch cost fields, and returns a fixed-size receipt (EDU-03).
 *
 * ROUT-04's mechanism: this is how a dispatched answer returns to the
 * session. Together with 06-01's declarative types and 06-07's route-level
 * black-box proof, this is the third of three complementary layers proving
 * EDU-02/EDU-03 hold in practice -- see this file's own doc comments below
 * for the specific, enforceable half of that guarantee.
 *
 * `ingestAnswer` never takes a session key. It finds the owning session by
 * scanning `state.sessions` for the first one whose `dispatches` map
 * contains `submission.dispatchId` -- dispatch ids are 192 bits of
 * randomness (mirrors `issueChromeLoadToken`'s own entropy budget, T-06-13),
 * so this scan is exactly what keeps the envelope's own `return_to` command
 * self-sufficient: `illuminate answer --dispatch <id> --port <port> --stdin`,
 * with no `--key` anywhere. Two different sessions holding the SAME
 * dispatch id would be a bug elsewhere; finding the first match is
 * sufficient (06-06-PLAN.md's own explicit note).
 */

import { basename } from 'node:path';
import { TIER_RANK } from './types.ts';
import type { IlluminateState, SessionRecord } from '../store/session-store.ts';
import type { MutateResult } from '../daemon/load-token.ts';
import type {
  AnswerRecord,
  AnswerSubmission,
  DispatchLedgerEntry,
  DispatchStatus,
  IngestResult,
  Role,
  Tier,
} from './types.ts';

/** Statuses a dispatch never re-accepts an answer for -- T-06-12's idempotency
 * safeguard. `open`/`delivered` are still awaiting an answer and stay
 * answerable; every one of these four is a final state. Mirrors
 * dispatch-ledger.ts's own local-constant convention
 * (ACTIVE_DISPATCH_STATUSES). */
const TERMINAL_DISPATCH_STATUSES: readonly DispatchStatus[] = ['answered', 'refused', 'cancelled', 'expired'];

interface OwningSession {
  readonly sessionKey: string;
  readonly record: SessionRecord;
  readonly entry: DispatchLedgerEntry;
}

/** The entire reason `illuminate answer` never needs a `--key` flag: a plain
 * linear scan over however many sessions this daemon currently holds open
 * (small in practice; this is not a hot path), returning the first session
 * whose `dispatches` map contains `dispatchId`. */
function findOwningSession(state: IlluminateState, dispatchId: string): OwningSession | null {
  for (const [sessionKey, record] of Object.entries(state.sessions)) {
    const entry = record.dispatches[dispatchId];
    if (entry) return { sessionKey, record, entry };
  }
  return null;
}

/**
 * The router's one write path for a submitted answer. Five outcomes:
 *
 * - no session holds `submission.dispatchId` at all -> `{kind: 'not-found'}`,
 *   no mutation.
 * - the dispatch is already terminal (answered/refused/cancelled/expired)
 *   -> `{kind: 'already-terminal', reason: <status>}`, no mutation --
 *   answering twice never double-bills or double-records (T-06-12).
 * - `role === 'implementer'` (fix-code) reporting a tier below the opus
 *   floor -> `{kind: 'refused', reason: <actionable text>}`; the ledger
 *   entry is left BYTE-FOR-BYTE UNCHANGED -- this is ROUT-06's one hard
 *   floor, and the only place tiering has teeth anywhere in this system.
 * - `role === 'implementer'` reporting a tier at or above the floor (via
 *   `TIER_RANK`, never a string-equality check, so this stays correct if a
 *   higher tier is ever added) -> accepted, never a deviation.
 * - any OTHER role reporting a tier different from `envelope.model_tier`
 *   -> accepted, `tierDeviation: true` recorded -- advisory, never
 *   blocking (ROUT-05).
 *
 * On any acceptance: status -> 'answered', the full `AnswerRecord`
 * (including `markdown`) is written into the ledger entry's OWN internal
 * `answer` field -- never surfaced by this function's return value, which
 * carries only a fixed-size receipt string (EDU-02/EDU-03).
 */
export function ingestAnswer(
  state: IlluminateState,
  submission: AnswerSubmission,
  nowIso: string,
): MutateResult<IngestResult> {
  const owning = findOwningSession(state, submission.dispatchId);
  if (!owning) return { next: state, result: { kind: 'not-found' } };

  const { sessionKey, record, entry } = owning;

  if (TERMINAL_DISPATCH_STATUSES.includes(entry.status)) {
    return { next: state, result: { kind: 'already-terminal', reason: entry.status } };
  }

  const { envelope } = entry;
  const isImplementerBelowFloor = envelope.role === 'implementer' && TIER_RANK[submission.tier] < TIER_RANK[envelope.model_tier];

  if (isImplementerBelowFloor) {
    return {
      next: state,
      result: {
        kind: 'refused',
        reason:
          `fix-code dispatches require tier '${envelope.model_tier}' or higher -- ` +
          `reported tier '${submission.tier}' is below the floor`,
      },
    };
  }

  const tierDeviation = envelope.role !== 'implementer' && submission.tier !== envelope.model_tier;

  const answer: AnswerRecord = {
    markdown: submission.markdown,
    model: submission.model,
    tier: submission.tier,
    tokensIn: submission.tokensIn,
    tokensOut: submission.tokensOut,
    cacheReadInputTokens: submission.cacheReadInputTokens,
    costUsd: submission.costUsd,
    wallMs: submission.wallMs,
    answeredAt: nowIso,
    verdict: submission.verdict,
    decidingLines: submission.decidingLines,
  };

  const nextEntry: DispatchLedgerEntry = { ...entry, status: 'answered', answer, tierDeviation };
  // Defensive dequeue (07-04, Rule 1 -- bug): under the ordinary flow, a
  // dispatch is always drained out of `record.queue` (dispatch-ledger.ts's
  // `drainQueue`, which empties the WHOLE queue at once) before a poll
  // hands it to a harness to answer, so `dispatchId` is already absent from
  // `queue` by the time an answer ever arrives here -- this filter is a
  // no-op for that path. 07-04's deterministic EDU-07 verify-shortcut is
  // the first caller that answers a dispatch WITHOUT it ever having been
  // drained (it is still sitting in `queue` with status 'open' at the
  // moment this function runs) -- without this filter, that same id would
  // still be sitting in `queue` and a later poll's `drainQueue` would
  // deliver its envelope anyway, silently re-surfacing an already-answered
  // dispatch to a harness. `ingestAnswer`'s own postcondition -- an
  // answered dispatch is never poll-deliverable -- must hold regardless of
  // which caller answered it.
  const nextRecord: SessionRecord = {
    ...record,
    dispatches: { ...record.dispatches, [submission.dispatchId]: nextEntry },
    queue: record.queue.filter((id) => id !== submission.dispatchId),
  };
  const next: IlluminateState = {
    ...state,
    sessions: { ...state.sessions, [sessionKey]: nextRecord },
  };

  const receipt = formatReceipt({
    dispatch_id: envelope.dispatch_id,
    role: envelope.role,
    tier: submission.tier,
    tokensIn: submission.tokensIn,
    tokensOut: submission.tokensOut,
    wallMs: submission.wallMs,
    artifactBasename: basename(record.file),
  });

  return { next, result: { kind: 'ok', receipt, entry: nextEntry, artifactPath: record.file } };
}

/** The exact fields `formatReceipt` needs -- and NO others. There is no
 * `markdown` parameter here, so it is structurally impossible for this
 * function to leak answer prose even by a future careless edit. */
export interface ReceiptFields {
  readonly dispatch_id: string;
  readonly role: Role;
  readonly tier: Tier;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly wallMs: number;
  readonly artifactBasename: string;
}

/**
 * EDU-03's structural discharge, realized: a single line of the exact shape
 * ARCHITECTURE.md specifies -- `ok <id> <role>/<tier> <tokens> tokens <s>s
 * -> <artifact>` -- named and built in exactly ONE place, so 06-08's CLI
 * printing and 06-07's route response both call this SAME function rather
 * than re-formatting ad hoc. Fixed-size regardless of how long the
 * submitted markdown answer was (see test/router/ingest.test.ts's
 * 5,000-word proof) -- there is no path from an answer's length to this
 * string's length.
 */
export function formatReceipt(fields: ReceiptFields): string {
  const totalTokens = fields.tokensIn + fields.tokensOut;
  const seconds = (fields.wallMs / 1000).toFixed(1);
  return `ok ${fields.dispatch_id} ${fields.role}/${fields.tier} ${totalTokens} tokens ${seconds}s -> ${fields.artifactBasename}`;
}

/** One recorded tier deviation -- ROUT-05's advisory trail. */
export interface AuditDeviation {
  readonly dispatchId: string;
  readonly expectedTier: Tier;
  readonly reportedTier: Tier;
}

/** One recorded hard refusal. */
export interface AuditRefusal {
  readonly dispatchId: string;
  readonly reason: string;
}

/** ROUT-08's audit-surface shape -- deliberately excludes any answer-prose
 * field, reinforcing EDU-02 discipline one more time at the aggregation
 * layer. Consumed by 06-08's `illuminate audit` command and 06-07's
 * `GET /api/:key/dispatches` route (that route stays session-keyed, unlike
 * the answer route -- audit is invoked against a known file/session, so
 * scoping it per-session is correct and simpler). */
export interface AuditSummary {
  readonly totalCostUsd: number;
  readonly totalTokensIn: number;
  readonly totalTokensOut: number;
  readonly totalCacheReadInputTokens: number;
  readonly deviations: readonly AuditDeviation[];
  readonly refusals: readonly AuditRefusal[];
}

/**
 * A pure aggregation over already-recorded ledger entries -- no I/O, no
 * mutation. Sums cost/token fields across every entry that actually
 * received an answer (`entry.answer !== null`, i.e. `status === 'answered'`
 * entries only), separates `tierDeviation` entries into `deviations`, and
 * surfaces any entry whose lifecycle ended at `status === 'refused'` as a
 * `refusals` entry -- ROUT-06 is the only hard-refusal rule this system
 * defines, so a refused entry's reason is derived from its own envelope's
 * role/floor, not from a submission that was, by construction, never
 * recorded (a hard refusal leaves the ledger entry it was rejected against
 * completely unchanged; see `ingestAnswer`).
 */
export function summarizeForAudit(entries: readonly DispatchLedgerEntry[]): AuditSummary {
  let totalCostUsd = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCacheReadInputTokens = 0;
  const deviations: AuditDeviation[] = [];
  const refusals: AuditRefusal[] = [];

  for (const entry of entries) {
    if (entry.answer) {
      totalCostUsd += entry.answer.costUsd;
      totalTokensIn += entry.answer.tokensIn;
      totalTokensOut += entry.answer.tokensOut;
      totalCacheReadInputTokens += entry.answer.cacheReadInputTokens;
      if (entry.tierDeviation) {
        deviations.push({
          dispatchId: entry.envelope.dispatch_id,
          expectedTier: entry.envelope.model_tier,
          reportedTier: entry.answer.tier,
        });
      }
    }
    if (entry.status === 'refused') {
      refusals.push({
        dispatchId: entry.envelope.dispatch_id,
        reason: `${entry.envelope.role} dispatch requires tier '${entry.envelope.model_tier}' or higher`,
      });
    }
  }

  return { totalCostUsd, totalTokensIn, totalTokensOut, totalCacheReadInputTokens, deviations, refusals };
}
