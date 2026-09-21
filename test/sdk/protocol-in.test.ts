import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSyncAnnotations, parseDispatchCreated, parseSyncFindings } from '../../src/sdk/protocol-in.ts';
import type { WireAnnotationStore } from '../../src/sdk/protocol-in.ts';

/**
 * 07-04's artifact-side (SDK) defensive parsers for the two new
 * chrome->artifact message types -- `illuminate:syncAnnotations` (carries a
 * full `WireAnnotationStore`) and `illuminate:dispatchCreated` (carries
 * `{dispatchId, elementUid}`). Unlike message-handling.ts's
 * `extractTypedIntent` (an adversarial boundary), chrome is privileged here
 * -- these functions validate SHAPE and never throw, but do not need
 * message-handling.ts's full field-by-field adversarial rigor.
 */

const FULL_STORE: WireAnnotationStore = {
  protocol: 'illuminate.annotations/1',
  cards: [
    {
      cardId: 'card-1',
      snapshot: {
        elementUid: null,
        anchor: { path: 'src/math.ts', startLine: 1, endLine: 3 },
        textContent: 'some text',
        prefixContext: null,
        suffixContext: 'after',
        structuralPath: 'body > p:nth-child(1)',
      },
      thread: [
        {
          dispatchId: 'd1',
          intent: 'explain',
          depth: 1,
          parentDispatchId: null,
          learnerNote: 'my own explanation attempt',
          markdown: 'This adds two numbers.',
          verdict: null,
          decidingLines: null,
          model: 'claude-test-model',
          tier: 'haiku',
          source: {
            path: 'src/math.ts',
            rev: 'abc123',
            range: { startLine: 1, endLine: 3 },
            status: 'clean',
            content: 'export function add(a, b) { return a + b; }',
          },
          answeredAt: '2026-09-11T00:00:00.000Z',
        },
        {
          dispatchId: 'd2',
          intent: 'verify',
          depth: 2,
          parentDispatchId: 'd1',
          learnerNote: null,
          markdown: 'Verified: supported by the cited lines.',
          verdict: 'supported',
          decidingLines: 'return a + b;',
          model: 'claude-test-model',
          tier: 'sonnet',
          source: null,
          answeredAt: '2026-09-11T00:01:00.000Z',
        },
      ],
      orphan: null,
    },
  ],
};

test('parseSyncAnnotations round-trips a well-formed WireAnnotationStore, including verdict and learnerNote fields', () => {
  const parsed = parseSyncAnnotations({ type: 'illuminate:syncAnnotations', payload: FULL_STORE });
  assert.deepStrictEqual(parsed, FULL_STORE);
});

test('parseSyncAnnotations returns null when type is anything else', () => {
  assert.strictEqual(parseSyncAnnotations({ type: 'illuminate:dispatchCreated', payload: FULL_STORE }), null);
  assert.strictEqual(parseSyncAnnotations({ type: 'not-a-real-type', payload: FULL_STORE }), null);
});

test('parseSyncAnnotations returns null when payload.cards is not an array', () => {
  assert.strictEqual(
    parseSyncAnnotations({ type: 'illuminate:syncAnnotations', payload: { protocol: 'illuminate.annotations/1', cards: 'nope' } }),
    null,
  );
});

test('parseSyncAnnotations rejects the WHOLE store when one card thread entry is missing dispatchId', () => {
  const broken: unknown = {
    protocol: 'illuminate.annotations/1',
    cards: [
      {
        ...FULL_STORE.cards[0],
        thread: [{ ...FULL_STORE.cards[0]?.thread[0], dispatchId: undefined }],
      },
    ],
  };
  assert.strictEqual(parseSyncAnnotations({ type: 'illuminate:syncAnnotations', payload: broken }), null);
});

test('parseSyncAnnotations never throws for null, undefined, a bare string, or a deeply malformed nested object', () => {
  assert.strictEqual(parseSyncAnnotations(null), null);
  assert.strictEqual(parseSyncAnnotations(undefined), null);
  assert.strictEqual(parseSyncAnnotations('just a string'), null);
  assert.strictEqual(
    parseSyncAnnotations({ type: 'illuminate:syncAnnotations', payload: { cards: [{ thread: [{ deeply: { nested: true } }] }] } }),
    null,
  );
});

test('parseDispatchCreated returns {dispatchId, elementUid} for a well-formed message', () => {
  const parsed = parseDispatchCreated({
    type: 'illuminate:dispatchCreated',
    payload: { dispatchId: 'd1', elementUid: 'el_abc' },
  });
  assert.deepStrictEqual(parsed, { dispatchId: 'd1', elementUid: 'el_abc' });
});

test('parseDispatchCreated returns null for missing or wrong-typed fields', () => {
  assert.strictEqual(parseDispatchCreated({ type: 'illuminate:dispatchCreated', payload: { dispatchId: 'd1' } }), null);
  assert.strictEqual(
    parseDispatchCreated({ type: 'illuminate:dispatchCreated', payload: { dispatchId: 1, elementUid: 'el_abc' } }),
    null,
  );
  assert.strictEqual(parseDispatchCreated({ type: 'illuminate:syncAnnotations', payload: { dispatchId: 'd1', elementUid: 'el_abc' } }), null);
});

test('parseDispatchCreated never throws for null, undefined, a bare string, or a deeply malformed nested object', () => {
  assert.strictEqual(parseDispatchCreated(null), null);
  assert.strictEqual(parseDispatchCreated(undefined), null);
  assert.strictEqual(parseDispatchCreated('just a string'), null);
  assert.strictEqual(parseDispatchCreated({ type: 'illuminate:dispatchCreated', payload: { dispatchId: { nested: true } } }), null);
});

// ---------------------------------------------------------------------------
// parseSyncFindings -- Plan 08-04's artifact-side parser for the new
// illuminate:syncFindings chrome->artifact message (carries {findings, meta}
// as payload). Same never-throw, whole-payload-invalid-means-null discipline
// as parseSyncAnnotations above.
// ---------------------------------------------------------------------------

const FULL_FINDINGS_SYNC = {
  protocol: 'illuminate.findings/1',
  findings: [
    {
      fingerprint: 'abc123def4567890',
      rule: 'drift-touched',
      target: { path: 'src/math.ts', startLine: 1, endLine: 3 },
      status: 'open',
    },
    {
      fingerprint: '0000000000000000',
      rule: 'drift-lost',
      target: { path: 'src/other.ts', startLine: null, endLine: null },
      status: 'dismissed',
    },
  ],
  meta: { watcherHealthy: true },
};

test('parseSyncFindings round-trips a well-formed WireFindingsSync', () => {
  const parsed = parseSyncFindings({ type: 'illuminate:syncFindings', payload: FULL_FINDINGS_SYNC });
  assert.deepStrictEqual(parsed, FULL_FINDINGS_SYNC);
});

test('parseSyncFindings returns null when type is anything else', () => {
  assert.strictEqual(parseSyncFindings({ type: 'illuminate:syncAnnotations', payload: FULL_FINDINGS_SYNC }), null);
  assert.strictEqual(parseSyncFindings({ type: 'not-a-real-type', payload: FULL_FINDINGS_SYNC }), null);
});

test('parseSyncFindings returns null when payload is missing', () => {
  assert.strictEqual(parseSyncFindings({ type: 'illuminate:syncFindings' }), null);
});

test('parseSyncFindings rejects the WHOLE payload when one findings entry is malformed (missing fingerprint)', () => {
  const broken = {
    protocol: 'illuminate.findings/1',
    findings: [{ ...FULL_FINDINGS_SYNC.findings[0], fingerprint: undefined }, FULL_FINDINGS_SYNC.findings[1]],
    meta: { watcherHealthy: true },
  };
  assert.strictEqual(parseSyncFindings({ type: 'illuminate:syncFindings', payload: broken }), null);
});

test('parseSyncFindings returns null when meta.watcherHealthy is not a boolean', () => {
  const broken = { ...FULL_FINDINGS_SYNC, meta: { watcherHealthy: 'yes' } };
  assert.strictEqual(parseSyncFindings({ type: 'illuminate:syncFindings', payload: broken }), null);
});

test('parseSyncFindings returns null when findings is not an array', () => {
  const broken = { ...FULL_FINDINGS_SYNC, findings: 'nope' };
  assert.strictEqual(parseSyncFindings({ type: 'illuminate:syncFindings', payload: broken }), null);
});

test('parseSyncFindings never throws for null, undefined, a bare string, or a deeply malformed nested object', () => {
  assert.strictEqual(parseSyncFindings(null), null);
  assert.strictEqual(parseSyncFindings(undefined), null);
  assert.strictEqual(parseSyncFindings('just a string'), null);
  assert.strictEqual(
    parseSyncFindings({ type: 'illuminate:syncFindings', payload: { findings: [{ deeply: { nested: true } }] } }),
    null,
  );
});
