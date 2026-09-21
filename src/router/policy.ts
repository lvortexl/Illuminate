/**
 * ROUT-02's security invariant, realized: the router is a pure lookup table
 * keyed on typed browser intent, so model output can never select a role or
 * tier. `resolvePolicy` takes exactly one argument, typed `Intent` -- the
 * closed 5-value union declared at src/shared/intent.ts, the boundary
 * furthest from any model output (that file's own doc comment) -- and
 * returns the fixed `PolicyEntry` `POLICY_TABLE` maps it to. There is no
 * branching, no second parameter, and nothing here for injected repo
 * content to influence even in principle.
 *
 * ROUT-05's locked role/tier table, resolved 1:1 against the 5 Intent
 * values (REQUIREMENTS.md's exact wording governs over ARCHITECTURE.md's
 * illustrative depth-conditional table, which has no slot in the actual
 * 5-value Intent union):
 *   explain      -> tutor       / haiku
 *   verify       -> verifier    / sonnet
 *   deeper       -> researcher  / sonnet
 *   fix-artifact -> author      / sonnet
 *   fix-code     -> implementer / opus
 *
 * `Record<Intent, PolicyEntry>` is what TypeScript actually checks for
 * completeness: every key of the 5-value union must be present in this
 * object literal, or `tsc` errors. No `const exhaustive: never = ...`
 * narrowing anywhere -- that pattern requires assigning the narrowed OBJECT
 * itself to `never`, not re-reading a property off it, and isn't needed
 * here since `Record<Intent, PolicyEntry>` already enforces exhaustiveness
 * on the object literal.
 */

import type { Intent } from '../shared/intent.ts';
import type { PolicyEntry, Role } from './types.ts';

export const POLICY_TABLE: Record<Intent, PolicyEntry> = {
  explain: { role: 'tutor', tier: 'haiku' },
  verify: { role: 'verifier', tier: 'sonnet' },
  deeper: { role: 'researcher', tier: 'sonnet' },
  'fix-artifact': { role: 'author', tier: 'sonnet' },
  'fix-code': { role: 'implementer', tier: 'opus' },
};

export function resolvePolicy(intent: Intent): PolicyEntry {
  return POLICY_TABLE[intent];
}

/**
 * EDU-01's zero-tool guarantee, as data: `tutor` (the `explain` role) gets
 * `[]` -- ALWAYS, not "usually" -- so a zero-tool dispatch is provable on
 * the wire, not merely a prompt-template convention. `verifier`/
 * `researcher`/`author` are read-only (`Read`/`Grep`/`Glob`). `implementer`
 * is deliberately given `[]` here too, but this entry is INERT BY
 * CONSTRUCTION: `self-dispatch.ts`'s `role === 'implementer'` branch never
 * reads `envelope.tools` at all (it omits `--tools` from argv entirely,
 * giving that one role full, untouched tool access) -- this table's
 * `implementer` entry exists solely so `Record<Role, readonly string[]>`
 * type-checks as total over all 5 roles. Do NOT "fix" this into a
 * nonempty list expecting it to matter; it never will, for that role.
 * ROUT-02's purity is unaffected: this is a SEPARATE lookup from
 * `POLICY_TABLE`/`resolvePolicy` above, never folded into `PolicyEntry`.
 */
export const TOOLS_BY_ROLE: Record<Role, readonly string[]> = {
  tutor: [],
  verifier: ['Read', 'Grep', 'Glob'],
  researcher: ['Read', 'Grep', 'Glob'],
  author: ['Read', 'Grep', 'Glob'],
  implementer: [], // inert -- see doc comment above; self-dispatch.ts never reads this for 'implementer'.
};

export function toolsForRole(role: Role): readonly string[] {
  return TOOLS_BY_ROLE[role];
}
