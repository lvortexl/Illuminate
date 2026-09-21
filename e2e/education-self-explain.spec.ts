// EDU-06's own real-browser, real-daemon proof -- same discipline as
// education-cards.spec.ts/education-deeper.spec.ts (see either file's own
// header comment for why: the fixture harness that let Phase 6's dead click
// path slip past 617 passing tests has since been deleted). This file
// proves three things a unit test alone cannot: (1) the "Check my
// understanding" affordance genuinely does not exist anywhere before any
// card does -- the non-interruption guarantee this whole plan exists to
// preserve; (2) opening the box alone never posts anything, and the submit
// control stays disabled until real text is typed; (3) typing real text and
// submitting dispatches a learner-graded explain, chained via
// parent_dispatch onto the SAME card, not a second one.
//
// This file's own first real run surfaced a genuine production bug this
// plan's own brief warned would be found: `computeDedupeKey`
// (src/daemon/dispatch-ledger.ts) did not include `learnerNote`, so a
// self-explanation dispatch -- a second `explain` intent on the exact same
// element/resolved content an ordinary Explain click already produced --
// silently deduped against (and was discarded in favor of) the original,
// already-answered explain. Fixed at the root (dispatch-ledger.ts, its own
// commit) before this file was written against it -- no workaround kept
// here.
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
const WIDGET_CONTENT = 'export function widget(): string {\n  return "hello from the education-self-explain fixture";\n}\n';
const WIDGET_ANCHOR_HASH = anchorHash(WIDGET_CONTENT);

// Two independently-anchored elements (same discipline as
// education-cards.spec.ts's own `#heading`/`#second` pair): each test that
// creates its own card uses a DIFFERENT element, so its own ordinary Explain
// dispatch never collides, via computeDedupeKey, with another test's.
const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Education Self-Explain Fixture</title></head>
  <body>
    <h1 id="heading" data-src="${WIDGET_FILE}" data-anchor-hash="${WIDGET_ANCHOR_HASH}">
      Anchored heading -- used by the disabled-submit / no-post-on-open proof
    </h1>
    <p id="second" data-src="${WIDGET_FILE}" data-anchor-hash="${WIDGET_ANCHOR_HASH}">
      A second, independently-anchored element -- used by the real submit/grading proof
    </p>
  </body>
</html>
`;

let ctx: RealSessionContext;

test.beforeAll(async () => {
  ctx = await startRealSession(FIXTURE_HTML);
  await writeFile(join(ctx.artifactRoot, WIDGET_FILE), WIDGET_CONTENT, 'utf8');
});

test.afterAll(async () => {
  await stopRealSession(ctx);
});

/**
 * Clicks `selector` then "Explain" in the real intent picker, capturing the
 * real `dispatch_id` off the real `POST /api/:key/dispatches` response --
 * mirrors education-cards.spec.ts's/education-deeper.spec.ts's own
 * `explainClickDispatchId` exactly.
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
 * `POST /api/dispatches/:id/answer` directly -- simulating a subagent, never
 * spawning a real `claude` process. Mirrors education-cards.spec.ts's/
 * education-deeper.spec.ts's own `postAnswer` exactly.
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

/** Creates a real, answered card by clicking Explain on `selector`, waiting
 * for the pending placeholder, posting a synthetic answer carrying `marker`,
 * then waiting for the real card to render it. Returns the card's own
 * dispatch id and a Locator scoped to that one card. */
async function createAnsweredCard(
  page: Page,
  frame: FrameLocator,
  selector: string,
  marker: string,
): Promise<{ readonly dispatchId: string; readonly card: Locator }> {
  const dispatchId = await explainClickDispatchId(page, frame, selector);
  await expect(page.locator('.il-card[data-state="pending"]')).toBeVisible({ timeout: 5000 });
  await postAnswer(ctx.port, dispatchId, `${marker} -- the original explanation.`, {
    model: 'edu-self-explain-test-model-original',
    tier: 'haiku',
  });
  const card = page.locator('.il-card').filter({ hasText: marker });
  await expect(card).toContainText(marker, { timeout: 8000 });
  return { dispatchId, card };
}

// ---------------------------------------------------------------------------
// Test 1 -- the load-bearing non-interruption proof. Runs FIRST, before any
// card exists anywhere in this session: no Explain click has happened yet.
// Do not weaken or skip this test.
// ---------------------------------------------------------------------------

test('the "Check my understanding" affordance does not exist before any card exists', async ({ page }) => {
  // The call still matters for its side effects -- it performs the real
  // begin handshake and waits for the SDK to boot; only the frame handle is
  // unused now that the assertions read the rail on the top-level page.
  await openRealChromeShell(page, ctx.port, ctx.key);

  await expect(page.locator('.il-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check my understanding' })).toHaveCount(0);
  await expect(page.locator('.il-self-explain')).toHaveCount(0);
  await expect(page.locator('.il-self-explain-textarea')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Test 2 -- once a card exists, opening the box alone posts nothing; submit
// stays disabled until real (non-whitespace) text is typed.
// ---------------------------------------------------------------------------

test('submit is disabled until real text is typed, and nothing is posted by opening the box alone', async ({ page }) => {
  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);
  const marker = 'ILLUM-MARKER-SELFEXPLAIN-DISABLED-6b1f04';
  const { card } = await createAnsweredCard(page, frame, '#heading', marker);

  const dispatchRequests: string[] = [];
  await page.route('**/dispatches', (route) => {
    if (route.request().method() === 'POST') dispatchRequests.push(route.request().url());
    void route.continue();
  });

  await card.getByRole('button', { name: 'Check my understanding' }).click();
  const textarea = card.locator('.il-self-explain-textarea');
  const submit = card.getByRole('button', { name: 'Grade my understanding' });
  await expect(textarea).toBeVisible();
  await expect(submit).toBeDisabled();
  expect(dispatchRequests.length).toBe(0);

  // Whitespace-only input must not enable submit.
  await textarea.fill('    ');
  await expect(submit).toBeDisabled();

  // Real text enables it (proven here so test 3's own submit flow is not
  // the FIRST proof that typing real text flips the disabled state).
  await textarea.fill('a real sentence');
  await expect(submit).toBeEnabled();

  // Nothing has been posted merely from opening the box and typing --
  // ONLY the original explain dispatch (already captured before the route
  // above was installed) exists; this route was installed AFTER that
  // dispatch, so it must have observed zero POSTs so far.
  expect(dispatchRequests.length).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 3 -- typing real text and submitting dispatches a learner-graded
// explain, chained onto the SAME card via parent_dispatch.
// ---------------------------------------------------------------------------

test('typing real text and submitting dispatches a learner-graded explain, chained onto the same card', async ({ page }) => {
  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);
  const marker = 'ILLUM-MARKER-SELFEXPLAIN-SUBMIT-9d3e21';
  const { dispatchId: originalDispatchId, card } = await createAnsweredCard(page, frame, '#second', marker);

  await card.getByRole('button', { name: 'Check my understanding' }).click();
  const textarea = card.locator('.il-self-explain-textarea');
  const typedSentence = 'I think this function just returns a fixed greeting string, nothing more.';
  await textarea.fill(typedSentence);
  const submit = card.getByRole('button', { name: 'Grade my understanding' });
  await expect(submit).toBeEnabled();

  const responsePromise = page.waitForResponse((res) => res.url().includes('/dispatches') && res.request().method() === 'POST');
  await submit.click();
  const response = await responsePromise;
  const payload = response.request().postDataJSON() as Record<string, unknown>;
  const body = (await response.json()) as { dispatch_id: string };
  const selfExplainDispatchId = body.dispatch_id;

  // The core EDU-06 wire proof: learnerNote actually reaches the dispatch,
  // chained onto the SAME card via parent_dispatch, at the SAME depth (a
  // parallel branch, never a step deeper on the explain->deeper ladder).
  expect(payload.intent).toBe('explain');
  expect(payload.learnerNote).toBe(typedSentence);
  expect(payload.parent_dispatch).toBe(originalDispatchId);
  expect(payload.depth).toBe(1);
  // The root-cause fix this file's own header comment documents: a genuinely
  // NEW dispatch id, never deduped back onto the original explain.
  expect(selfExplainDispatchId).not.toBe(originalDispatchId);

  const gradingMarker = 'ILLUM-MARKER-SELFEXPLAIN-GRADED-4e7a88';
  await postAnswer(
    ctx.port,
    selfExplainDispatchId,
    `${gradingMarker} -- close, but this also returns a STRING, not just performs an action.`,
    { model: 'edu-self-explain-test-model-graded', tier: 'sonnet' },
  );

  // Both the original explanation AND the graded feedback must land in the
  // SAME single card -- never a second, disconnected one.
  await expect(card).toContainText(gradingMarker, { timeout: 8000 });
  await expect(card).toContainText(marker);
  await expect(page.locator('.il-card').filter({ hasText: marker })).toHaveCount(1);

  const cardText = await card.innerText();
  expect(cardText).toContain(typedSentence);
});
