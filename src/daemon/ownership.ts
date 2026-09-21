import { isPidAlive, type KillFn, type LockRecord } from './lock.ts';

/**
 * Two-factor result of checking whether a lockfile's recorded pid is still
 * "ours and healthy." Closes the pid-recycling gap `isPidAlive` alone cannot
 * close (RESEARCH.md §2.4): a dead illuminate pid reused by an unrelated
 * process must never be misattributed as ours.
 */
export type OwnershipResult =
  | { status: 'ours-and-healthy' }
  | { status: 'stale-pid-dead' }
  | { status: 'foreign-process-on-recorded-pid' };

/**
 * Two-factor ownership check: pid liveness AND a `/health` token
 * cross-check. A dead pid short-circuits before any network I/O
 * (`stale-pid-dead`). A live pid is not, by itself, sufficient — the health
 * response body must also agree on both `pid` and `healthToken`, which is
 * what defeats pid recycling (a dead illuminate pid reused by an unrelated
 * process) and the `EPERM`-treated-as-alive case from `isPidAlive` (locked
 * decision A2: liveness AND health-token match, both halves required).
 *
 * Do not treat a bare `isPidAlive() === true` as sufficient anywhere else —
 * every call site that needs "is this daemon ours and healthy" goes through
 * this function, never a standalone liveness check.
 */
export async function checkOwnership(
  record: LockRecord,
  opts: { timeoutMs?: number; killFn?: KillFn } = {},
): Promise<OwnershipResult> {
  const { timeoutMs = 500, killFn } = opts;
  if (!isPidAlive(record.pid, killFn)) return { status: 'stale-pid-dead' };

  try {
    const res = await fetch(`http://127.0.0.1:${record.port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { status: 'foreign-process-on-recorded-pid' };
    const body = (await res.json()) as { pid?: number; healthToken?: string };
    if (body.pid === record.pid && body.healthToken === record.healthToken) {
      return { status: 'ours-and-healthy' };
    }
    return { status: 'foreign-process-on-recorded-pid' };
  } catch {
    return { status: 'foreign-process-on-recorded-pid' };
  }
}
