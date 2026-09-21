import { fileURLToPath } from 'node:url';
import { readLock, cleanupLock, isPidAlive, type LockRecord } from './lock.ts';
import { checkOwnership } from './ownership.ts';
import { spawnDaemon } from './spawn.ts';
import { lockPathFor } from './state-dir.ts';
import { DEFAULT_PORT, PORT_PROBE_RANGE } from './bind.ts';

// NOTE for maintainers: __ILLUMINATE_VERSION__ must NOT be referenced
// anywhere in this module. `node --test` imports orchestrate.ts directly
// (unbundled), and an unreplaced esbuild `define` would throw at runtime
// under the test runner. Version references belong in cli.ts and
// daemon-entry.ts only.

const POLL_INTERVAL_MS = 50;
const STARTUP_TIMEOUT_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The entry path is `dist/daemon-entry.mjs`, resolved relative to the
 * running CLI's own location — never cwd, which would break once installed
 * globally.
 *
 * Dual-mode by construction, not by branching on NODE_ENV or similar: esbuild
 * preserves `import.meta.url` as the bundled output file's own location, so
 * under the built CLI (dist/cli.mjs, which bundles this module) this
 * resolves to the sibling dist/daemon-entry.mjs. Run directly from source —
 * as this module is under `node --test`'s integration tests, unbundled —
 * `import.meta.url` is this file's own src/daemon/orchestrate.ts location,
 * so this resolves to the sibling src/daemon/daemon-entry.ts instead, which
 * is directly runnable via `node <path>` since this project's Node floor
 * strips TypeScript types unflagged.
 */
function resolveDaemonEntryPath(): string {
  const built = import.meta.url.endsWith('.mjs') || import.meta.url.endsWith('.js');
  const fileName = built ? 'daemon-entry.mjs' : 'daemon-entry.ts';
  return fileURLToPath(new URL(`./${fileName}`, import.meta.url));
}

/**
 * RESEARCH.md §3.2 step 5's diagnostic — the one case with no safe automatic
 * recovery: the whole probe range is held by something that never went
 * through illuminate's ownership protocol at all. Never attempts to inspect
 * or kill the foreign process; names only the two zero-dependency
 * Windows-native *user-run* diagnostics.
 *
 * Exported so daemon-entry.ts's own bind-failure path (it is the process
 * actually attempting the bind) prints the *identical* text to stderr —
 * one source of truth, not two copies that could drift. This process can
 * never read that stderr verbatim to relay it (spawn.ts's `stdio: 'ignore'`
 * is deliberate, per 01-06), so both sides import the same function instead.
 */
export function portInUseDiagnostic(startPort: number, range: number): string {
  const endPort = startPort + range - 1;
  const portDesc = range > 1 ? `${startPort}-${endPort}` : `${startPort}`;
  return (
    `Port ${portDesc} is in use by a process illuminate cannot identify as its own.\n` +
    `illuminate does not shell out to inspect other processes on Windows.\n\n` +
    `To find what's using it:\n` +
    `  PowerShell:  Get-Process -Id (Get-NetTCPConnection -LocalPort ${startPort}).OwningProcess\n` +
    `  cmd.exe:     netstat -ano | findstr :${startPort}\n\n` +
    `Or just let illuminate pick a free port instead:  illuminate <file> --port 0`
  );
}

/**
 * Polls for the just-spawned child to either: (a) write a lockfile and come
 * up healthy, or (b) exit without ever writing one at all (the no-safe-
 * recovery case above). Bounded by STARTUP_TIMEOUT_MS throughout (T-01-20):
 * a wedged or crash-looping child cannot hang the CLI invocation forever.
 */
async function waitForDaemon(lockPath: string, childPid: number, artifactRoot: string): Promise<LockRecord> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let record: LockRecord | null;
    try {
      record = await readLock(lockPath);
    } catch {
      // acquireLock creates the lockfile (`open(path, 'wx')`) before its
      // content is fully written by a separate `writeFile` call -- a poll
      // landing in that narrow window sees a truncated/empty file and
      // JSON.parse throws. Treat it identically to "no record yet" and
      // keep polling; this is not evidence of a genuinely corrupted
      // lockfile, only of a write still in flight.
      record = null;
    }
    if (record) {
      const remainingMs = Math.max(1, deadline - Date.now());
      try {
        const res = await fetch(`http://127.0.0.1:${record.port}/health`, {
          signal: AbortSignal.timeout(remainingMs),
        });
        if (res.ok) return record;
      } catch {
        // Not ready yet (connection refused / not listening quite yet) —
        // keep polling within the same overall deadline.
      }
    } else if (!isPidAlive(childPid)) {
      // The child exited before ever writing a lockfile at all — surface
      // the same diagnostic text the child itself printed, not a generic
      // timeout message.
      throw new Error(portInUseDiagnostic(DEFAULT_PORT, PORT_PROBE_RANGE));
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`daemon failed to start for artifact directory: ${artifactRoot}`);
}

/**
 * Shared by the "no lock" branch and the version-mismatch restart branch
 * below — spawn the child, then poll for it to come up (see waitForDaemon).
 * Structural extraction only (Plan 01-11): the "no lock" branch's observable
 * result is identical before and after this refactor.
 */
async function spawnFreshDaemon(
  artifactRoot: string,
  lockPath: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ port: number; attached: false }> {
  const daemonEntryPath = resolveDaemonEntryPath();
  const childPid = spawnDaemon(daemonEntryPath, [artifactRoot], env !== undefined ? { env } : {});
  const record = await waitForDaemon(lockPath, childPid, artifactRoot);
  return { port: record.port, attached: false };
}

/**
 * Exact-match today; a future phase may relax this to semver-compatible
 * ranges once there is a reason to. Kept as its own named function so that
 * decision lives in one place, not inline in the decision tree.
 */
export function shouldRestartForVersion(recordVersion: string, currentVersion: string): boolean {
  return recordVersion !== currentVersion;
}

/**
 * Pass `__ILLUMINATE_VERSION__` from the CLI's own bundle. Omitted — or
 * `currentVersion` left `undefined` — skips the version check entirely,
 * which is what keeps Plan 01-08's existing single-argument
 * `ensureDaemonRunning(artifactRoot)` call sites behaving byte-for-byte
 * identically to before this plan.
 */
export interface EnsureDaemonOptions {
  currentVersion?: string;
  /**
   * Merged on top of the spawned child's inherited `process.env` — threaded
   * straight through to `spawnDaemon` (see spawn.ts's `SpawnDaemonOptions`
   * doc comment). Plan 01-08's forcing function: an integration test needs
   * a short, real `ILLUMINATE_IDLE_TIMEOUT_MS` scoped to one spawned
   * daemon rather than mutating the whole test process's `process.env`.
   * Omitted entirely (the default) reproduces existing behavior exactly.
   */
  env?: NodeJS.ProcessEnv;
}

const SHUTDOWN_REQUEST_TIMEOUT_MS = 2000;
const GRACEFUL_SHUTDOWN_POLL_WINDOW_MS = 3000;
const SIGTERM_POLL_WINDOW_MS = 1000;

/** Polls isPidAlive within a bounded window; returns whether the pid is confirmed dead by the deadline. */
async function waitUntilDead(pid: number, windowMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return !isPidAlive(pid);
}

/**
 * The version-mismatch restart sequence: graceful token-checked `/shutdown`
 * first (identical shape to `illuminate stop`'s request, Plan 01-07), a
 * bounded wait, then a `SIGTERM` fallback, then one more bounded wait. If
 * the daemon still has not died after both attempts, this throws rather
 * than spawning a second daemon on top of a live one — mirrors Plan 01-07's
 * own "no safe automatic recovery" precedent for the foreign-port case
 * (T-01-25).
 */
async function restartForVersionMismatch(record: LockRecord, artifactRoot: string, lockPath: string): Promise<void> {
  process.stderr.write(`illuminate: daemon version ${record.version} differs from CLI version -- restarting\n`);

  try {
    await fetch(`http://127.0.0.1:${record.port}/shutdown?token=${record.healthToken}`, {
      method: 'POST',
      signal: AbortSignal.timeout(SHUTDOWN_REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Wedged event loop, already gone, or a transient network hiccup — the
    // isPidAlive poll below is the real source of truth, not this response.
  }

  let dead = await waitUntilDead(record.pid, GRACEFUL_SHUTDOWN_POLL_WINDOW_MS);

  if (!dead) {
    process.kill(record.pid, 'SIGTERM');
    dead = await waitUntilDead(record.pid, SIGTERM_POLL_WINDOW_MS);
  }

  if (!dead) {
    throw new Error(
      `illuminate: daemon for ${artifactRoot} (pid ${record.pid}) did not exit after a graceful shutdown ` +
        `request and SIGTERM -- refusing to spawn a second daemon on top of one that will not die`,
    );
  }

  // Idempotent — the dying daemon's own exit handler (registerCleanupHandlers)
  // may already have removed it.
  await cleanupLock(lockPath);
}

/**
 * RESEARCH.md §3.2's full recovery decision tree, implemented exactly:
 *
 *   1. Read the lockfile for this artifact dir, if it exists.
 *   2. No lockfile → spawn fresh.
 *   3. Lockfile exists → checkOwnership():
 *        - 'ours-and-healthy' → version check (Plan 01-11, additive, see
 *          below), then attach, do not spawn (LIFE-04's contract).
 *        - 'stale-pid-dead' / 'foreign-process-on-recorded-pid' → the pid
 *          coincidence is not evidence of anything, the health check is the
 *          source of truth — delete the lock and reclaim identically for
 *          both statuses, then spawn fresh.
 *   4/5. Spawn path: spawnDaemon + poll (see waitForDaemon above), which
 *        also surfaces the one no-safe-recovery case.
 *
 * Plan 01-11's addition: when `opts.currentVersion` is provided and differs
 * from the healthy daemon's recorded version, gracefully restart it to the
 * current version (see restartForVersionMismatch) instead of attaching to
 * stale code. Omitting `opts` entirely reproduces Plan 01-07's original
 * behavior exactly.
 */
export async function ensureDaemonRunning(
  artifactRoot: string,
  opts: EnsureDaemonOptions = {},
): Promise<{ port: number; attached: boolean }> {
  const lockPath = lockPathFor(artifactRoot);
  const existing = await readLock(lockPath);

  if (existing) {
    const ownership = await checkOwnership(existing);
    if (ownership.status === 'ours-and-healthy') {
      if (opts.currentVersion !== undefined && shouldRestartForVersion(existing.version, opts.currentVersion)) {
        await restartForVersionMismatch(existing, artifactRoot, lockPath);
        return spawnFreshDaemon(artifactRoot, lockPath, opts.env);
      }
      return { port: existing.port, attached: true };
    }
    await cleanupLock(lockPath);
  }

  return spawnFreshDaemon(artifactRoot, lockPath, opts.env);
}
