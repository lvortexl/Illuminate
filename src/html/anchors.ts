import { parse } from 'parse5';
import type { AnchorInput } from '../provenance/anchor.ts';
import { findAllByAttribute } from './detect.ts';

/** Reads one attribute's raw string value off a parse5 element, or undefined
 * when the attribute is absent -- a thin lookup, no grammar interpretation. */
function attrValue(el: ReturnType<typeof findAllByAttribute>[number], name: string): string | undefined {
  return el.attrs.find((attr) => attr.name === name)?.value;
}

/** The exact (path, range, rev, anchorHash) tuple this anchor cites, used as
 * a dedup key -- two elements citing the literal same anchor must not
 * double-count in the scan this function feeds. */
function dedupeKey(input: AnchorInput): string {
  return JSON.stringify([input.path, input.range ?? null, input.rev ?? null, input.anchorHash]);
}

/** Parses `html` with parse5 (sourceCodeLocationInfo NOT needed -- this
 * function only reads attribute values, never computes a splice offset,
 * unlike inject.ts) and returns one AnchorInput per element carrying
 * data-src, in document order, DEDUPLICATED by the exact (path, range,
 * rev, anchorHash) tuple (two elements citing literally the same anchor
 * must not double-count in the scan below). `data-anchor-hash`'s absence
 * becomes anchorHash: '' -- NOT filtered out here; parseAnchor
 * (src/provenance/anchor.ts) is the single place that already treats an
 * empty anchorHash as a grammar failure (ANCH-01), and resolve() already
 * turns that into `refused` -- this function does no grammar validation of
 * its own, mirroring anchor-read.ts's own "raw passthrough, not a resolved
 * anchor" discipline on the browser side. */
export function extractAnchorInputs(html: string): readonly AnchorInput[] {
  const doc = parse(html);
  const elements = findAllByAttribute(doc, 'data-src');

  const seen = new Set<string>();
  const result: AnchorInput[] = [];

  for (const el of elements) {
    // Split at the FIRST '#' exactly as src/sdk/snapshot.ts's
    // parseAnchorRangeFromSrc already does on the browser side (same
    // grammar, independently re-derived server-side per this codebase's
    // established Node/browser-boundary duplication convention -- the
    // browser file is never imported here, it carries DOM-lib assumptions
    // this module must not depend on). Unlike the browser side, the range
    // stays a raw string here -- AnchorInput.range is the raw "Lx-Ly"
    // suffix, not pre-parsed line numbers.
    const src = attrValue(el, 'data-src');
    if (src === undefined) continue; // findAllByAttribute already filtered to elements carrying this attribute
    const hashIndex = src.indexOf('#');
    const path = hashIndex === -1 ? src : src.slice(0, hashIndex);
    const range = hashIndex === -1 ? undefined : src.slice(hashIndex + 1);
    const rev = attrValue(el, 'data-rev');
    const anchorHash = attrValue(el, 'data-anchor-hash') ?? '';

    const input: AnchorInput = {
      path,
      anchorHash,
      ...(range !== undefined ? { range } : {}),
      ...(rev !== undefined ? { rev } : {}),
    };

    const key = dedupeKey(input);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(input);
  }

  return result;
}
