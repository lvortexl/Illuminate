import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnchorRegion, anchorHash } from './hash.ts';

test('normalizeAnchorRegion: CRLF line endings are converted to LF', () => {
  const raw = 'line one\r\nline two\r\n';
  assert.strictEqual(normalizeAnchorRegion(raw), 'line one\nline two\n');
});

test('normalizeAnchorRegion: lone-CR line endings are converted to LF', () => {
  const raw = 'line one\rline two\r';
  assert.strictEqual(normalizeAnchorRegion(raw), 'line one\nline two\n');
});

test('normalizeAnchorRegion: trailing whitespace at the end of each line is stripped', () => {
  const raw = 'line one   \nline two\t\t\n';
  assert.strictEqual(normalizeAnchorRegion(raw), 'line one\nline two\n');
});

test('normalizeAnchorRegion: leading and trailing blank lines of the region are trimmed', () => {
  const raw = '\n\n  \nline one\nline two\n\n\n';
  assert.strictEqual(normalizeAnchorRegion(raw), 'line one\nline two\n');
});

test('normalizeAnchorRegion: result always ends in exactly one trailing newline', () => {
  const raw = 'line one\nline two';
  const result = normalizeAnchorRegion(raw);
  assert.match(result, /[^\n]\n$/);
  assert.strictEqual(result, 'line one\nline two\n');
});

test('normalizeAnchorRegion (A1 boundary): different indentation normalizes to different strings', () => {
  const twoSpace = 'function f() {\n  return 1;\n}\n';
  const fourSpace = 'function f() {\n    return 1;\n}\n';
  assert.notStrictEqual(normalizeAnchorRegion(twoSpace), normalizeAnchorRegion(fourSpace));
});

test('anchorHash: returns a 16-character lowercase hex string', () => {
  const hash = anchorHash('some content\n');
  assert.match(hash, /^[0-9a-f]{16}$/);
});

test('anchorHash: CRLF and LF versions of identical logical content produce the same hash', () => {
  const crlf = 'function f() {\r\n  return 1;\r\n}\r\n';
  const lf = 'function f() {\n  return 1;\n}\n';
  assert.strictEqual(anchorHash(crlf), anchorHash(lf));
});

test('anchorHash (A1 boundary): indentation difference produces different hashes', () => {
  const twoSpace = 'function f() {\n  return 1;\n}\n';
  const fourSpace = 'function f() {\n    return 1;\n}\n';
  assert.notStrictEqual(anchorHash(twoSpace), anchorHash(fourSpace));
});

test('anchorHash: is deterministic across repeated calls', () => {
  const raw = 'stable content\nacross calls\n';
  assert.strictEqual(anchorHash(raw), anchorHash(raw));
});
