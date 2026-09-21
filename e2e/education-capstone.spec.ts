// 07-09's own capstone proof: the two EDU-04 properties no earlier plan in
// this phase exercises against a real daemon and a real browser -- a card
// surviving genuine artifact REGENERATION (moved into the unattached-notes
// drawer, never deleted) and a card surviving a full DAEMON RESTART with
// the machine-local session-store ledger wiped ("reopening the artifact
// the next day," ROADMAP.md's own phrase; the ordinary-reload half of
// EDU-04 is already proven by education-cards.spec.ts). Same real-daemon,
// real-browser discipline as every other e2e/education-*.spec.ts file in
// this phase -- see education-cards.spec.ts's own header comment for why:
// the fixture harness that let Phase 6's dead click path slip past 617
// passing tests has since been deleted.
// MIGRATED to the chrome review rail. These assertions used to read the
// floating in-artifact card (`.illum-card`, inside the iframe). The rail now
// owns card bodies (`illuminate:setCardPresentation`), so the user-visible
// surface for every claim below is `.il-card` on the TOP-LEVEL page. The
// dispatch/answer orchestration is unchanged -- only where the result is
// read from moved.
import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import { writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anchorHash } from '../src/provenance/hash.ts';
import { ensureDaemonRunning } from '../src/daemon/orchestrate.ts';
import { readLock, isPidAlive } from '../src/daemon/lock.ts';
import { lockPathFor } from '../src/daemon/state-dir.ts';
import { sessionStorePathFor } from '../src/store/session-store.ts';
import { startRealSession, stopRealSession, openRealChromeShell, gotoRealSessionShell, type RealSessionContext } from './real-daemon.ts';
import { forceRemove } from '../test/fixtures/cleanup.ts';

const WIDGET_FILE = 'widget.ts';
const WIDGET_CONTENT = 'export function widget(): string {\n  return "hello from the education-capstone fixture";\n}\n';
const WIDGET_ANCHOR_HASH = anchorHash(WIDGET_CONTENT);

/**
 * `POST /api/dispatches/:id/answer` directly -- simulating a subagent,
 * never spawning a real `claude` process. Mirrors education-cards.spec.ts's
 * own `postAnswer` exactly.
 */
async function postAnswer(
  port: number,
  dispatchId: string,
  markdown: string,
  opts: { readonly model: string; readonly tier: 'haiku' | 'sonnet' | 'opus' },
): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/dispatches/${dispatchId}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      markdown,
      model: opts.model,
      tier: opts.tier,
      tokensIn: 42,
      tokensOut: 84,
      cacheReadInputTokens: 0,
      costUsd: 0.0012,
      wallMs: 250,
      verdict: null,
      decidingLines: null,
    }),
  });
  if (res.status !== 200) {
    throw new Error(`answer POST failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Clicks `selector` then "Explain" in the real intent picker, capturing the
 * real `dispatch_id` off the real `POST /api/:key/dispatches` response --
 * mirrors education-cards.spec.ts's own `explainClickDispatchId` exactly.
 */
async function explainClickDispatchId(page: Page, frame: FrameLocator, selector: string): Promise<string> {
  const responsePromise = page.waitForResponse(
    (res) => res.url().includes('/dispatches') && res.request().method() === 'POST',
  );
  await frame.locator(selector).click({ button: 'right' });
  await frame.locator('.illum-chip', { hasText: 'Explain' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();
  const response = await responsePromise;
  const body = (await response.json()) as { dispatch_id: string };
  return body.dispatch_id;
}

test.describe('regeneration', () => {
  const REGEN_MARKER = 'ILLUM-MARKER-REGEN-7d31ac';

  const ORIGINAL_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Capstone Regeneration Fixture</title></head>
  <body>
    <h1 id="heading" data-src="${WIDGET_FILE}" data-anchor-hash="${WIDGET_ANCHOR_HASH}">
      Anchored heading -- this exact element will be gone after regeneration
    </h1>
  </body>
</html>
`;

  // Deliberately shares NO text, no data-src, no structural overlap with
  // ORIGINAL_HTML above -- a genuine regeneration (different heading text
  // AND tag, no anchor at all), not a cosmetic edit. Still a normal,
  // SDK-injectable HTML document (a real </body> for injectScriptTag to
  // target) -- it just has no anchored elements of its own, which is why
  // this test waits on the drawer toggle (built unconditionally by
  // createCardsController regardless of anchor count) rather than the
  // (deliberately absent) .illum-trigger to prove the SDK actually
  // rebooted against this new content.
  const REGENERATED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Regenerated</title></head>
  <body>
    <p>Completely regenerated content -- nothing here shares any text, tag, or structural position with the prior version.</p>
  </body>
</html>
`;

  let ctx: RealSessionContext;

  test.beforeAll(async () => {
    ctx = await startRealSession(ORIGINAL_HTML);
    // A real, resolvable sibling file under the same (git-less) artifact
    // root -- see education-cards.spec.ts's own header comment for why
    // this avoids the self-referencing-hash chicken-and-egg problem a bare
    // artifact.html anchor would otherwise hit.
    await writeFile(join(ctx.artifactRoot, WIDGET_FILE), WIDGET_CONTENT, 'utf8');
  });

  test.afterAll(async () => {
    await stopRealSession(ctx);
  });

  test('regeneration: an orphaned card moves to the drawer, never deleted', async ({ page }) => {
    const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);
    const dispatchId = await explainClickDispatchId(page, frame, '#heading');
    await expect(page.locator('.il-card[data-state="pending"]')).toBeVisible({ timeout: 5000 });

    await postAnswer(ctx.port, dispatchId, `${REGEN_MARKER} -- the heading exists to anchor this real card.`, {
      model: 'edu-capstone-regen-model',
      tier: 'haiku',
    });

    const card = page.locator('.il-card').filter({ hasText: REGEN_MARKER });
    await expect(card).toContainText(REGEN_MARKER, { timeout: 8000 });

    // The genuine regeneration: overwrite the artifact file on disk with
    // content sharing nothing with the original -- there is no element for
    // this card to reattach to, by construction.
    await writeFile(join(ctx.artifactRoot, 'artifact.html'), REGENERATED_HTML, 'utf8');

    // A fresh, real begin handshake against the SAME session key -- exactly
    // mirroring a real reload -- so the daemon actually re-reads the file
    // it now serves (readArtifactWithFreshnessGuard reads live from disk on
    // every load, never caches). Not openRealChromeShell: the regenerated
    // document has no anchored elements, so no .illum-trigger will ever
    // render for it to wait on.
    const regeneratedLoad = await gotoRealSessionShell(page, ctx.port, ctx.key);
    expect(regeneratedLoad.artifactRevision).toBe(2);
    const regeneratedFrame = page.frameLocator('iframe');

    // Positive control FIRST (this project's own context-isolation
    // discipline, carried over from EDU-02/03's live guard): wait for the
    // drawer to actually receive this card before asserting anything is
    // ABSENT from the page body below -- otherwise an "absent" assertion
    // could pass vacuously because sync simply hasn't run yet, not because
    // reattachment genuinely failed to match.
    // The rail replaced the in-artifact "unattached notes" drawer this
    // assertion used to open. The guarantee is the same one -- an orphaned
    // card is never deleted -- but it is now expressed by the card STAYING
    // in the list rather than moving to a separate corner panel, because a
    // card that disappears from where you last saw it reads as data loss
    // even when nothing was lost.
    const orphanedCard = page.locator('.il-card').filter({ hasText: REGEN_MARKER });
    await expect(orphanedCard).toBeVisible({ timeout: 8000 });

    // (a) Nothing attached to any element in the new document -- there is
    // nothing left for it to attach to, so the artifact carries no floating
    // card and no trigger for this card at all.
    await expect(regeneratedFrame.locator('.illum-card')).toHaveCount(0);

    // (c) The sidecar itself was never touched by the regeneration -- the
    // card's full original thread is still there, unmodified. Fetched
    // directly (not via the drawer's own truncated summary) so this
    // assertion proves the ACTUAL stored content, not a UI paraphrase of it.
    const annotationsRes = await fetch(`http://127.0.0.1:${ctx.port}/api/${ctx.key}/annotations`);
    const annotations = (await annotationsRes.json()) as {
      readonly cards: ReadonlyArray<{ readonly thread: ReadonlyArray<{ readonly markdown: string }> }>;
    };
    const persistedCard = annotations.cards.find((c) => c.thread.some((entry) => entry.markdown.includes(REGEN_MARKER)));
    expect(persistedCard).toBeDefined();
    expect(persistedCard?.thread.some((entry) => entry.markdown === `${REGEN_MARKER} -- the heading exists to anchor this real card.`)).toBe(
      true,
    );
  });
});

test.describe('restart', () => {
  const NO_SELF_DISPATCH_ENV: NodeJS.ProcessEnv = { ILLUMINATE_DISABLE_SELF_DISPATCH: '1' };
  const RESTART_MARKER = 'ILLUM-MARKER-RESTART-e48b13';

  function sleep(ms: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }

  /**
   * Mirrors real-daemon.ts's own `stopRealSession` shutdown sequence
   * (token-checked /shutdown, a bounded wait, SIGTERM fallback) but
   * deliberately does NOT remove `artifactRoot` or anything under it --
   * this test's whole point is to reuse both across the restart. Removing
   * the session-store state file is left to the caller, done explicitly
   * and asserted on directly (see the test body below) rather than
   * silently assumed to have happened as a side effect of this function.
   */
  async function stopDaemonKeepingRoot(artifactRoot: string): Promise<void> {
    const lockPath = lockPathFor(artifactRoot);
    const record = await readLock(lockPath);
    if (!record) return;
    try {
      await fetch(`http://127.0.0.1:${record.port}/shutdown?token=${record.healthToken}`, {
        method: 'POST',
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // Wedged, already gone, or a transient network hiccup -- the
      // isPidAlive poll below is the real source of truth, not this response.
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && isPidAlive(record.pid)) {
      await sleep(25);
    }
    if (isPidAlive(record.pid)) {
      try {
        process.kill(record.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  }

  /** `POST /api/sessions` against an already-running daemon, without
   * rewriting the artifact file -- unlike real-daemon.ts's own
   * `openSessionFile`, this test needs to re-open the SAME on-disk file
   * untouched across the restart, not re-author its content. */
  async function postCreateSession(port: number, file: string): Promise<{ key: string }> {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    return (await res.json()) as { key: string };
  }

  async function fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  test('restart: reopening the artifact the next day still shows every previously-created card', async ({ page }) => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'illum-e2e-capstone-restart-'));
    const artifactFile = join(artifactRoot, 'artifact.html');

    try {
      const html = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Capstone Restart Fixture</title></head>
  <body>
    <h1 id="heading" data-src="${WIDGET_FILE}" data-anchor-hash="${WIDGET_ANCHOR_HASH}">
      Anchored heading -- must still carry its card after a full daemon restart
    </h1>
  </body>
</html>
`;
      await writeFile(artifactFile, html, 'utf8');
      await writeFile(join(artifactRoot, WIDGET_FILE), WIDGET_CONTENT, 'utf8');

      const { port: firstPort } = await ensureDaemonRunning(artifactRoot, { env: NO_SELF_DISPATCH_ENV });
      const { key: firstKey } = await postCreateSession(firstPort, artifactFile);

      const { frame } = await openRealChromeShell(page, firstPort, firstKey);
      const dispatchId = await explainClickDispatchId(page, frame, '#heading');
      await expect(page.locator('.il-card[data-state="pending"]')).toBeVisible({ timeout: 5000 });

      await postAnswer(firstPort, dispatchId, `${RESTART_MARKER} -- must survive a full daemon restart.`, {
        model: 'edu-capstone-restart-model',
        tier: 'sonnet',
      });
      await expect(page.locator('.il-card').filter({ hasText: RESTART_MARKER })).toContainText(RESTART_MARKER, {
        timeout: 8000,
      });

      // A genuine daemon stop -- not merely closing the browser tab.
      await stopDaemonKeepingRoot(artifactRoot);

      // The session-store ledger is wiped explicitly -- mirroring
      // stopRealSession's own documented cleanup step -- and confirmed
      // gone directly, since this whole test's point depends on the
      // ledger being gone, not merely on the daemon process having exited.
      const storePath = sessionStorePathFor(artifactRoot);
      await rm(storePath, { force: true });
      expect(await fileExists(storePath)).toBe(false);

      // A FRESH daemon, same artifact root -- mints a brand-new, empty
      // session-store state file the moment anything reads it
      // (SessionStore.read()'s own ENOENT -> emptyState() behavior); this
      // daemon process has never heard of firstKey/dispatchId in its life.
      const { port: secondPort } = await ensureDaemonRunning(artifactRoot, { env: NO_SELF_DISPATCH_ENV });
      const { key: secondKey } = await postCreateSession(secondPort, artifactFile);

      // sessionKey is a pure function of the artifact's own realpath -- a
      // fresh daemon with a fresh, empty ledger must still derive the
      // IDENTICAL key for the SAME file.
      expect(secondKey).toBe(firstKey);

      // Still called for its side effects (real begin handshake + SDK boot);
      // the frame handle is unused now that the assertions read the rail.
      await openRealChromeShell(page, secondPort, secondKey);
      await expect(page.locator('.il-card').filter({ hasText: RESTART_MARKER })).toContainText(RESTART_MARKER, {
        timeout: 8000,
      });

      await stopDaemonKeepingRoot(artifactRoot);
    } finally {
      await forceRemove(artifactRoot);
    }
  });
});
