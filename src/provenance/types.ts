// Shared contracts for `src/provenance/`. Declarations only — no logic here.
// Every downstream module in this phase (git batch pool, git metadata, relocation,
// drift classification, identity, and the resolver entry point) imports these types
// rather than redefining its own shape for an anchor or a resolve result.

/**
 * The four-state drift model (ANCH-07), plus the operational states that sit
 * outside "drift" proper: `refused` (containment/grammar rejection), `no-git`
 * (path not inside any git repo), and `unanchored` (no anchor was present at all).
 */
export type DriftState =
  | 'unchanged'
  | 'moved'
  | 'touched'
  | 'lost'
  | 'cannot-determine'
  | 'refused'
  | 'no-git'
  | 'file-level'
  | 'unanchored';

/**
 * A parsed, validated anchor. `path` is always POSIX-relative to the repo root,
 * normalized on parse regardless of what the authoring agent emitted (Windows
 * backslash paths included). `rev: null` means the anchor is unpinned (A4) —
 * resolved against HEAD and ineligible for staleness classification.
 */
export type AnchorRef = {
  readonly path: string; // POSIX-relative to repo root, normalized on parse
  readonly startLine: number | null; // null when #Lx-Ly is absent (whole-file anchor)
  readonly endLine: number | null;
  readonly rev: string | null; // null => unpinned, resolve against HEAD
  readonly anchorHash: string; // mandatory, 16 hex chars (see hash.ts)
  readonly unpinned: boolean; // true iff rev === null
};

export type ParseAnchorResult =
  | { readonly ok: true; readonly anchor: AnchorRef }
  | { readonly ok: false; readonly reason: string };

export type ResolveResult = {
  readonly status: DriftState;
  readonly content: string | null;
  readonly resolvedRev: string | null; // actual rev content was read at (HEAD when unpinned)
  readonly resolvedRange: { readonly startLine: number; readonly endLine: number } | null;
  readonly eligibleForStaleness: boolean; // false when unpinned, refused, no-git, or unanchored
  readonly reason: string | null; // diagnostic detail for refused/cannot-determine/no-git
};
