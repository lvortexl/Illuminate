import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mimeFor } from './mime.ts';
import { strongEtag, isNotModified } from './etag.ts';
import { parseRange, isRangeFresh } from './range.ts';

/**
 * Wiring order (Plan 01-07 must call these in this order):
 *
 *   Host check (isAllowedHost) -> path resolution (resolveAssetPath) -> serveAsset
 *
 * `serveAsset` assumes `filePath` has already passed `resolveAssetPath` in
 * containment.ts — it does NOT re-check containment, dotfile denial, or the
 * Host allowlist itself. It is only safe to call on a `{ kind: 'ok' }`
 * containment result, on a request that already passed `isAllowedHost`.
 */
export async function serveAsset(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
): Promise<void> {
  const stats = await stat(filePath);
  const etag = strongEtag(stats);
  const lastModified = stats.mtime;

  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', lastModified.toUTCString());
  res.setHeader('Content-Type', mimeFor(filePath));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');

  if (isNotModified(req.headers, etag, lastModified)) {
    res.statusCode = 304;
    res.end();
    return;
  }

  const rangeHeaderRaw = req.headers['range'];
  const rangeHeader = Array.isArray(rangeHeaderRaw) ? rangeHeaderRaw[0] : rangeHeaderRaw;
  const rangeFresh = isRangeFresh(req.headers, etag, lastModified);
  const rangeResult = rangeFresh ? parseRange(rangeHeader, stats.size) : { kind: 'none' as const };

  if (rangeResult.kind === 'unsatisfiable') {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${stats.size}`);
    res.end();
    return;
  }

  if (rangeResult.kind === 'range') {
    const { start, end } = rangeResult.range;
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Length', String(stats.size));
  createReadStream(filePath).pipe(res);
}
