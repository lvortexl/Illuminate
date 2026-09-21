/// <reference lib="dom" />
// See addressing.ts's own top-of-file comment for why this directive is
// needed here too: this file is imported both by tsconfig.browser.json
// (lib: DOM) and, transitively, by test/sdk/snapshot.test.ts under the
// root tsconfig.json (lib: ES2022, no DOM).

import type { ElementSnapshot } from '../provenance/identity.ts';
import { walkChain, buildSelector, truncateText } from './addressing.ts';
import { readAnchorAttributes } from './anchor-read.ts';

// Duplicated-by-design from src/provenance/anchor.ts's RANGE_PATTERN --
// anchor.ts imports node:fs (via confine.ts) and cannot be bundled into the
// browser SDK (the opaque-origin constraint: the SDK has no filesystem).
// Same grammar (`^L(\d+)-L(\d+)$`), same 1-indexed semantics -- if that
// grammar ever changes, BOTH copies must change together; there is no
// single source of truth across the Node/browser boundary for this one
// regex.
const RANGE_PATTERN = /^L(\d+)-L(\d+)$/;

/** Splits a `data-src` value ("path#Lx-Ly" or bare "path") into the shape
 * `ElementSnapshot.anchor` wants. A missing or malformed range degrades to
 * a whole-file anchor (null start/end) rather than throwing -- this
 * function has no access to a server-side "refused" state to report
 * through. */
export function parseAnchorRangeFromSrc(src: string): {
  readonly path: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
} {
  const hashIndex = src.indexOf('#');
  if (hashIndex === -1) {
    return { path: src, startLine: null, endLine: null };
  }

  const path = src.slice(0, hashIndex);
  const range = src.slice(hashIndex + 1);
  const match = RANGE_PATTERN.exec(range);
  if (!match) {
    return { path, startLine: null, endLine: null };
  }

  return { path, startLine: Number(match[1]), endLine: Number(match[2]) };
}

// Budget per direction for prefix/suffix sibling-text context -- small on
// purpose: this is disambiguation context for tier 3's text-quote match,
// not a second copy of the element's own content.
const CONTEXT_BUDGET = 40;

/** Walks sibling nodes outward from `start` (in the direction `next`
 * advances), concatenating trimmed textContent until either CONTEXT_BUDGET
 * characters are collected or siblings run out. Returns null when no text
 * is found in that direction at all (e.g. the element is the only child of
 * its parent). Private to this file -- no existing SDK code computes
 * prefix/suffix context today. */
function collectSiblingContext(
  start: ChildNode | null,
  next: (node: ChildNode) => ChildNode | null,
  prepend: boolean,
): string | null {
  const pieces: string[] = [];
  let collectedLength = 0;
  let node = start;
  while (node && collectedLength < CONTEXT_BUDGET) {
    const text = (node.textContent ?? '').trim();
    if (text) {
      pieces.push(text);
      collectedLength += text.length;
    }
    node = next(node);
  }

  if (pieces.length === 0) return null;

  const joined = prepend ? pieces.reverse().join(' ') : pieces.join(' ');
  return prepend ? joined.slice(-CONTEXT_BUDGET) : joined.slice(0, CONTEXT_BUDGET);
}

/** Builds an ElementSnapshot from a LIVE DOM element -- the browser-side
 * counterpart to identity.ts's synthetic, tested-in-isolation snapshots.
 * `textContent` is truncated with the SAME 240-char default index.ts's
 * wire payload already uses -- the stored snapshot must match what the
 * wire truncates to, or tier-3 text-quote matching would compare a full
 * string against a truncated one and never match. `anchor` reuses
 * anchor-read.ts's existing readAnchorAttributes (no new attribute-reading
 * logic), then parseAnchorRangeFromSrc splits its `src` into the
 * {path, startLine, endLine} shape ElementSnapshot.anchor wants.
 * `elementUid` is always null -- a documented v1 limitation: no
 * `data-illum-id` authoring convention exists yet. */
export function computeElementSnapshot(el: Element): ElementSnapshot {
  const structuralPath = buildSelector(walkChain(el));
  const textContent = truncateText((el.textContent ?? '').trim());
  const rawAnchor = readAnchorAttributes(el.getAttribute.bind(el));
  const anchor = rawAnchor ? parseAnchorRangeFromSrc(rawAnchor.src) : null;

  return {
    elementUid: null,
    anchor,
    textContent,
    prefixContext: collectSiblingContext(el.previousSibling, (n) => n.previousSibling, true),
    suffixContext: collectSiblingContext(el.nextSibling, (n) => n.nextSibling, false),
    structuralPath,
  };
}
