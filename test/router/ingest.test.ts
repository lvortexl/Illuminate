import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { upsertSession } from '../../src/store/session-store.ts';
import type { IlluminateState, SessionRecord } from '../../src/store/session-store.ts';
import type { AnswerSubmission, DispatchEnvelope, DispatchLedgerEntry, IngestResult } from '../../src/router/types.ts';
import { ingestAnswer, formatReceipt, summarizeForAudit } from '../../src/router/ingest.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const INGEST_SOURCE_PATH = join(HERE, '..', '..', 'src', 'router', 'ingest.ts');

const KEY = 'session-key-1';
const FILE = 'roadmap.html';
const NOW = '2026-01-01T00:10:00.000Z';

/** A DispatchEnvelope fixture, mirroring test/daemon/dispatch-ledger.test.ts's own
 * makeEnvelope -- each id gets its own element uid by default. */
function makeEnvelope(id: string, overrides: Partial<DispatchEnvelope> = {}): DispatchEnvelope {
  return {
    protocol: 'illuminate.dispatch/2',
    dispatch_id: id,
    intent: 'explain',
    role: 'tutor',
    model_tier: 'haiku',
    deadline_ms: 30000,
    targets: [{ element: { uid: `elem-${id}`, selector: `#${id}`, tag: 'p', text: 'some text', prefixContext: null, suffixContext: null }, source: null }],
    return_to: `illuminate answer --dispatch ${id} --port 4319 --stdin`,
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

/** A DispatchLedgerEntry fixture -- defaults to a plain 'delivered', unanswered
 * entry, which is the realistic pre-ingest state for most of these tests. */
function makeEntry(envelope: DispatchEnvelope, overrides: Partial<DispatchLedgerEntry> = {}): DispatchLedgerEntry {
  return {
    envelope,
    status: 'delivered',
    createdAt: '2026-01-01T00:00:00.000Z',
    deliveredAt: '2026-01-01T00:00:01.000Z',
    answer: null,
    tierDeviation: false,
    ...overrides,
  };
}

/** A single-session state with exactly one ledger entry under `id`. */
function stateWithEntry(
  id: string,
  envelope: DispatchEnvelope,
  entryOverrides: Partial<DispatchLedgerEntry> = {},
  key: string = KEY,
): IlluminateState {
  const { next } = upsertSession({ sessions: {} }, key, FILE);
  const record = next.sessions[key];
  assert.ok(record);
  const entry = makeEntry(envelope, entryOverrides);
  const nextRecord: SessionRecord = { ...record, dispatches: { [id]: entry } };
  return { ...next, sessions: { ...next.sessions, [key]: nextRecord } };
}

function makeSubmission(overrides: Partial<AnswerSubmission> = {}): AnswerSubmission {
  return {
    dispatchId: 'd1',
    markdown: 'the answer',
    model: 'claude-haiku-4',
    tier: 'haiku',
    tokensIn: 100,
    tokensOut: 200,
    cacheReadInputTokens: 0,
    costUsd: 0.001,
    wallMs: 4100,
    verdict: null,
    decidingLines: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EDU-02, compile-time proof: IngestResult's 'ok' variant must never carry an
// answer body -- mirrors test/router/types.test.ts's own @ts-expect-error
// proofs, at the ingest boundary specifically.
// ---------------------------------------------------------------------------

// @ts-expect-error -- IngestResult's 'ok' variant must never carry an answer body; if this stops
// erroring, someone widened IngestResult and reopened EDU-02's leak. entry/artifactPath are supplied
// (both legitimately required by 07-01) so the ONLY reason this literal fails is the illegal `markdown` field.
const leakedIngestResult: IngestResult = { kind: 'ok', receipt: 'ok d1', entry: makeEntry(makeEnvelope('d1')), artifactPath: 'roadmap.html', markdown: 'the answer' };
void leakedIngestResult;

// ---------------------------------------------------------------------------
// not-found
// ---------------------------------------------------------------------------

test('ingestAnswer returns not-found when no session holds the dispatch id', () => {
  const state = stateWithEntry('d1', makeEnvelope('d1'));
  const { next, result } = ingestAnswer(state, makeSubmission({ dispatchId: 'unknown' }), NOW);

  assert.deepStrictEqual(result, { kind: 'not-found' });
  assert.strictEqual(next, state, 'not-found performs no mutation');
});

test('ingestAnswer returns not-found when state has no sessions at all', () => {
  const { next, result } = ingestAnswer({ sessions: {} }, makeSubmission(), NOW);

  assert.deepStrictEqual(result, { kind: 'not-found' });
  assert.deepStrictEqual(next, { sessions: {} });
});

// ---------------------------------------------------------------------------
// already-terminal: idempotency (T-06-12) -- answering twice never double-bills
// ---------------------------------------------------------------------------

test('ingestAnswer refuses to re-ingest an already-terminal dispatch for every terminal status, without mutating the ledger', () => {
  for (const status of ['answered', 'refused', 'cancelled', 'expired'] as const) {
    const state = stateWithEntry('d1', makeEnvelope('d1'), { status });
    const { next, result } = ingestAnswer(state, makeSubmission({ dispatchId: 'd1' }), NOW);

    assert.deepStrictEqual(result, { kind: 'already-terminal', reason: status }, `status "${status}"`);
    assert.strictEqual(next, state, `status "${status}" must not mutate state`);
  }
});

test('ingestAnswer does NOT treat "open" or "delivered" as terminal -- both are still answerable', () => {
  for (const status of ['open', 'delivered'] as const) {
    const state = stateWithEntry('d1', makeEnvelope('d1'), { status });
    const { result } = ingestAnswer(state, makeSubmission({ dispatchId: 'd1' }), NOW);

    assert.strictEqual(result.kind, 'ok', `status "${status}" must still be answerable`);
  }
});

// ---------------------------------------------------------------------------
// ROUT-06: fix-code (implementer) hard floor -- the ONE place tiering has teeth
// ---------------------------------------------------------------------------

test('ingestAnswer hard-refuses a fix-code (implementer) answer reporting sonnet, one rank below the opus floor', () => {
  const envelope = makeEnvelope('d1', { role: 'implementer', model_tier: 'opus', intent: 'fix-code' });
  const state = stateWithEntry('d1', envelope, { status: 'delivered' });

  const { next, result } = ingestAnswer(state, makeSubmission({ dispatchId: 'd1', tier: 'sonnet' }), NOW);

  assert.strictEqual(result.kind, 'refused');
  if (result.kind !== 'refused') throw new Error('unreachable');
  assert.match(result.reason, /opus/, 'refusal reason must name the required floor');
  assert.match(result.reason, /sonnet/, 'refusal reason must name what was actually reported');
  assert.deepStrictEqual(next, state, 'ledger stays byte-for-byte unchanged on hard refusal');
});

test('ingestAnswer hard-refuses a fix-code answer reporting haiku, two ranks below the opus floor', () => {
  const envelope = makeEnvelope('d1', { role: 'implementer', model_tier: 'opus', intent: 'fix-code' });
  const state = stateWithEntry('d1', envelope);

  const { next, result } = ingestAnswer(state, makeSubmission({ dispatchId: 'd1', tier: 'haiku' }), NOW);

  assert.strictEqual(result.kind, 'refused');
  assert.deepStrictEqual(next, state);
});

test('a hard-refused fix-code dispatch leaves status, answer, and tierDeviation completely untouched', () => {
  const envelope = makeEnvelope('d1', { role: 'implementer', model_tier: 'opus', intent: 'fix-code' });
  const state = stateWithEntry('d1', envelope, { status: 'delivered' });

  ingestAnswer(state, makeSubmission({ dispatchId: 'd1', tier: 'sonnet' }), NOW);
  const entry = state.sessions[KEY]?.dispatches['d1'];

  assert.strictEqual(entry?.status, 'delivered');
  assert.strictEqual(entry?.answer, null);
  assert.strictEqual(entry?.tierDeviation, false);
});

test('ingestAnswer accepts a fix-code answer reporting exactly opus -- the floor itself, not "above" it', () => {
  const envelope = makeEnvelope('d1', { role: 'implementer', model_tier: 'opus', intent: 'fix-code' });
  const state = stateWithEntry('d1', envelope);

  const { next, result } = ingestAnswer(state, makeSubmission({ dispatchId: 'd1', tier: 'opus', model: 'claude-opus-4' }), NOW);

  assert.strictEqual(result.kind, 'ok');
  const entry = next.sessions[KEY]?.dispatches['d1'];
  assert.strictEqual(entry?.status, 'answered');
  assert.strictEqual(entry?.answer?.tier, 'opus');
  assert.strictEqual(entry?.tierDeviation, false, 'reporting exactly the required floor is never a deviation');
});

// ---------------------------------------------------------------------------
// ROUT-05: non-implementer tier deviations are advisory-only, never refused
// ---------------------------------------------------------------------------

test('ingestAnswer accepts a non-implementer answer reporting a DIFFERENT tier than policy expected, recording the deviation, never refusing', () => {
  const envelope = makeEnvelope('d1', { role: 'tutor', model_tier: 'haiku', intent: 'explain' });
  const state = stateWithEntry('d1', envelope);

  const { next, result } = ingestAnswer(state, makeSubmission({ dispatchId: 'd1', tier: 'sonnet' }), NOW);

  assert.strictEqual(result.kind, 'ok');
  const entry = next.sessions[KEY]?.dispatches['d1'];
  assert.strictEqual(entry?.status, 'answered');
  assert.strictEqual(entry?.tierDeviation, true);
  assert.strictEqual(entry?.answer?.tier, 'sonnet');
});

test('ingestAnswer accepts a non-implementer answer matching the expected tier exactly -- no deviation recorded', () => {
  const envelope = makeEnvelope('d1', { role: 'tutor', model_tier: 'haiku' });
  const state = stateWithEntry('d1', envelope);

  const { next, result } = ingestAnswer(state, makeSubmission({ dispatchId: 'd1', tier: 'haiku' }), NOW);

  assert.strictEqual(result.kind, 'ok');
  assert.strictEqual(next.sessions[KEY]?.dispatches['d1']?.tierDeviation, false);
});

test('a non-implementer reporting a HIGHER tier than expected is still a deviation, never refused (the hard floor is implementer-only)', () => {
  const envelope = makeEnvelope('d1', { role: 'verifier', model_tier: 'sonnet', intent: 'verify' });
  const state = stateWithEntry('d1', envelope);

  const { result, next } = ingestAnswer(state, makeSubmission({ dispatchId: 'd1', tier: 'opus' }), NOW);

  assert.strictEqual(result.kind, 'ok');
  assert.strictEqual(next.sessions[KEY]?.dispatches['d1']?.tierDeviation, true);
});

// ---------------------------------------------------------------------------
// On acceptance: full AnswerRecord populated, answeredAt stamped, status flips
// ---------------------------------------------------------------------------

test('ingestAnswer records tokensIn/tokensOut/cacheReadInputTokens/costUsd/wallMs exactly as reported, never estimated', () => {
  const envelope = makeEnvelope('d1');
  const state = stateWithEntry('d1', envelope);
  const submission = makeSubmission({
    dispatchId: 'd1',
    tokensIn: 4123,
    tokensOut: 987,
    cacheReadInputTokens: 512,
    costUsd: 0.01234,
    wallMs: 6789,
  });

  const { next } = ingestAnswer(state, submission, NOW);
  const answer = next.sessions[KEY]?.dispatches['d1']?.answer;

  assert.strictEqual(answer?.tokensIn, 4123);
  assert.strictEqual(answer?.tokensOut, 987);
  assert.strictEqual(answer?.cacheReadInputTokens, 512);
  assert.strictEqual(answer?.costUsd, 0.01234);
  assert.strictEqual(answer?.wallMs, 6789);
  assert.strictEqual(answer?.answeredAt, NOW);
  assert.strictEqual(answer?.model, submission.model);
  assert.strictEqual(answer?.markdown, submission.markdown);
});

test('ingestAnswer returns a non-empty string receipt on acceptance (exact format is formatReceipt\'s own contract, proven separately)', () => {
  const envelope = makeEnvelope('d1');
  const state = stateWithEntry('d1', envelope);

  const { result } = ingestAnswer(state, makeSubmission({ dispatchId: 'd1' }), NOW);

  assert.strictEqual(result.kind, 'ok');
  if (result.kind !== 'ok') throw new Error('unreachable');
  assert.strictEqual(typeof result.receipt, 'string');
  assert.ok(result.receipt.length > 0);
});

// ---------------------------------------------------------------------------
// 07-01: IngestResult's 'ok' variant carries the SAME entry ingestAnswer just
// wrote (Plan 07-04's handleAnswer needs this to append into the annotation
// store without a second store read), plus the owning session's artifactPath.
// ---------------------------------------------------------------------------

test("ingestAnswer's 'ok' result carries the SAME entry it just wrote -- status/answer already reflect the new submission, no second read needed", () => {
  const envelope = makeEnvelope('d1');
  const state = stateWithEntry('d1', envelope);

  const { next, result } = ingestAnswer(state, makeSubmission({ dispatchId: 'd1' }), NOW);

  assert.strictEqual(result.kind, 'ok');
  if (result.kind !== 'ok') throw new Error('unreachable');
  assert.strictEqual(result.entry.status, 'answered');
  assert.ok(result.entry.answer !== null);
  assert.strictEqual(result.entry, next.sessions[KEY]?.dispatches['d1'], 'result.entry must be the SAME entry object just written, not a re-fetch');
  assert.strictEqual(result.artifactPath, FILE);
});

test("ingestAnswer's 'ok' result entry.answer.verdict/decidingLines round-trip a verify submission's values", () => {
  const envelope = makeEnvelope('d1', { role: 'verifier', model_tier: 'sonnet', intent: 'verify' });
  const state = stateWithEntry('d1', envelope);
  const submission = makeSubmission({ dispatchId: 'd1', tier: 'sonnet', verdict: 'contradicted', decidingLines: 'line 42 says X, the claim says Y' });

  const { result } = ingestAnswer(state, submission, NOW);

  assert.strictEqual(result.kind, 'ok');
  if (result.kind !== 'ok') throw new Error('unreachable');
  assert.strictEqual(result.entry.answer?.verdict, 'contradicted');
  assert.strictEqual(result.entry.answer?.decidingLines, 'line 42 says X, the claim says Y');
});

test("ingestAnswer's 'ok' result entry.answer.verdict/decidingLines are null when the submission's are null (the ordinary, non-verify case)", () => {
  const envelope = makeEnvelope('d1');
  const state = stateWithEntry('d1', envelope);

  const { result } = ingestAnswer(state, makeSubmission({ dispatchId: 'd1' }), NOW);

  assert.strictEqual(result.kind, 'ok');
  if (result.kind !== 'ok') throw new Error('unreachable');
  assert.strictEqual(result.entry.answer?.verdict, null);
  assert.strictEqual(result.entry.answer?.decidingLines, null);
});

// ---------------------------------------------------------------------------
// Find-by-id-alone: no --key required, dispatch ids scanned across sessions
// ---------------------------------------------------------------------------

test('ingestAnswer finds the owning session by dispatch id alone across two different sessions, mutating only the correct one', () => {
  const { next: withA } = upsertSession({ sessions: {} }, 'session-A', 'a.html');
  const { next: withBoth } = upsertSession(withA, 'session-B', 'b.html');

  const envelopeA = makeEnvelope('d-A');
  const envelopeB = makeEnvelope('d-B', { role: 'implementer', model_tier: 'opus', intent: 'fix-code' });
  const recordA = withBoth.sessions['session-A'];
  const recordB = withBoth.sessions['session-B'];
  assert.ok(recordA);
  assert.ok(recordB);

  const state: IlluminateState = {
    sessions: {
      'session-A': { ...recordA, dispatches: { 'd-A': makeEntry(envelopeA) } },
      'session-B': { ...recordB, dispatches: { 'd-B': makeEntry(envelopeB) } },
    },
  };

  const { next, result } = ingestAnswer(state, makeSubmission({ dispatchId: 'd-B', tier: 'opus', model: 'claude-opus-4' }), NOW);

  assert.strictEqual(result.kind, 'ok');
  assert.strictEqual(next.sessions['session-B']?.dispatches['d-B']?.status, 'answered');
  assert.strictEqual(next.sessions['session-A'], state.sessions['session-A'], 'session-A is untouched by an id that lives in session-B');
});

// ---------------------------------------------------------------------------
// Task 2 -- formatReceipt: EDU-03's structural, testable, fixed-size proof.
// ---------------------------------------------------------------------------

test('formatReceipt formats exactly "ok <id> <role>/<tier> <tokens> tokens <seconds>s -> <artifact>"', () => {
  const receipt = formatReceipt({
    dispatch_id: 'd_01JQ8F3K',
    role: 'tutor',
    tier: 'haiku',
    tokensIn: 612,
    tokensOut: 200,
    wallMs: 4100,
    artifactBasename: 'roadmap.html',
  });

  assert.strictEqual(receipt, 'ok d_01JQ8F3K tutor/haiku 812 tokens 4.1s -> roadmap.html');
});

test('formatReceipt sums tokensIn and tokensOut, never just one of them', () => {
  const receipt = formatReceipt({
    dispatch_id: 'd1',
    role: 'verifier',
    tier: 'sonnet',
    tokensIn: 1000,
    tokensOut: 1,
    wallMs: 1000,
    artifactBasename: 'a.html',
  });

  assert.match(receipt, /1001 tokens/);
});

test('formatReceipt renders wallMs as seconds with one decimal place', () => {
  const receipt = formatReceipt({
    dispatch_id: 'd1',
    role: 'author',
    tier: 'sonnet',
    tokensIn: 0,
    tokensOut: 0,
    wallMs: 250,
    artifactBasename: 'a.html',
  });

  assert.match(receipt, /0\.3s/);
});

test('a 5,000-word markdown answer fed through the full accept path still produces a receipt under a small fixed character budget -- the literal, testable proof of EDU-03', () => {
  const bigMarkdown = 'word '.repeat(5000);
  const envelope = makeEnvelope('d1');
  const state = stateWithEntry('d1', envelope);
  const submission = makeSubmission({ dispatchId: 'd1', markdown: bigMarkdown, tier: 'haiku' });

  const { result } = ingestAnswer(state, submission, NOW);

  assert.strictEqual(result.kind, 'ok');
  if (result.kind !== 'ok') throw new Error('unreachable');
  assert.ok(
    result.receipt.length < 200,
    `receipt must stay fixed-size regardless of a 5,000-word answer; got ${result.receipt.length} chars: ${result.receipt}`,
  );
  assert.ok(!result.receipt.includes('word word'), 'the receipt must never contain the submitted markdown content');
});

test('formatReceipt never mentions or accepts markdown -- there is no parameter to leak from', () => {
  const receipt = formatReceipt({
    dispatch_id: 'd1',
    role: 'tutor',
    tier: 'haiku',
    tokensIn: 10,
    tokensOut: 10,
    wallMs: 500,
    artifactBasename: 'a.html',
  });
  // formatReceipt's parameter type structurally has no markdown field -- this is
  // the compile-time half of that guarantee, checked by tsc, not just this
  // runtime assertion (an @ts-expect-error proof would require a widened call
  // site to fail to type-check, but ReceiptFields simply has no such field to
  // even attempt passing).
  assert.doesNotMatch(receipt, /the answer/i);
});

test("source-text: formatReceipt's own declared parameter type never mentions markdown (EDU-02 defense in depth)", () => {
  const source = readFileSync(INGEST_SOURCE_PATH, 'utf8');
  const marker = 'export interface ReceiptFields {';
  const start = source.indexOf(marker);
  assert.notStrictEqual(start, -1, 'ReceiptFields interface must exist in src/router/ingest.ts');
  const end = source.indexOf('}', start);
  const block = source.slice(start, end + 1);
  assert.doesNotMatch(block, /markdown/i);
});

// ---------------------------------------------------------------------------
// Task 3 -- summarizeForAudit: ROUT-08's audit-surface aggregation.
// ---------------------------------------------------------------------------

function extractFunctionBlock(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(`could not find "${signature}" in src/router/ingest.ts -- was it renamed?`);
  }
  const openBraceIndex = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = openBraceIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error(`unbalanced braces while extracting "${signature}" from src/router/ingest.ts`);
  }
  return source.slice(start, end + 1);
}

test('summarizeForAudit sums cost/token totals across answered entries only, separates deviations from refusals, and leaks no answer prose', () => {
  const answeredClean = makeEntry(makeEnvelope('a1', { role: 'tutor', model_tier: 'haiku' }), {
    status: 'answered',
    tierDeviation: false,
    answer: {
      markdown: 'a secret explanation nobody outside the browser should ever see',
      model: 'claude-haiku-4',
      tier: 'haiku',
      tokensIn: 100,
      tokensOut: 50,
      cacheReadInputTokens: 10,
      costUsd: 0.001,
      wallMs: 1000,
      answeredAt: NOW,
      verdict: null,
      decidingLines: null,
    },
  });
  const answeredDeviated = makeEntry(makeEnvelope('a2', { role: 'verifier', model_tier: 'sonnet' }), {
    status: 'answered',
    tierDeviation: true,
    answer: {
      markdown: 'another secret explanation',
      model: 'claude-haiku-4',
      tier: 'haiku',
      tokensIn: 200,
      tokensOut: 100,
      cacheReadInputTokens: 0,
      costUsd: 0.002,
      wallMs: 2000,
      answeredAt: NOW,
      verdict: null,
      decidingLines: null,
    },
  });
  const refused = makeEntry(makeEnvelope('a3', { role: 'implementer', model_tier: 'opus', intent: 'fix-code' }), {
    status: 'refused',
  });
  const stillOpen = makeEntry(makeEnvelope('a4'), { status: 'open' });

  const summary = summarizeForAudit([answeredClean, answeredDeviated, refused, stillOpen]);

  assert.strictEqual(summary.totalCostUsd, 0.003);
  assert.strictEqual(summary.totalTokensIn, 300);
  assert.strictEqual(summary.totalTokensOut, 150);
  assert.strictEqual(summary.totalCacheReadInputTokens, 10);
  assert.deepStrictEqual(summary.deviations, [{ dispatchId: 'a2', expectedTier: 'sonnet', reportedTier: 'haiku' }]);
  assert.strictEqual(summary.refusals.length, 1);
  assert.strictEqual(summary.refusals[0]?.dispatchId, 'a3');
  assert.ok(!JSON.stringify(summary).includes('secret'), 'summarizeForAudit output must never contain any answer markdown');
});

test('summarizeForAudit returns zeroed totals and empty arrays for no entries', () => {
  const summary = summarizeForAudit([]);

  assert.strictEqual(summary.totalCostUsd, 0);
  assert.strictEqual(summary.totalTokensIn, 0);
  assert.strictEqual(summary.totalTokensOut, 0);
  assert.strictEqual(summary.totalCacheReadInputTokens, 0);
  assert.deepStrictEqual(summary.deviations, []);
  assert.deepStrictEqual(summary.refusals, []);
});

test('summarizeForAudit ignores still-open/delivered entries entirely -- only answered entries contribute to totals', () => {
  const open = makeEntry(makeEnvelope('o1'), { status: 'open' });
  const delivered = makeEntry(makeEnvelope('o2'), { status: 'delivered' });

  const summary = summarizeForAudit([open, delivered]);

  assert.strictEqual(summary.totalCostUsd, 0);
  assert.strictEqual(summary.totalTokensIn, 0);
  assert.strictEqual(summary.deviations.length, 0);
  assert.strictEqual(summary.refusals.length, 0);
});

test("source-text: summarizeForAudit's own declared return type never mentions markdown (EDU-02 defense in depth)", () => {
  const source = readFileSync(INGEST_SOURCE_PATH, 'utf8');
  const block = extractFunctionBlock(source, 'export function summarizeForAudit');
  assert.doesNotMatch(block, /markdown/i);
});
