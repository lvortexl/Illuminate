import { extname } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
};

const DEFAULT_MIME = 'application/octet-stream';

/**
 * Looks up the Content-Type for a file path by extension. Matching is
 * case-insensitive. An extension outside the table returns the generic
 * octet-stream type rather than guessing — a wrong specific MIME type
 * (e.g. mislabeling a .otf as .ttf) is worse than an honest generic one.
 */
export function mimeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  return MIME[ext] ?? DEFAULT_MIME;
}
