import type { GitBatchPool } from './git-batch-pool.ts';
import type { AnchorRef, DriftState } from './types.ts';
import { detectRename } from './git-meta.ts';
import { relocateWithinFile } from './relocate.ts';
import { anchorHash } from './hash.ts';

// The four-state drift classifier (ANCH-06/ANCH-07) — the CORE subset of
// `02-RESEARCH.md`'s Four-State Model mapping table: revision reachable,
// working tree clean, path confined, git available. Those pre-checks are
// Plan 09's `resolve.ts` concern, applied BEFORE `classifyDrift` is ever
// called; this module never re-derives them and never produces `refused`,
// `no-git`, or `unanchored` — only `unchanged` / `moved` / `touched` /
// `lost` / `cannot-determine`.

type Range = { readonly startLine: number; readonly endLine: number };

type ClassifyResult = {
  readonly state: DriftState;
  readonly resolvedRange: Range | null;
  readonly content: string | null;
};

/**
 * Splits blob text into 1-indexed lines matching git's own numbering — a
 * private copy of `relocate.ts`'s identical helper (not exported there).
 * Deliberately not routed through `normalizeAnchorRegion` (hash.ts's A1
 * boundary): that function is for HASHING, not for indexing into content by
 * line number.
 */
function splitLines(text: string): string[] {
  const withoutTrailingNewline = text.replace(/\r\n$|\n$/, '');
  return withoutTrailingNewline.split(/\r\n|\n/);
}

/**
 * Resolves the anchor's concrete original range. When both `startLine` and
 * `endLine` are supplied, returns them unchanged — this is the path every
 * case in this plan's Task 1 suite exercises. When either is `null` (a
 * whole-file anchor, per `types.ts`'s own documented semantics: "null when
 * #Lx-Ly is absent"), the cited region is the entire file AS IT STOOD AT
 * `dataRev` — resolved via one extra blob fetch, never against `headRev`'s
 * (possibly different) line count, since `relocateWithinFile`'s diff-hunk
 * math is expressed in `dataRev`-relative line coordinates. Not one of this
 * plan's named cases (every one supplies a concrete range); handled here
 * only so `classifyDrift` is total over `AnchorRef`'s actual (nullable)
 * shape rather than throwing on a legal input.
 */
async function resolveOriginalRange(
  pool: GitBatchPool,
  relPath: string,
  dataRev: string,
  startLine: number | null,
  endLine: number | null,
): Promise<Range | null> {
  if (startLine !== null && endLine !== null) {
    return { startLine, endLine };
  }
  const dataBlob = await pool.contents(`${dataRev}:${relPath}`);
  if (!dataBlob.found) return null;
  const lines = splitLines(dataBlob.content.toString('utf8'));
  return { startLine: 1, endLine: lines.length };
}

/** Fetches `relPath`@`rev` and slices it to `range`, bound-checked BEFORE the slice; `null` on any miss. */
async function contentAt(pool: GitBatchPool, rev: string, relPath: string, range: Range): Promise<string | null> {
  const blob = await pool.contents(`${rev}:${relPath}`);
  if (!blob.found) return null;
  const lines = splitLines(blob.content.toString('utf8'));
  if (range.startLine < 1 || range.endLine < range.startLine || range.endLine > lines.length) return null;
  return lines.slice(range.startLine - 1, range.endLine).join('\n');
}

/**
 * Delegates to `relocateWithinFile` (same `relPath` at both revisions — its
 * "within the same file" contract) and maps its 3-state result onto this
 * module's 4-state-plus-`cannot-determine` vocabulary, fetching the current
 * content at whatever range it resolved to. Shared by the in-bounds-mismatch
 * and out-of-bounds branches below — both are same-path calls, never a
 * renamed path (see `classifyMissingAtHead`, which handles renames
 * separately because `relocateWithinFile` assumes a single stable path).
 */
async function relocateAndMap(
  pool: GitBatchPool,
  repoRoot: string,
  relPath: string,
  dataRev: string,
  headRev: string,
  originalRange: Range,
  originalHash: string,
): Promise<ClassifyResult> {
  const outcome = await relocateWithinFile(pool, repoRoot, relPath, dataRev, headRev, originalRange, originalHash);
  if (outcome.state === 'moved') {
    const content = await contentAt(pool, headRev, relPath, outcome.newRange);
    return { state: 'moved', resolvedRange: outcome.newRange, content };
  }
  if (outcome.state === 'touched') {
    const content = outcome.newRange ? await contentAt(pool, headRev, relPath, outcome.newRange) : null;
    return { state: 'touched', resolvedRange: outcome.newRange, content };
  }
  return { state: 'lost', resolvedRange: null, content: null };
}

/**
 * Handles the case where the anchored path does not resolve at `headRev` at
 * all. Consults `detectRename` (git-meta.ts) BEFORE ever calling the file
 * lost — per this plan's `key_links`, rename detection is always consulted
 * first. `relocateWithinFile` is deliberately NOT reused here even for the
 * `single` case: it assumes the SAME `relPath` exists at both `dataRev` and
 * `headRev` (its own doc comment: "within the same file"), which is false
 * once the path itself has changed — reusing it naively against the new
 * path would feed it a `dataRev` blob lookup at a path that never existed
 * there, corrupting Stage A/B's own logic. Instead this compares the SAME
 * original line range at the renamed destination directly via `anchorHash`
 * — the identical comparison primitive Stage A/B use internally, per this
 * plan's "reuse... rather than duplicating comparison logic" instruction —
 * without re-running the full same-file ladder.
 */
async function classifyMissingAtHead(
  pool: GitBatchPool,
  repoRoot: string,
  relPath: string,
  dataRev: string,
  headRev: string,
  originalRange: Range,
  originalHash: string,
): Promise<ClassifyResult> {
  const rename = detectRename(repoRoot, dataRev, headRev, relPath);

  if (rename.kind === 'ambiguous') {
    // ANCH-07: never guess between candidates. See this plan's SUMMARY for
    // the documented limitation on constructing a fixture that reaches this
    // branch via real `git diff --name-status` output on git 2.53 (Plan
    // 04's finding, reconfirmed here) — implemented to spec regardless.
    return { state: 'cannot-determine', resolvedRange: null, content: null };
  }
  if (rename.kind === 'none') {
    return { state: 'lost', resolvedRange: null, content: null };
  }

  // rename.kind === 'single'
  const newBlob = await pool.contents(`${headRev}:${rename.newPath}`);
  if (!newBlob.found) {
    // Defensive: git's own rename detection named a destination that cat-file
    // can no longer resolve. Never seen in practice; treated conservatively
    // as lost rather than guessed.
    return { state: 'lost', resolvedRange: null, content: null };
  }
  const newLines = splitLines(newBlob.content.toString('utf8'));
  const fitsAtSamePosition = originalRange.startLine >= 1 && originalRange.endLine <= newLines.length;
  const candidateText = fitsAtSamePosition
    ? newLines.slice(originalRange.startLine - 1, originalRange.endLine).join('\n')
    : null;

  if (candidateText !== null && anchorHash(candidateText) === originalHash) {
    return { state: 'moved', resolvedRange: originalRange, content: candidateText };
  }
  // Renamed AND changed (content edited, or shifted within the renamed
  // file) — the file positively exists at the renamed destination, so this
  // is never reported as `lost`, only the more cautious `touched`.
  return { state: 'touched', resolvedRange: originalRange, content: candidateText };
}

/**
 * Classifies an anchored region's drift between `dataRev` (authoring time)
 * and `headRev` (current) against real git history for `repoRoot`. Never
 * throws on a malformed or out-of-bounds range — every failure mode maps to
 * an explicit state, per ANCH-07.
 */
export async function classifyDrift(
  pool: GitBatchPool,
  repoRoot: string,
  anchor: Pick<AnchorRef, 'path' | 'startLine' | 'endLine' | 'anchorHash'>,
  dataRev: string,
  headRev: string,
): Promise<ClassifyResult> {
  const originalRange = await resolveOriginalRange(pool, anchor.path, dataRev, anchor.startLine, anchor.endLine);
  if (originalRange === null) {
    return { state: 'cannot-determine', resolvedRange: null, content: null };
  }

  const headBlob = await pool.contents(`${headRev}:${anchor.path}`);

  if (!headBlob.found) {
    return classifyMissingAtHead(pool, repoRoot, anchor.path, dataRev, headRev, originalRange, anchor.anchorHash);
  }

  const headLines = splitLines(headBlob.content.toString('utf8'));
  const inBounds =
    originalRange.startLine >= 1 &&
    originalRange.endLine >= originalRange.startLine &&
    originalRange.endLine <= headLines.length;

  if (!inBounds) {
    // Bound-checked BEFORE any slice (ANCH-07's out-of-bounds case): the
    // content may still have moved even though the original line numbers no
    // longer fit the shrunk file, so this delegates to the same relocation
    // ladder rather than assuming `lost` outright.
    return relocateAndMap(pool, repoRoot, anchor.path, dataRev, headRev, originalRange, anchor.anchorHash);
  }

  const candidateText = headLines.slice(originalRange.startLine - 1, originalRange.endLine).join('\n');
  if (anchorHash(candidateText) === anchor.anchorHash) {
    return { state: 'unchanged', resolvedRange: originalRange, content: candidateText };
  }

  return relocateAndMap(pool, repoRoot, anchor.path, dataRev, headRev, originalRange, anchor.anchorHash);
}
