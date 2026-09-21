import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractElementSelection, extractTypedIntent } from '../../src/chrome/message-handling.ts';

/**
 * `illuminate:selectElement` -- the artifact telling the chrome rail which
 * element the human just pointed at.
 *
 * This message is emitted on an ordinary click and creates nothing: no
 * dispatch, no queue entry, no model call. That is precisely why it gets its
 * own message type instead of riding `illuminate:queuePrompt` behind a
 * `payload.protocol` discriminator the way the dismiss action does -- the
 * mutual-exclusion test at the bottom is the one that would fail loudly if
 * anyone ever merged them and a free message became readable as billable
 * work.
 *
 * It crosses the same trust boundary as every other artifact->chrome
 * message, so it gets the same treatment: never throws, and a stale load
 * token is rejected rather than tolerated because the payload looks harmless.
 */

const LOAD_TOKEN = 'tok-abc-123';

const VALID_ELEMENT = {
  uid: 'u1',
  selector: 'body > div:nth-of-type(1)',
  tag: 'div',
  text: 'Hello world',
  prefixContext: null,
  suffixContext: null,
};
const VALID_ANCHOR = { src: 'src/main.ts#L1-L5', rev: 'abc123', anchorHash: 'deadbeef01234567' };

function selection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'illuminate:selectElement',
    artifact_load_token: LOAD_TOKEN,
    payload: { element: VALID_ELEMENT, anchor: VALID_ANCHOR, label: 'src/main.ts#L1-L5' },
    ...overrides,
  };
}

// --- the happy path --------------------------------------------------

test('extracts a valid selection', () => {
  const result = extractElementSelection(selection(), LOAD_TOKEN);
  assert.ok(result);
  assert.deepStrictEqual(result.element, VALID_ELEMENT);
  assert.deepStrictEqual(result.anchor, VALID_ANCHOR);
  assert.strictEqual(result.label, 'src/main.ts#L1-L5');
});

test('a null anchor is the legitimate unanchored case, not a rejection', () => {
  const result = extractElementSelection(
    selection({ payload: { element: VALID_ELEMENT, anchor: null, label: '<div> Hello world' } }),
    LOAD_TOKEN,
  );
  assert.ok(result);
  assert.strictEqual(result.anchor, null);
});

// --- the trust boundary ----------------------------------------------

test('rejects a selection from a superseded artifact load', () => {
  assert.strictEqual(extractElementSelection(selection(), 'a-different-token'), null);
});

test('rejects a selection carrying no load token at all', () => {
  const msg = selection();
  delete msg.artifact_load_token;
  assert.strictEqual(extractElementSelection(msg, LOAD_TOKEN), null);
});

test('rejects a message of any other type', () => {
  assert.strictEqual(extractElementSelection(selection({ type: 'illuminate:queuePrompt' }), LOAD_TOKEN), null);
  assert.strictEqual(extractElementSelection(selection({ type: 'not-an-illuminate-type' }), LOAD_TOKEN), null);
});

// --- never throws, whatever arrives ----------------------------------

test('returns null rather than throwing on malformed input', () => {
  const garbage: unknown[] = [
    null,
    undefined,
    0,
    'a string',
    [],
    {},
    { type: 'illuminate:selectElement' },
    selection({ payload: null }),
    selection({ payload: {} }),
    selection({ payload: { element: VALID_ELEMENT, anchor: VALID_ANCHOR } }), // no label
    selection({ payload: { element: VALID_ELEMENT, anchor: VALID_ANCHOR, label: 42 } }),
    selection({ payload: { element: { uid: 'u1' }, anchor: null, label: 'x' } }), // partial element
    selection({ payload: { element: VALID_ELEMENT, anchor: 'not-an-object', label: 'x' } }),
  ];
  for (const data of garbage) {
    assert.strictEqual(extractElementSelection(data, LOAD_TOKEN), null, `should reject: ${JSON.stringify(data)}`);
  }
});

// --- separation from the message that DOES cost something ------------

test('a selection is never readable as a typed intent', () => {
  assert.strictEqual(
    extractTypedIntent(selection(), LOAD_TOKEN),
    null,
    'pointing at an element must never be extractable as a dispatch',
  );
});

test('a typed intent is never readable as a selection', () => {
  const intentMessage = {
    type: 'illuminate:queuePrompt',
    artifact_load_token: LOAD_TOKEN,
    payload: {
      protocol: 'illuminate.intent/1',
      intent: 'explain',
      element: VALID_ELEMENT,
      anchor: VALID_ANCHOR,
      depth: 1,
      parent_dispatch: null,
      learnerNote: null,
      note: null,
    },
  };
  assert.strictEqual(extractElementSelection(intentMessage, LOAD_TOKEN), null);
});
