import type { AnchorRef, ParseAnchorResult } from './types.ts';
import { confineToRepoRoot } from './confine.ts';

// Already-split grammar components — extracting `data-src`/`data-rev`/
// `data-anchor-hash` from a raw HTML attribute is Phase 3/4's concern
// (serving/injection), not this module's. This module validates the
// components, normalizes the path, enforces containment, and produces a
// typed AnchorRef.
export type AnchorInput = {
  readonly path: string;
  readonly range?: string;
  readonly rev?: string;
  readonly anchorHash: string;
};

const RANGE_PATTERN = /^L(\d+)-L(\d+)$/;

export function parseAnchor(repoRoot: string, input: AnchorInput): ParseAnchorResult {
  // anchorHash is the one mandatory field (ANCH-01) — its absence is a parse
  // failure, never a degraded-but-valid anchor.
  if (!input.anchorHash) {
    return { ok: false, reason: 'data-anchor-hash is mandatory and was empty or missing' };
  }

  let startLine: number | null = null;
  let endLine: number | null = null;
  if (input.range !== undefined) {
    const match = RANGE_PATTERN.exec(input.range);
    if (!match) {
      return { ok: false, reason: `malformed range "${input.range}": expected "Lx-Ly"` };
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start < 1) {
      return {
        ok: false,
        reason: `malformed range "${input.range}": lines are 1-indexed, got L${String(start)}`,
      };
    }
    if (end < start) {
      return {
        ok: false,
        reason: `malformed range "${input.range}": end line ${String(end)} precedes start line ${String(start)}`,
      };
    }
    startLine = start;
    endLine = end;
  }

  // Windows backslash paths are normalized BEFORE containment is checked
  // (Pitfall 7) — a backslash-form path must never reach a git pathspec or
  // get persisted.
  const normalizedPath = input.path.replace(/\\/g, '/');

  // Containment refusal is reported distinctly from a grammar error so the
  // caller (Plan 09's resolve.ts) can map it to `refused` rather than a
  // generic parse failure.
  if (confineToRepoRoot(repoRoot, normalizedPath) === null) {
    return { ok: false, reason: 'path escapes repo root' };
  }

  const rev = input.rev ?? null;

  const anchor: AnchorRef = {
    path: normalizedPath,
    startLine,
    endLine,
    rev,
    anchorHash: input.anchorHash,
    unpinned: rev === null,
  };
  return { ok: true, anchor };
}
