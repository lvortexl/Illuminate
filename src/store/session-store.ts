import { rename, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { stateDir, statePathHash } from '../daemon/state-dir.ts';
import { AsyncMutex } from './async-mutex.ts';
import type { DispatchLedgerEntry } from '../router/types.ts';

/**
 * Deterministic key for a served artifact, derived from its already-
 * resolved real path. Lower-cased before hashing -- the identical NTFS
 * case-insensitivity rationale as state-dir.ts's lockPathFor. Pure: does
 * no filesystem I/O. Callers (Phase 3's session-open flow) are
 * responsible for resolving fs.realpath before calling this.
 */
export function sessionKey(realArtifactPath: string): string {
  return createHash('sha256').update(realArtifactPath.toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * Phase 1 shipped this record deliberately incomplete -- "sessions grows
 * real fields (queued prompts, presence, dispatch ledger) in the phases
 * that actually implement them" (01-10-PLAN.md's objective). Phase 6 is
 * that phase: `queue`/`dispatches`/`browserLastSeenAt`/`sessionEndedAt`
 * below are those fields. This file stays a dumb schema + mutex +
 * atomic-write file, per its own established separation of concerns --
 * every one of the four fields is actually MUTATED by
 * `src/daemon/dispatch-ledger.ts`'s reducers, exactly like
 * `artifactRevision`/`chromeLoadToken`/`artifactLoadToken` are mutated by
 * `load-token.ts`, not here. The annotation store is explicitly NOT part
 * of this file -- ARCHITECTURE.md requires annotations to live in a
 * separate, portable sidecar next to the artifact (Phase 7), never merged
 * into this machine-local state file; `dispatches` below is machine-local
 * ledger bookkeeping only, not that sidecar.
 */
export interface SessionRecord {
  key: string;
  file: string;
  createdAt: string;
  /** Bumped by beginArtifactLoad (load-token.ts) on every fresh artifact
   * load -- the freshness guard's revision half. */
  artifactRevision: number;
  /** Last-writer-wins: the most recently issued chrome-shell load token.
   * null until the first GET /session/:key. */
  chromeLoadToken: string | null;
  /** The token tied to the CURRENT artifactRevision. null until the first
   * artifact-loads/begin. */
  artifactLoadToken: string | null;
  /** FIFO queue of dispatch ids awaiting delivery to the next poll --
   * appended to the END by enqueueDispatch, drained (never reordered) by
   * drainQueue, and re-prepended to the FRONT by restoreToQueue when a
   * poll dies mid-delivery (POLL-02's drain-verify-restore guarantee).
   * Mutated exclusively by `src/daemon/dispatch-ledger.ts`. */
  queue: string[];
  /** The durable dispatch ledger, keyed by `dispatch_id`. Mutated
   * exclusively by `src/daemon/dispatch-ledger.ts`'s
   * enqueueDispatch/drainQueue/restoreToQueue reducers. */
  dispatches: Record<string, DispatchLedgerEntry>;
  /** Last time the browser side of this session was observed alive (a
   * poll arriving, or an explicit heartbeat) -- POLL-04's presence signal.
   * `null` until the first poll/heartbeat. Set by
   * `src/daemon/dispatch-ledger.ts`'s recordHeartbeat. */
  browserLastSeenAt: string | null;
  /** Set once the session is explicitly ended. `null` while the session is
   * live. Set by `src/daemon/dispatch-ledger.ts`'s endSession. */
  sessionEndedAt: string | null;
}

export interface IlluminateState {
  sessions: Record<string, SessionRecord>;
}

function emptyState(): IlluminateState {
  return { sessions: {} };
}

/**
 * Idempotent session creation. Phase 3's session-open flow calls this on
 * every GET /session/:key -- it must never reset an already in-progress
 * session's revision/tokens just because the tab was reloaded or a second
 * tab opened the same key. Key lookup, never file comparison, decides
 * whether a record already exists (file is derived from key 1:1 in
 * practice, but this function does not assume that invariant holds).
 */
export function upsertSession(
  state: IlluminateState,
  key: string,
  file: string,
): { next: IlluminateState; result: SessionRecord } {
  const existing = state.sessions[key];
  if (existing) return { next: state, result: existing };
  const record: SessionRecord = {
    key,
    file,
    createdAt: new Date().toISOString(),
    artifactRevision: 0,
    chromeLoadToken: null,
    artifactLoadToken: null,
    queue: [],
    dispatches: {},
    browserLastSeenAt: null,
    sessionEndedAt: null,
  };
  return {
    next: { ...state, sessions: { ...state.sessions, [key]: record } },
    result: record,
  };
}

/**
 * The one durable JSON file backing a single daemon's session state,
 * colocated with that daemon's own lockfile under the SAME per-project
 * hash key -- one daemon, one lockfile, one state file, sharing a
 * lifecycle. (The reference keeps one GLOBAL state.json for everything;
 * ARCHITECTURE.md's own reasoning for why that is wrong for illuminate's
 * annotations -- cross-project contamination -- applies equally here,
 * given LIFE-04 already requires that two concurrent projects never
 * cross-talk.)
 *
 * The key comes from `statePathHash` (state-dir.ts), the SAME function
 * `lockPathFor` uses -- not a local copy of its derivation. This file used
 * to duplicate those three lines deliberately, to avoid importing an
 * unexported internal; that internal is now exported precisely because the
 * duplication was the defect: a lockfile and the state file that shares its
 * lifecycle cannot be allowed to normalize their key differently, and two
 * copies of a normalization rule are two things to keep in step.
 */
export function sessionStorePathFor(artifactRoot: string): string {
  return join(stateDir(), 'servers', `${statePathHash(artifactRoot)}.state.json`);
}

export type RenameFn = (oldPath: string, newPath: string) => Promise<void>;

/**
 * Atomic write: write to a uniquely-named temp file in the same
 * directory, then rename() over the destination. rename() within one
 * directory is atomic on both NTFS and POSIX -- a reader never observes a
 * partial write. Windows can transiently deny the rename (EPERM/EBUSY) if
 * an antivirus or indexer briefly has the destination open; retry a few
 * times with a short backoff rather than surfacing a spurious failure
 * (PITFALLS.md's "atomic write with Windows retry").
 */
export async function writeAtomic(
  path: string,
  contents: string,
  renameFn: RenameFn = rename,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, contents, 'utf8');
  const attempts = 5;
  for (let i = 0; i < attempts; i++) {
    try {
      await renameFn(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EBUSY') && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 25 * (i + 1)));
        continue;
      }
      await rm(tmp, { force: true });
      throw err;
    }
  }
}

export class SessionStore {
  #path: string;
  #mutex = new AsyncMutex();

  constructor(artifactRoot: string) {
    this.#path = sessionStorePathFor(artifactRoot);
  }

  async read(): Promise<IlluminateState> {
    try {
      return JSON.parse(await readFile(this.#path, 'utf8')) as IlluminateState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw err;
    }
  }

  /**
   * Mutex-serialized read-modify-write. `fn` receives the current state
   * (or an empty state on first use) and returns the next state plus
   * whatever `mutate` should resolve to; the result is written atomically
   * before the mutex releases, so concurrent callers never interleave a
   * read with another caller's not-yet-flushed write.
   */
  async mutate<T>(fn: (state: IlluminateState) => { next: IlluminateState; result: T }): Promise<T> {
    return this.#mutex.runExclusive(async () => {
      const current = await this.read();
      const { next, result } = fn(current);
      await writeAtomic(this.#path, JSON.stringify(next, null, 2));
      return result;
    });
  }
}
