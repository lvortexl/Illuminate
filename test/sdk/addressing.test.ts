import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSelector, buildUid, truncateText } from '../../src/sdk/addressing.ts';
import type { AncestorStep } from '../../src/sdk/addressing.ts';

// --- buildSelector ---

test('buildSelector joins a chain of nth-of-type steps with " > "', () => {
  const chain: AncestorStep[] = [
    { tag: 'body', nthOfType: 1, id: null },
    { tag: 'section', nthOfType: 2, id: null },
    { tag: 'div', nthOfType: 1, id: null },
  ];
  assert.strictEqual(buildSelector(chain), 'body > section:nth-of-type(2) > div:nth-of-type(1)');
});

test('a step with a non-null id renders as tag#id and drops :nth-of-type(...)', () => {
  const chain: AncestorStep[] = [
    { tag: 'body', nthOfType: 1, id: null },
    { tag: 'section', nthOfType: 2, id: 'main' },
  ];
  assert.strictEqual(buildSelector(chain), 'body > section#main');
});

test('buildSelector([]) returns the empty string, never throws', () => {
  assert.strictEqual(buildSelector([]), '');
});

// --- buildUid ---

test('buildUid is deterministic -- same inputs, called twice, return identical strings', () => {
  const a = buildUid('body > section:nth-of-type(2)', 'some text');
  const b = buildUid('body > section:nth-of-type(2)', 'some text');
  assert.strictEqual(a, b);
});

test('buildUid is sensitive to its selector input -- different selector, different hash', () => {
  const a = buildUid('body > section:nth-of-type(2)', 'some text');
  const b = buildUid('body > section:nth-of-type(3)', 'some text');
  assert.notStrictEqual(a, b);
});

test('buildUid is sensitive to its text input -- different text, different hash', () => {
  const a = buildUid('body > section:nth-of-type(2)', 'some text');
  const b = buildUid('body > section:nth-of-type(2)', 'other text');
  assert.notStrictEqual(a, b);
});

test('buildUid is prefixed with el_', () => {
  assert.ok(buildUid('a', 'b').startsWith('el_'));
});

// --- truncateText ---

test('truncateText truncates to exactly 240 characters by default', () => {
  const long = 'x'.repeat(500);
  const result = truncateText(long);
  assert.strictEqual(result.length, 240);
});

test('truncateText leaves short text unchanged', () => {
  assert.strictEqual(truncateText('short'), 'short');
});

test('truncateText respects an explicit maxLength override', () => {
  const long = 'x'.repeat(500);
  assert.strictEqual(truncateText(long, 10).length, 10);
});
