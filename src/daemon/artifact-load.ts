import type { SessionStore, SessionRecord } from '../store/session-store.ts';
import { verifyArtifactLoad } from './load-token.ts';

export interface ReadArtifactOptions {
  store: SessionStore;
  key: string;
  artifactLoadToken: string;
  artifactRevision: number;
  /** Injectable for deterministic race testing -- mirrors this project's
   * established injectable-failure pattern (RenameFn in session-store.ts,
   * KillFn in ownership.ts). A test double can mutate the store from
   * inside this callback to simulate "someone else began a new load while
   * this read was in flight" without depending on real timing. */
  readFile: (path: string) => Promise<string>;
}

export type ReadArtifactResult =
  | { status: 'ok'; record: SessionRecord; html: string }
  | { status: 'not-found' }
  | { status: 'expired' };

/**
 * SERVE-08's race-free freshness guard: verifies the (artifactLoadToken,
 * artifactRevision) pair against the session's CURRENT record BEFORE
 * `readFile`, and AGAIN after -- any beginArtifactLoad landing in between
 * (a second tab reloading, a supersession) changes both the token and the
 * revision, so either check failing independently is sufficient to catch
 * it. The before-check is a true gate, not a formality: `readFile` is never
 * called at all when it fails.
 */
export async function readArtifactWithFreshnessGuard(opts: ReadArtifactOptions): Promise<ReadArtifactResult> {
  const before = await opts.store.read();
  const record = before.sessions[opts.key];
  if (!record) return { status: 'not-found' };
  if (!verifyArtifactLoad(record, opts.artifactLoadToken, opts.artifactRevision)) return { status: 'expired' };

  const html = await opts.readFile(record.file);

  const after = await opts.store.read();
  if (!verifyArtifactLoad(after.sessions[opts.key], opts.artifactLoadToken, opts.artifactRevision)) {
    return { status: 'expired' };
  }
  return { status: 'ok', record, html };
}
