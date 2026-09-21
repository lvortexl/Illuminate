/**
 * The one temp-directory teardown helper for this codebase's tests.
 *
 * Windows fails `rmdir` with `EBUSY`/`EPERM` when anything still holds a
 * handle on the directory — Defender or the Search Indexer racing the many
 * `mkdtemp`+`rmdir` cycles a test file performs, a git child process that has
 * not fully exited, or a fire-and-forget async scan the test did not await.
 * `fs.rm` defaults `maxRetries` to **0**, so it throws on the first collision
 * rather than waiting the moment out.
 *
 * This existed as ELEVEN separate near-identical copies across the suite,
 * with another ~30 call sites using a bare `rm` and flaking accordingly. One
 * copy means one place to tune the backoff when a new Windows behaviour shows
 * up, and no test file that silently missed the fix.
 *
 * Deliberately swallows nothing: after the final attempt the original error
 * is rethrown, so a genuine teardown bug still fails its test rather than
 * hiding behind a retry loop.
 */
import { rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';

const ATTEMPTS = 10;
const BACKOFF_MS = 25;

export async function forceRemove(path: string): Promise<void> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      return;
    } catch (err) {
      if (attempt === ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
    }
  }
}

/**
 * The synchronous form, for `t.after(() => ...)` teardown that cannot await.
 *
 * Needed for its own reasons, not merely for symmetry: the sync call sites in
 * this suite are overwhelmingly git FIXTURE REPOS, and a `git` subprocess that
 * has just exited can still hold a handle on its working directory for a few
 * milliseconds on Windows — the single likeliest source of a teardown EBUSY
 * anywhere in this codebase. `rmSync` honours `maxRetries`/`retryDelay` with a
 * synchronous busy-wait, so the bounded retry works here too.
 */
export function forceRemoveSync(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
