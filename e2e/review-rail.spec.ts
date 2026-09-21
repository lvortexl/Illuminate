// The chrome review rail's real-browser proof.
//
// This file exists because the rail replaced a design that unit tests could
// not have caught: every piece of review UI used to be drawn INSIDE the
// sandboxed artifact as `position: fixed` overlays, and a card whose anchor
// had been scrolled past rendered at a negative `top` -- measured at -482px
// for a 313px card, i.e. entirely invisible. Clicking "Explain" appeared to
// do nothing. No assertion in the suite was false while that was true.
//
// So the assertions here are deliberately geometric and structural: is the
// artifact actually beside the rail, is a card actually on screen, is the
// queued note actually gone after sending. Anything checkable by reading
// state alone belongs in test/chrome/*.test.ts, not here.
import { test, expect, type Page } from '@playwright/test';
import { startRealSession, stopRealSession, openRealChromeShell, type RealSessionContext } from './real-daemon.ts';

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Rail Fixture</title>
  <style>body { margin: 0; font: 16px/1.6 system-ui; } p { margin: 0 0 1200px; }</style>
  </head>
  <body>
    <p id="first" data-src="src/example/alpha.ts" data-rev="abc123" data-anchor-hash="aaaaaaaaaaaaaaaa">
      The first anchored claim, at the very top of a deliberately tall page.
    </p>
    <p id="second" data-src="src/example/beta.ts" data-rev="abc123" data-anchor-hash="bbbbbbbbbbbbbbbb">
      The second anchored claim, far below the fold.
    </p>
  </body>
</html>`;

let ctx: RealSessionContext;

test.beforeAll(async () => {
  ctx = await startRealSession(FIXTURE_HTML);
});

test.afterAll(async () => {
  await stopRealSession(ctx);
});

/** Opens the shell and waits for the rail to have mounted. */
async function openShell(page: Page): Promise<void> {
  await openRealChromeShell(page, ctx.port, ctx.key);
  await page.locator('.il-rail').waitFor();
}


/** Opens the element composer on `selector`, writes `note`, and commits it.
 * The composer lives ON the element now, inside the artifact frame -- the
 * rail's own textarea is gone, because two places to write one note meant
 * two controls that could disagree about which element they meant. */
async function compose(page: Page, selector: string, note: string, action: 'Queue' | 'Send'): Promise<void> {
  const frame = page.frameLocator('iframe');
  await frame.locator(selector).click();
  await frame.locator('.illum-composer-note').fill(note);
  await frame.locator('.illum-composer-actions button', { hasText: action }).click();
}

// --- 1. The structural change: artifact and rail coexist -------------

test('the artifact iframe and the review rail occupy the window side by side', async ({ page }) => {
  await openShell(page);

  const frameBox = await page.locator('#illuminate-artifact-frame').boundingBox();
  const railBox = await page.locator('.il-rail').boundingBox();
  const barBox = await page.locator('.il-bar').boundingBox();
  expect(frameBox).not.toBeNull();
  expect(railBox).not.toBeNull();
  expect(barBox).not.toBeNull();
  if (!frameBox || !railBox || !barBox) return;

  // The iframe used to be position:fixed;inset:0 -- it filled the viewport,
  // which is exactly why no rail could exist. It must now END where the
  // rail BEGINS, with neither overlapping the other.
  expect(Math.round(frameBox.x + frameBox.width)).toBeLessThanOrEqual(Math.round(railBox.x) + 1);
  expect(railBox.width).toBeGreaterThan(200);
  // And both must sit below the bar rather than under it.
  expect(frameBox.y).toBeGreaterThanOrEqual(barBox.height - 1);
});

test('the rail collapses and restores on demand', async ({ page }) => {
  await openShell(page);
  const widthWithRail = (await page.locator('#illuminate-artifact-frame').boundingBox())?.width ?? 0;

  await page.locator('#illuminate-rail-toggle').click();
  await expect(page.locator('#illuminate-app')).toHaveAttribute('data-rail', 'collapsed');
  await expect(page.locator('.il-rail')).toBeHidden();
  const widthWithout = (await page.locator('#illuminate-artifact-frame').boundingBox())?.width ?? 0;
  expect(widthWithout).toBeGreaterThan(widthWithRail);

  await page.locator('#illuminate-rail-toggle').click();
  await expect(page.locator('.il-rail')).toBeVisible();
});

// --- 2. The queue: point, write, queue, send -------------------------

test('opening the composer on an element costs nothing until it is committed', async ({ page }) => {
  await openShell(page);
  const frame = page.frameLocator('iframe');

  await frame.locator('#first').click();

  // The composer names what it is pointed at, including the citation, so the
  // reader knows whether the answer will be grounded before they write.
  await expect(frame.locator('.illum-composer')).toBeVisible();
  await expect(frame.locator('.illum-composer-cite')).toContainText('src/example/alpha.ts');
  // And opening it dispatches nothing and queues nothing.
  await expect(page.locator('.il-card')).toHaveCount(0);
  await expect(page.locator('.il-queued')).toHaveCount(0);
});

test('a note queues, shows in the rail, and only leaves the queue once sent', async ({ page }) => {
  await openShell(page);
  const frame = page.frameLocator('iframe');

  // Send is unavailable until there is something to send.
  await expect(page.locator('.il-compose .il-btn--primary')).toBeDisabled();

  await compose(page, '#first', 'Which line actually proves this?', 'Queue');

  await expect(page.locator('.il-queued')).toHaveCount(1);
  await expect(page.locator('.il-queued')).toContainText('Which line actually proves this?');
  await expect(page.locator('.il-compose .il-btn--primary')).toContainText('Send 1 to Agent');
  // Queued is not sent: the composer closes, but nothing has been dispatched.
  await expect(frame.locator('.illum-composer')).toHaveCount(0);
  await expect(page.locator('.il-card[data-state="pending"]')).toHaveCount(0);

  await page.locator('.il-compose .il-btn--primary').click();

  await expect(page.locator('.il-queued')).toHaveCount(0);
  await expect(page.locator('.il-card[data-state="pending"]')).toHaveCount(1);
  await expect(page.locator('.il-card[data-state="pending"]')).toContainText('waiting for the agent');
});

test('several notes batch into one send', async ({ page }) => {
  await openShell(page);

  for (const [selector, text] of [
    ['#first', 'First note.'],
    ['#second', 'Second note.'],
  ] as const) {
    await compose(page, selector, text, 'Queue');
  }

  await expect(page.locator('.il-queued')).toHaveCount(2);
  await expect(page.locator('.il-compose .il-btn--primary')).toContainText('Send 2 to Agent');

  await page.locator('.il-compose .il-btn--primary').click();
  await expect(page.locator('.il-queued')).toHaveCount(0);
  await expect(page.locator('.il-card[data-state="pending"]')).toHaveCount(2);
});

test('a queued note can be removed before it is ever sent', async ({ page }) => {
  await openShell(page);

  await compose(page, '#first', 'Never mind.', 'Queue');
  await expect(page.locator('.il-queued')).toHaveCount(1);

  await page.locator('.il-queued .il-compose-clear').click();
  await expect(page.locator('.il-queued')).toHaveCount(0);
  await expect(page.locator('.il-compose .il-btn--primary')).toBeDisabled();
});

// --- 3. Nothing renders off-screen -----------------------------------

test('every card the rail renders is inside the viewport', async ({ page }) => {
  await openShell(page);
  const frame = page.frameLocator('iframe');

  // Queue against the element at the very TOP of a very tall page, then
  // scroll far past it. Under the old floating-card design this is the exact
  // condition that produced a negative `top`: the card was positioned from
  // its anchor's live rect, and the clamp only ever handled bottom overflow.
  await compose(page, '#first', 'Anchored at the top, read from the bottom.', 'Send');
  await expect(page.locator('.il-card')).toHaveCount(1);

  await frame.locator('#second').scrollIntoViewIfNeeded();

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  if (!viewport) return;

  for (const card of await page.locator('.il-card').all()) {
    const box = await card.boundingBox();
    expect(box, 'a card in the rail must have a layout box').not.toBeNull();
    if (!box) continue;
    expect(box.y + box.height).toBeGreaterThan(0);
    expect(box.y).toBeLessThan(viewport.height);
    expect(box.x + box.width).toBeGreaterThan(0);
    expect(box.x).toBeLessThan(viewport.width);
  }
});

test('the rail owning card bodies leaves no duplicate copy floating over the artifact', async ({ page }) => {
  await openShell(page);
  const frame = page.frameLocator('iframe');

  await compose(page, '#first', 'Once, not twice.', 'Send');
  await expect(page.locator('.il-card')).toHaveCount(1);

  // The in-artifact renderer must stand down entirely while the rail owns
  // presentation -- including the corner drawers, which duplicate rail tabs.
  await expect(frame.locator('.illum-card')).toHaveCount(0);
  await expect(frame.locator('.illum-card-pending')).toHaveCount(0);
  await expect(frame.locator('.illum-drawer-toggle')).toBeHidden();
  await expect(frame.locator('.illum-findings-toggle')).toBeHidden();
});

// --- 4. Tabs and empty states ----------------------------------------

test('each tab states what it means when it has nothing to show', async ({ page }) => {
  await openShell(page);

  // Scoped to the VISIBLE panel: all three panels stay in the DOM and are
  // hidden by attribute, so an unscoped `.il-empty-title` matches all three.
  const shown = page.locator('.il-panel:not([hidden]) .il-empty-title');

  await expect(page.locator('#il-tab-review')).toHaveAttribute('aria-selected', 'true');
  await expect(shown).toContainText('Nothing under review yet');

  await page.locator('#il-tab-findings').click();
  await expect(shown).toContainText('Everything still matches');

  await page.locator('#il-tab-conversation').click();
  await expect(shown).toContainText('No word from the agent yet');
});

test('the review tab counts what is waiting on the human', async ({ page }) => {
  await openShell(page);

  const count = page.locator('#il-tab-review .il-count');
  await expect(count).toHaveAttribute('data-zero', 'true');

  await compose(page, '#first', 'Counted.', 'Queue');

  await expect(count).toHaveAttribute('data-zero', 'false');
  await expect(count).toHaveText('1');
});

// --- 5. The connection lamp ------------------------------------------

test('the connection lamp reports a live daemon', async ({ page }) => {
  await openShell(page);
  await expect(page.locator('#illuminate-connection')).toHaveAttribute('data-state', 'live', { timeout: 15000 });
});

/**
 * `POST /api/dispatches/:id/answer` directly -- simulating a subagent,
 * exactly as e2e/education-cards.spec.ts does. Never spawns a real
 * `claude`. Node's own global `fetch` sends no `Origin` header, and
 * `isSameOriginRequest` treats an absent Origin as same-origin
 * (containment.ts) -- the same posture a real subagent's HTTP client has.
 */
async function postAnswer(port: number, dispatchId: string, markdown: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/dispatches/${dispatchId}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      markdown,
      model: 'claude-haiku-4-5-20251001',
      tier: 'haiku',
      tokensIn: 42,
      tokensOut: 84,
      cacheReadInputTokens: 0,
      costUsd: 0.0012,
      wallMs: 250,
      verdict: null,
      decidingLines: null,
    }),
  });
  if (res.status !== 200) throw new Error(`answer POST failed: ${res.status} ${await res.text()}`);
}

/** Queues one note against `selector` and sends it, returning the real
 * dispatch id off the real POST response. */
async function sendNote(page: Page, selector: string, note: string): Promise<string> {
  const frame = page.frameLocator('iframe');
  await frame.locator(selector).click();
  await frame.locator('.illum-composer-note').fill(note);
  const responsePromise = page.waitForResponse(
    (res) => res.url().includes('/dispatches') && res.request().method() === 'POST',
  );
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();
  const body = (await (await responsePromise).json()) as { dispatch_id: string };
  return body.dispatch_id;
}

// --- 6. The depth ladder and self-explanation, from the rail ---------
//
// EDU-05 ("go deeper") and EDU-06 ("explain it back") used to be reachable
// only from the floating in-artifact card. Once the rail took over card
// bodies, leaving them there would have made both unreachable in a served
// session -- a regression no existing assertion covered, because every
// existing assertion looked at the floating card.

test('a rail card offers the depth ladder, and going deeper chains onto the same card', async ({ page }) => {
  await openShell(page);
  const dispatchId = await sendNote(page, '#first', 'Explain this.');
  await postAnswer(ctx.port, dispatchId, 'The first explanation.');

  const card = page.locator('.il-card').filter({ hasText: 'The first explanation.' });
  await expect(card).toHaveCount(1, { timeout: 15000 });

  const deeperPost = page.waitForResponse(
    (res) => res.url().includes('/dispatches') && res.request().method() === 'POST',
  );
  await card.getByRole('button', { name: 'Go deeper' }).click();
  const deeperBody = (await (await deeperPost).request().postDataJSON()) as {
    intent: string;
    depth: number;
    parent_dispatch: string | null;
  };

  // Chained, not a fresh start: next rung down, parented on the answer it
  // was clicked from.
  expect(deeperBody.intent).toBe('deeper');
  expect(deeperBody.depth).toBe(2);
  expect(deeperBody.parent_dispatch).toBe(dispatchId);
});

test('a rail card can grade the human’s own explanation without becoming a rung', async ({ page }) => {
  await openShell(page);
  // A DIFFERENT element from the depth-ladder test above. Tests in this file
  // share one session, and the daemon dedupes on element + intent + resolved
  // content -- reusing #first returns that test's already-answered dispatch
  // id, and answering it a second time is a legitimate 409.
  const dispatchId = await sendNote(page, '#second', 'Explain this one too.');
  await postAnswer(ctx.port, dispatchId, 'The second explanation.');

  const card = page.locator('.il-card').filter({ hasText: 'The second explanation.' });
  await expect(card).toHaveCount(1, { timeout: 15000 });

  await card.getByRole('button', { name: 'Check my understanding' }).click();
  await card.locator('.il-self-explain textarea').fill('I think it means the router never trusts prose.');

  const gradePost = page.waitForResponse(
    (res) => res.url().includes('/dispatches') && res.request().method() === 'POST',
  );
  await card.getByRole('button', { name: 'Grade my understanding' }).click();
  const body = (await (await gradePost).request().postDataJSON()) as {
    intent: string;
    depth: number;
    parent_dispatch: string | null;
    learnerNote: string | null;
    note: string | null;
  };

  // A parallel branch off the same rung, never a step down the ladder...
  expect(body.intent).toBe('explain');
  expect(body.depth).toBe(1);
  expect(body.parent_dispatch).toBe(dispatchId);
  // ...and the learner's words travel as learnerNote (which switches the
  // envelope to the grading contract), NOT as an ordinary note.
  expect(body.learnerNote).toBe('I think it means the router never trusts prose.');
  expect(body.note).toBeNull();
});

test('a composed note travels as note, never as a graded learnerNote', async ({ page }) => {
  await openShell(page);
  const frame = page.frameLocator('iframe');
  await frame.locator('#first').click();
  await frame.locator('.illum-composer-note').fill('Which line proves this?');

  const post = page.waitForResponse(
    (res) => res.url().includes('/dispatches') && res.request().method() === 'POST',
  );
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();
  const body = (await (await post).request().postDataJSON()) as {
    note: string | null;
    learnerNote: string | null;
  };

  expect(body.note).toBe('Which line proves this?');
  expect(body.learnerNote).toBeNull();
});

// --- 7. Attachments -------------------------------------------------------
//
// An image is the one payload that cannot ride the existing wire: a
// sandboxed opaque-origin frame has no `fetch`, so bytes cross to the chrome
// as a data URL, get uploaded once, and everything after that refers to an
// id. These assert the seam actually holds -- that ids, not bytes, reach the
// dispatch, and that the file an agent is pointed at exists.

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('an attached image is uploaded and reaches the dispatch as an id, never as bytes', async ({ page }) => {
  await openShell(page);
  const frame = page.frameLocator('iframe');

  await frame.locator('#first').click();
  await frame.locator('.illum-composer input[type="file"]').setInputFiles({
    name: 'screenshot.png',
    mimeType: 'image/png',
    buffer: PNG_1PX,
  });
  await expect(frame.locator('.illum-file')).toContainText('screenshot.png');
  await frame.locator('.illum-composer-note').fill('Why does it render like this?');

  const post = page.waitForResponse(
    (res) => res.url().includes('/dispatches') && res.request().method() === 'POST',
  );
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();
  const body = (await (await post).request().postDataJSON()) as {
    note: string | null;
    attachments: { id: string; mediaType: string }[];
  };

  expect(body.note).toBe('Why does it render like this?');
  expect(body.attachments).toHaveLength(1);
  expect(body.attachments[0]?.mediaType).toBe('image/png');
  // The id is a bare hex token -- the shape `attachmentPathFor` will accept
  // before it joins anything onto a path.
  expect(body.attachments[0]?.id).toMatch(/^[0-9a-f]{24}$/);
  // And no base64 anywhere near the dispatch body.
  expect(JSON.stringify(body)).not.toContain('data:image');
  expect(JSON.stringify(body)).not.toContain('iVBORw0KGgo');
});

test('an attachment can be removed before the note is committed', async ({ page }) => {
  await openShell(page);
  const frame = page.frameLocator('iframe');

  await frame.locator('#first').click();
  await frame.locator('.illum-composer input[type="file"]').setInputFiles({
    name: 'wrong-one.png',
    mimeType: 'image/png',
    buffer: PNG_1PX,
  });
  await expect(frame.locator('.illum-file')).toHaveCount(1);

  await frame.locator('.illum-file-remove').click();
  await expect(frame.locator('.illum-file')).toHaveCount(0);

  const post = page.waitForResponse(
    (res) => res.url().includes('/dispatches') && res.request().method() === 'POST',
  );
  await frame.locator('.illum-composer-note').fill('No image after all.');
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();
  const body = (await (await post).request().postDataJSON()) as { attachments: unknown[] };
  expect(body.attachments).toHaveLength(0);
});

test('a queued note carries its attachments through to the batch send', async ({ page }) => {
  await openShell(page);
  const frame = page.frameLocator('iframe');

  await frame.locator('#first').click();
  await frame.locator('.illum-composer input[type="file"]').setInputFiles({
    name: 'queued.png',
    mimeType: 'image/png',
    buffer: PNG_1PX,
  });
  await frame.locator('.illum-composer-note').fill('Look at this rendering.');
  await frame.locator('.illum-composer-actions button', { hasText: 'Queue' }).click();

  // The queued row says so, because an image you cannot see attached to a
  // note you are about to send is a thing you will forget you attached.
  await expect(page.locator('.il-queued')).toHaveCount(1);
  await expect(page.locator('.il-queued-attach')).toContainText('1 image attached');

  const post = page.waitForResponse(
    (res) => res.url().includes('/dispatches') && res.request().method() === 'POST',
  );
  await page.locator('.il-compose .il-btn--primary').click();
  const body = (await (await post).request().postDataJSON()) as { attachments: { id: string }[] };
  expect(body.attachments).toHaveLength(1);
});
