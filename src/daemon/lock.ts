import { open, readFile, unlink, mkdir } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The full ownership record written into a daemon's lockfile. `healthToken`
 * is echoed by the daemon's own `GET /health` route and is the two-factor
 * check that closes the pid-recycling gap `isPidAlive` alone cannot close
 * (see RESEARCH.md §2.4 — implemented in a later plan's ownership.ts).
 */
export interface LockRecord {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
  healthToken: string;
}

/**
 * Atomically creates the lockfile or fails if one already exists. Backed by
 * `fs.open(path, 'wx')`, which maps to POSIX `O_CREAT | O_EXCL` and the
 * Windows `CREATE_NEW` disposition — atomic at the filesystem level, unlike
 * a hand-rolled "check then write" which would race.
 */
export async function acquireLock(lockPath: string, record: LockRecord): Promise<'acquired' | 'exists'> {
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    const handle = await open(lockPath, 'wx');
    try {
      await handle.writeFile(JSON.stringify(record, null, 2));
    } finally {
      await handle.close();
    }
    return 'acquired';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw err;
  }
}

/**
 * Reads and parses the lockfile. Returns `null` when no lockfile exists so
 * callers can distinguish "no lock" from "lock exists and is malformed"
 * (the latter propagates as a thrown error, e.g. a JSON.parse failure).
 */
export async function readLock(lockPath: string): Promise<LockRecord | null> {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8')) as LockRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Removes the lockfile. Idempotent — a missing file is not an error, since
 * callers may race with another cleanup path (e.g. §2.5's exit handler).
 */
export async function cleanupLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Injectable so the EPERM branch is testable without a real different-user-token process. */
export type KillFn = (pid: number, signal: 0) => void;

/**
 * Cross-platform pid liveness check via signal 0 — documented by Node as
 * portable, including on win32 (Node's signal-emulation layer implements
 * existence-check semantics for it even though Windows has no real signal
 * delivery). Never shells out to any external process-inspection CLI.
 *
 * EPERM (process exists, but signalling it is denied) is treated as "alive":
 * the safe default is to refuse reclaiming a lock this process cannot prove
 * is dead, rather than risk a false reclaim (RESEARCH.md §2.3, decision A2).
 * Note this alone does not close the pid-recycling gap — that is the
 * two-factor health-token cross-check implemented downstream (§2.4).
 */
export function isPidAlive(pid: number, killFn: KillFn = process.kill.bind(process)): boolean {
  try {
    killFn(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw err;
  }
}

/**
 * Registers graceful-exit cleanup for the lockfile. Explicit opt-in — the
 * daemon entry point calls this once; it is NOT a module-level side effect,
 * so importing lock.ts for its pure functions never attaches listeners.
 *
 * SIGKILL and `taskkill /F` cannot be intercepted by any handler — this is
 * why "lockfile present but pid dead" (readLock + isPidAlive together, on
 * the *next* invocation) is the primary recovery path, not this handler.
 */
export function registerCleanupHandlers(lockPath: string): void {
  const cleanup = (): void => {
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone, fine
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
}
