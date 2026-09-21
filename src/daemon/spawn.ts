import { spawn } from 'node:child_process';

/**
 * Spawns a detached daemon process using the platform-correct flag
 * combination, returning the child's pid synchronously — this call never
 * waits for the child to finish starting up.
 *
 * `detached: true` on every platform, plus `windowsHide: true` on win32,
 * `stdio: 'ignore'`, and `.unref()`.
 *
 * win32 previously used `detached: false` here, to avoid the visible console
 * window that Node's own canonical daemon example produces
 * [nodejs/node#21825]. That traded LIFE-01 for LIFE-05 without anyone
 * noticing: `detached: false` ties the child's lifetime to its parent's
 * console, so `illuminate <file>` printed a healthy session URL and the
 * daemon died the instant the CLI process exited. A real run hit
 * ERR_CONNECTION_REFUSED on a URL that had just been served successfully.
 *
 * The two requirements were never actually in tension. `windowsHide: true`
 * is what suppresses the console (it sets `CREATE_NO_WINDOW`); `detached`
 * governs lifetime, not visibility. The docs' example flashes a window
 * because it omits `windowsHide`, not because it sets `detached`. A direct
 * three-way probe on a real Windows host confirmed it:
 *
 *   detached:false + windowsHide  -> dies with parent   (the old behavior)
 *   detached:true  + windowsHide  -> survives, no window (this)
 *   detached:true  alone          -> survives, flashes a window
 *
 * Do not "restore" `detached: false` on win32 to fix a window flash — that
 * reintroduces LIFE-05. If a window ever appears, `windowsHide` is the
 * knob.
 */
export interface SpawnDaemonOptions {
  /**
   * Merged on top of the current process's own `process.env` (never a
   * replacement of it — the child still needs PATH etc. to run Node at
   * all). Narrow, additive escape hatch: Plan 01-08's idle-e2e integration
   * test is what forces this addition (a short, real
   * `ILLUMINATE_IDLE_TIMEOUT_MS` scoped to one spawned child, rather than
   * mutating the whole test process's `process.env`, which is not safe
   * under `node --test`'s own concurrent test execution within one file).
   * Omitting `opts`/`env` entirely reproduces the previous behavior byte
   * for byte: the child inherits `process.env` unmodified.
   */
  env?: NodeJS.ProcessEnv;
}

export function spawnDaemon(entry: string, args: string[], opts: SpawnDaemonOptions = {}): number {
  const isWin = process.platform === 'win32';
  const child = spawn(process.execPath, [entry, ...args], {
    detached: true,
    windowsHide: isWin,
    stdio: 'ignore',
    ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
  });
  child.unref();
  if (child.pid === undefined) throw new Error('daemon spawn failed to obtain a pid');
  return child.pid;
}
