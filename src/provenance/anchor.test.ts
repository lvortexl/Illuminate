import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAnchor } from './anchor.ts';

function makeRepoRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'illuminate-anchor-root-')));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'src', 'main'));
  writeFileSync(join(root, 'src', 'main', 'engine.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, 'file.txt'), 'hello\n');
  return root;
}

const HASH = 'abcdef0123456789';

test('parseAnchor: a full anchor parses to ok:true with unpinned:false', () => {
  const root = makeRepoRoot();
  const result = parseAnchor(root, {
    path: 'file.txt',
    range: 'L1-L1',
    rev: 'HEAD',
    anchorHash: HASH,
  });
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  assert.strictEqual(result.anchor.path, 'file.txt');
  assert.strictEqual(result.anchor.startLine, 1);
  assert.strictEqual(result.anchor.endLine, 1);
  assert.strictEqual(result.anchor.rev, 'HEAD');
  assert.strictEqual(result.anchor.anchorHash, HASH);
  assert.strictEqual(result.anchor.unpinned, false);
});

test('parseAnchor (A4): rev omitted parses successfully with unpinned:true and rev:null', () => {
  const root = makeRepoRoot();
  const result = parseAnchor(root, { path: 'file.txt', anchorHash: HASH });
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  assert.strictEqual(result.anchor.rev, null);
  assert.strictEqual(result.anchor.unpinned, true);
});

test('parseAnchor: range omitted parses successfully as a whole-file anchor', () => {
  const root = makeRepoRoot();
  const result = parseAnchor(root, { path: 'file.txt', rev: 'HEAD', anchorHash: HASH });
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  assert.strictEqual(result.anchor.startLine, null);
  assert.strictEqual(result.anchor.endLine, null);
});

test('parseAnchor: anchorHash omitted is a parse failure', () => {
  const root = makeRepoRoot();
  const result = parseAnchor(root, { path: 'file.txt', rev: 'HEAD', anchorHash: '' });
  assert.strictEqual(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /hash/i);
});

test('parseAnchor: malformed range (endLine < startLine) is a parse failure with a reason', () => {
  const root = makeRepoRoot();
  const result = parseAnchor(root, { path: 'file.txt', range: 'L10-L2', anchorHash: HASH });
  assert.strictEqual(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /range/i);
});

test('parseAnchor: malformed range (non-numeric) is a parse failure with a reason', () => {
  const root = makeRepoRoot();
  const result = parseAnchor(root, { path: 'file.txt', range: 'Lx-Ly', anchorHash: HASH });
  assert.strictEqual(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /range/i);
});

test('parseAnchor: malformed range (L0, 1-indexed grammar) is a parse failure with a reason', () => {
  const root = makeRepoRoot();
  const result = parseAnchor(root, { path: 'file.txt', range: 'L0-L5', anchorHash: HASH });
  assert.strictEqual(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /range/i);
});

test('parseAnchor: a Windows-style backslash path is normalized to forward slashes and succeeds', () => {
  const root = makeRepoRoot();
  const result = parseAnchor(root, { path: 'src\\main\\engine.ts', anchorHash: HASH });
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  assert.strictEqual(result.anchor.path, 'src/main/engine.ts');
});

// "Absolute" is a platform-specific notion, and this test is about the
// containment property, not about one operating system's spelling of it. A
// drive-lettered path is absolute on Windows; on Linux `\` is a legal
// character in a filename, so `C:\Windows\...` is an ordinary relative name
// that parseAnchor correctly accepts -- which is exactly why hard-coding the
// Windows spelling made this the one anchor test that failed on the Linux CI
// leg. Asserting the running platform's own absolute form keeps the property
// proven on both.
const ABSOLUTE_PATH = process.platform === 'win32' ? String.raw`C:\Windows\System32\config\SAM` : '/etc/passwd';

test('parseAnchor: an absolute path input is a parse failure', () => {
  const root = makeRepoRoot();
  const result = parseAnchor(root, { path: ABSOLUTE_PATH, anchorHash: HASH });
  assert.strictEqual(result.ok, false);
});

test('parseAnchor: a path resolving outside repoRoot fails with a containment-refusal reason', () => {
  const root = makeRepoRoot();
  const result = parseAnchor(root, { path: '../../.ssh/id_rsa', anchorHash: HASH });
  assert.strictEqual(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /path escapes repo root/);
});

test('parseAnchor: a path resolving outside repoRoot (.env) fails with a containment-refusal reason', () => {
  const root = makeRepoRoot();
  const result = parseAnchor(root, { path: '../.env', anchorHash: HASH });
  assert.strictEqual(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /path escapes repo root/);
});
