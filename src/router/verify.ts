/**
 * EDU-07's deterministic pre-check: whether a dispatch's resolved source
 * gives a verifier anything to check a claim against AT ALL, decided by a
 * pure function, before any model is ever asked anything. The third
 * verdict state ('not-determinable' -- src/router/types.ts's `Verdict`) is
 * load-bearing: a verifier that can only ever answer SUPPORTED or
 * CONTRADICTED will confabulate one of those two when the anchor
 * genuinely resolved to no readable content. `isUngroundable` is what lets
 * a later plan (07-04's `handleCreateDispatch`) short-circuit that case
 * deterministically, with zero model calls and zero cost, instead of
 * dispatching a verify request no subagent could ever answer honestly.
 *
 * Zero dependencies beyond `DispatchSource`'s own type -- no I/O, no
 * imports beyond a type-only one, importable from anywhere `router/types.ts`
 * itself is.
 */

import type { DispatchTarget } from './types.ts';

/**
 * True when there is no readable resolved content to check a claim
 * against -- covers unanchored (`source === null`), and every `DriftState`
 * that yields no content: `'refused'` | `'no-git'` | `'cannot-determine'` |
 * `'lost'` (and `'unanchored'`, defensively, though that state implies
 * `source === null` already in this router's own real call path --
 * `buildDispatchEnvelope` never calls `resolve()` with a null anchor).
 *
 * Deliberately keyed on `source.content === null`, not on `source.status`
 * directly -- content-nullness is the actual thing that makes verification
 * impossible, and this stays correct even if a future `DriftState` is
 * added without this file being updated. This also means `'no-git'` is NOT
 * unconditionally ungroundable: `resolve()`'s own `no-git` path can still
 * read real working-tree content when the confined file exists and is
 * readable (only genuinely unreadable/out-of-bounds `no-git` cases yield
 * `content: null`) -- drifted-but-present content (`'touched'`/`'moved'`)
 * is likewise still groundable; staleness and groundability are different
 * axes, and this function must never conflate them.
 */
export function isUngroundable(targets: readonly DispatchTarget[]): boolean {
  // ADR-103: ungroundable only when EVERY selected section is. Refusing the
  // whole dispatch because one of five sections is unanchored would throw
  // away four readable files -- the same over-strictness ADR-001 removed.
  // An empty selection is vacuously ungroundable: there is nothing to read.
  return targets.every((t) => t.source === null || t.source.content === null);
}
