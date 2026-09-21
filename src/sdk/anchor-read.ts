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

/**
 * Reads `data-files` -- one section citing SEVERAL files.
 *
 * Deliberately hash-less: each listed path grounds at the file-level tier
 * (`resolve()`'s `file-level` status), which is the entire point. Asking an
 * author to stamp a content hash per file would put the ritual back that made
 * grounding fail in ordinary artifacts, and a list of files is a coarser
 * claim than a pinned region anyway -- the weaker tier is the honest one for
 * it. An author who wants drift detection on a specific region still uses
 * `data-src` with a hash; the two are different claims, not two spellings of
 * one.
 *
 * Each entry may carry its own `#Lx-Ly` range, exactly like `data-src` --
 * `splitAnchorSrc` (router/envelope.ts) does the same split for both, so the
 * grammar is shared rather than re-specified here.
 *
 * Empty entries are dropped rather than rejected: a trailing comma in a
 * hand-written attribute is a typo, not a reason to silently unground the
 * whole section.
 */
export function readFileList(getAttribute: (name: string) => string | null): IntentAnchor[] {
  const raw = getAttribute('data-files');
  if (!raw) return [];
  const rev = getAttribute('data-rev');
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((src) => ({ src, rev, anchorHash: null }));
}
