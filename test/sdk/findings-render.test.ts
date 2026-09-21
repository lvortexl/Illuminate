import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingStateForTarget, openFindings } from '../../src/sdk/findings-render.ts';
import type { WireFinding } from '../../src/sdk/protocol-in.ts';

const TARGET = { path: 'src/widget.ts', startLine: 1, endLine: 2 };

function finding(overrides: Partial<WireFinding> = {}): WireFinding {
  return {
    fingerprint: 'fp0000000000abcd',
    rule: 'drift-touched',
    target: TARGET,
    status: 'open',
    ...overrides,
  };
}

test('findingStateForTarget: returns null against an empty findings array', () => {
  assert.strictEqual(findingStateForTarget([], TARGET), null);
});

test("findingStateForTarget: a single open drift-touched finding at an exact-match target returns 'touched'", () => {
  const findings = [finding({ rule: 'drift-touched' })];
  assert.strictEqual(findingStateForTarget(findings, TARGET), 'touched');
});

test("findingStateForTarget: a single open drift-lost finding at an exact-match target returns 'lost'", () => {
  const findings = [finding({ rule: 'drift-lost' })];
  assert.strictEqual(findingStateForTarget(findings, TARGET), 'lost');
});

test('findingStateForTarget: a finding matching target.path but with a DIFFERENT startLine/endLine returns null -- range must match exactly, not just the path', () => {
  const findings = [finding({ target: { path: TARGET.path, startLine: 10, endLine: 20 } })];
  assert.strictEqual(findingStateForTarget(findings, TARGET), null);
});

test("findingStateForTarget: a resolved finding matching target exactly returns null -- only 'open' produces a marker", () => {
  const findings = [finding({ status: 'resolved' })];
  assert.strictEqual(findingStateForTarget(findings, TARGET), null);
});

test("findingStateForTarget: a dismissed finding matching target exactly returns null -- only 'open' produces a marker", () => {
  const findings = [finding({ status: 'dismissed' })];
  assert.strictEqual(findingStateForTarget(findings, TARGET), null);
});

test("findingStateForTarget: BOTH an open drift-touched and an open drift-lost finding for the SAME target (pathological, defensively handled) returns 'lost'", () => {
  const findings = [
    finding({ fingerprint: 'fp1111111111abcd', rule: 'drift-touched' }),
    finding({ fingerprint: 'fp2222222222abcd', rule: 'drift-lost' }),
  ];
  assert.strictEqual(findingStateForTarget(findings, TARGET), 'lost');
});

test('openFindings: returns only the open findings from a mixed array, in their original relative order', () => {
  const findings = [
    finding({ fingerprint: 'fp1', status: 'open' }),
    finding({ fingerprint: 'fp2', status: 'resolved' }),
    finding({ fingerprint: 'fp3', status: 'open' }),
    finding({ fingerprint: 'fp4', status: 'dismissed' }),
    finding({ fingerprint: 'fp5', status: 'open' }),
  ];
  assert.deepStrictEqual(
    openFindings(findings).map((f) => f.fingerprint),
    ['fp1', 'fp3', 'fp5'],
  );
});
