import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHADOW_CSS } from '../../src/sdk/shadow-style.ts';

// STACK.md's self-contained, zero-network constraint -- checkable at the
// string level (not just by code review) so a regression fails a fast unit
// test rather than waiting on the Playwright suite.

test('SHADOW_CSS is a non-empty string', () => {
  assert.strictEqual(typeof SHADOW_CSS, 'string');
  assert.ok(SHADOW_CSS.length > 0);
});

test('SHADOW_CSS contains the :host{all: initial} artifact-isolation reset', () => {
  assert.ok(SHADOW_CSS.includes(':host { all: initial'));
});

test('SHADOW_CSS contains no @import', () => {
  assert.ok(!SHADOW_CSS.includes('@import'));
});

test('SHADOW_CSS contains no url(', () => {
  assert.ok(!SHADOW_CSS.includes('url('));
});
