import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strongEtag, isNotModified } from '../../src/serve/etag.ts';

const STAT = { size: 1234, mtimeMs: 1_700_000_000_000 };
const LAST_MODIFIED = new Date(STAT.mtimeMs);

test('strongEtag never carries a W/ prefix', () => {
  const etag = strongEtag(STAT);
  assert.ok(!etag.startsWith('W/'), `expected no W/ prefix, got ${etag}`);
});

test('strongEtag changes when size changes, holding mtimeMs constant', () => {
  const a = strongEtag({ size: 100, mtimeMs: STAT.mtimeMs });
  const b = strongEtag({ size: 200, mtimeMs: STAT.mtimeMs });
  assert.notStrictEqual(a, b);
});

test('strongEtag changes when mtimeMs changes, holding size constant', () => {
  const a = strongEtag({ size: STAT.size, mtimeMs: 1_700_000_000_000 });
  const b = strongEtag({ size: STAT.size, mtimeMs: 1_700_000_001_000 });
  assert.notStrictEqual(a, b);
});

test('isNotModified: If-None-Match exactly matching the current ETag is true', () => {
  const etag = strongEtag(STAT);
  assert.strictEqual(isNotModified({ 'if-none-match': etag }, etag, LAST_MODIFIED), true);
});

test('isNotModified: If-None-Match containing the ETag in a comma-separated list is true', () => {
  const etag = strongEtag(STAT);
  const headers = { 'if-none-match': `"otherEtag", ${etag}, "thirdEtag"` };
  assert.strictEqual(isNotModified(headers, etag, LAST_MODIFIED), true);
});

test('isNotModified: If-None-Match: * is true', () => {
  const etag = strongEtag(STAT);
  assert.strictEqual(isNotModified({ 'if-none-match': '*' }, etag, LAST_MODIFIED), true);
});

test('isNotModified: If-None-Match present but not matching is false, and If-Modified-Since is not consulted', () => {
  const etag = strongEtag(STAT);
  const headers = {
    'if-none-match': '"stale-etag"',
    // Would be true on its own — must NOT be consulted because If-None-Match
    // takes precedence when both headers are present (MDN).
    'if-modified-since': LAST_MODIFIED.toUTCString(),
  };
  assert.strictEqual(isNotModified(headers, etag, LAST_MODIFIED), false);
});

test('isNotModified: no If-None-Match, If-Modified-Since at or after last-modified is true', () => {
  const etag = strongEtag(STAT);
  const headers = { 'if-modified-since': LAST_MODIFIED.toUTCString() };
  assert.strictEqual(isNotModified(headers, etag, LAST_MODIFIED), true);
});

test('isNotModified: no If-None-Match, If-Modified-Since strictly before last-modified is false', () => {
  const etag = strongEtag(STAT);
  const earlier = new Date(LAST_MODIFIED.getTime() - 5000);
  const headers = { 'if-modified-since': earlier.toUTCString() };
  assert.strictEqual(isNotModified(headers, etag, LAST_MODIFIED), false);
});
