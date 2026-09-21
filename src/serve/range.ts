import type { IncomingHttpHeaders } from 'node:http';

export interface ParsedRange {
  start: number;
  end: number;
}

export type RangeResult =
  | { kind: 'none' } // no Range header, malformed, or If-Range stale → full body
  | { kind: 'unsatisfiable' } // 416
  | { kind: 'range'; range: ParsedRange };

// Captures only the first range; any further comma-separated ranges are
// discarded. Multi-range (`multipart/byteranges`) requests are out of scope
// for the spike (locked decision A4) — served as a single range or a full 200.
const BYTES_RANGE = /^bytes=(\d*)-(\d*)(?:,.*)?$/;

/**
 * Parses a `Range: bytes=...` header against a known resource size. Never
 * throws on malformed/adversarial input — always resolves to a typed result
 * (a parser that throws would crash the request handler).
 */
export function parseRange(rangeHeader: string | undefined, size: number): RangeResult {
  if (!rangeHeader) return { kind: 'none' };
  const match = BYTES_RANGE.exec(rangeHeader.trim());
  if (!match) return { kind: 'none' }; // malformed → treat as absent

  const [, startStr, endStr] = match;
  if (startStr === undefined || endStr === undefined) return { kind: 'none' };
  if (startStr === '' && endStr === '') return { kind: 'none' }; // "bytes=-" is malformed

  let start: number;
  let end: number;

  if (startStr === '') {
    // suffix range: bytes=-500 → last 500 bytes
    const suffixLength = Number(endStr);
    if (suffixLength <= 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? size - 1 : Number(endStr);
  }

  if (start >= size || start > end) return { kind: 'unsatisfiable' };
  end = Math.min(end, size - 1); // clamp overshoot — only start >= size is unsatisfiable
  return { kind: 'range', range: { start, end } };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Decides whether a Range request should be honored, per If-Range semantics:
 * "only give me the range if the resource hasn't changed since I last saw
 * it; otherwise give me everything." Uses exact strong-string comparison for
 * ETags (no W/ tolerance) — deliberately not unified with isNotModified's
 * weak-tolerant comparison, because If-Range requires strong comparison per
 * RFC 7233.
 */
export function isRangeFresh(
  headers: IncomingHttpHeaders,
  etag: string,
  lastModified: Date,
): boolean {
  const ifRange = headerValue(headers['if-range']);
  if (!ifRange) return true; // no If-Range means Range is unconditionally honored
  if (ifRange === etag) return true; // strong comparison — exact match only, no W/ tolerance
  const ifRangeDate = new Date(ifRange);
  if (!isNaN(ifRangeDate.getTime())) {
    return Math.floor(lastModified.getTime() / 1000) <= Math.floor(ifRangeDate.getTime() / 1000);
  }
  return false; // unparseable If-Range value → treat as stale, serve full 200
}
