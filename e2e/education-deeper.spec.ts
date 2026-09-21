// EDU-05's second rung, proved against a real daemon and a real browser --
// same discipline as education-cards.spec.ts (see that file's own header
// comment for why: the fixture harness that let Phase 6's dead click path
// slip past 617 passing tests has since been deleted). This file drives a
// real Explain click, answers it, drives a real "Go deeper" click off the
// resulting card, answers THAT dispatch too, and asserts both answers land
// in the SAME single card -- never two.
// MIGRATED to the chrome review rail. These assertions used to read the
// floating in-artifact card (`.illum-card`, inside the iframe). The rail now
// owns card bodies (`illuminate:setCardPresentation`), so the user-visible
// surface for every claim below is `.il-card` on the TOP-LEVEL page. The
// dispatch/answer orchestration is unchanged -- only where the result is
// read from moved.
import { test, expect, type Page, type FrameLocator, type Locator } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { anchorHash } from '../src/provenance/hash.ts';
import { startRealSession, stopRealSession, openRealChromeShell, type RealSessionContext } from './real-daemon.ts';

const WIDGET_FILE = 'widget.ts';
const WIDGET_CONTENT = 'export function widget(): string {\n  return "hello from the education-deeper fixture";\n}\n';
const WIDGET_ANCHOR_HASH = anchorHash(WIDGET_CONTENT);

// Deliberately a full-width block element (an `<h1>`, no sibling narrowing
// its own rendered width) -- this is the exact shape that exposed cards.ts's
// own unclamped `positionAt` (see this plan's SUMMARY: any anchor whose
// right edge already sits at/near the viewport's own right edge pushed the
// ENTIRE card off-screen). Kept as the fixture's only element, on purpose,
// so this test doubles as that fix's own regression proof.
const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Education Deeper Fixture</title></head>
  <body>
    <h1 id="heading" data-src="${WIDGET_FILE}" data-anchor-hash="${WIDGET_ANCHOR_HASH}">
      Anchored heading -- Explain, then Go deeper, both grounded here
    </h1>
  </body>
</html>
`;

let ctx: RealSessionContext;

test.beforeAll(async () => {
  ctx = await startRealSession(FIXTURE_HTML);
  // A real, resolvable sibling file under the same (git-less) artifact
  // root -- see education-cards.spec.ts's own header comment for why this
  // avoids the self-referencing-hash chicken-and-egg problem a bare
  // artifact.html anchor would otherwise hit.
  await writeFile(join(ctx.artifactRoot, WIDGET_FILE), WIDGET_CONTENT, 'utf8');
});

test.afterAll(async () => {
  await stopRealSession(ctx);
});

/**
 * Clicks `selector` then "Explain" in the real intent picker, capturing the
 * real `dispatch_id` off the real `POST /api/:key/dispatches` response --
 * mirrors education-cards.spec.ts's own `explainClickDispatchId` exactly.
 */
async function explainClickDispatchId(page: Page, frame: FrameLocator, selector: string): Promise<string> {
  const responsePromise = page.waitForResponse((res) => res.url().includes('/dispatches') && res.request().method() === 'POST');
  await frame.locator(selector).click();
  await frame.locator('.illum-chip', { hasText: 'Explain' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();
  const response = await responsePromise;
  const body = (await response.json()) as { dispatch_id: string };
  return body.dispatch_id;
}

/**
 * Clicks the given card's "Go deeper" button, capturing both the real
 * `dispatch_id` AND the exact `TypedIntentPayload` this codebase's own
 * `POST /api/:key/dispatches` route accepts as its raw request body
 * (server.ts's own doc comment: `POST /api/:key/dispatches --
 * {..TypedIntentPayload} -> 200 {dispatch_id}` -- the body IS the payload,
 * not a wrapper around it).
 */
async function deeperClickDispatch(
  card: Locator,
  page: Page,
): Promise<{ readonly dispatchId: string; readonly payload: Record<string, unknown> }> {
  const responsePromise = page.waitForResponse((res) => res.url().includes('/dispatches') && res.request().method() === 'POST');
  await card.getByRole('button', { name: /Go deeper/ }).click();
  const response = await responsePromise;
  const payload = response.request().postDataJSON() as Record<string, unknown>;
  const body = (await response.json()) as { dispatch_id: string };
  return { dispatchId: body.dispatch_id, payload };
}

/**
 * `POST /api/dispatches/:id/answer` directly -- simulating a subagent, never
 * spawning a real `claude` process. Mirrors education-cards.spec.ts's own
 * `postAnswer` exactly.
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

test('go deeper, clicked from a card, chains onto that same card -- not a second one', async ({ page }) => {
  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);

  // --- Rung 1: Explain ---
  const firstDispatchId = await explainClickDispatchId(page, frame, '#heading');
  await expect(page.locator('.il-card[data-state="pending"]')).toBeVisible({ timeout: 5000 });

  const markerA = 'ILLUM-MARKER-DEEPER-A-3f7c12';
  await postAnswer(ctx.port, firstDispatchId, `${markerA} -- the first-rung answer.`, {
    model: 'edu-deeper-test-model-a',
    tier: 'haiku',
  });

  const card = page.locator('.il-card').filter({ hasText: markerA });
  await expect(card).toContainText(markerA, { timeout: 8000 });
  await expect(page.locator('.il-card')).toHaveCount(1);

  // --- Rung 2: Go deeper, clicked from the rendered card itself -- a real
  // pointer click on a button rendered INSIDE the positioned card, which is
  // exactly what a `.toBeVisible()`/`.toContainText()` assertion alone
  // never proves (both pass regardless of whether an element is actually
  // within the viewport). ---
  const { dispatchId: secondDispatchId, payload } = await deeperClickDispatch(card, page);

  expect(payload.intent).toBe('deeper');
  expect(payload.parent_dispatch).toBe(firstDispatchId);
  expect(payload.depth).toBe(2);
  expect(secondDispatchId).not.toBe(firstDispatchId);

  const markerB = 'ILLUM-MARKER-DEEPER-B-9a04e8';
  await postAnswer(ctx.port, secondDispatchId, `${markerB} -- the chained, second-rung answer.`, {
    model: 'edu-deeper-test-model-b',
    tier: 'sonnet',
  });

  // Both markers must land inside the SAME card -- not two separate cards.
  await expect(card).toContainText(markerB, { timeout: 8000 });
  await expect(card).toContainText(markerA);
  await expect(page.locator('.il-card')).toHaveCount(1);

  const cardText = await card.innerText();
  expect(cardText).toContain('edu-deeper-test-model-a');
  expect(cardText).toContain('edu-deeper-test-model-b');
});
