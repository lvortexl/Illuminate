import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnchorRangeFromSrc } from '../../src/sdk/snapshot.ts';

test('parseAnchorRangeFromSrc splits a ranged src into path + 1-indexed start/end lines', () => {
  assert.deepStrictEqual(parseAnchorRangeFromSrc('src/main.ts#L120-L180'), {
    path: 'src/main.ts',
    startLine: 120,
    endLine: 180,
  });
});

test('parseAnchorRangeFromSrc with no range at all returns null start/end -- a whole-file anchor', () => {
  assert.deepStrictEqual(parseAnchorRangeFromSrc('src/main.ts'), {
    path: 'src/main.ts',
    startLine: null,
    endLine: null,
  });
});

test('parseAnchorRangeFromSrc degrades a malformed range to a whole-file anchor rather than throwing', () => {
  assert.deepStrictEqual(parseAnchorRangeFromSrc('src/main.ts#garbage'), {
    path: 'src/main.ts',
    startLine: null,
    endLine: null,
  });
});

test('parseAnchorRangeFromSrc handles the #L1-L1 single-line boundary case', () => {
  assert.deepStrictEqual(parseAnchorRangeFromSrc('src/main.ts#L1-L1'), {
    path: 'src/main.ts',
    startLine: 1,
    endLine: 1,
  });
});
