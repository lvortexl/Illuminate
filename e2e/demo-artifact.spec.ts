// MIGRATED to the chrome review rail. These assertions used to read the
// floating in-artifact card (`.illum-card`, inside the iframe). The rail now
// owns card bodies (`illuminate:setCardPresentation`), so the user-visible
// surface for every claim below is `.il-card` on the TOP-LEVEL page. The
// dispatch/answer orchestration is unchanged -- only where the result is
// read from moved.
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureDaemonRunning } from '../src/daemon/orchestrate.ts';
import { openSessionFile, openRealChromeShell } from './real-daemon.ts';
import { lockPathFor } from '../src/daemon/state-dir.ts';
import { readLock } from '../src/daemon/lock.ts';
import { sessionStorePathFor } from '../src/store/session-store.ts';
import { annotationStorePathFor } from '../src/store/annotation-store.ts';
import { rm } from 'node:fs/promises';

/**
 * End-to-end against the REAL `.demo/illuminate-self.html` artifact, driven
 * the way a person drives it: open the page, look for illuminate's own chrome,
 * click an anchored block, pick an action, wait for a card.
 *
 * Distinct from the other specs in two ways that matter:
 *  - it uses the actual shipped demo artifact, not a minimal fixture, so
 *    anything that only breaks on a real 400-line page with 15 anchors is
 *    reachable here;
 *  - self-dispatch is LEFT ENABLED. Every other spec sets
 *    ILLUMINATE_DISABLE_SELF_DISPATCH=1, which means the path that actually
 *    produces an answer for a user running the CLI standalone -- spawning
 *    `claude -p` -- had no end-to-end coverage at all. A card stuck on
 *    "thinking" forever is exactly the failure that gap allows.
 */

const ARTIFACT = fileURLToPath(new URL('../.demo/illuminate-self.html', import.meta.url));
const ARTIFACT_DIR = fileURLToPath(new URL('../.demo/', import.meta.url));

test.describe('the real demo artifact, with self-dispatch live', () => {
  // This spec runs a daemon on the REAL `.demo` directory rather than a temp
  // fixture, and that makes teardown different from every other spec here.
  //
  // Do NOT reuse `stopRealSession`: its last act is `forceRemove(artifactRoot)`,
  // which is correct for the temp fixtures it was written for and would delete
  // the checked-in `.demo` directory outright -- artifact, guide and tooling.
  //
  // Only the port needs handing back. Leaving the daemon alive leaks into the
  // rest of the suite: bind.test.ts and orchestrate's port-range tests assert
  // the probe range is FREE and fail if anything is still listening.
  /**
   * Start from a clean session, every time.
   *
   * Every other spec gets this for free by running against a fresh temp dir.
   * This one uses the real `.demo` directory, so its session store PERSISTS
   * between runs -- and a persisted store makes this spec order-dependent in a
   * way that looks exactly like the bug it tests for:
   *
   *   `enqueueDispatch` dedupes an identical element+intent against an
   *   already-ANSWERED dispatch. Once a previous run has answered "explain"
   *   for the first anchored block, a later run's click is pointed at that
   *   answer instead of producing a fresh one.
   *
   * That is correct behaviour -- an answer came back, so there is nothing to
   * re-ask (a dispatch that went unanswered IS re-opened by a retry now; see
   * dispatch-ledger.ts's `shouldReopen`). But it would make this spec assert
   * against a previous run's work rather than this one's. Reset first.
   */
  test.beforeAll(async () => {
    await shutdownDaemon();
    await rm(sessionStorePathFor(ARTIFACT_DIR), { force: true });
    await rm(lockPathFor(ARTIFACT_DIR), { force: true });
    await rm(annotationStorePathFor(ARTIFACT), { force: true });
  });

  // Only the port is handed back -- never `stopRealSession`, whose last act is
  // `forceRemove(artifactRoot)`. Correct for the temp fixtures it was written
  // for, destructive here, where the artifact root is the checked-in `.demo`
  // directory. Leaving the daemon alive also leaks into the rest of the suite:
  // bind.test.ts and orchestrate's port tests assert the probe range is free.
  test.afterAll(shutdownDaemon);

  async function shutdownDaemon(): Promise<void> {
    try {
      const record = await readLock(lockPathFor(ARTIFACT_DIR));
      if (!record) return;
      await fetch(`http://127.0.0.1:${record.port}/shutdown?token=${record.healthToken}`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      });
      // Give the listener a moment to actually release the port.
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      // Already gone, or wedged. Either way this is teardown, not an assertion.
    }
  }

  test('illuminate chrome renders, an anchored block is actionable, and Explain resolves to a card', async ({ page }) => {
    test.setTimeout(240_000);

    const html = readFileSync(ARTIFACT, 'utf8');
    // Self-dispatch failures are otherwise unobservable: the daemon spawns
    // with stdio:'ignore', so the adapter's reason for giving up goes nowhere
    // and the only symptom is a card stuck on "thinking…". Route it to a file
    // so a failure here reports WHY instead of just "never resolved".
    const logFile = fileURLToPath(new URL('../.demo/selfdispatch.log', import.meta.url));
    const { port } = await ensureDaemonRunning(ARTIFACT_DIR, { env: { ILLUMINATE_LOG_FILE: logFile } });
    const { key } = await openSessionFile({ port, artifactRoot: ARTIFACT_DIR }, 'illuminate-self.html', html);

    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    // The pending "thinking…" card is rendered optimistically, the moment the
    // intent is posted -- it does NOT prove the dispatch reached the daemon.
    // Record the API traffic so a stuck card can be told apart from a rejected
    // or never-sent request.
    const api: string[] = [];
    page.on('requestfailed', (r) => api.push(`FAILED ${r.method()} ${r.url()} -- ${r.failure()?.errorText ?? '?'}`));
    page.on('response', (r) => {
      if (r.url().includes('/api/')) api.push(`${r.status()} ${r.request().method()} ${r.url()}`);
    });

    const { frame } = await openRealChromeShell(page, port, key);

    // --- 1. The artifact itself rendered -------------------------------------
    await expect(frame.locator('h1')).toContainText('illuminate');

    // --- 2. illuminate's own chrome is present -------------------------------
    // Every anchored element must get a keyboard-reachable trigger. The demo
    // artifact has 15 anchors; if the SDK booted, there are 15 triggers.
    const triggers = frame.locator('.illum-trigger');
    await expect
      .poll(async () => triggers.count(), { timeout: 15_000, message: 'SDK never decorated the anchored blocks' })
      .toBeGreaterThan(0);
    const triggerCount = await triggers.count();
    expect(triggerCount, 'one trigger per anchored block').toBe(15);

    // The findings drawer toggle is the persistent piece of chrome -- the
    // closest thing this UI has to a "sidebar".
    await expect(page.locator('#il-tab-findings')).toHaveCount(1);

    expect(consoleErrors, 'the artifact must boot with no console errors').toEqual([]);

    // --- 3. Clicking an anchored block opens the intent picker ---------------
    // Triggers are `position: fixed`, positioned from the anchor's live
    // getBoundingClientRect and repositioned on scroll. A human scrolling the
    // page moves them into place; Playwright's auto-scroll cannot, because
    // scrolling a fixed element into view is a no-op. So scroll the ANCHOR,
    // let the SDK's scroll handler run, then click.
    const anchor = frame.locator('[data-src]').first();
    await anchor.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    await triggers.first().click();
    const picker = frame.locator('.illum-composer');
    await expect(picker).toBeVisible({ timeout: 10_000 });

    // --- 4. Choosing Explain produces a pending card ------------------------
    await picker.locator('.illum-chip').filter({ hasText: 'Explain' }).first().click();
    await picker.locator('.illum-composer-actions button').filter({ hasText: 'Send' }).click();

    // The immediate placeholder. Its presence proves the intent was posted and
    // the SDK accepted it -- everything after this is the answer round trip.
    await expect(page.locator('.il-card[data-state="pending"]')).toBeVisible({ timeout: 15_000 });

    // --- 5. ...and that card RESOLVES ---------------------------------------
    // The actual regression: a card must not sit on "thinking…" forever.
    // Self-dispatch shells out to a real `claude -p`, so allow a generous
    // real-model budget -- but not an unbounded one.
    // Explicitly NOT `.il-card` alone. The rail renders a pending row and a
    // real answer with the same class, told apart by `data-state` -- so a
    // bare `.il-card` locator matches the placeholder that is already on
    // screen and this wait passes instantly, making the assertion that
    // follows the only real check and this one pure decoration. The whole
    // point of this test is that a card does not sit on "thinking..."
    // forever, so it has to wait for a card that is NOT pending.
    const card = page.locator('.il-card:not([data-state="pending"])').first();
    try {
      await expect(card).toBeVisible({ timeout: 180_000 });
    } catch (err) {
      // A bare "never became visible" is what made this class of bug so slow
      // to diagnose. Report what the daemon actually saw instead.
      const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '(self-dispatch logged nothing -- it was never attempted)';
      throw new Error(
        [
          'the pending card never became a real answer card.',
          '',
          'API traffic:',
          ...api.map((line) => '  ' + line),
          '',
          'self-dispatch log:',
          log,
          '',
          `Original: ${String(err)}`,
        ].join('\n'),
      );
    }
    await expect(page.locator('.il-card[data-state="pending"]')).toHaveCount(0);

    const answer = (await card.innerText()).trim();
    expect(answer.length, 'the resolved card must carry real answer prose').toBeGreaterThan(40);
    expect(answer, 'the answer must not just echo the placeholder').not.toMatch(/^thinking/i);
  });
});
