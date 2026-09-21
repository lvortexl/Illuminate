import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolvePolicy, toolsForRole, TOOLS_BY_ROLE } from '../../src/router/policy.ts';
import { INTENT_TYPES } from '../../src/shared/intent.ts';
import { ROLES } from '../../src/router/types.ts';
import type { Intent } from '../../src/shared/intent.ts';
import type { PolicyEntry } from '../../src/router/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY_SOURCE_PATH = join(HERE, '..', '..', 'src', 'router', 'policy.ts');

// ---------------------------------------------------------------------------
// Task 1 (RED -> GREEN): resolvePolicy's five locked mappings, ROUT-05's
// exact wording resolved 1:1 against the 5 Intent values. One assertion per
// intent, spelled out individually here (Task 2 below adds the table-driven
// loop over the same locked mapping, from an independently-declared source,
// so a single typo can't pass both).
// ---------------------------------------------------------------------------

test('resolvePolicy(explain) resolves to tutor/haiku', () => {
  assert.deepStrictEqual(resolvePolicy('explain'), { role: 'tutor', tier: 'haiku' });
});

test('resolvePolicy(verify) resolves to verifier/sonnet', () => {
  assert.deepStrictEqual(resolvePolicy('verify'), { role: 'verifier', tier: 'sonnet' });
});

test('resolvePolicy(deeper) resolves to researcher/sonnet', () => {
  assert.deepStrictEqual(resolvePolicy('deeper'), { role: 'researcher', tier: 'sonnet' });
});

test('resolvePolicy(fix-artifact) resolves to author/sonnet', () => {
  assert.deepStrictEqual(resolvePolicy('fix-artifact'), { role: 'author', tier: 'sonnet' });
});

test('resolvePolicy(fix-code) resolves to implementer/opus', () => {
  assert.deepStrictEqual(resolvePolicy('fix-code'), { role: 'implementer', tier: 'opus' });
});

// ---------------------------------------------------------------------------
// Task 2, part 1: exhaustiveness, table-driven -- mirrors drift.ts's
// "exhaustively table-tested" precedent (src/provenance/drift.test.ts). One
// loop over INTENT_TYPES (imported from shared/intent.ts, never
// hand-duplicated), checked against LOCKED_MAPPING below -- an
// independently-declared source of truth, not read off POLICY_TABLE itself
// (which would make this test a tautology that could never catch a typo
// shared by both).
// ---------------------------------------------------------------------------

const LOCKED_MAPPING: Record<Intent, PolicyEntry> = {
  explain: { role: 'tutor', tier: 'haiku' },
  verify: { role: 'verifier', tier: 'sonnet' },
  deeper: { role: 'researcher', tier: 'sonnet' },
  'fix-artifact': { role: 'author', tier: 'sonnet' },
  'fix-code': { role: 'implementer', tier: 'opus' },
};

test('resolvePolicy is exhaustive over every INTENT_TYPES value, matching the locked mapping', () => {
  for (const intent of INTENT_TYPES) {
    assert.deepStrictEqual(resolvePolicy(intent), LOCKED_MAPPING[intent], `mismatch for intent "${intent}"`);
  }
});

// ---------------------------------------------------------------------------
// 07-01: toolsForRole -- EDU-01's zero-tool guarantee, as data. A SEPARATE
// lookup from resolvePolicy/POLICY_TABLE above (this file's own doc
// comment), never folded into PolicyEntry.
// ---------------------------------------------------------------------------

test("toolsForRole('tutor') returns [] -- EDU-01's zero-tool dispatch", () => {
  assert.deepStrictEqual(toolsForRole('tutor'), []);
});

test("toolsForRole returns ['Read', 'Grep', 'Glob'] for verifier/researcher/author", () => {
  for (const role of ['verifier', 'researcher', 'author'] as const) {
    assert.deepStrictEqual(toolsForRole(role), ['Read', 'Grep', 'Glob'], `mismatch for role "${role}"`);
  }
});

test('TOOLS_BY_ROLE is total over every ROLES value -- no role silently falls through to an unresolved lookup', () => {
  for (const role of ROLES) {
    const tools: readonly string[] = TOOLS_BY_ROLE[role];
    assert.ok(Array.isArray(tools), `TOOLS_BY_ROLE must have a real array entry for role "${role}"`);
  }
});

// ---------------------------------------------------------------------------
// Task 2, part 2: signature-purity, source-text -- the actual ROUT-02 proof
// this plan owns. Reads src/router/policy.ts's own source text (not its
// runtime behavior) and asserts, by regex, that resolvePolicy's declared
// signature is exactly `(intent: Intent): PolicyEntry`, and that no other
// exported function in the file takes a parameter shaped like model- or
// content-derived input -- catching a future author who adds a second
// "helper" export that takes extra context, not just a signature change to
// resolvePolicy itself.
// ---------------------------------------------------------------------------

const RESOLVE_POLICY_SIGNATURE = /export function resolvePolicy\(intent: Intent\): PolicyEntry \{/;
/** Excludes `toolsForRole` by name (07-01): it is a deliberate, SEPARATE,
 * pure lookup from an ALREADY-CLOSED `Role` value (itself only ever
 * produced by `resolvePolicy` from a typed `Intent`) to a fixed tool list --
 * it never influences role/tier SELECTION (ROUT-02's actual concern), only
 * what an already-selected role is allowed to touch. A future "helper"
 * that takes role/model/content/source/anchor to help DECIDE role or tier
 * is still caught by this scan. */
const SUSPICIOUS_EXPORTED_PARAM = /export function (?!toolsForRole\()\w+\([^)]*\b(content|source|anchor|model|role)\b/;

test("source-text: resolvePolicy's declared signature takes exactly one argument, typed Intent", () => {
  const source = readFileSync(POLICY_SOURCE_PATH, 'utf8');
  assert.match(
    source,
    RESOLVE_POLICY_SIGNATURE,
    'resolvePolicy must be declared as `export function resolvePolicy(intent: Intent): PolicyEntry` -- ' +
      'any other parameter list (a second argument, a widened type, a default value) reopens ROUT-02.',
  );
});

test('source-text: no exported function in src/router/policy.ts takes a content/source/anchor/model/role-shaped parameter', () => {
  const source = readFileSync(POLICY_SOURCE_PATH, 'utf8');
  assert.strictEqual(
    SUSPICIOUS_EXPORTED_PARAM.test(source),
    false,
    'a future "helper" export taking extra context (content/source/anchor/model/role) would let resolved ' +
      'repo content or model output influence role/tier selection -- ROUT-02 forbids this by construction.',
  );
});
