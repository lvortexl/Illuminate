// 07-05's own real-browser, real-daemon proof: the plan where EDU-01
// ("renders as a card") and the ordinary-reload half of EDU-04 become
// observable to an actual human for the first time. Per this phase's own
// hard-won lesson (Phase 6 had 617 passing tests while the real click path
// was dead in a real browser -- the fixture harness that let that slip has
// since been deleted), this file drives a real daemon subprocess and a real
// Chromium instance -- e2e/real-daemon.ts -- never a fixture stand-in.
//
// Anchoring pattern mirrors test/cli-answer.test.ts's own proven approach:
// a real sibling file, written directly into the real (git-less) temp
// artifact root via node:fs/promises, addressed by a real anchorHash
// (src/provenance/hash.ts) computed over its own exact content -- so
// resolve.ts's no-git degraded path serves genuine, resolvable content
// (T-02-01/02) without needing a git fixture repo. `data-rev` is
// deliberately omitted (unpinned, `rev: null`), the same happy path
// test/cli-answer.test.ts's own passing anchor already exercises.
// MIGRATED to the chrome review rail. These assertions used to read the
// floating in-artifact card (`.illum-card`, inside the iframe). The rail now
// owns card bodies (`illuminate:setCardPresentation`), so the user-visible
// surface for every claim below is `.il-card` on the TOP-LEVEL page. The
// dispatch/answer orchestration is unchanged -- only where the result is
// read from moved.
import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { anchorHash } from '../src/provenance/hash.ts';
import { startRealSession, stopRealSession, openRealChromeShell, type RealSessionContext } from './real-daemon.ts';

const WIDGET_FILE = 'widget.ts';
const WIDGET_CONTENT = 'export function widget(): string {\n  return "hello from the education-cards fixture";\n}\n';
const WIDGET_ANCHOR_HASH = anchorHash(WIDGET_CONTENT);

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Education Cards Fixture</title></head>
  <body>
    <h1 id="heading" data-src="${WIDGET_FILE}" data-anchor-hash="${WIDGET_ANCHOR_HASH}">
      Anchored heading -- a real Explain click on this renders a card next to it
    </h1>
    <p id="second" data-src="${WIDGET_FILE}" data-anchor-hash="${WIDGET_ANCHOR_HASH}">
      A second, independently-anchored element -- used by the reload-persistence proof
    </p>
  </body>
</html>
`;

let ctx: RealSessionContext;

test.beforeAll(async () => {
  ctx = await startRealSession(FIXTURE_HTML);
  // A real, resolvable sibling file under the same (git-less) artifact
  // root -- see this file's own header comment for why this avoids the
  // self-referencing-hash chicken-and-egg problem a bare artifact.html
  // anchor would otherwise hit.
  await writeFile(join(ctx.artifactRoot, WIDGET_FILE), WIDGET_CONTENT, 'utf8');
});

test.afterAll(async () => {
  await stopRealSession(ctx);
});

/**
 * Clicks `selector` then "Explain" in the real intent picker, capturing the
 * real `dispatch_id` off the real `POST /api/:key/dispatches` response --
 * simpler than intercepting the `illuminate:dispatchCreated` postMessage
 * relay, and deliberately independent of it: this technique's own success
 * does not depend on Plan 07-04's relay working, so the pending-card
 * assertion that follows is what actually proves that relay end to end.
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

/**
 * `POST /api/dispatches/:id/answer` directly -- simulating a subagent,
 * exactly as Plan 07-04's own tests do (test/daemon/annotations-route.
 * test.ts). Never spawns a real `claude` process. Node's own global
 * `fetch`, called directly from this test process (not `page.evaluate`),
 * sends no `Origin` header -- `isSameOriginRequest` treats an absent
 * Origin as same-origin (containment.ts), exactly the same posture a real
 * subagent's own HTTP client has.
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

test('explain click renders a pending card, then fills in once answered', async ({ page }) => {
  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);

  const dispatchId = await explainClickDispatchId(page, frame, '#heading');

  // This assertion is what actually proves Plan 07-04's dispatchCreated
  // relay works, end to end, in a real browser: the pending placeholder
  // only ever renders via that relay reaching cardsController.renderPendingCard.
  await expect(page.locator('.il-card[data-state="pending"]')).toBeVisible({ timeout: 5000 });

  const marker = 'ILLUM-MARKER-EXPLAIN-8f2a91';
  await postAnswer(ctx.port, dispatchId, `${marker} -- the heading exists to anchor this real card.`, {
    model: 'edu-cards-test-model',
    tier: 'haiku',
  });

  // Wait up to the heartbeat window (chrome-client.js's real 5s
  // HEARTBEAT_INTERVAL_MS) for the next illuminate:syncAnnotations tick to
  // land and reconcile the pending placeholder into the real card.
  // `.filter({ hasText })` (not a bare `.illum-card` locator): this session
  // accumulates one card per test in this file, so a later test's own
  // `.illum-card` count is never exactly one -- scoping by this test's own
  // unique marker is what keeps each assertion pointed at ITS card.
  const card = page.locator('.il-card').filter({ hasText: marker });
  await expect(card).toContainText(marker, { timeout: 8000 });

  // The pending placeholder must have been REPLACED, never stacked
  // alongside the real card (cards.ts's own no-duplicate contract).
  await expect(page.locator('.il-card[data-state="pending"]')).toHaveCount(0);

  const cardText = await card.first().innerText();
  expect(cardText).toContain('edu-cards-test-model');
  expect(cardText).toContain('haiku');
  expect(cardText).toContain(WIDGET_FILE);
});

test('a card survives an ordinary page reload', async ({ page }) => {
  const { frame: frameBeforeReload } = await openRealChromeShell(page, ctx.port, ctx.key);
  const dispatchId = await explainClickDispatchId(page, frameBeforeReload, '#second');

  const marker = 'ILLUM-MARKER-RELOAD-c91d47';
  await postAnswer(ctx.port, dispatchId, `${marker} -- reload persistence proof.`, {
    model: 'edu-cards-reload-model',
    tier: 'sonnet',
  });

  await expect(page.locator('.il-card').filter({ hasText: marker })).toContainText(marker, {
    timeout: 8000,
  });

  // A genuine reload: a fresh, real begin handshake (GET /session/:key +
  // POST .../artifact-loads/begin) against the SAME session key, driven by
  // gotoRealSessionShell's own page.goto -- exactly mirroring a real user
  // reloading the page. No second Explain click; no second
  // POST /api/:key/dispatches anywhere in this test after the one above --
  // the reload alone, via GET /api/:key/annotations + reattachment, is
  // what must produce the card below. This session also still carries the
  // OTHER test's own card (the shared ctx.key session accumulates one per
  // test in this file) -- `.filter({ hasText })` is what proves THIS
  // card, not merely "some card", survived the reload.
  // The call still matters for its side effects -- it performs the real
  // begin handshake and waits for the SDK to boot; only the frame handle is
  // unused now that the assertions read the rail on the top-level page.
  await openRealChromeShell(page, ctx.port, ctx.key);
  await expect(page.locator('.il-card').filter({ hasText: marker })).toContainText(marker, {
    timeout: 8000,
  });
});
