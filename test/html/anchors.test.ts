import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAnchorInputs } from '../../src/html/anchors.ts';

// ---------------------------------------------------------------------------
// Task 1: extractAnchorInputs -- server-side anchor discovery
// ---------------------------------------------------------------------------

test('extractAnchorInputs: three elements carrying distinct data-src values produce three AnchorInputs in document order, fields mapped correctly', () => {
  const html = `<!doctype html><html><body>
    <div data-src="src/a.ts" data-anchor-hash="hash1">whole file</div>
    <div data-src="src/b.ts#L5-L10" data-anchor-hash="hash2">ranged</div>
    <div data-src="src/c.ts#L1-L2" data-rev="abcdef1234567890" data-anchor-hash="hash3">ranged + rev</div>
  </body></html>`;

  const result = extractAnchorInputs(html);

  assert.deepStrictEqual(result, [
    { path: 'src/a.ts', anchorHash: 'hash1' },
    { path: 'src/b.ts', range: 'L5-L10', anchorHash: 'hash2' },
    { path: 'src/c.ts', range: 'L1-L2', rev: 'abcdef1234567890', anchorHash: 'hash3' },
  ]);
});

test('extractAnchorInputs: two elements citing the exact same (path, range, rev, anchorHash) tuple produce exactly ONE AnchorInput', () => {
  const html = `<!doctype html><html><body>
    <div data-src="src/dup.ts#L1-L2" data-rev="rev1" data-anchor-hash="hashX">first</div>
    <div data-src="src/dup.ts#L1-L2" data-rev="rev1" data-anchor-hash="hashX">second, identical anchor</div>
    <div data-src="src/other.ts#L1-L2" data-rev="rev1" data-anchor-hash="hashX">different path, not a dup</div>
  </body></html>`;

  const result = extractAnchorInputs(html);

  assert.strictEqual(result.length, 2);
  assert.deepStrictEqual(result[0], { path: 'src/dup.ts', range: 'L1-L2', rev: 'rev1', anchorHash: 'hashX' });
  assert.deepStrictEqual(result[1], { path: 'src/other.ts', range: 'L1-L2', rev: 'rev1', anchorHash: 'hashX' });
});

test('extractAnchorInputs: an element with data-src but no data-anchor-hash produces AnchorInput with anchorHash: "" -- not filtered out, not thrown on', () => {
  const html = `<!doctype html><html><body>
    <div data-src="src/nohash.ts">no hash at all</div>
  </body></html>`;

  const result = extractAnchorInputs(html);

  assert.deepStrictEqual(result, [{ path: 'src/nohash.ts', anchorHash: '' }]);
});

test('extractAnchorInputs: an artifact with NO data-src anywhere returns an empty array', () => {
  const html = `<!doctype html><html><body><p>nothing anchored here</p></body></html>`;

  const result = extractAnchorInputs(html);

  assert.deepStrictEqual(result, []);
});

test('extractAnchorInputs: data-src appearing only as literal text inside <pre><code> (never a real parsed attribute) is NOT extracted', () => {
  const html = `<!doctype html><html><body>
    <pre><code>&lt;div data-src="ghost.ts" data-anchor-hash="ghosthash"&gt;&lt;/div&gt;</code></pre>
  </body></html>`;

  const result = extractAnchorInputs(html);

  assert.deepStrictEqual(result, []);
});
