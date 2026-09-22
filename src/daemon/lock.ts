import { open, readFile, unlink, mkdir } from 'node:fs/promises';
import { unlinkSync, readFileSync } from 'node:fs';
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
 * Reads a pid's raw `/proc/<pid>/stat` line, or `null` where no such file
 * can be read. Injected for the same reason `KillFn` is: the zombie branch
 * has to be provable on the platforms that cannot manufacture a zombie.
 */
export type ProcStatReader = (pid: number) => string | null;

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
 *
 * Signal 0 alone answers a narrower question than the name of this function
 * asks: it proves only that the pid still occupies a row in the process
 * table. On POSIX a process that has already exited keeps that row until
 * its parent collects the exit status — the zombie state — and signal 0
 * succeeds on a zombie. That gap is not theoretical: a daemon that had shut
 * down cleanly was read as one that "did not exit after a graceful shutdown
 * request and SIGTERM", because its parent was blocked inside a synchronous
 * spawn and could not reap it. Windows has no zombie state, which is why
 * this only ever failed on the Linux CI leg.
 *
 * So a successful signal 0 is followed by one `/proc/<pid>/stat` read.
 * Deliberately not gated on `process.platform`: the reader reports `null`
 * wherever there is no such file (Windows, macOS), and a `null` reading
 * leaves the answer exactly as signal 0 gave it — byte-for-byte today's
 * behaviour on every platform without a procfs. Reading a file is not
 * shelling out; this function still spawns nothing.
 */
export function isPidAlive(
  pid: number,
  killFn: KillFn = process.kill.bind(process),
  readStat: ProcStatReader = readProcStat,
): boolean {
  try {
    killFn(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw err;
  }
  return !isZombie(pid, readStat);
}

/**
 * Reads a pid's raw procfs status line, or `null` where there is none to
 * read — a kernel without procfs, a pid that vanished between the signal
 * and the read, or any permission problem. Every failure reads the same:
 * "no opinion", never "dead".
 */
function readProcStat(pid: number): string | null {
  try {
    return readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The state character is the field after the executable name, and that name
 * is wrapped in parentheses precisely because it may itself contain spaces
 * and parentheses. Splitting on whitespace and taking the third field is
 * the classic way to get this wrong; the state is the first token after the
 * LAST `)`.
 */
function isZombie(pid: number, readStat: ProcStatReader): boolean {
  const stat = readStat(pid);
  if (stat === null) return false;
  const afterName = stat.slice(stat.lastIndexOf(')') + 1).trim();
  return afterName.split(/\s+/)[0] === 'Z';
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
