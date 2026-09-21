// 07-08's own real-browser, real-daemon proof: EDU-07's three-state verdict
// vocabulary, proven both ways it can be reached --
//
//   1. deterministically (the EDU-07 SHORTCUT, 07-04's `handleCreateDispatch`
//      short-circuit via `isUngroundable`): an unanchored element's Verify
//      renders `not-determinable` with NO answer ever submitted, by anyone.
//   2. manually (this plan's own `illuminate answer --verdict ...
//      --deciding-lines ...` CLI flags, exercised here at the wire level via
//      a direct `POST /api/dispatches/:id/answer` -- simulating a subagent,
//      exactly like `e2e/education-cards.spec.ts`'s own `postAnswer`): an
//      anchored (groundable) element's Verify can be answered with any of
//      the three verdicts, and the card renders each one distinguishably.
//
// Mirrors `e2e/education-cards.spec.ts`'s own real-daemon setup and anchoring
// pattern verbatim (a real sibling file under the git-less temp artifact
// root, addressed by a real `anchorHash` over its own exact content) --
// never a fixture stand-in.
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
import type { Verdict } from '../src/router/types.ts';
import { startRealSession, stopRealSession, openRealChromeShell, type RealSessionContext } from './real-daemon.ts';

const VERIFY_A_FILE = 'verify-a.ts';
const VERIFY_A_CONTENT = 'export function verifyA(): number {\n  return 1;\n}\n';
const VERIFY_A_HASH = anchorHash(VERIFY_A_CONTENT);

const VERIFY_B_FILE = 'verify-b.ts';
const VERIFY_B_CONTENT = 'export function verifyB(): number {\n  return 2;\n}\n';
const VERIFY_B_HASH = anchorHash(VERIFY_B_CONTENT);

const VERIFY_C_FILE = 'verify-c.ts';
const VERIFY_C_CONTENT = 'export function verifyC(): number {\n  return 3;\n}\n';
const VERIFY_C_HASH = anchorHash(VERIFY_C_CONTENT);

// This message text is server.ts's own literal constant for the EDU-07
// shortcut's synthesized markdown -- matching against it (rather than just
// "some card exists") is what proves this specific card is the SHORTCUT's
// own output, not a coincidentally-similar manual answer.
const SHORTCUT_MARKDOWN_MARKER = 'no resolved source content is available to check this claim against';

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Education Verify Fixture</title></head>
  <body>
    <p id="unanchored">
      Unanchored paragraph -- deliberately no data-src at all, the
      deterministic not-determinable shortcut proof's own fixture.
    </p>
    <!-- width constrained (not the default full-width block) so each
         card -- positioned at getBoundingClientRect().right + 8 -- renders
         within the real viewport instead of off past its right edge,
         which is what a full-width heading would push it to; the second
         test below clicks INSIDE each card's own toggle, unlike
         education-cards.spec.ts's read-only assertions, so this must
         actually be reachable, not merely present in the DOM. -->
    <h2 id="verifyA" style="width: 220px; margin-bottom: 700px;" data-src="${VERIFY_A_FILE}" data-anchor-hash="${VERIFY_A_HASH}">Anchored verify fixture A</h2>
    <h2 id="verifyB" style="width: 220px; margin-bottom: 700px;" data-src="${VERIFY_B_FILE}" data-anchor-hash="${VERIFY_B_HASH}">Anchored verify fixture B</h2>
    <h2 id="verifyC" style="width: 220px; margin-bottom: 700px;" data-src="${VERIFY_C_FILE}" data-anchor-hash="${VERIFY_C_HASH}">Anchored verify fixture C</h2>
  </body>
</html>
`;

let ctx: RealSessionContext;

test.beforeAll(async () => {
  ctx = await startRealSession(FIXTURE_HTML);
  await writeFile(join(ctx.artifactRoot, VERIFY_A_FILE), VERIFY_A_CONTENT, 'utf8');
  await writeFile(join(ctx.artifactRoot, VERIFY_B_FILE), VERIFY_B_CONTENT, 'utf8');
  await writeFile(join(ctx.artifactRoot, VERIFY_C_FILE), VERIFY_C_CONTENT, 'utf8');
});

test.afterAll(async () => {
  await stopRealSession(ctx);
});

/** Clicks `selector` then "Verify" in the real intent picker, capturing the
 * real `dispatch_id` off the real `POST /api/:key/dispatches` response --
 * same technique as `education-cards.spec.ts`'s own `explainClickDispatchId`,
 * targeting the "Verify" menu item instead of "Explain". */
async function verifyClickDispatchId(page: Page, frame: FrameLocator, selector: string): Promise<string> {
  const responsePromise = page.waitForResponse(
    (res) => res.url().includes('/dispatches') && res.request().method() === 'POST',
  );
  await frame.locator(selector).click();
  await frame.locator('.illum-chip', { hasText: 'Verify' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();
  const response = await responsePromise;
  const body = (await response.json()) as { dispatch_id: string };
  return body.dispatch_id;
}

/** `POST /api/dispatches/:id/answer` directly, with a reported verdict and
 * deciding lines -- simulating a real subagent that used this plan's own
 * `illuminate answer --verdict ... --deciding-lines ...` flags. Never spawns
 * a real `claude` process. Mirrors `education-cards.spec.ts`'s own
 * `postAnswer`, widened with the two EDU-07 fields this plan adds. */
async function postVerdictAnswer(
  port: number,
  dispatchId: string,
  markdown: string,
  verdict: Verdict,
  decidingLines: string,
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
      verdict,
      decidingLines,
    }),
  });
  if (res.status !== 200) {
    throw new Error(`answer POST failed: ${res.status} ${await res.text()}`);
  }
}

const VERDICT_LABELS: Record<Verdict, string> = {
  supported: 'Supported',
  contradicted: 'Contradicted',
  'not-determinable': 'Not determinable',
};

test('an unanchored element Verify renders NOT DETERMINABLE without any answer ever being submitted', async ({ page }) => {
  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);

  // The invariant this test exists to prove: no request to the manual
  // answer route is EVER made during this test, from any source -- the
  // deterministic shortcut is what must produce the rendered card below,
  // not this test (or anything else) calling `illuminate answer` for it.
  const answerRequestUrls: string[] = [];
  page.on('request', (req) => {
    if (/\/api\/dispatches\/[^/]+\/answer$/.test(req.url())) answerRequestUrls.push(req.url());
  });

  await verifyClickDispatchId(page, frame, '#unanchored');

  // Waits out the real ~5s heartbeat-cadence illuminate:syncAnnotations
  // sync (chrome-client.js's real HEARTBEAT_INTERVAL_MS) for the shortcut's
  // already-answered ledger entry to land as a real card -- no answer POST
  // anywhere in this test.
  const card = page.locator('.il-card').filter({ hasText: SHORTCUT_MARKDOWN_MARKER });
  await expect(card).toBeVisible({ timeout: 8000 });

  const badge = card.locator('.il-verdict');
  await expect(badge).toHaveText(VERDICT_LABELS['not-determinable']);
  // The rail carries the verdict as data, not as a modifier class -- one
  // `.il-verdict` rule keyed on `data-v` rather than three classes.
  await expect(badge).toHaveAttribute('data-v', 'not-determinable');

  // The durable, card-visible zero-cost proof: CardThreadEntry carries no
  // cost fields at all (07-02's schema), so the model field reading
  // 'illuminate (no model call)' -- server.ts's own literal for this
  // shortcut -- is the rendered proof no real model was ever billed.
  await expect(card).toContainText('illuminate (no model call)');

  expect(answerRequestUrls).toEqual([]);
});

test('an anchored element Verify can be answered with any of the three verdicts, and the card shows it', async ({ page }) => {
  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);

  const cases: readonly { readonly selector: string; readonly verdict: Verdict }[] = [
    { selector: '#verifyA', verdict: 'supported' },
    { selector: '#verifyB', verdict: 'contradicted' },
    { selector: '#verifyC', verdict: 'not-determinable' },
  ];

  for (const { selector, verdict } of cases) {
    const dispatchId = await verifyClickDispatchId(page, frame, selector);
    const marker = `ILLUM-MARKER-VERIFY-${verdict}`;
    const decidingLines = `deciding lines proving ${verdict} for ${selector}`;

    await postVerdictAnswer(ctx.port, dispatchId, `${marker} -- manual three-verdict round trip.`, verdict, decidingLines, {
      model: 'edu-verify-test-model',
      tier: 'sonnet',
    });

    const card = page.locator('.il-card').filter({ hasText: marker });
    await expect(card).toContainText(marker, { timeout: 8000 });

    const badge = card.locator('.il-verdict');
    await expect(badge).toHaveText(VERDICT_LABELS[verdict]);
    await expect(badge).toHaveAttribute('data-v', verdict);

    // Deciding lines are shown EXPANDED in the rail, not behind the toggle
    // the in-artifact card used. Deliberate: the deciding lines are the
    // citation that makes a verdict checkable, and a verdict whose evidence
    // is one click away is an assertion first and a citation second. The
    // resolved source body is still behind "Show the code" -- that is bulk,
    // this is the proof.
    await expect(card.locator('.il-deciding')).toBeVisible();
    await expect(card.locator('.il-deciding .il-code').filter({ hasText: decidingLines })).toBeVisible();
  }
});
