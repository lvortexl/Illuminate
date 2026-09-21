import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, isRangeFresh } from '../../src/serve/range.ts';
import { strongEtag } from '../../src/serve/etag.ts';

const SIZE = 1000;
const STAT = { size: SIZE, mtimeMs: 1_700_000_000_000 };
const LAST_MODIFIED = new Date(STAT.mtimeMs);

test('bytes=0-499 on a 1000-byte resource parses to start=0, end=499', () => {
  assert.deepStrictEqual(parseRange('bytes=0-499', SIZE), {
    kind: 'range',
    range: { start: 0, end: 499 },
  });
});

test('bytes=500- (open-ended) resolves end to size-1', () => {
  assert.deepStrictEqual(parseRange('bytes=500-', SIZE), {
    kind: 'range',
    range: { start: 500, end: 999 },
  });
});

test('bytes=-500 (suffix range) resolves to the last 500 bytes', () => {
  assert.deepStrictEqual(parseRange('bytes=-500', SIZE), {
    kind: 'range',
    range: { start: 500, end: 999 },
  });
});

test('bytes=800-999999 (overshooting end) clamps to size-1, stays a range not unsatisfiable', () => {
  assert.deepStrictEqual(parseRange('bytes=800-999999', SIZE), {
    kind: 'range',
    range: { start: 800, end: 999 },
  });
});

test('bytes=1000- (start === size) is unsatisfiable', () => {
  assert.deepStrictEqual(parseRange('bytes=1000-', SIZE), { kind: 'unsatisfiable' });
});

test('bytes=-0 (zero-length suffix) is unsatisfiable', () => {
  assert.deepStrictEqual(parseRange('bytes=-0', SIZE), { kind: 'unsatisfiable' });
});

test('not-a-range (fails bytes= syntax entirely) is treated as absent, not an error', () => {
  assert.deepStrictEqual(parseRange('not-a-range', SIZE), { kind: 'none' });
});

test('bytes=- (empty both sides) is treated as absent', () => {
  assert.deepStrictEqual(parseRange('bytes=-', SIZE), { kind: 'none' });
});

test('no Range header at all is treated as absent', () => {
  assert.deepStrictEqual(parseRange(undefined, SIZE), { kind: 'none' });
});

test('isRangeFresh: no If-Range header honors the Range unconditionally', () => {
  const etag = strongEtag(STAT);
  assert.strictEqual(isRangeFresh({}, etag, LAST_MODIFIED), true);
});

test('isRangeFresh: If-Range exactly equal to the current strong ETag is true', () => {
  const etag = strongEtag(STAT);
  const headers = { 'if-range': etag };
  assert.strictEqual(isRangeFresh(headers, etag, LAST_MODIFIED), true);
});

test('isRangeFresh: If-Range is a parseable HTTP-date at or after last-modified is true', () => {
  const etag = strongEtag(STAT);
  const headers = { 'if-range': LAST_MODIFIED.toUTCString() };
  assert.strictEqual(isRangeFresh(headers, etag, LAST_MODIFIED), true);
});

test('isRangeFresh: If-Range names a stale/different ETag is false — must not serve 206 of the wrong file', () => {
  const etag = strongEtag(STAT);
  const headers = { 'if-range': '"stale-etag-1234"' };
  assert.strictEqual(isRangeFresh(headers, etag, LAST_MODIFIED), false);
});

test('isRangeFresh: unparseable If-Range value is false — fails toward correctness', () => {
  const etag = strongEtag(STAT);
  const headers = { 'if-range': 'not-an-etag-or-a-date' };
  assert.strictEqual(isRangeFresh(headers, etag, LAST_MODIFIED), false);
});
