import type { PollResponse } from '../router/types.ts';

/** Sleep ladder for consecutive `browser_disconnected` responses (ADR-108). */
export const FOLLOW_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000];

export type FollowAction =
  | { readonly kind: 'continue' }
  | { readonly kind: 'sleep'; readonly ms: number; readonly notice: string | null }
  | { readonly kind: 'exit'; readonly code: number; readonly message: string };

/**
 * What `illuminate poll --follow` does after one poll response. Pure, so the
 * loop's end states are testable without a daemon (RT-01: the loop used to
 * ignore `status` entirely and spun at full speed once the browser was gone
 * or the session had ended, rewriting the session file every iteration).
 *
 * A closed tab is the middle of a review session, not its end, so
 * `browser_disconnected` keeps the harness attached and backs off; `ended`
 * is a real terminal state and the harness returns.
 */
export function nextFollowAction(status: PollResponse['status'], consecutiveDisconnects: number): FollowAction {
  if (status === 'dispatch' || status === 'waiting') return { kind: 'continue' };
  if (status === 'ended') return { kind: 'exit', code: 0, message: 'illuminate poll: the session has ended' };
  const index = Math.min(consecutiveDisconnects, FOLLOW_BACKOFF_MS.length - 1);
  const ms = FOLLOW_BACKOFF_MS[index] ?? FOLLOW_BACKOFF_MS[FOLLOW_BACKOFF_MS.length - 1] ?? 8000;
  return {
    kind: 'sleep',
    ms,
    notice: consecutiveDisconnects === 0 ? 'illuminate poll: the browser is not connected; staying attached and backing off' : null,
  };
}
