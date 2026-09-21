import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUngroundable } from '../../src/router/verify.ts';
import type { DispatchSource } from '../../src/router/types.ts';

/** A syntactically valid, minimal `DispatchSource` fixture -- only
 * `status`/`content` vary per table row below; `path`/`rev`/`range` are
 * fixed, plausible values irrelevant to `isUngroundable`'s own logic. */
function source(status: DispatchSource['status'], content: string | null): DispatchSource {
  return {
    path: 'src/example.ts',
    rev: 'abc123',
    range: { startLine: 1, endLine: 3 },
    status,
    content,
  };
}

// ---------------------------------------------------------------------------
// Table-driven over every DriftState this plan's own <behavior> spec names
// (mirrors this codebase's established exhaustive-table-testing style) --
// 7 DriftState values, each with the content shape `resolve()` actually
// produces for that status in practice.
// ---------------------------------------------------------------------------

const CASES: ReadonlyArray<{
  readonly name: string;
  readonly source: DispatchSource;
  readonly expected: boolean;
}> = [
  { name: 'refused (containment/grammar rejection)', source: source('refused', null), expected: true },
  { name: 'no-git, file unreadable', source: source('no-git', null), expected: true },
  { name: 'cannot-determine', source: source('cannot-determine', null), expected: true },
  { name: 'lost', source: source('lost', null), expected: true },
  { name: 'unchanged', source: source('unchanged', 'const x = 1;'), expected: false },
  { name: 'moved (content followed the anchor to a new location)', source: source('moved', 'const x = 1;'), expected: false },
  {
    name: 'touched (drifted-but-present content is still groundable)',
    source: source('touched', 'const x = 2;'),
    expected: false,
  },
];

for (const { name, source: s, expected } of CASES) {
  test(`isUngroundable: ${name} -> ${String(expected)}`, () => {
    assert.strictEqual(isUngroundable(s), expected);
  });
}

// ---------------------------------------------------------------------------
// The null-source case: an unanchored element (ANCH-08) -- no DispatchSource
// object at all, not a DispatchSource with a null-content field.
// ---------------------------------------------------------------------------

test('isUngroundable(null) -> true (unanchored element, no source object at all)', () => {
  assert.strictEqual(isUngroundable(null), true);
});

// ---------------------------------------------------------------------------
// The actual design proof: keyed on content, never on status alone.
// 'no-git' can carry EITHER real working-tree content or null, depending on
// whether resolve()'s own serveNoGit path could read the confined file --
// this proves isUngroundable follows content, not the status string.
// ---------------------------------------------------------------------------

test('isUngroundable is keyed on content nullness, not status: a "no-git" source WITH real content is groundable', () => {
  assert.strictEqual(isUngroundable(source('no-git', 'raw working-tree content')), false);
});

test('isUngroundable is keyed on content nullness, not status: a "refused" source can never carry content, and stays ungroundable', () => {
  assert.strictEqual(isUngroundable(source('refused', null)), true);
});

// ---------------------------------------------------------------------------
// 'unanchored' status, defensively -- resolve() itself can produce this
// (when called with a null AnchorInput), even though buildDispatchEnvelope's
// own real call path never does (it only calls resolve() when
// payload.anchor !== null). Covered here so this function stays correct
// even if a future caller of resolve() reaches this branch.
// ---------------------------------------------------------------------------

test('isUngroundable: a DispatchSource with status "unanchored" (defensive, not reachable via buildDispatchEnvelope today) -> true', () => {
  assert.strictEqual(isUngroundable(source('unanchored', null)), true);
});
