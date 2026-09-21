// Re-anchors an artifact against the current commit.
//
// Replaces every `data-rev="AUTOREV"` with the short HEAD sha, then fills in
// each `data-anchor-hash="AUTO"` using illuminate's OWN hash authority
// (src/provenance/hash.ts) against the git blob at that rev -- the exact bytes
// the resolver will read. Run this after committing a change that touches an
// anchored file, then re-run check-anchors.mjs to prove 14/14 still resolve.
//
// Usage: node --experimental-strip-types .demo/stamp-anchors.mjs <artifact.html>
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { anchorHash } from '../src/provenance/hash.ts';

const file = process.argv[2];
if (!file) throw new Error('usage: stamp-anchors.mjs <artifact.html>');
let html = readFileSync(file, 'utf8');

const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();

// A dirty tree means the blobs at HEAD are not what the anchored prose was
// written against. Stamping anyway would bake in a hash for content that is
// about to change -- refuse rather than produce a plausible-looking lie.
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).trim();
if (dirty) {
  throw new Error(`refusing to stamp: src/ has uncommitted changes, so HEAD blobs are stale.\n${dirty}`);
}

html = html.replaceAll('AUTOREV', head);

// Mirrors drift.ts splitLines: strip one trailing newline, split on CRLF|LF.
function splitLines(text) {
  const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  return withoutTrailingNewline.split(/\r\n|\n/);
}

const ANCHORED = /data-src="([^"]+)"\s+data-rev="([0-9a-f]+)"\s+data-anchor-hash="AUTO"/g;
let stamped = 0;
const seen = [];

html = html.replace(ANCHORED, (whole, src, rev) => {
  const hashIdx = src.indexOf('#L');
  const path = hashIdx === -1 ? src : src.slice(0, hashIdx);
  const range = hashIdx === -1 ? null : src.slice(hashIdx + 2);

  const blob = execFileSync('git', ['show', `${rev}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = splitLines(blob);

  let region;
  if (range === null) {
    region = lines.join('\n');
  } else {
    const [a, b] = range.split('-L').map(Number);
    if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`bad range in ${src}`);
    if (a < 1 || b < a || b > lines.length) {
      throw new Error(`range ${src} out of bounds: file has ${lines.length} lines`);
    }
    region = lines.slice(a - 1, b).join('\n');
  }

  const h = anchorHash(region);
  stamped++;
  seen.push(`  ${src.padEnd(46)} ${h}`);
  return `data-src="${src}" data-rev="${rev}" data-anchor-hash="${h}"`;
});

if (/data-anchor-hash="AUTO"/.test(html)) {
  throw new Error('some AUTO anchors did not match the expected attribute order (data-src, data-rev, data-anchor-hash)');
}

writeFileSync(file, html);
console.log(`stamped ${stamped} anchors in ${file} at ${head}`);
console.log(seen.join('\n'));
