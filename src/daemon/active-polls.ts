/**
 * 06-11's standalone-adapter support: two small, ephemeral, in-memory
 * pieces of state that live for exactly one daemon process's lifetime and
 * are NEVER persisted to disk (unlike `SessionStore`/`dispatch-ledger.ts`,
 * which are the durable record) -- ARCHITECTURE.md's own reference
 * `activePolls` Map is exactly this shape: presence, not durability.
 *
 * 1. `createActivePolls()` -- a count (not a boolean) of how many `GET
 *    /api/:key/poll` requests are CURRENTLY open for a given session key,
 *    mirroring `IdleController`'s own `#activeCount` pattern (idle.ts):
 *    that class tracks "is anything at all connected to this daemon" the
 *    same way -- `enter()`/`exit()` pairs, never a reset-on-every-request
 *    boolean -- because two harnesses polling the same session
 *    concurrently is an already-documented-elsewhere edge case that a
 *    boolean would collapse incorrectly (a `false` from the first
 *    harness's poll ending would wrongly report "no poll open" while the
 *    second harness's poll is still live).
 *
 * 2. `createClaudeOnPathProbe()` -- an injectable, cached `claude
 *    --version` PATH probe. Returned as a FACTORY (not a bare module-level
 *    singleton) specifically so production code (server.ts) can construct
 *    exactly ONE per `createDaemonServer` call -- i.e. per daemon process,
 *    which is genuinely "one process lifetime" -- while tests construct as
 *    many independent probes as they need, each carrying its own cache,
 *    with zero risk of one test's cached result leaking into the next.
 *    Re-probing on every dispatch would be wasteful (PATH does not change
 *    mid-process in practice); caching after the first call is the
 *    documented, deliberate tradeoff.
 */

import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';

export interface ActivePolls {
  enter(key: string): void;
  exit(key: string): void;
  isActive(key: string): boolean;
}

export function createActivePolls(): ActivePolls {
  const counts = new Map<string, number>();

  return {
    enter(key: string): void {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    exit(key: string): void {
      const current = counts.get(key) ?? 0;
      const next = current - 1;
      if (next <= 0) {
        counts.delete(key);
      } else {
        counts.set(key, next);
      }
    },
    isActive(key: string): boolean {
      return (counts.get(key) ?? 0) > 0;
    },
  };
}

/**
 * The exact, narrow slice of a spawned child process this probe needs --
 * only `.on('error' | 'exit', ...)`. A hand-rolled interface (deliberately
 * NOT `Pick<ChildProcess, 'on'>`): `ChildProcess`'s own `on()` overloads
 * return `this`, which binds the return type to `ChildProcess` itself and
 * makes a `Pick` of it unsatisfiable by any other class (e.g. a test
 * double built on `node:events`'s `EventEmitter`, whose own `on()` returns
 * `this` bound to THAT class instead). Returning `unknown` here sidesteps
 * that trap: the real `spawn()`'s return value (a genuine `ChildProcess`)
 * satisfies this narrower shape with no cast, and a test double needs
 * nothing more than a plain `EventEmitter`.
 */
export interface ProbeChild {
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
}

export type ProbeSpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ProbeChild;

const defaultProbeSpawnFn: ProbeSpawnFn = (command, args, options) => spawn(command, args, options);

/**
 * One-shot `claude --version` probe. Resolves `true` only on a genuine
 * exit code 0; a non-zero exit, a spawn `'error'` event (e.g. ENOENT --
 * the binary is not on PATH), or `spawnFn` throwing synchronously all
 * resolve `false` -- never rejects, so a caller can safely `await` this
 * without its own try/catch.
 */
function probeClaudeOnPath(spawnFn: ProbeSpawnFn): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let child: ProbeChild;
    try {
      child = spawnFn('claude', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32', windowsHide: true });
    } catch {
      resolvePromise(false);
      return;
    }

    let settled = false;
    child.on('error', () => {
      if (settled) return;
      settled = true;
      resolvePromise(false);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      resolvePromise(code === 0);
    });
  });
}

/**
 * Returns a callable `isClaudeOnPath(spawnFn?)` closure with its own
 * private cache -- see this file's header doc comment for why a factory,
 * not a bare exported function with a module-level `let`.
 */
export function createClaudeOnPathProbe(): (spawnFn?: ProbeSpawnFn) => Promise<boolean> {
  let cached: boolean | null = null;
  return async (spawnFn: ProbeSpawnFn = defaultProbeSpawnFn): Promise<boolean> => {
    if (cached !== null) return cached;
    cached = await probeClaudeOnPath(spawnFn);
    return cached;
  };
}
