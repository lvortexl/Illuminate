import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { stateDir, lockPathFor, canonicalPathKey, statePathHash } from '../../src/daemon/state-dir.ts';
import { sessionStorePathFor } from '../../src/store/session-store.ts';
import { findingsStorePathFor } from '../../src/store/findings-store.ts';

/**
 * stateDir() only READS process.platform, so every OS branch is testable from
 * a single CI leg by stubbing it. That keeps all three branches covered on the
 * Linux runner too, rather than only the branch that runner happens to be.
 */
function withPlatform<T>(platform: string, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
}

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[key] = original;
    else delete process.env[key];
  }
}

test('win32 with LOCALAPPDATA set resolves under that base', () => {
  withPlatform('win32', () =>
    withEnv('LOCALAPPDATA', 'C:\Users\test\AppData\Local', () => {
      const dir = stateDir();
      assert.match(dir, /illuminate-axi$/);
      assert.ok(dir.startsWith('C:\Users\test\AppData\Local'));
    }),
  );
});

test('win32 with LOCALAPPDATA unset throws rather than guessing', () => {
  withPlatform('win32', () =>
    withEnv('LOCALAPPDATA', undefined, () => {
      assert.throws(() => stateDir(), /LOCALAPPDATA is not set/);
    }),
  );
});

test('darwin resolves under Library/Application Support', () => {
  withPlatform('darwin', () => {
    assert.strictEqual(
      stateDir(),
      join(homedir(), 'Library', 'Application Support', 'illuminate-axi'),
    );
  });
});

test('linux honours XDG_STATE_HOME when set', () => {
  withPlatform('linux', () =>
    withEnv('XDG_STATE_HOME', '/custom/state', () => {
      assert.strictEqual(stateDir(), join('/custom/state', 'illuminate-axi'));
    }),
  );
});

test('linux falls back to ~/.local/state when XDG_STATE_HOME is unset', () => {
  withPlatform('linux', () =>
    withEnv('XDG_STATE_HOME', undefined, () => {
      assert.strictEqual(stateDir(), join(homedir(), '.local', 'state', 'illuminate-axi'));
    }),
  );
});

test('lockPathFor is case-insensitive across differently-cased input strings', () => {
  // Compares the function's own output for two input STRINGS, so the assertion
  // is meaningful on a case-sensitive filesystem (the Linux CI leg) too.
  assert.strictEqual(lockPathFor('/Foo/Bar'), lockPathFor('/foo/bar'));
});

test('lockPathFor is case-insensitive for Windows-style paths', () => {
  // NTFS is case-insensitive, so C:\Foo and c:\foo are the same directory
  // and must key one lockfile. Built with String.raw so the backslashes are
  // unambiguously backslashes and not accidental escape sequences.
  assert.strictEqual(lockPathFor(String.raw`C:\Foo\Bar`), lockPathFor(String.raw`c:\foo\bar`));
});

test('lockPathFor distinguishes different directories', () => {
  assert.notStrictEqual(lockPathFor('/Foo/Bar'), lockPathFor('/Foo/Baz'));
});

test('lockPathFor lives under stateDir()/servers/<16-hex>.json', () => {
  const p = lockPathFor('/Foo/Bar');
  assert.ok(p.startsWith(join(stateDir(), 'servers')));
  assert.match(p, /[/\\]servers[/\\][0-9a-f]{16}\.json$/);
});

// ---------------------------------------------------------------------------
// canonicalization -- the fix for `illuminate stop <dir>` printing "not
// running" at a live daemon (see canonicalPathKey's own doc comment)
// ---------------------------------------------------------------------------

test('lockPathFor keys a relative directory identically to its resolved absolute form', () => {
  // The whole defect in one assertion: `illuminate .demo/a.html` keys off an
  // absolute path, `illuminate stop .demo` off a relative one.
  const relative = join('test', 'fixtures');
  assert.strictEqual(lockPathFor(relative), lockPathFor(resolve(relative)));
});

test('lockPathFor keys a trailing separator identically to the bare directory', () => {
  const dir = join(tmpdir(), 'illuminate-canon', 'a', 'b');
  assert.strictEqual(lockPathFor(dir + sep), lockPathFor(dir));
  assert.strictEqual(lockPathFor(dir + sep + sep), lockPathFor(dir));
});

test('lockPathFor keys `.` and `..` segments identically to the collapsed path', () => {
  const dir = join(tmpdir(), 'illuminate-canon', 'a', 'b');
  assert.strictEqual(lockPathFor(join(dir, '.', 'c', '..')), lockPathFor(dir));
});

test('canonicalPathKey never strips the separator that IS the filesystem root', () => {
  // `C:` and `C:\` are different things on win32 (`C:` is drive-relative), and
  // `/` with the slash removed is the empty string. path.resolve knows this; a
  // hand-rolled "chop any trailing separator" would not.
  const root = resolve(sep);
  assert.strictEqual(canonicalPathKey(root), root.toLowerCase());
  assert.ok(canonicalPathKey(root).endsWith(sep), 'the root separator must survive canonicalization');
});

test(
  'lockPathFor keys a forward-slash win32 path identically to its backslash form',
  {
    skip:
      process.platform === 'win32'
        ? false
        : 'win32-only: on POSIX a backslash is an ordinary filename character, not a separator, so these really are two different paths',
  },
  () => {
    assert.strictEqual(lockPathFor('C:/Projects/illuminate/.demo'), lockPathFor(String.raw`C:\Projects\illuminate\.demo`));
  },
);

test('lockPathFor still distinguishes two genuinely different directories after canonicalization', () => {
  // Guards the other direction: a normalization that over-collapses would
  // silently merge two projects onto one daemon, breaking LIFE-04.
  assert.notStrictEqual(lockPathFor(join(tmpdir(), 'alpha')), lockPathFor(join(tmpdir(), 'beta')));
});

// ---------------------------------------------------------------------------
// migration -- see canonicalPathKey's MIGRATION NOTE
// ---------------------------------------------------------------------------

test('canonicalization is a FIXED POINT for an already-canonical absolute path: the key is byte-identical to the pre-normalization derivation', () => {
  // This is the whole migration story. Every daemon that ever really started
  // was keyed off `dirname(realpath(resolve(file)))` -- already absolute,
  // already separator-normalized, already free of a trailing separator. If
  // that input hashed differently after this change, every running daemon and
  // every existing state file would be orphaned at once, and a second daemon
  // would be spawned on top of each live one.
  const canonical = resolve(join(tmpdir(), 'illuminate-migration', 'artifacts'));
  const legacy = createHash('sha256').update(canonical.toLowerCase()).digest('hex').slice(0, 16);
  assert.strictEqual(statePathHash(canonical), legacy);
  assert.strictEqual(lockPathFor(canonical), join(stateDir(), 'servers', `${legacy}.json`));
});

test('lockPathFor, sessionStorePathFor and findingsStorePathFor all key off the SAME canonicalization', () => {
  // A lockfile and the state file that shares its daemon's lifecycle must
  // never disagree about what a path normalizes to. Asserted on a
  // deliberately NON-canonical spelling, which is exactly where two
  // independent copies of the rule would drift apart unnoticed.
  const messy = join('test', 'fixtures') + sep;
  const key = statePathHash(messy);
  assert.strictEqual(lockPathFor(messy), join(stateDir(), 'servers', `${key}.json`));
  assert.strictEqual(sessionStorePathFor(messy), join(stateDir(), 'servers', `${key}.state.json`));
  assert.strictEqual(findingsStorePathFor(messy), join(stateDir(), 'findings', `${key}.json`));
});
