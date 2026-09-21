import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTENT_TYPES } from '../../src/shared/intent.ts';
import { INTENT_MENU_ITEMS, labelFor } from '../../src/sdk/intent-picker.ts';

// --- INTENT_MENU_ITEMS: derived from INTENT_TYPES, never hand-duplicated ---

test('INTENT_MENU_ITEMS has exactly 5 entries', () => {
  assert.strictEqual(INTENT_MENU_ITEMS.length, 5);
});

test('INTENT_MENU_ITEMS is in INTENT_TYPES exact order -- derived, not hand-maintained', () => {
  assert.deepStrictEqual(
    INTENT_MENU_ITEMS.map((item) => item.intent),
    INTENT_TYPES,
  );
});

test('every INTENT_MENU_ITEMS entry carries a non-empty label', () => {
  for (const item of INTENT_MENU_ITEMS) {
    assert.ok(item.label.length > 0, `label for ${item.intent} must be non-empty`);
  }
});

// --- labelFor: exhaustive by construction, distinct + human-readable labels ---

test("labelFor('fix-artifact') and labelFor('fix-code') are distinct -- not visually confusable in a 5-item menu", () => {
  const fixArtifact = labelFor('fix-artifact');
  const fixCode = labelFor('fix-code');
  assert.notStrictEqual(fixArtifact, fixCode);
});

test('labelFor returns a non-empty, human-readable string for every INTENT_TYPES entry', () => {
  for (const intent of INTENT_TYPES) {
    const label = labelFor(intent);
    assert.ok(label.length > 0, `labelFor(${intent}) must be non-empty`);
  }
});

test("labelFor('fix-artifact') is non-empty and distinct from its own intent string", () => {
  const label = labelFor('fix-artifact');
  assert.ok(label.length > 0);
  assert.notStrictEqual(label, 'fix-artifact');
});
