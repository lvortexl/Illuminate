import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const APP_DIR = 'illuminate-axi';

/**
 * The OS-correct directory where illuminate keeps its own state (lockfiles,
 * session records). illuminate never writes state next to the user's artifact.
 */
export function stateDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA;
    // Fail loud rather than silently falling back: a missing LOCALAPPDATA
    // means the environment is broken, and guessing would scatter state.
    if (!base) throw new Error('LOCALAPPDATA is not set — cannot determine state directory');
    return join(base, APP_DIR);
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_DIR);
  }
  const xdg = process.env.XDG_STATE_HOME;
  return join(xdg || join(homedir(), '.local', 'state'), APP_DIR);
}

/**
 * THE one normalization every state key in this codebase goes through
 * before hashing. There is no second one: `lockPathFor` below,
 * `sessionStorePathFor` (src/store/session-store.ts) and
 * `findingsStorePathFor` (src/store/findings-store.ts) all key off
 * `statePathHash`, which is the only caller of this function.
 *
 * Before this existed, each of the three hashed the RAW argument string.
 * That made `illuminate stop .demo` and `illuminate stop C:/x/.demo` key
 * two *different* daemons from the one `illuminate .demo/a.html` had
 * actually started (which keys off `dirname(realpath(resolve(file)))`), so
 * `stop` reported "not running" at a live daemon and left it running.
 *
 * `path.resolve` does three of the four normalizations in one call, on the
 * platform's own rules:
 *   - makes the path absolute (against cwd), which is what lets a relative
 *     `stop .demo` find the daemon an absolute `illuminate` started;
 *   - rewrites separators to the platform's own (`C:/x` -> `C:\x` on
 *     win32);
 *   - collapses `.`/`..` segments and strips any trailing separator,
 *     EXCEPT on a bare root (`C:\`, `/`, `\\server\share\`), where the
 *     separator is part of the root and removing it would change meaning.
 *
 * The fourth is the lower-casing, which is deliberately UNCONDITIONAL
 * rather than gated on win32. Two reasons, both load-bearing: NTFS is
 * case-insensitive, so `C:\Foo` and `c:\foo` must key one daemon; and this
 * is the behaviour the other two stores already shipped, so gating it here
 * would silently split a lockfile from the session/findings files that are
 * supposed to be colocated with it under the same key. The cost is that on
 * a genuinely case-sensitive filesystem `/Foo` and `/foo` collide — an
 * accepted, pre-existing tradeoff, not a regression introduced here.
 *
 * MIGRATION NOTE. This function is a FIXED POINT for every path that ever
 * successfully keyed a daemon: `dirname(realpath(resolve(file)))` is
 * already absolute, already separator-normalized, and already has no
 * trailing separator, so `resolve()` returns it unchanged and the hash is
 * byte-identical to the pre-normalization one. No already-running daemon
 * changes key, and no existing lock/state/findings file is orphaned. Only
 * the pathological inputs whose keys DO change (relative, trailing
 * separator, wrong separator) are ones that never addressed a real daemon
 * in the first place — that was the bug. `test/daemon/state-dir.test.ts`
 * pins this against the legacy derivation so it cannot silently drift.
 */
export function canonicalPathKey(path: string): string {
  return resolve(path).toLowerCase();
}

/** The 16-hex state key for a path. Truncated sha256, same primitive and
 * same truncation rationale as `src/provenance/hash.ts`: a bucketing key,
 * never a tamper-evidence boundary. */
export function statePathHash(path: string): string {
  return createHash('sha256').update(canonicalPathKey(path)).digest('hex').slice(0, 16);
}

/**
 * The lockfile path identifying the server that owns a given artifact
 * directory. Canonicalized before hashing (see `canonicalPathKey`) so every
 * spelling of one directory keys exactly one lockfile.
 */
export function lockPathFor(artifactDir: string): string {
  return join(stateDir(), 'servers', `${statePathHash(artifactDir)}.json`);
}
