import { randomBytes } from 'node:crypto';
import type { IlluminateState, SessionRecord } from '../store/session-store.ts';

/**
 * Every mutating export here matches SessionStore.mutate()'s exact
 * callback shape by construction -- Plan 03-03 calls these as
 * `store.mutate(state => openChromeSession(state, key))` with no adapter
 * code needed.
 */
export type MutateResult<T> = { next: IlluminateState; result: T };

/**
 * 192 bits of crypto randomness (T-03-04) -- not a counter, not
 * predictable, so a local process cannot guess a live token to hijack a
 * session's artifact-loads/begin call.
 */
export function issueChromeLoadToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * GET /session/:key's mint step. Last-writer-wins by construction: every
 * call mints and stores a NEW chromeLoadToken, unconditionally replacing
 * whatever tab last held it -- this is SERVE-09's supersession mechanism,
 * and it is symmetric: a superseded tab can call this itself to take the
 * session back (T-03-05).
 */
export function openChromeSession(
  state: IlluminateState,
  key: string,
): MutateResult<{ status: 'ok'; chromeLoadToken: string } | { status: 'not-found' }> {
  const record = state.sessions[key];
  if (!record) return { next: state, result: { status: 'not-found' } };
  const chromeLoadToken = issueChromeLoadToken();
  const next: IlluminateState = {
    ...state,
    sessions: { ...state.sessions, [key]: { ...record, chromeLoadToken } },
  };
  return { next, result: { status: 'ok', chromeLoadToken } };
}

/**
 * POST /artifact-loads/begin's mint step. The caller-asserted
 * chromeLoadToken is checked against the session's CURRENT stored value,
 * never the one initially issued to that caller (T-03-05) -- a stale tab's
 * begin call is provably rejected as 'superseded', not silently honored.
 * On success, bumps artifactRevision and mints a fresh artifactLoadToken:
 * together they are the freshness guard's two halves (SERVE-08),
 * independently re-verifiable via verifyArtifactLoad.
 */
export function beginArtifactLoad(
  state: IlluminateState,
  key: string,
  chromeLoadToken: string,
): MutateResult<
  | { status: 'ok'; artifactLoadToken: string; artifactRevision: number }
  | { status: 'superseded' }
  | { status: 'not-found' }
> {
  const record = state.sessions[key];
  if (!record) return { next: state, result: { status: 'not-found' } };
  if (record.chromeLoadToken !== chromeLoadToken) return { next: state, result: { status: 'superseded' } };
  const artifactLoadToken = issueChromeLoadToken();
  const artifactRevision = record.artifactRevision + 1;
  const next: IlluminateState = {
    ...state,
    sessions: { ...state.sessions, [key]: { ...record, artifactLoadToken, artifactRevision } },
  };
  return { next, result: { status: 'ok', artifactLoadToken, artifactRevision } };
}

/**
 * The double-read guard's actual mechanism: a caller re-verifies the
 * (token, revision) pair it observed at read time against whatever the
 * CURRENT record now holds. Any beginArtifactLoad that landed in between
 * changes both the token and the revision, so either comparison failing
 * independently is sufficient to detect it. `record` may be undefined (a
 * session that no longer exists) so callers never need a separate
 * not-found check before calling this.
 */
export function verifyArtifactLoad(
  record: SessionRecord | undefined,
  artifactLoadToken: string,
  artifactRevision: number,
): boolean {
  if (!record) return false;
  return record.artifactLoadToken === artifactLoadToken && record.artifactRevision === artifactRevision;
}
