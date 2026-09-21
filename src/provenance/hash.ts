import { createHash } from 'node:crypto';

// The A1 normalization boundary (locked decision). This function is the ONLY
// place line-ending/trailing-whitespace normalization happens in this codebase
// — never scatter a second `.replace(/[ \t]+$/` or CRLF-stripping regex
// elsewhere in `src/provenance/`. Phase 5's spike tunes this exact boundary
// later; keeping it isolated here is what lets that happen without a call-site
// refactor.
//
// Deliberately NOT touched: interior whitespace, indentation. A region
// re-indented from 2 spaces to 4 spaces must normalize to a DIFFERENT string.
export function normalizeAnchorRegion(raw: string): string {
  const lfOnly = raw.replace(/\r\n?/g, '\n');
  const lines = lfOnly.split('\n').map((line) => line.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

// SHA-256 truncated to 16 hex chars over the normalized region. Truncation is
// an accepted tradeoff (T-02-04): this hash is a relocation signal, not a
// tamper-evidence boundary — the real security boundary is path containment
// (confine.ts).
export function anchorHash(raw: string): string {
  return createHash('sha256').update(normalizeAnchorRegion(raw), 'utf8').digest('hex').slice(0, 16);
}
