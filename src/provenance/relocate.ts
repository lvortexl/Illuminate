import type { GitBatchPool } from './git-batch-pool.ts';
import { parseDiffHunks } from './git-meta.ts';
import type { DiffHunk } from './git-meta.ts';
import { anchorHash } from './hash.ts';

// The two-stage content relocation ladder (ANCH-07). Stage A is a cheap
// diff-hunk line-shift, tried first and ALWAYS confirmed by an exact hash
// re-check before being trusted (`02-RESEARCH.md`, Content-Based Relocation,
// Stage A). Stage B is a bounded fuzzy line-similarity search, tried only
// when Stage A is inconclusive (an overlapping hunk, or a shift whose
// re-hash doesn't match).
//
// The two similarity thresholds below are the single highest-risk
// unverified numbers in this project (locked decision A2) — provisional by
// design, and Phase 5's validation spike measures and re-tunes them against
// real repository history. They exist as exactly these two named, exported
// constants and NOWHERE else in this file, so that spike can override them
// without touching a single call site below. A regression guard in
// `relocate.test.ts` enforces this by reading this file's own source text.

/** similarity >= this => a moved/touched candidate, never a silent "moved" from Stage B alone. */
export const RELOCATION_TOUCHED_THRESHOLD = 0.7 as const;
/** similarity < this (after Stage A is inconclusive) => "lost"; >= this falls into the cautious "touched" band. */
export const RELOCATION_LOST_THRESHOLD = 0.3 as const;

/**
 * Stage B's search cost bound (T-02-11): below this many lines, the whole
 * file is searched; above it, the search is clamped to a fixed-size window
 * centered on the anchor's original position, preventing an unbounded
 * O(file-size squared) scan against a pathologically large committed file.
 */
export const WINDOWED_SEARCH_WHOLE_FILE_LIMIT = 2000 as const;

// Stage B's window-size tolerance around the anchor's original line count —
// an implementation detail of the search bound, not one of the two risk
// thresholds above, so it is not exported.
const SEARCH_SIZE_TOLERANCE_RATIO = 0.2;

type Range = { readonly startLine: number; readonly endLine: number };

type RelocateResult =
  | { readonly state: 'moved'; readonly newRange: Range; readonly confirmed: true }
  | { readonly state: 'touched'; readonly newRange: Range | null }
  | { readonly state: 'lost' };

/**
 * Splits blob text into 1-indexed lines matching git's own line numbering:
 * a single trailing line terminator (the near-universal case for a
 * committed text file) is dropped rather than counted as a trailing empty
 * line. Deliberately not routed through `normalizeAnchorRegion` — that
 * function collapses trailing whitespace and blank edge lines for HASHING
 * purposes; this is plain line splitting for indexing into file content by
 * line number, a different job.
 */
function splitLines(text: string): string[] {
  const withoutTrailingNewline = text.replace(/\r\n$|\n$/, '');
  return withoutTrailingNewline.split(/\r\n|\n/);
}

/**
 * Direct dynamic-programming LCS length over two line arrays (O(n*m) time,
 * O(m) space via a rolling row) — not an imported diff library, per this
 * phase's zero-new-npm-dependency constraint.
 */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j]!;
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j]!, row[j - 1]!);
      diag = temp;
    }
  }
  return row[b.length]!;
}

/**
 * Line-based similarity ratio between two line arrays: the LCS length
 * (order-preserving common lines) divided by the LONGER of the two arrays'
 * lengths. Using the longer array as the denominator (rather than the
 * candidate window's own size) means shrinking a candidate window can never
 * inflate its score relative to the best-fitting window — it can only ever
 * match or lose ground. Isolated as its own exported function so Phase 5 can
 * unit-test or swap it independently of the ladder's orchestration logic
 * below.
 */
export function lineSimilarity(a: readonly string[], b: readonly string[]): number {
  const denom = Math.max(a.length, b.length);
  if (denom === 0) return 1;
  return lcsLength(a, b) / denom;
}

/**
 * `true` iff a diff hunk (in OLD-file line coordinates) touches the given
 * range at all — a real edit candidate inside the cited region, per
 * `02-RESEARCH.md`'s Stage A description, that must never be resolved by
 * line-shift arithmetic alone. A pure insertion (`oldLines === 0`) has no
 * old-side span of its own; it only counts as touching the range when its
 * insertion point falls strictly inside it, not merely adjacent above or
 * below (the "insert 50 lines above" case is deliberately NOT an overlap).
 */
function hunkOverlapsRange(hunk: DiffHunk, range: Range): boolean {
  if (hunk.oldLines === 0) {
    return hunk.oldStart >= range.startLine && hunk.oldStart < range.endLine;
  }
  const hunkEnd = hunk.oldStart + hunk.oldLines - 1;
  return hunk.oldStart <= range.endLine && range.startLine <= hunkEnd;
}

/**
 * Stage A: parses the unified-diff hunks between `dataRev` and `headRev`,
 * and — only if NONE of them overlap `originalRange` — computes the shifted
 * range by summing `(newLines - oldLines)` across every hunk that starts
 * entirely before `originalRange.startLine`. The shifted candidate is then
 * fetched from `headRev` and re-hashed with the SAME `anchorHash` used at
 * authoring time; only an exact match is trusted. Returns `null` (never a
 * verdict of its own) whenever the line-shift math cannot be trusted, so the
 * caller falls through to Stage B.
 */
async function tryStageA(
  pool: GitBatchPool,
  repoRoot: string,
  relPath: string,
  dataRev: string,
  headRev: string,
  originalRange: Range,
  originalHash: string,
): Promise<RelocateResult | null> {
  const hunks = parseDiffHunks(repoRoot, dataRev, headRev, relPath);
  if (hunks.some((hunk) => hunkOverlapsRange(hunk, originalRange))) return null;

  let delta = 0;
  for (const hunk of hunks) {
    if (hunk.oldStart < originalRange.startLine) {
      delta += hunk.newLines - hunk.oldLines;
    }
  }

  const shifted: Range = {
    startLine: originalRange.startLine + delta,
    endLine: originalRange.endLine + delta,
  };
  if (shifted.startLine < 1 || shifted.endLine < shifted.startLine) return null;

  const headBlob = await pool.contents(`${headRev}:${relPath}`);
  if (!headBlob.found) return null;
  const headLines = splitLines(headBlob.content.toString('utf8'));
  if (shifted.endLine > headLines.length) return null;

  const candidateText = headLines.slice(shifted.startLine - 1, shifted.endLine).join('\n');
  if (anchorHash(candidateText) !== originalHash) return null;

  return { state: 'moved', newRange: shifted, confirmed: true };
}

/** The line range Stage B is allowed to scan, bounded per `WINDOWED_SEARCH_WHOLE_FILE_LIMIT` (T-02-11). */
function searchBounds(totalLines: number, centerLine: number): { from: number; to: number } {
  if (totalLines <= WINDOWED_SEARCH_WHOLE_FILE_LIMIT) {
    return { from: 1, to: totalLines };
  }
  const half = Math.floor(WINDOWED_SEARCH_WHOLE_FILE_LIMIT / 2);
  const from = Math.max(1, centerLine - half);
  const to = Math.min(totalLines, from + WINDOWED_SEARCH_WHOLE_FILE_LIMIT);
  return { from, to };
}

/**
 * Stage B: fetches the original anchored text at `dataRev` (always
 * resolvable — a historical blob) and the full current content at
 * `headRev`, then searches a bounded window of the current content for a
 * contiguous span of lines matching the original. An exact normalized-hash
 * match at a DIFFERENT position is a confirmed silent move; otherwise the
 * best-scoring window (line-based similarity) decides `touched` vs `lost`.
 * Per `02-RESEARCH.md`'s Four-State Model table, EVERY fuzzy (unconfirmed)
 * match — from the high-similarity band at/above `RELOCATION_TOUCHED_THRESHOLD`
 * down through the ambiguous middle band — resolves to the SAME cautious
 * `touched`, never a silently-promoted `moved`; a byte-identical relocation
 * is always caught earlier by the exact-hash pass above, which is the only
 * path that can produce `moved` out of Stage B. Both bands are still split
 * into their own `if` below (rather than one combined bound check) so
 * `RELOCATION_TOUCHED_THRESHOLD` is an actual, exercised branch condition —
 * not merely a declared, unreferenced constant — should a future change
 * (e.g. Phase 5's validation spike, `05-04-PLAN.md`) need to give the two
 * bands different treatment without restructuring this function.
 */
async function stageB(
  pool: GitBatchPool,
  relPath: string,
  dataRev: string,
  headRev: string,
  originalRange: Range,
  originalHash: string,
): Promise<RelocateResult> {
  const originalBlob = await pool.contents(`${dataRev}:${relPath}`);
  if (!originalBlob.found) return { state: 'lost' };
  const originalLines = splitLines(originalBlob.content.toString('utf8')).slice(
    originalRange.startLine - 1,
    originalRange.endLine,
  );

  const currentBlob = await pool.contents(`${headRev}:${relPath}`);
  if (!currentBlob.found) return { state: 'lost' };
  const currentLines = splitLines(currentBlob.content.toString('utf8'));

  const n = originalLines.length;
  const { from, to } = searchBounds(currentLines.length, originalRange.startLine);

  // Priority pass: an exact normalized-hash match, at the anchor's original
  // line count, anywhere in the search bound — a confirmed silent move.
  for (let start = from; start + n - 1 <= to; start++) {
    const windowLines = currentLines.slice(start - 1, start - 1 + n);
    if (anchorHash(windowLines.join('\n')) === originalHash) {
      return { state: 'moved', newRange: { startLine: start, endLine: start + n - 1 }, confirmed: true };
    }
  }

  // Fuzzy pass: best line-similarity score across windows sized within
  // tolerance of the original line count.
  const minSize = Math.max(1, Math.floor(n * (1 - SEARCH_SIZE_TOLERANCE_RATIO)));
  const maxSize = Math.ceil(n * (1 + SEARCH_SIZE_TOLERANCE_RATIO));

  let best: { score: number; range: Range } | null = null;
  for (let size = minSize; size <= maxSize; size++) {
    for (let start = from; start + size - 1 <= to; start++) {
      const windowLines = currentLines.slice(start - 1, start - 1 + size);
      const score = lineSimilarity(originalLines, windowLines);
      if (best === null || score > best.score) {
        best = { score, range: { startLine: start, endLine: start + size - 1 } };
      }
    }
  }

  if (best === null || best.score < RELOCATION_LOST_THRESHOLD) {
    return { state: 'lost' };
  }
  if (best.score >= RELOCATION_TOUCHED_THRESHOLD) {
    // High similarity, but a fuzzy Stage B match is never trusted enough on
    // its own to report a silent "moved" (see this file's top-of-file block
    // comment and the two constants' own doc comments above). A
    // byte-identical relocation is already caught by the exact-hash
    // priority pass above and never reaches here.
    return { state: 'touched', newRange: best.range };
  }
  // Ambiguous middle band (RELOCATION_LOST_THRESHOLD <= score <
  // RELOCATION_TOUCHED_THRESHOLD): the same cautious default as the
  // high-similarity band above, per A2's asymmetry — a wrongly-silent
  // "moved" verdict is worse than one extra passive "touched" marker.
  return { state: 'touched', newRange: best.range };
}

/**
 * Resolves an anchored region's current location within the same file
 * between `dataRev` (where the anchor was authored) and `headRev` (current).
 * Tries Stage A first; only falls through to Stage B when Stage A cannot
 * confirm its result. See the Stage A/B functions above for the full
 * decision tree.
 */
export async function relocateWithinFile(
  pool: GitBatchPool,
  repoRoot: string,
  relPath: string,
  dataRev: string,
  headRev: string,
  originalRange: Range,
  originalHash: string,
): Promise<RelocateResult> {
  const stageAResult = await tryStageA(pool, repoRoot, relPath, dataRev, headRev, originalRange, originalHash);
  if (stageAResult) return stageAResult;
  return stageB(pool, relPath, dataRev, headRev, originalRange, originalHash);
}
