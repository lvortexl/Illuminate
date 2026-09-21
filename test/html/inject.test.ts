import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { injectScriptTag } from '../../src/html/inject.ts';
import { detectBaseHref, detectAuthorCsp } from '../../src/html/detect.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '../fixtures/artifacts');

const ALL_FIXTURES = [
  'body-in-script.html',
  'body-in-pre-code.html',
  'body-in-comment.html',
  'body-in-srcdoc.html',
  'body-in-style.html',
  'no-body-tag.html',
  'base-href.html',
  'author-csp-meta.html',
  'bom-crlf.html',
  'quirky-mutations.html',
];

// The 5 fixtures whose ONLY purpose is to carry a decoy `</body>`-shaped
// substring ahead of the real closing tag -- a naive `.replace(/<\/body>/i, …)`
// (the reference implementation's actual bug, PITFALLS.md #5) would match the
// decoy, not the real thing.
const DECOY_FIXTURES = [
  'body-in-script.html',
  'body-in-pre-code.html',
  'body-in-comment.html',
  'body-in-srcdoc.html',
  'body-in-style.html',
];

const SCRIPT_URL = 'http://127.0.0.1:4319/sdk.js';
const SCRIPT_TAG = `<script src="${SCRIPT_URL}"></script>`;

function fixturePath(name: string): string {
  return join(FIXTURES_DIR, name);
}

function readFixture(name: string): string {
  return readFileSync(fixturePath(name), 'utf8');
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

// ---------------------------------------------------------------------------
// Task 1: detectBaseHref / detectAuthorCsp
// ---------------------------------------------------------------------------

test('detectBaseHref is true only for base-href.html', () => {
  for (const name of ALL_FIXTURES) {
    const expected = name === 'base-href.html';
    assert.strictEqual(detectBaseHref(readFixture(name)), expected, name);
  }
});

test('detectAuthorCsp is true only for author-csp-meta.html', () => {
  for (const name of ALL_FIXTURES) {
    const expected = name === 'author-csp-meta.html';
    assert.strictEqual(detectAuthorCsp(readFixture(name)), expected, name);
  }
});

test('a plain fixture (no <base>, no CSP meta) reports both detectors false', () => {
  const html = readFixture('body-in-comment.html');
  assert.strictEqual(detectBaseHref(html), false);
  assert.strictEqual(detectAuthorCsp(html), false);
});

test('detectAuthorCsp is case-insensitive on the http-equiv attribute value', () => {
  const lower =
    '<!doctype html><html><head>' +
    '<meta http-equiv="content-security-policy" content="default-src \'self\'">' +
    '</head><body></body></html>';
  const upper =
    '<!doctype html><html><head>' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">' +
    '</head><body></body></html>';
  assert.strictEqual(detectAuthorCsp(lower), true);
  assert.strictEqual(detectAuthorCsp(upper), true);
});

// ---------------------------------------------------------------------------
// Task 2: injectScriptTag -- splice precision, fallback ladder, absolute-URL
// guard, warnings, and the no-serialize source-text regression
// ---------------------------------------------------------------------------

test('injectScriptTag locates the REAL </body> across all 5 decoy fixtures, never a decoy', () => {
  for (const name of DECOY_FIXTURES) {
    const original = readFixture(name);
    const occurrences = allIndicesOf(original, '</body>');
    assert.ok(
      occurrences.length >= 2,
      `${name}: expected at least one decoy plus the real </body>, found ${occurrences.length}`,
    );
    const decoyPositions = occurrences.slice(0, -1);
    const realPosition = occurrences[occurrences.length - 1];

    const result = injectScriptTag(original, SCRIPT_URL);
    const insertedAt = result.html.indexOf(SCRIPT_TAG);
    assert.notStrictEqual(insertedAt, -1, `${name}: injected tag not found in output`);

    for (const decoyPosition of decoyPositions) {
      assert.ok(
        insertedAt > decoyPosition,
        `${name}: injected tag at ${insertedAt} must be after decoy at ${decoyPosition}`,
      );
    }
    // The tag is spliced in immediately before the real </body> -- its start
    // offset in the (unmodified-up-to-that-point) output string is exactly
    // where the real </body> used to start in the original.
    assert.strictEqual(
      insertedAt,
      realPosition,
      `${name}: injected tag must land exactly at the real </body> position`,
    );
  }
});

test('injectScriptTag on no-body-tag.html appends at the end without losing content', () => {
  const original = readFixture('no-body-tag.html');
  const result = injectScriptTag(original, SCRIPT_URL);
  assert.strictEqual(result.html, original + SCRIPT_TAG);
  assert.ok(result.html.startsWith(original));
});

test('injectScriptTag preserves quirky-mutations.html verbatim aside from the inserted tag', () => {
  const original = readFixture('quirky-mutations.html');
  const result = injectScriptTag(original, SCRIPT_URL);
  assert.strictEqual(result.html.replace(SCRIPT_TAG, ''), original);

  // Direct regression against the five mutations STACK.md measured
  // parse5.serialize() making: unquoted attr requoted, single-quoted attr
  // requoted, boolean attr given ="", unclosed <br> closed, self-closing
  // <svg><path/> expanded. None of these can happen via a string splice, but
  // assert the literal substrings survive anyway.
  assert.ok(result.html.includes('<body class=x data-a>'), 'unquoted/boolean attrs must survive verbatim');
  assert.ok(result.html.includes("<meta charset='utf-8'>"), 'single-quoted attr must survive verbatim');
  assert.ok(result.html.includes('<br>there'), 'unclosed <br> must survive verbatim');
  assert.ok(result.html.includes('<path d="M0 0"/>'), 'self-closing <path/> must survive verbatim');
});

test('injectScriptTag preserves the leading BOM and every CRLF in bom-crlf.html', () => {
  const original = readFixture('bom-crlf.html');
  const result = injectScriptTag(original, SCRIPT_URL);
  assert.strictEqual(result.html.charCodeAt(0), 0xfeff, 'leading BOM character (U+FEFF) must survive');
  const originalCrlfCount = (original.match(/\r\n/g) ?? []).length;
  const resultCrlfCount = (result.html.match(/\r\n/g) ?? []).length;
  assert.strictEqual(resultCrlfCount, originalCrlfCount, 'CRLF count must be unchanged');
  assert.strictEqual(result.html.replace(SCRIPT_TAG, ''), original);
});

test('golden: removing the single inserted tag reconstructs every fixture byte-for-byte', () => {
  for (const name of ALL_FIXTURES) {
    const original = readFixture(name);
    const result = injectScriptTag(original, SCRIPT_URL);
    const occurrences = result.html.split(SCRIPT_TAG).length - 1;
    assert.strictEqual(occurrences, 1, `${name}: expected exactly one injected tag, found ${occurrences}`);
    assert.strictEqual(
      result.html.replace(SCRIPT_TAG, ''),
      original,
      `${name}: removing the tag did not reconstruct the original`,
    );
  }
});

test('injectScriptTag throws on a non-absolute (root-relative) scriptUrl', () => {
  const original = readFixture('base-href.html');
  assert.throws(() => injectScriptTag(original, '/sdk.js'));
});

test('injectScriptTag does not throw on absolute http:// or https:// scriptUrl', () => {
  const original = readFixture('base-href.html');
  assert.doesNotThrow(() => injectScriptTag(original, 'http://127.0.0.1:4319/sdk.js'));
  assert.doesNotThrow(() => injectScriptTag(original, 'https://127.0.0.1:4319/sdk.js'));
});

test('injectScriptTag warnings: base-href.html carries a base-href warning', () => {
  const result = injectScriptTag(readFixture('base-href.html'), SCRIPT_URL);
  assert.deepStrictEqual(result.warnings, ['base-href']);
});

test('injectScriptTag warnings: author-csp-meta.html carries a csp-meta warning', () => {
  const result = injectScriptTag(readFixture('author-csp-meta.html'), SCRIPT_URL);
  assert.deepStrictEqual(result.warnings, ['csp-meta']);
});

test('injectScriptTag warnings: a plain fixture carries no warnings', () => {
  const result = injectScriptTag(readFixture('body-in-comment.html'), SCRIPT_URL);
  assert.deepStrictEqual(result.warnings, []);
});

test('source-text regression: parse5 serialize is never referenced in src/html/', () => {
  const injectSource = readFileSync(join(HERE, '../../src/html/inject.ts'), 'utf8');
  const detectSource = readFileSync(join(HERE, '../../src/html/detect.ts'), 'utf8');
  assert.ok(!injectSource.includes('serialize'), 'inject.ts must never reference serialize');
  assert.ok(!detectSource.includes('serialize'), 'detect.ts must never reference serialize');
});

// ---------------------------------------------------------------------------
// Task 3: golden byte-equality proof + disk-never-mutated guarantee
// ---------------------------------------------------------------------------

test('injectScriptTag never mutates the fixture file on disk', () => {
  for (const name of ALL_FIXTURES) {
    const path = fixturePath(name);
    const before = readFileSync(path);
    injectScriptTag(readFileSync(path, 'utf8'), SCRIPT_URL);
    const after = readFileSync(path);
    assert.ok(before.equals(after), `${name}: disk bytes changed after calling injectScriptTag`);
  }
});

test('golden byte-equality against the Buffer read from disk, not just the in-memory string', () => {
  for (const name of ALL_FIXTURES) {
    const path = fixturePath(name);
    const diskBuffer = readFileSync(path);
    const original = readFileSync(path, 'utf8');
    const result = injectScriptTag(original, SCRIPT_URL);
    const reconstructed = Buffer.from(result.html.replace(SCRIPT_TAG, ''), 'utf8');
    assert.ok(reconstructed.equals(diskBuffer), `${name}: reconstructed bytes do not match the bytes on disk`);
  }
});

test('injectScriptTag is stateless: repeated calls on the same original never accumulate', () => {
  const original = readFixture('body-in-comment.html');
  const urlA = 'http://127.0.0.1:4319/sdk.js';
  const urlB = 'https://127.0.0.1:5000/other.js';
  const tagA = `<script src="${urlA}"></script>`;
  const tagB = `<script src="${urlB}"></script>`;

  const resultA = injectScriptTag(original, urlA);
  const resultB = injectScriptTag(original, urlB);

  assert.strictEqual(resultA.html.split(tagA).length - 1, 1);
  assert.strictEqual(resultA.html.includes(tagB), false);
  assert.strictEqual(resultA.html.replace(tagA, ''), original);

  assert.strictEqual(resultB.html.split(tagB).length - 1, 1);
  assert.strictEqual(resultB.html.includes(tagA), false);
  assert.strictEqual(resultB.html.replace(tagB, ''), original);
});
