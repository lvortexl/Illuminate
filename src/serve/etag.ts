import type { Stats } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * A strong ETag derived from (size, mtimeMs) — never weak (no `W/` prefix).
 * This is non-negotiable: Range/If-Range validation requires strong
 * comparison per RFC 7233, and a weak ETag would make Range support
 * spec-non-compliant.
 */
export function strongEtag(stat: Pick<Stats, 'size' | 'mtimeMs'>): string {
  const size = stat.size.toString(16);
  const mtime = Math.floor(stat.mtimeMs).toString(16);
  return `"${size}-${mtime}"`;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Decides whether the requester already holds a fresh copy (→ 304), per the
 * If-None-Match / If-Modified-Since conditional-GET rules. If-None-Match
 * takes precedence over If-Modified-Since when both are present — if it's
 * present and doesn't match, If-Modified-Since is not consulted (MDN).
 */
export function isNotModified(
  headers: IncomingHttpHeaders,
  etag: string,
  lastModified: Date,
): boolean {
  const ifNoneMatch = headerValue(headers['if-none-match']);
  if (ifNoneMatch) {
    // If-None-Match may be a comma-separated list, or "*"
    if (ifNoneMatch === '*') return true;
    const tags = ifNoneMatch.split(',').map((t) => t.trim());
    return tags.includes(etag) || tags.includes(`W/${etag}`);
  }
  const ifModifiedSince = headerValue(headers['if-modified-since']);
  if (ifModifiedSince) {
    const since = new Date(ifModifiedSince);
    // HTTP-date has 1-second resolution — truncate both sides before comparing.
    return Math.floor(lastModified.getTime() / 1000) <= Math.floor(since.getTime() / 1000);
  }
  return false;
}
