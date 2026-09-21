import type { IntentAnchor } from '../shared/intent.ts';

/**
 * Reads data-src/data-rev/data-anchor-hash as raw passthrough strings -- NOT
 * a resolved, validated anchor (that is Phase 2's resolver, which the SDK
 * cannot import: it runs on an opaque origin with no filesystem/git --
 * ARCHITECTURE.md Part 0). `getAttribute` is duck-typed so this stays
 * Node-testable with a plain closure; boot.ts/index.ts pass
 * `el.getAttribute.bind(el)` for the real DOM case.
 *
 * REVERSAL (06-01-PLAN.md): Phase 4 originally did NOT read data-anchor-hash
 * here -- "ANCH-01 validation is Phase 2/6 resolver territory, not the SDK."
 * That was correct for Phase 4's scope, but src/provenance/anchor.ts's
 * parseAnchor treats anchorHash as MANDATORY: without it, every real anchor
 * this SDK ever emitted would resolve to `refused`. This function now reads
 * data-anchor-hash unconditionally (still just a passthrough string, still
 * no validation) so Phase 6's router has something resolvable to send.
 */
export function readAnchorAttributes(getAttribute: (name: string) => string | null): IntentAnchor | null {
  const src = getAttribute('data-src');
  if (!src) return null;
  return { src, rev: getAttribute('data-rev'), anchorHash: getAttribute('data-anchor-hash') };
}
