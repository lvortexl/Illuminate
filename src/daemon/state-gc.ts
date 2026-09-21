import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDir } from './state-dir.ts';
import { isPidAlive, type LockRecord } from './lock.ts';
import type { IlluminateState } from '../store/session-store.ts';

/**
 * Garbage collection for `<stateDir>/servers/`.
 *
 * Nothing ever removed anything from that directory. A real machine had ~200
 * orphaned `*.state.json` files plus stray `*.json.<hex>.tmp` fragments, almost
 * all of them naming `C:\...\Temp\illuminate-*-test-*` artifacts deleted long
 * ago: every `mkdtemp` fixture that ever started a daemon left one behind, and
 * `writeAtomic` leaves its temp file behind on the one path where the rename
 * genuinely fails.
 *
 * The posture throughout is CONSERVATIVE: this deletes only what it can prove
 * is dead, and treats every ambiguity -- an unparseable file, a pid it cannot
 * rule out, a recently-written file -- as a reason to keep. Deleting a live
 * daemon's state file would lose a user's session; keeping an orphan costs a
 * few hundred bytes.
 */

/**
 * The one age threshold in this file, applied to BOTH an orphaned state/lock
 * pair and a stray `.tmp` fragment. Single-source and single-valued on
 * purpose: two thresholds would be two things to reason about, and nothing
 * here distinguishes the two cases -- an atomic-write temp file lives for
 * milliseconds and a daemon writes its lockfile before its state file, so any
 * value comfortably above "one process start" is equally correct for both.
 *
 * Its real job is to be a safety margin against a race this code cannot
 * otherwise see: a daemon that is mid-startup or mid-shutdown, briefly holding
 * one of the two files without the other.
 */
export const STATE_GC_MIN_AGE_MS = 10 * 60 * 1000;

export interface StateGcOptions {
  /** The directory to sweep. Defaults to the real `<stateDir>/servers`. */
  readonly dir?: string;
  /** "Now", in ms. Injected so a test need not sleep out the threshold. */
  readonly now?: number;
  /**
   * Liveness check. Deliberately `isPidAlive` and NOT `checkOwnership`: GC
   * must never open a socket to an arbitrary port it found on disk, and
   * `isPidAlive` errs in the safe direction anyway -- a recycled pid reads as
   * alive, which keeps a file that could have been deleted rather than
   * deleting one that could not.
   */
  readonly isAlive?: (pid: number) => boolean;
}

export interface StateGcResult {
  readonly removedStateFiles: number;
  readonly removedLockFiles: number;
  readonly removedTmpFiles: number;
}

const STATE_SUFFIX = '.state.json';
const LOCK_SUFFIX = '.json';
const TMP_SUFFIX = '.tmp';

/** The three kinds of file that live in `servers/`, grouped by the 16-hex key
 * that ties a lockfile to the state file sharing its daemon's lifecycle. */
interface KeyFiles {
  lock: string | null;
  state: string | null;
}

async function mtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await mtimeMs(path)) !== null;
}

/** Removes a file, treating "already gone" as success -- a concurrent daemon
 * or a user's own cleanup may have won the race, and that is not an error. */
async function removeIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Whether a daemon can be PROVEN dead for this key. A missing lockfile is a
 * proof (a daemon writes its lock before anything else and removes it on the
 * way out); a lockfile naming a pid that is gone is a proof. Anything else --
 * a live pid, a lockfile too mangled to read a pid out of -- is not, and
 * returns false so the caller keeps the files.
 */
async function daemonIsProvablyDead(lockPath: string | null, isAlive: (pid: number) => boolean): Promise<boolean> {
  if (lockPath === null) return true;
  const record = await readJson<LockRecord>(lockPath);
  if (record === null || typeof record.pid !== 'number') return false;
  return !isAlive(record.pid);
}

/**
 * Whether any artifact this state file was serving still exists on disk.
 *
 * `null` means "cannot tell" -- no state file, or one too mangled to parse --
 * which the caller treats as a reason to keep, never as an absence of
 * artifacts. A state file that parses cleanly with zero sessions genuinely has
 * no artifact to protect and returns `false`; it is the age threshold and the
 * dead-daemon proof, not this function, that keep that case safe.
 */
async function anyArtifactSurvives(statePath: string | null): Promise<boolean | null> {
  if (statePath === null) return null;
  const state = await readJson<IlluminateState>(statePath);
  if (state === null || typeof state.sessions !== 'object' || state.sessions === null) return null;
  for (const session of Object.values(state.sessions)) {
    if (typeof session?.file === 'string' && (await exists(session.file))) return true;
  }
  return false;
}

/**
 * Sweeps `servers/` once. Never throws: a missing directory, an unreadable
 * file, or a losing race with another process all resolve to "removed fewer
 * things", because this runs on a daemon's startup path and a cleanup that can
 * take down the thing it is cleaning up for is worse than litter.
 */
export async function collectStateGarbage(opts: StateGcOptions = {}): Promise<StateGcResult> {
  const dir = opts.dir ?? join(stateDir(), 'servers');
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? ((pid: number) => isPidAlive(pid));

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { removedStateFiles: 0, removedLockFiles: 0, removedTmpFiles: 0 };
  }

  const byKey = new Map<string, KeyFiles>();
  const tmpNames: string[] = [];
  for (const name of names) {
    if (name.endsWith(TMP_SUFFIX)) {
      tmpNames.push(name);
      continue;
    }
    // `.state.json` must be tested BEFORE `.json`, since it also ends in it.
    const isState = name.endsWith(STATE_SUFFIX);
    if (!isState && !name.endsWith(LOCK_SUFFIX)) continue;
    const key = name.slice(0, -(isState ? STATE_SUFFIX.length : LOCK_SUFFIX.length));
    const entry = byKey.get(key) ?? { lock: null, state: null };
    if (isState) entry.state = name;
    else entry.lock = name;
    byKey.set(key, entry);
  }

  let removedStateFiles = 0;
  let removedLockFiles = 0;
  let removedTmpFiles = 0;

  for (const name of tmpNames) {
    const path = join(dir, name);
    const mtime = await mtimeMs(path);
    if (mtime === null || now - mtime <= STATE_GC_MIN_AGE_MS) continue;
    if (await removeIfPresent(path)) removedTmpFiles += 1;
  }

  for (const { lock, state } of byKey.values()) {
    const lockPath = lock === null ? null : join(dir, lock);
    const statePath = state === null ? null : join(dir, state);

    if (!(await daemonIsProvablyDead(lockPath, isAlive))) continue;

    // Newest of the pair: a lockfile rewritten a moment ago must protect the
    // state file beside it, and vice versa.
    const ages = (await Promise.all([lockPath, statePath].map((p) => (p === null ? null : mtimeMs(p))))).filter(
      (m): m is number => m !== null,
    );
    if (ages.length === 0) continue;
    if (now - Math.max(...ages) <= STATE_GC_MIN_AGE_MS) continue;

    const survives = await anyArtifactSurvives(statePath);
    if (survives !== false) continue;

    if (statePath !== null && (await removeIfPresent(statePath))) removedStateFiles += 1;
    if (lockPath !== null && (await removeIfPresent(lockPath))) removedLockFiles += 1;
  }

  return { removedStateFiles, removedLockFiles, removedTmpFiles };
}
