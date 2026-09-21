import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findBodyCloseOffset } from '../../src/html/detect.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '../fixtures/artifacts');

// The 5 fixtures whose ONLY purpose is to carry a decoy `</body>`-shaped
// substring ahead of the real closing tag -- mirrors test/html/inject.test.ts's
// own DECOY_FIXTURES list, reused here to prove the offset math directly
// against `findBodyCloseOffset`, not just indirectly through `injectScriptTag`.
const DECOY_FIXTURES = [
  'body-in-script.html',
  'body-in-pre-code.html',
  'body-in-comment.html',
  'body-in-srcdoc.html',
  'body-in-style.html',
];

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

function allIndicesOf(haystack: string, needle: string): number[] {
  const indices: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    indices.push(at);
    from = at + 1;
  }
  return indices;
}

test('findBodyCloseOffset on a document with an explicit </body> returns that tag\'s start offset', () => {
  const html = '<!doctype html><html><head></head><body><p>hi</p></body></html>';
  const offset = findBodyCloseOffset(html);
  assert.strictEqual(html.slice(offset, offset + '</body>'.length), '</body>');
});

test('findBodyCloseOffset on a document with no explicit </body> (implied close) returns html.length', () => {
  const original = readFixture('no-body-tag.html');
  assert.strictEqual(findBodyCloseOffset(original), original.length);
});

test('findBodyCloseOffset locates the REAL </body> across all 5 decoy fixtures, never a decoy', () => {
  for (const name of DECOY_FIXTURES) {
    const html = readFixture(name);
    const occurrences = allIndicesOf(html, '</body>');
    assert.ok(
      occurrences.length >= 2,
      `${name}: expected at least one decoy plus the real </body>, found ${occurrences.length}`,
    );
    const decoyPositions = occurrences.slice(0, -1);
    const realPosition = occurrences[occurrences.length - 1];

    const offset = findBodyCloseOffset(html);

    assert.strictEqual(offset, realPosition, `${name}: offset must land exactly at the real </body> position`);
    for (const decoyPosition of decoyPositions) {
      assert.notStrictEqual(offset, decoyPosition, `${name}: offset must never land at a decoy </body> position`);
    }
  }
});

test('findBodyCloseOffset is stateless: repeated calls on the same input return the same offset', () => {
  const html = readFixture('body-in-comment.html');
  const first = findBodyCloseOffset(html);
  const second = findBodyCloseOffset(html);
  assert.strictEqual(first, second);
});

test('source-text regression: parse5 serialize is never referenced in detect.ts', () => {
  const detectSource = readFileSync(join(HERE, '../../src/html/detect.ts'), 'utf8');
  assert.ok(!detectSource.includes('serialize'), 'detect.ts must never reference serialize');
});
