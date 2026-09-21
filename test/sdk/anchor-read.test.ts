import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAnchorAttributes } from '../../src/sdk/anchor-read.ts';

test('reads data-src and data-rev when both are present, and a null anchorHash when data-anchor-hash is absent', () => {
  const result = readAnchorAttributes((name) =>
    name === 'data-src' ? 'src/main.ts#L1-L5' : name === 'data-rev' ? 'abc123' : null,
  );
  assert.deepStrictEqual(result, { src: 'src/main.ts#L1-L5', rev: 'abc123', anchorHash: null });
});

test('reads data-src with a null rev and a null anchorHash when both are absent', () => {
  const result = readAnchorAttributes((name) => (name === 'data-src' ? 'src/main.ts' : null));
  assert.deepStrictEqual(result, { src: 'src/main.ts', rev: null, anchorHash: null });
});

test('returns null when data-src is absent entirely -- graceful degradation', () => {
  const result = readAnchorAttributes(() => null);
  assert.strictEqual(result, null);
});

test('returns null when data-src is the empty string', () => {
  const result = readAnchorAttributes((name) => (name === 'data-src' ? '' : null));
  assert.strictEqual(result, null);
});

test('reads data-src, data-rev, and data-anchor-hash when all three are present', () => {
  const result = readAnchorAttributes((name) =>
    name === 'data-src'
      ? 'src/main.ts#L1-L5'
      : name === 'data-rev'
        ? 'abc123'
        : name === 'data-anchor-hash'
          ? 'deadbeef01234567'
          : null,
  );
  assert.deepStrictEqual(result, { src: 'src/main.ts#L1-L5', rev: 'abc123', anchorHash: 'deadbeef01234567' });
});

// INVERTED from Phase 4's "does not read data-anchor-hash -- ANCH-01 validation is Phase 2/6 resolver
// territory, not the SDK". That was correct for Phase 4's scope, but Phase 2's parseAnchor/resolve()
// treat anchorHash as MANDATORY: without it every real anchor would resolve to `refused`. This plan
// (06-01) deliberately reverses that decision -- see src/sdk/anchor-read.ts's rewritten doc comment.
test('DOES now read data-anchor-hash and pass it through -- reversal of Phase 4 decision, per 06-01-PLAN.md', () => {
  let hashWasRead = false;
  const result = readAnchorAttributes((name) => {
    if (name === 'data-anchor-hash') hashWasRead = true;
    return name === 'data-src' ? 'src/main.ts' : name === 'data-anchor-hash' ? 'cafebabe01234567' : null;
  });
  assert.strictEqual(hashWasRead, true);
  assert.deepStrictEqual(result, { src: 'src/main.ts', rev: null, anchorHash: 'cafebabe01234567' });
});
