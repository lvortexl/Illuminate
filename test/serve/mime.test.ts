import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mimeFor } from '../../src/serve/mime.ts';

// The fixture table mirrors RESEARCH.md §6.1 exactly — every entry must
// resolve to its documented Content-Type, including the charset suffixes
// the table specifies.
const FIXTURES: Array<[string, string]> = [
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.avif', 'image/avif'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.pdf', 'application/pdf'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.wasm', 'application/wasm'],
];

test('every fixture extension returns its exact documented Content-Type', () => {
  for (const [ext, expected] of FIXTURES) {
    assert.strictEqual(mimeFor(`asset${ext}`), expected, `mismatch for ${ext}`);
  }
});

test('an unknown extension returns application/octet-stream, not a guess', () => {
  assert.strictEqual(mimeFor('asset.xyz'), 'application/octet-stream');
});

test('extension matching is case-insensitive', () => {
  assert.strictEqual(mimeFor('IMAGE.PNG'), mimeFor('image.png'));
  assert.strictEqual(mimeFor('IMAGE.PNG'), 'image/png');
});
