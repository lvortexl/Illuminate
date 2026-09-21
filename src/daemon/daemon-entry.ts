import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { bindWithProbe, DEFAULT_PORT, PORT_PROBE_RANGE } from './bind.ts';
import { acquireLock, registerCleanupHandlers, type LockRecord } from './lock.ts';
import { lockPathFor } from './state-dir.ts';
import { collectStateGarbage } from './state-gc.ts';
import { createDaemonServer } from './server.ts';
import { portInUseDiagnostic } from './orchestrate.ts';

/**
 * Build-time substituted by scripts/build.mjs's esbuild `define` when
 * bundled into dist/daemon-entry.mjs. This file is ALSO run directly from
 * source (unbundled) by test/daemon/orchestrate.test.ts's real-subprocess
 * integration tests and by orchestrate.ts's dev-mode entry resolution — in
 * that mode no substitution has happened and this identifier has no
 * runtime binding at all. Never reference it directly; go through
 * resolveVersion() below, which uses `typeof` (the one JS construct that
 * can safely probe a genuinely undeclared identifier without throwing).
 */
declare const __ILLUMINATE_VERSION__: string;

function resolveVersion(): string {
  if (typeof __ILLUMINATE_VERSION__ !== 'undefined') return __ILLUMINATE_VERSION__;
  return 'dev';
}

const DEFAULT_IDLE_MS = 45 * 60 * 1000;

/**
 * Resolves the idle self-stop timeout from ILLUMINATE_IDLE_TIMEOUT_MS
 * (Plan 01-06's documented production-default note). '0' or 'off' disables
 * idle shutdown entirely — createDaemonServer never constructs an
 * IdleController, and onIdle is never called, in that case.
 */
function resolveIdleMs(): number | null {
  const raw = process.env.ILLUMINATE_IDLE_TIMEOUT_MS;
  if (raw === '0' || raw === 'off') return null;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_IDLE_MS;
}

/**
 * Test-only escape hatch closing 06-11's own documented gap
 * (deferred-items.md): `test/cli-answer.test.ts`/`test/cli-audit.test.ts`
 * spawn a REAL, separate daemon subprocess via `ensureDaemonRunning`
 * (orchestrate.ts), which has no seam to pass `DaemonServerOptions`
 * directly the way the in-process tests (`dispatch-routes.test.ts`,
 * `end-session-route.test.ts`) already do via
 * `isClaudeOnPathOverride: async () => false`. Without this, any machine
 * with a real `claude` binary on PATH -- true on this dev host, since this
 * very session runs inside it -- has those two suites' dispatch-creation
 * calls silently spawn a real, costly, non-deterministic `claude -p`
 * subprocess as a side effect (06-11-SUMMARY.md's own confirmed timing
 * drop: ~1.3s -> ~0.4s once removed from the two suites that COULD take
 * the override).
 *
 * Mirrors `resolveIdleMs()`'s own env-var-in-daemon-entry precedent, but
 * requires the exact string `'1'` -- not "any truthy-looking value" -- so a
 * stray or malformed env var can never disable self-dispatch by accident in
 * production. Omitting it entirely (the default) reproduces real production
 * behavior exactly: `opts.isClaudeOnPathOverride` stays `undefined`, and
 * `createDaemonServer` falls back to the real, once-per-process-cached
 * `claude --version` PATH probe (server.ts).
 */
function resolveSelfDispatchDisabled(): boolean {
  return process.env.ILLUMINATE_DISABLE_SELF_DISPATCH === '1';
}

/**
 * Test/ops-only escape hatch mirroring `resolveSelfDispatchDisabled()`'s own
 * exact-string-'1' precedent -- forces every session's staleness watcher
 * unhealthy at creation, without ever calling real `fs.watch`. Lets Plan
 * 08-05's Playwright suite prove the "visible degraded state" UI against a
 * real spawned daemon subprocess without reaching into its real fs.watch
 * internals.
 */
function resolveForceWatcherUnhealthy(): boolean {
  return process.env.ILLUMINATE_FORCE_WATCHER_UNHEALTHY === '1';
}

/**
 * `ILLUMINATE_STALENESS_DEBOUNCE_MS` -- mirrors `resolveIdleMs()`'s own
 * numeric-override precedent: a set-but-non-finite value is treated as
 * unset (falls back to staleness-registry.ts's own real production
 * default), never throws or crashes daemon startup.
 */
function resolveStalenessDebounceMs(): number | undefined {
  const raw = process.env.ILLUMINATE_STALENESS_DEBOUNCE_MS;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `ILLUMINATE_STALENESS_RECONCILE_MS` -- same shape as resolveStalenessDebounceMs. */
function resolveStalenessReconcileMs(): number | undefined {
  const raw = process.env.ILLUMINATE_STALENESS_RECONCILE_MS;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function main(): Promise<void> {
  const artifactRoot = process.argv[2];
  if (!artifactRoot) {
    process.stderr.write('daemon-entry: missing artifactRoot argument\n');
    process.exitCode = 1;
    return;
  }

  const lockPath = lockPathFor(artifactRoot);

  // Bind BEFORE building the LockRecord: the record's `port` field must be
  // the real bound port, which bindWithProbe only knows after a successful
  // bind. createDaemonServer therefore takes an already-bound server and
  // attaches its route handler to it, rather than creating/binding one
  // itself (Plan 01-07 Task 2's documented reshape of Task 1's sketch).
  const server = createServer();

  let port: number;
  try {
    port = await bindWithProbe(server, DEFAULT_PORT, '127.0.0.1');
  } catch {
    // RESEARCH.md §3.2 step 5: the one case with no safe automatic
    // recovery. Never inspect or kill the foreign process holding the
    // range — name only the two zero-dependency Windows-native user-run
    // diagnostics. No lockfile is ever written on this path, which is
    // exactly what ensureDaemonRunning's poll loop (orchestrate.ts) uses
    // to detect this failure and surface the same text.
    process.stderr.write(portInUseDiagnostic(DEFAULT_PORT, PORT_PROBE_RANGE) + '\n');
    process.exitCode = 1;
    return;
  }

  const record: LockRecord = {
    pid: process.pid,
    port,
    version: resolveVersion(),
    startedAt: new Date().toISOString(),
    healthToken: randomUUID(),
  };

  const lockResult = await acquireLock(lockPath, record);
  if (lockResult === 'exists') {
    // Lost a genuine race against a concurrent spawn for the same artifact
    // root (two CLI invocations racing on a directory with no prior lock).
    // Never proceed with two daemons owning one artifact root.
    server.close();
    process.exitCode = 0;
    return;
  }

  registerCleanupHandlers(lockPath);

  // Garbage-collect the state directory, once per daemon start.
  //
  // The daemon is the only process that writes to `servers/`, and by this line
  // it holds the lock that makes its OWN key provably live -- so it is the one
  // place with the standing to decide another key is dead. It is also the
  // cheapest place: daemon starts are rare (one per artifact directory), and
  // this process is detached with `stdio: 'ignore'`, so the sweep never sits
  // between the user and their artifact the way a CLI-side sweep would.
  //
  // Deliberately fire-and-forget, after `acquireLock` and before the server is
  // built: nothing downstream reads its result, and a cleanup that can delay
  // or fail a daemon start is worse than the litter it removes. See
  // `collectStateGarbage` for why it cannot delete a live daemon's files.
  void collectStateGarbage().catch(() => {});

  const stalenessDebounceMs = resolveStalenessDebounceMs();
  const stalenessReconcileMs = resolveStalenessReconcileMs();
  createDaemonServer(server, artifactRoot, record, {
    idleMs: resolveIdleMs(),
    ...(resolveSelfDispatchDisabled() ? { isClaudeOnPathOverride: async () => false } : {}),
    ...(resolveForceWatcherUnhealthy() ? { forceWatcherUnhealthy: true } : {}),
    ...(stalenessDebounceMs !== undefined ? { stalenessWatchDebounceMs: stalenessDebounceMs } : {}),
    ...(stalenessReconcileMs !== undefined ? { stalenessReconcileIntervalMs: stalenessReconcileMs } : {}),
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`daemon-entry: fatal: ${message}\n`);
  process.exitCode = 1;
});
