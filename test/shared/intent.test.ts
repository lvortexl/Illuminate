import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTENT_PROTOCOL_VERSION,
  INTENT_TYPES,
  isIntent,
  buildTypedIntentPayload,
} from '../../src/shared/intent.ts';
import type { TypedIntentPayload, IntentElement, IntentAnchor } from '../../src/shared/intent.ts';

const element: IntentElement = {
  uid: 'e1',
  selector: '#main > p:nth-child(2)',
  tag: 'p',
  text: 'Some element text',
  prefixContext: null,
  suffixContext: null,
};

// --- 1. Exactly 5 intents, in the locked order ---

test('INTENT_TYPES has exactly 5 entries, in ROUT-01/REQUIREMENTS.md order', () => {
  assert.deepStrictEqual(INTENT_TYPES, ['explain', 'verify', 'deeper', 'fix-artifact', 'fix-code']);
});

// --- 2. isIntent narrows untrusted strings ---

test('isIntent narrows a valid intent string', () => {
  assert.strictEqual(isIntent('explain'), true);
});

test('isIntent rejects ARCHITECTURE.md illustrative naming that REQUIREMENTS.md does not use', () => {
  assert.strictEqual(isIntent('fix-doc'), false);
});

test('isIntent rejects the empty string', () => {
  assert.strictEqual(isIntent(''), false);
});

// --- 3. buildTypedIntentPayload exact shape ---

test('buildTypedIntentPayload returns the exact fixed-default shape', () => {
  const payload = buildTypedIntentPayload({ intent: 'explain', targets: [{ element, anchor: null }] });
  assert.deepStrictEqual(payload, {
    protocol: 'illuminate.intent/2',
    intent: 'explain',
    targets: [{ element, anchor: null }],
    depth: 1,
    parent_dispatch: null,
    learnerNote: null,
    note: null,
    attachments: [],
  });
});

test('buildTypedIntentPayload returns the exact values passed for depth/parent_dispatch/learnerNote, not the defaults', () => {
  const payload = buildTypedIntentPayload({
    intent: 'explain',
    targets: [{ element, anchor: null }],
    depth: 2,
    parent_dispatch: 'd1',
    learnerNote: 'my guess',
    note: null,
    attachments: [],
  });
  assert.strictEqual(payload.depth, 2);
  assert.strictEqual(payload.parent_dispatch, 'd1');
  assert.strictEqual(payload.learnerNote, 'my guess');
});

// --- 4. Pure function, no hidden state ---

test('buildTypedIntentPayload called twice with the same input produces deep-equal, not just same-reference, output', () => {
  const input = { intent: 'verify' as const, targets: [{ element, anchor: null }] };
  const first = buildTypedIntentPayload(input);
  const second = buildTypedIntentPayload(input);
  assert.notStrictEqual(first, second);
  assert.deepStrictEqual(first, second);
});

test('protocol exposes an explicit version for future compatibility checks', () => {
  assert.strictEqual(INTENT_PROTOCOL_VERSION, 'illuminate.intent/2');
});

test('a real IntentAnchor round-trips through buildTypedIntentPayload unchanged', () => {
  // 3-key literal (anchorHash added 06-01-PLAN.md): anchorHash is a required
  // key with a nullable value, not an optional key -- omitting it is a
  // compile error, so this literal must stay a real, current example of the
  // type it asserts against.
  const anchor: IntentAnchor = { src: 'src/foo.ts', rev: 'abc123', anchorHash: 'abc123def456' };
  const payload = buildTypedIntentPayload({ intent: 'fix-code', targets: [{ element, anchor }] });
  assert.deepStrictEqual(payload.targets[0]!.anchor, anchor);
});

// --- 5. Compile-time: targets is required, never omittable ---
// ADR-102: the field this guards renamed from `anchor` to `targets`, but the
// guarantee is the same one -- a payload that names nothing to act on must
// not type-check.
// @ts-expect-error — targets is required; omitting it must fail to type-check
const _missingTargets: TypedIntentPayload = {
  protocol: 'illuminate.intent/2',
  intent: 'explain',
  depth: 1,
  parent_dispatch: null,
};
void _missingTargets;
