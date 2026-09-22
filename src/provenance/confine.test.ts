import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { confineToRepoRoot } from './confine.ts';

function makeRepoRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'illuminate-confine-root-')));
  writeFileSync(join(root, 'file.txt'), 'hello\n');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'nested.txt'), 'nested\n');
  return root;
}

test('confineToRepoRoot: a normal existing relative path inside the root resolves to its realpath', () => {
  const root = makeRepoRoot();
  const result = confineToRepoRoot(root, 'sub/nested.txt');
  assert.strictEqual(result, realpathSync(join(root, 'sub', 'nested.txt')));
});

test('confineToRepoRoot: a POSIX absolute path returns null', () => {
  const root = makeRepoRoot();
  const result = confineToRepoRoot(root, '/etc/passwd');
  assert.strictEqual(result, null);
});

// The absolute-path refusal itself is proven on every platform by the POSIX
// case above, which `resolve` treats as absolute on Windows too. This test
// covers the drive-lettered spelling, and that spelling means two different
// things: an absolute path on Windows, and an ordinary relative filename on
// Linux, where `\` is a legal character in a name. Asserting a refusal on
// both was asserting a falsehood on one, and it was the only confine test
// that failed on the Linux CI leg.
test('confineToRepoRoot: a drive-lettered path is refused on Windows and is an ordinary relative name elsewhere', () => {
  const root = makeRepoRoot();
  const result = confineToRepoRoot(root, 'C:\\Windows\\System32\\config\\SAM');
  if (process.platform === 'win32') {
    assert.strictEqual(result, null);
    return;
  }
  assert.notStrictEqual(result, null, 'a backslash name is legal on POSIX and resolves inside the root');
  assert.ok(result !== null && result.startsWith(root), `expected a path under ${root}, got ${String(result)}`);
});

test('confineToRepoRoot: a ../-traversal path resolving outside repoRoot returns null', () => {
  const root = makeRepoRoot();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'illuminate-confine-outside-')));
  writeFileSync(join(outside, 'secret.txt'), 'secret\n');
  const rel = relative(root, join(outside, 'secret.txt')).split(sep).join('/');
  assert.match(rel, /^\.\./, 'test fixture sanity: relative path must escape root');
  const result = confineToRepoRoot(root, rel);
  assert.strictEqual(result, null);
});

// STAL-03: a path that does not exist is NOT a security refusal. A file that
// was validly committed and cited at data-rev and has since been DELETED is
// exactly the case `lost` exists to name; refusing it here made `lost`
// unreachable through resolve(). Containment is still enforced — see the two
// tests immediately below, which prove a missing path cannot escape.
test('confineToRepoRoot: a path that does not exist on disk still resolves, so a deleted cited file can reach drift classification', () => {
  const root = makeRepoRoot();
  const result = confineToRepoRoot(root, 'does/not/exist.txt');
  assert.strictEqual(result, join(root, 'does', 'not', 'exist.txt'));
});

test('confineToRepoRoot: a NONEXISTENT path that traverses outside repoRoot is still refused', () => {
  const root = makeRepoRoot();
  const result = confineToRepoRoot(root, '../escaped/gone.txt');
  assert.strictEqual(result, null, 'a missing path must not bypass containment');
});

test('confineToRepoRoot: a NONEXISTENT leaf UNDER an escaping junction is still refused -- the existing prefix is realpathed first', (t) => {
  const root = makeRepoRoot();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'illuminate-confine-outside-')));
  mkdirSync(join(outside, 'escaped'));

  const junctionPath = join(root, 'escape-link');
  try {
    symlinkSync(join(outside, 'escaped'), junctionPath, 'junction');
  } catch {
    t.skip('directory junctions require privileges unavailable in this environment');
    return;
  }

  // `deleted.txt` does not exist, but `escape-link` does and resolves outside
  // the root. The walk must resolve the existing prefix before appending.
  const result = confineToRepoRoot(root, 'escape-link/deleted.txt');
  assert.strictEqual(result, null);
});

test('confineToRepoRoot: a nonexistent leaf inside a junction pointing INSIDE the root resolves through the junction', (t) => {
  const root = makeRepoRoot();
  const realDir = join(root, 'realsub2');
  mkdirSync(realDir);

  const junctionPath = join(root, 'linksub2');
  try {
    symlinkSync(realDir, junctionPath, 'junction');
  } catch {
    t.skip('directory junctions require privileges unavailable in this environment');
    return;
  }

  const result = confineToRepoRoot(root, 'linksub2/deleted.txt');
  assert.strictEqual(result, join(realpathSync(realDir), 'deleted.txt'));
});

test('confineToRepoRoot: a directory junction inside repoRoot pointing outside returns null', (t) => {
  const root = makeRepoRoot();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'illuminate-confine-outside-')));
  mkdirSync(join(outside, 'escaped'));
  writeFileSync(join(outside, 'escaped', 'leak.txt'), 'leak\n');

  const junctionPath = join(root, 'escape-link');
  try {
    symlinkSync(join(outside, 'escaped'), junctionPath, 'junction');
  } catch {
    t.skip('directory junctions require privileges unavailable in this environment');
    return;
  }

  const result = confineToRepoRoot(root, 'escape-link/leak.txt');
  assert.strictEqual(result, null);
});

test('confineToRepoRoot: a directory junction inside repoRoot pointing inside resolves normally', (t) => {
  const root = makeRepoRoot();
  const realDir = join(root, 'realsub');
  mkdirSync(realDir);
  writeFileSync(join(realDir, 'in.txt'), 'in\n');

  const junctionPath = join(root, 'linksub');
  try {
    symlinkSync(realDir, junctionPath, 'junction');
  } catch {
    t.skip('directory junctions require privileges unavailable in this environment');
    return;
  }

  const result = confineToRepoRoot(root, 'linksub/in.txt');
  assert.strictEqual(result, realpathSync(join(realDir, 'in.txt')));
});
