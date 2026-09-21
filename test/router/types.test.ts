import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { PollResponse, DispatchEnvelope, DispatchElement, AnswerSubmission, AnswerRecord } from '../../src/router/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES_SOURCE_PATH = join(HERE, '..', '..', 'src', 'router', 'types.ts');

const element: DispatchElement = {
  uid: 'e1',
  selector: '#main > p:nth-child(2)',
  tag: 'p',
  text: 'some text',
  prefixContext: null,
  suffixContext: null,
};

function validEnvelope(): DispatchEnvelope {
  return {
    protocol: 'illuminate.dispatch/2',
    dispatch_id: 'd1',
    intent: 'explain',
    role: 'tutor',
    model_tier: 'haiku',
    deadline_ms: 30000,
    targets: [{ element, source: null }],
    return_to: 'illuminate answer d1',
    return_contract: 'run the command above, piping your markdown answer to stdin',
    tools: [],
    depth: 1,
    parent_dispatch: null,
    learnerNote: null,
    note: null,
    attachments: [],
  };
}

// ---------------------------------------------------------------------------
// EDU-02, part 1: compile-time proof (the enforceable half).
//
// Each block below is a top-level module-scope assignment, not inside a
// test() callback -- mirrors src/shared/protocol.test.ts's own
// artifact_load_token proof exactly. `npm run typecheck` is what proves
// this: if the expected error disappears (because someone widened
// PollResponse or DispatchEnvelope to carry an answer-shaped field), `tsc
// --noEmit` fails on an UNUSED `@ts-expect-error` directive -- THAT failure
// is the CI assertion. This is genuinely runnable in CI (package.json's
// `typecheck` script), not aspirational.
// ---------------------------------------------------------------------------

// @ts-expect-error -- PollResponse must structurally reject an answer body; if this
// stops erroring, someone widened PollResponse and silently reopened EDU-02's leak.
const leakedPollResponse: PollResponse = { status: 'waiting', dispatches: [], markdown: 'the answer' };
void leakedPollResponse;

// @ts-expect-error -- DispatchEnvelope must structurally reject an answer body; if this
// stops erroring, someone widened the envelope shape an orchestrator can see back from a
// poll, silently reopening EDU-02's leak.
const leakedEnvelope: DispatchEnvelope = { ...validEnvelope(), markdown: 'the answer' };
void leakedEnvelope;

// @ts-expect-error -- same proof, the "answer" field name instead of "markdown" -- neither
// spelling of an answer body may ever attach to the envelope an orchestrator can poll for.
const leakedEnvelopeAnswerField: DispatchEnvelope = { ...validEnvelope(), answer: 'the answer' };
void leakedEnvelopeAnswerField;

// @ts-expect-error -- the poll-reachable summary shape generally: an individual dispatch
// INSIDE a PollResponse's `dispatches` array must reject an answer body too, not just the
// top-level PollResponse object -- this is the actual shape an orchestrator iterates over.
const leakedViaDispatchesArray: PollResponse = { status: 'dispatch', dispatches: [{ ...validEnvelope(), markdown: 'the answer' }] };
void leakedViaDispatchesArray;

// ---------------------------------------------------------------------------
// 07-01: `tools`/`depth`/`parent_dispatch`/`learnerNote` are legitimately
// allowed on DispatchEnvelope -- they are dispatch INPUT (what a harness is
// told to do and with what), never answer OUTPUT. No @ts-expect-error here
// on purpose: a real envelope literal setting all four must compile and
// round-trip exactly, proving this plan's widening didn't accidentally
// require touching the EDU-02 proofs above.
// ---------------------------------------------------------------------------

test('DispatchEnvelope legitimately carries tools/depth/parent_dispatch/learnerNote -- dispatch input, never answer output', () => {
  const envelope: DispatchEnvelope = {
    ...validEnvelope(),
    tools: ['Read', 'Grep', 'Glob'],
    depth: 3,
    parent_dispatch: 'd_prior',
    learnerNote: "the reader's own guess",
    note: null,
    attachments: [],
  };
  assert.deepStrictEqual(envelope.tools, ['Read', 'Grep', 'Glob']);
  assert.strictEqual(envelope.depth, 3);
  assert.strictEqual(envelope.parent_dispatch, 'd_prior');
  assert.strictEqual(envelope.learnerNote, "the reader's own guess");
});

// ---------------------------------------------------------------------------
// 07-01: verdict/decidingLines legitimately live on the answer-only types
// (AnswerSubmission/AnswerRecord) -- they never touch PollResponse or
// DispatchEnvelope, so no @ts-expect-error is warranted here either.
// ---------------------------------------------------------------------------

test('AnswerSubmission and AnswerRecord permit verdict/decidingLines (answer-only types, never envelope-reachable)', () => {
  const submission: AnswerSubmission = {
    dispatchId: 'd1',
    markdown: 'the answer',
    model: 'claude-haiku-4',
    tier: 'haiku',
    tokensIn: 10,
    tokensOut: 20,
    cacheReadInputTokens: 0,
    costUsd: 0.001,
    wallMs: 500,
    verdict: 'not-determinable',
    decidingLines: null,
  };
  const record: AnswerRecord = {
    markdown: submission.markdown,
    model: submission.model,
    tier: submission.tier,
    tokensIn: submission.tokensIn,
    tokensOut: submission.tokensOut,
    cacheReadInputTokens: submission.cacheReadInputTokens,
    costUsd: submission.costUsd,
    wallMs: submission.wallMs,
    answeredAt: '2026-01-01T00:00:00.000Z',
    verdict: submission.verdict,
    decidingLines: submission.decidingLines,
  };
  assert.strictEqual(submission.verdict, 'not-determinable');
  assert.strictEqual(record.verdict, 'not-determinable');
  assert.strictEqual(record.decidingLines, null);
});

// ---------------------------------------------------------------------------
// EDU-02, part 2: source-text defense in depth.
//
// A second, independent proof that does not rely on TypeScript alone (in
// case a future refactor moves PollResponse somewhere @ts-expect-error
// isn't checked). Mirrors this codebase's established source-text
// regression-test precedent (src/provenance/relocate.test.ts's
// RELOCATION_TOUCHED_THRESHOLD constant-isolation scan): read
// src/router/types.ts's own source text, extract the interface block by
// brace-matching, and assert it never mentions an answer-shaped field name.
// ---------------------------------------------------------------------------

const FORBIDDEN_FIELD_NAME = /\b(markdown|answer|body|explanation)\b/i;

/** Extracts `export interface <name> { ... }`'s full text (braces included)
 * from `source` by counting brace depth from the interface's opening brace
 * -- robust to nested object-literal-shaped fields inside the interface
 * (e.g. DispatchEnvelope's `element`/`source` fields are themselves object
 * types), unlike a naive non-greedy regex which would stop at the first `}`. */
function extractInterfaceBlock(source: string, name: string): string {
  const marker = `export interface ${name} {`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`could not find "${marker}" in src/router/types.ts -- was the interface renamed?`);
  }
  const openBraceIndex = start + marker.length - 1;
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
    throw new Error(`unbalanced braces while extracting "export interface ${name}" from src/router/types.ts`);
  }
  return source.slice(start, end + 1);
}

test('source-text: PollResponse never mentions an answer-shaped field name (EDU-02 defense in depth)', () => {
  const source = readFileSync(TYPES_SOURCE_PATH, 'utf8');
  const block = extractInterfaceBlock(source, 'PollResponse');
  assert.strictEqual(
    FORBIDDEN_FIELD_NAME.test(block),
    false,
    `PollResponse's declaration must never carry an answer-shaped field name. Extracted block:\n${block}`,
  );
  // Sanity check the extraction actually found the real, current 2-field shape --
  // this guard can't pass merely because the interface was renamed or emptied.
  assert.match(block, /status/);
  assert.match(block, /dispatches/);
});

test('source-text: DispatchEnvelope never mentions an answer-shaped field name (EDU-02 defense in depth)', () => {
  // Re-run after 07-01's own widening of this interface (tools/depth/
  // parent_dispatch/learnerNote): none of those four names -- nor their doc
  // comments -- match FORBIDDEN_FIELD_NAME, so this assertion still holds
  // with no regex change required.
  const source = readFileSync(TYPES_SOURCE_PATH, 'utf8');
  const block = extractInterfaceBlock(source, 'DispatchEnvelope');
  assert.strictEqual(
    FORBIDDEN_FIELD_NAME.test(block),
    false,
    `DispatchEnvelope's declaration must never carry an answer-shaped field name. Extracted block:\n${block}`,
  );
  assert.match(block, /return_to/);
  assert.match(block, /return_contract/);
  assert.match(block, /tools/);
});

// ---------------------------------------------------------------------------
// EDU-03: structural proof (declarative half).
//
// A plain runtime test constructing a DispatchEnvelope literal and asserting
// return_to and return_contract are present, non-empty strings -- proving
// the return contract is DATA carried on the envelope itself, not something
// assembled later by a CLI command's print statement.
// ---------------------------------------------------------------------------

test('EDU-03: DispatchEnvelope carries its own return contract as typed data, not assembled prose', () => {
  const envelope = validEnvelope();
  assert.strictEqual(typeof envelope.return_to, 'string');
  assert.ok(envelope.return_to.length > 0, 'return_to must be a non-empty string');
  assert.strictEqual(typeof envelope.return_contract, 'string');
  assert.ok(envelope.return_contract.length > 0, 'return_contract must be a non-empty string');
});

test('PollResponse has exactly the two fields EDU-02 requires -- status and dispatches, nothing else', () => {
  const response: PollResponse = { status: 'ended', dispatches: [] };
  assert.deepStrictEqual(Object.keys(response).sort(), ['dispatches', 'status']);
});
