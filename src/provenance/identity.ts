import type { AnchorRef } from './types.ts';

// DELIBERATE ZERO IMPORT FROM GIT PLUMBING (hash.ts / confine.ts / anchor.ts /
// git-batch-pool.ts / git-meta.ts / relocate.ts / drift.ts). Element identity
// answers a different question than the resolver: "is this the same HTML
// element after the authoring agent regenerated the artifact from scratch",
// not "what code does this element describe" (that is provenance, resolved
// against git). See 02-RESEARCH.md, "Stable Element Identity and Orphan
// Handling" — conflating the two is the most likely design mistake in this
// phase. The only shared contract is AnchorRef, used below purely as an
// equality shape for tier 2 of the fallback chain.

/**
 * A snapshot of one rendered HTML element, taken either before or after an
 * artifact regeneration, carrying every signal the priority-ordered
 * fallback chain (tiers 1-4) needs to decide whether it is "the same"
 * element in the new snapshot.
 */
export type ElementSnapshot = {
  readonly elementUid: string | null; // data-illum-id, if the authoring agent preserved it
  readonly anchor: Pick<AnchorRef, 'path' | 'startLine' | 'endLine'> | null; // data-src + range, if present
  readonly textContent: string;
  readonly prefixContext: string | null; // text immediately before, for disambiguation
  readonly suffixContext: string | null;
  readonly structuralPath: string; // e.g. "body>div:nth-child(2)>p:nth-child(1)"
};

/**
 * A record of an element that failed to re-attach at a given revision.
 * Never removed once created (ANCH-05, "never silently delete") — only
 * ever appended or updated in place by `reattach`.
 */
export type OrphanRecord = {
  readonly element: ElementSnapshot;
  readonly firstMissRevision: string;
  readonly lastMissRevision: string;
  readonly confirmedOrphan: boolean; // true once a SECOND miss at a DIFFERENT revision has occurred
};

type AnchorShape = Pick<AnchorRef, 'path' | 'startLine' | 'endLine'>;

function anchorsOverlap(a: AnchorShape, b: AnchorShape): boolean {
  if (a.path !== b.path) return false;
  if (a.startLine === null || a.endLine === null || b.startLine === null || b.endLine === null) {
    // A whole-file anchor (no range) is treated as overlapping anything in
    // the same path — it carries no range information to disambiguate with.
    return true;
  }
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Tier 3 of the fallback chain, isolated as its own named seam (mirroring
 * the pattern relocate.ts, Plan 07, uses for its own fuzzy-matching logic) —
 * exact match of `textContent` after trivial whitespace collapse, not a
 * similarity score, disambiguated by prefix/suffix context when multiple
 * candidates tie on text alone. There is no Phase-5-tunable numeric
 * threshold here; v1 is exact-after-collapse by design.
 */
export function textQuoteMatch(
  before: ElementSnapshot,
  candidates: readonly ElementSnapshot[],
): ElementSnapshot | null {
  const beforeText = normalizeWhitespace(before.textContent);
  const textMatches = candidates.filter(
    (candidate) => normalizeWhitespace(candidate.textContent) === beforeText,
  );

  if (textMatches.length === 1) {
    const [only] = textMatches;
    return only ?? null;
  }
  if (textMatches.length > 1) {
    const contextMatches = textMatches.filter(
      (candidate) =>
        candidate.prefixContext === before.prefixContext &&
        candidate.suffixContext === before.suffixContext,
    );
    if (contextMatches.length === 1) {
      const [only] = contextMatches;
      return only ?? null;
    }
  }

  return null;
}

function matchElement(
  before: ElementSnapshot,
  after: readonly ElementSnapshot[],
): ElementSnapshot | null {
  // Tier 1: element_uid, exact match. Short-circuits the rest of the chain
  // WHEN it finds a candidate. A miss here (uid absent from `after` — e.g.
  // the authoring agent didn't preserve it) falls through rather than
  // orphaning the element outright.
  if (before.elementUid !== null) {
    const tier1 = after.find((candidate) => candidate.elementUid === before.elementUid);
    if (tier1) return tier1;
  }

  // Tier 2: anchor equality (path + overlapping range). Only confident with
  // EXACTLY one candidate — ambiguity (e.g. a file split in two, both citing
  // the same original range) falls through rather than guessing.
  const beforeAnchor = before.anchor;
  if (beforeAnchor !== null) {
    const tier2Candidates = after.filter(
      (candidate) => candidate.anchor !== null && anchorsOverlap(beforeAnchor, candidate.anchor),
    );
    if (tier2Candidates.length === 1) {
      const [only] = tier2Candidates;
      if (only) return only;
    }
  }

  // Tier 3: text-quote match — see textQuoteMatch().
  const tier3 = textQuoteMatch(before, after);
  if (tier3) return tier3;

  // Tier 4: structural selector — weakest signal, last resort before orphan.
  const tier4Candidates = after.filter(
    (candidate) => candidate.structuralPath === before.structuralPath,
  );
  if (tier4Candidates.length === 1) {
    const [only] = tier4Candidates;
    if (only) return only;
  }

  return null;
}

/**
 * Re-anchors each element in `before` against the `after` snapshot using the
 * priority-ordered fallback chain (element_uid -> anchor equality ->
 * text-quote -> structural selector -> orphan). Elements that cannot be
 * matched at any tier become orphans, accumulated on top of `priorOrphans`
 * (never removed by this function — see OrphanRecord).
 */
export function reattach(
  before: readonly ElementSnapshot[],
  after: readonly ElementSnapshot[],
  revision: string,
  priorOrphans: readonly OrphanRecord[] = [],
): {
  readonly matched: ReadonlyMap<ElementSnapshot, ElementSnapshot>;
  readonly orphans: readonly OrphanRecord[];
} {
  const matched = new Map<ElementSnapshot, ElementSnapshot>();

  // Seed the working store from priorOrphans so every entry the caller has
  // ever accumulated survives this call regardless of whether it is
  // re-examined below (never-delete, ANCH-05).
  const orphanByElement = new Map<ElementSnapshot, OrphanRecord>();
  for (const record of priorOrphans) {
    orphanByElement.set(record.element, record);
  }

  for (const element of before) {
    const match = matchElement(element, after);
    if (match) {
      matched.set(element, match);
      // NOTE: if `element` already has a stale OrphanRecord (it re-matched,
      // most likely via tier 1's element_uid, after a prior miss), that
      // record is intentionally left in place rather than cleared here.
      // Clearing orphan status on re-match is the obvious next extension —
      // out of scope for this plan, not a silent gap.
      continue;
    }

    const existing = orphanByElement.get(element);
    if (!existing) {
      orphanByElement.set(element, {
        element,
        firstMissRevision: revision,
        lastMissRevision: revision,
        confirmedOrphan: false,
      });
      continue;
    }

    if (existing.lastMissRevision === revision) {
      // Same revision already recorded for this element — an idempotent
      // re-check, not a new miss. Leave the record untouched.
      continue;
    }

    // A miss at a genuinely new revision. Two DIFFERENT revisions with a
    // miss is what promotes confidence to "confirmed" (ANCH-05's two-strikes
    // detection discipline) — the record is updated in place, never removed.
    orphanByElement.set(element, {
      element,
      firstMissRevision: existing.firstMissRevision,
      lastMissRevision: revision,
      confirmedOrphan: existing.confirmedOrphan || existing.firstMissRevision !== revision,
    });
  }

  return { matched, orphans: [...orphanByElement.values()] };
}

/** orphaned_count / previously_attached_count, per re-attachment run (ANCH-05). */
export function computeOrphanRate(previouslyAttachedCount: number, orphanedCount: number): number {
  if (previouslyAttachedCount <= 0) return 0;
  return orphanedCount / previouslyAttachedCount;
}
