// ROUT-01's end-to-end proof: the artifact SDK emits a typed intent over
// postMessage -- mouse and keyboard paths produce structurally identical
// payload shapes, an unanchored element degrades gracefully instead of
// dead-ending, Escape posts nothing, and the full interaction loop never
// makes an outbound network request to a foreign origin. Runs against the
// REAL daemon (06-10-PLAN.md's repoint) -- a real `GET /session/:key` real
// chrome shell, embedding a real, sandboxed `GET /artifact/:key/` document
// (real SDK, real freshness-guarded tokens) -- rather than Plan 04-01's now-
// retired `e2e/server.ts` fixture stand-in.
//
// The real chrome shell's own shipped script (`src/chrome/client.ts`)
// forwards a validated intent straight to `POST /api/:key/dispatches` -- it
// does not also record it on `window.__received` the way Plan 04-01's
// fixture `chrome-shell.html` did. This file's own `page.addInitScript`
// installs a SECOND, purely passive `message` listener on the top page
// (harmless to add -- `window` supports multiple listeners for the same
// event) so every assertion below keeps observing the exact same raw
// postMessage payload the fixture used to record locally -- this listener
// only OBSERVES; it never forwards anything to the daemon itself, so it
// exercises no code the real chrome shell doesn't already run on its own.
import { test, expect, type Page } from '@playwright/test';
import { isFromCurrentArtifactLoad } from '../src/shared/protocol.ts';
import {
  startRealSession,
  stopRealSession,
  openSessionFile,
  openRealChromeShell,
  beginArtifactLoad,
  type RealSessionContext,
  type ArtifactLoad,
} from './real-daemon.ts';

const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads';

interface ReceivedIntentMessage {
  readonly type: string;
  readonly artifact_load_token: string;
  readonly payload?: {
    readonly protocol: string;
    readonly intent: string;
    readonly element: { readonly uid: string; readonly selector: string; readonly tag: string; readonly text: string };
    readonly anchor: { readonly src: string; readonly rev: string | null; readonly anchorHash: string | null } | null;
    readonly note?: string | null;
    readonly mode?: string;
    readonly depth: number;
    readonly parent_dispatch: string | null;
  };
}

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Fixture Artifact</title></head>
  <body>
    <h1 id="heading" data-src="src/example/widget.ts" data-rev="abc123" data-anchor-hash="fixture-anchor-hash">
      Anchored heading -- data-src/data-rev/data-anchor-hash present
    </h1>
    <!-- A realistic anchored BLOCK: the citation is on the container, the
         reader clicks the prose inside it. This is the shape every real
         artifact uses, and the shape that used to dispatch unanchored. -->
    <div id="block" data-src="src/example/block.ts" data-rev="abc123" data-anchor-hash="block-anchor-hash">
      <span id="blockcite">src/example/block.ts</span>
      <p id="blockprose">Prose inside an anchored block -- the part a reader actually clicks.</p>
    </div>
    <footer id="footer">
      Unanchored footer -- deliberately no data-src, for the graceful-
      degradation fixture (an unanchored element still gets a typed intent,
      just without grounding).
    </footer>
  </body>
</html>
`;

const HEADING_ANCHOR = { src: 'src/example/widget.ts', rev: 'abc123', anchorHash: 'fixture-anchor-hash' };

let ctx: RealSessionContext;

test.beforeAll(async () => {
  ctx = await startRealSession(FIXTURE_HTML);
});

test.afterAll(async () => {
  await stopRealSession(ctx);
});

/**
 * Reads back window.__received on the TOP page. A cross-frame postMessage
 * out of a sandboxed (opaque-origin) iframe is genuinely asynchronous --
 * Chromium delivers it as its own task, not synchronously within the click
 * that triggered it -- so a bare page.evaluate() immediately after a click
 * races the delivery and intermittently observes zero messages that do
 * arrive microseconds later. When the caller knows how many messages a
 * scenario should produce, poll for that count (bounded, 5s) instead of
 * reading once. When a scenario expects NO message (the Escape/negative
 * paths), there is no positive count to poll for -- give any wrongly-fired
 * postMessage the same real settle time a positive assertion would get, so
 * a passing "zero messages" assertion is a genuine absence, not a fast read
 * that outraced an async delivery it should have caught.
 */
async function received(page: Page, expectedLength = 0): Promise<ReceivedIntentMessage[]> {
  if (expectedLength > 0) {
    await page.waitForFunction(
      (n) => ((window as unknown as { __received?: unknown[] }).__received ?? []).length >= n,
      expectedLength,
      { timeout: 5000 },
    );
  } else {
    await page.waitForTimeout(250);
  }
  return page.evaluate(() => (window as unknown as { __received?: ReceivedIntentMessage[] }).__received ?? []);
}

/** Installs this file's own passive message recorder, then opens the real
 * chrome shell (real GET /session/:key, real begin handshake, real
 * sandboxed GET /artifact/:key/), waiting for the SDK to have actually
 * booted. Returns the real (token, revision) pair this load minted --
 * callers assert against the real minted token, never a hardcoded fixture
 * string (there is no such thing anymore); the iframe itself is re-derived
 * per call site via `page.frameLocator('iframe')`. */
async function openFixtureChromeShell(page: Page): Promise<ArtifactLoad> {
  await page.addInitScript(() => {
    (window as unknown as { __received: unknown[] }).__received = [];
    window.addEventListener('message', (e) => {
      (window as unknown as { __received: unknown[] }).__received.push(e.data);
    });
  });
  const { load } = await openRealChromeShell(page, ctx.port, ctx.key);
  return load;
}

// --- 1. Mouse round trip ---

test('mouse: clicking an anchored element then "Explain" posts exactly one typed-intent message', async ({ page }) => {
  const load = await openFixtureChromeShell(page);
  const frame = page.frameLocator('iframe');
  await frame.locator('#heading').click();
  await frame.locator('.illum-chip', { hasText: 'Explain' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();

  const messages = await received(page, 1);
  expect(messages).toHaveLength(1);
  const msg = messages[0];
  if (!msg) throw new Error('unreachable: messages.length === 1');
  expect(msg.type).toBe('illuminate:queueNote');
  expect(msg.artifact_load_token).toBe(load.artifactLoadToken);
    expect(msg.payload?.intent).toBe('explain');
  expect(msg.payload?.element.selector).toBe('body > h1#heading');
  expect(msg.payload?.element.tag).toBe('h1');
  expect(msg.payload?.anchor).toEqual(HEADING_ANCHOR);
});

// --- 2. Keyboard-only round trip ---

test('keyboard: Tab to the trigger, Enter opens the composer, Ctrl+Enter sends it', async ({ page }) => {
  const load = await openFixtureChromeShell(page);
  const frame = page.frameLocator('iframe');
  // See below for why the iframe element is focused first.
  await page.locator('#illuminate-artifact-frame').focus();
  await frame.locator('body').evaluate((el) => (el as HTMLElement).focus());

  await page.keyboard.press('Tab'); // -> first trigger, the heading's
  await page.keyboard.press('Enter'); // -> opens the composer, focusing its note field
  await frame.locator('.illum-composer').waitFor();

  // The note field takes focus on open, so a keyboard user can type
  // immediately and commit without ever reaching for the pointer. Ctrl+Enter
  // sends; plain Enter would queue.
  await page.keyboard.type('what does this do');
  await page.keyboard.press('Control+Enter');

  const messages = await received(page, 1);
  const msg = messages[0];
  if (!msg) throw new Error('unreachable: messages.length === 1');
  expect(msg.type).toBe('illuminate:queueNote');
  expect(msg.artifact_load_token).toBe(load.artifactLoadToken);
  // Explain is the default selection, so a keyboard user who types and sends
  // without touching a chip still emits a typed intent from the closed set.
  expect(msg.payload?.intent).toBe('explain');
  expect(msg.payload?.note).toBe('what does this do');
  expect(msg.payload?.mode).toBe('send');
  expect(msg.payload?.element.selector).toBe('body > h1#heading');
  expect(msg.payload?.anchor).toEqual(HEADING_ANCHOR);
});

test('keyboard: a chip can be reached and chosen without a pointer', async ({ page }) => {
  await openFixtureChromeShell(page);
  const frame = page.frameLocator('iframe');
  await page.locator('#illuminate-artifact-frame').focus();
  await frame.locator('body').evaluate((el) => (el as HTMLElement).focus());
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await frame.locator('.illum-composer').waitFor();

  // Shift+Tab walks back out of the note field into the chip row.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');

  const checked = await frame
    .locator('.illum-chip[aria-checked="true"]')
    .evaluateAll((els) => els.map((e) => e.textContent));
  expect(checked).toHaveLength(1);
  expect(checked[0]).toBe('Fix code');
});

// --- 3. Unanchored degradation ---

test('unanchored: an element with no data-src still opens the picker and posts with anchor: null', async ({ page }) => {
  await openFixtureChromeShell(page);
  const frame = page.frameLocator('iframe');
  await frame.locator('#footer').click();
  await frame.locator('.illum-chip', { hasText: 'Explain' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();

  const messages = await received(page, 1);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.payload?.intent).toBe('explain');
  expect(messages[0]?.payload?.anchor).toBeNull();
});

// --- 4. Escape ---

test('escape closes the picker without posting anything and returns focus to whatever opened it', async ({ page }) => {
  await openFixtureChromeShell(page);
  const frame = page.frameLocator('iframe');
  await frame.locator('#heading').click();
  await frame.getByRole('dialog', { name: 'Review this element' }).waitFor();

  await page.keyboard.press('Escape');

  const messages = await received(page);
  expect(messages).toHaveLength(0);

  // h1 is not natively focusable -- clicking it leaves document.body as
  // the focused element both before and after the picker's lifecycle, per
  // the plan's own "or document.body for the mouse-click case" spec.
  const bodyFocused = await frame.locator('body').evaluate((el) => document.activeElement === el);
  expect(bodyFocused).toBe(true);

  // The menu itself must actually be gone, not just visually hidden.
  await expect(frame.getByRole('dialog', { name: 'Review this element' })).toHaveCount(0);
});

test('escape after opening via keyboard returns focus to the trigger button that opened it', async ({ page }) => {
  await openFixtureChromeShell(page);
  const frame = page.frameLocator('iframe');
  // See the keyboard test above for why the iframe element is focused first.
  await page.locator('#illuminate-artifact-frame').focus();
  await frame.locator('body').evaluate((el) => (el as HTMLElement).focus());
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await frame.getByRole('dialog', { name: 'Review this element' }).waitFor();

  await page.keyboard.press('Escape');

  const messages = await received(page);
  expect(messages).toHaveLength(0);

  // document.activeElement retargets to the shadow HOST (not the actual
  // focused descendant) whenever real focus lives inside an open shadow
  // root -- a DOM spec behavior, not a bug -- so a direct `===` comparison
  // against a shadow-DOM element (the trigger button lives in the SDK's
  // own shadow root) is never true regardless of whether focus restoration
  // actually worked. Drill through shadowRoot.activeElement (exposed for
  // open shadow roots specifically so this is observable) to find the real
  // innermost focused element before comparing.
  const triggerFocused = await frame
    .locator('.illum-trigger')
    .first()
    .evaluate((el) => {
      let active: Element | null = document.activeElement;
      while (active?.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      return active === el;
    });
  expect(triggerFocused).toBe(true);
});

// --- 5. Zero requests to a foreign origin across the full interaction sequence ---

test('the full mouse, keyboard, unanchored, and escape sequence never issues a request outside this daemon\'s own origin', async ({
  page,
}) => {
  const violations: string[] = [];
  const daemonOrigin = `http://127.0.0.1:${ctx.port}`;
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (!url.startsWith(daemonOrigin)) {
      violations.push(url);
      void route.abort();
      return;
    }
    void route.continue();
  });

  await openFixtureChromeShell(page);
  const frame = page.frameLocator('iframe');

  // mouse round trip
  await frame.locator('#heading').click();
  await frame.locator('.illum-chip', { hasText: 'Explain' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();

  // keyboard round trip
  await frame.locator('body').evaluate((el) => (el as HTMLElement).focus());
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  // unanchored degradation
  await frame.locator('#footer').click();
  await frame.locator('.illum-chip', { hasText: 'Verify' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();

  // escape
  await frame.locator('#heading').click();
  await page.keyboard.press('Escape');

  expect(violations).toEqual([]);
});

// --- 6. Token invariant: negative cases, as hard as the positive round trip ---
//
// protocol.ts's isFromCurrentArtifactLoad is the guard the real chrome
// shell's own shipped script (src/chrome/message-handling.ts) runs before
// trusting any artifact->chrome message. These three tests prove that a
// GENUINELY posted message (a real SDK boot + real postMessage, not a
// hand-built literal) carries whatever REAL, currently-valid token was
// actually on the artifact document's own URL, and that the guard correctly
// rejects it whenever that token is not the one a receiver is currently
// tracking. Each uses its OWN dedicated real session (its own file, its own
// key) so it can freely mint/supersede tokens without disturbing the shared
// fixture session the tests above reuse.

test("token invariant: a message from a different session's token is structurally distinguishable and rejected against another session's token", async ({
  page,
}) => {
  const { key: otherKey } = await openSessionFile(ctx, 'different-session.html', FIXTURE_HTML);
  await page.addInitScript(() => {
    (window as unknown as { __received: unknown[] }).__received = [];
    window.addEventListener('message', (e) => {
      (window as unknown as { __received: unknown[] }).__received.push(e.data);
    });
  });
  const { frame, load: otherLoad } = await openRealChromeShell(page, ctx.port, otherKey);
  await frame.locator('#heading').click();
  await frame.locator('.illum-chip', { hasText: 'Explain' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();

  const messages = await received(page, 1);
  expect(messages).toHaveLength(1);
  // The SDK reads its token from its OWN document's URL (JOIN-CONTRACT.md
  // §1) -- it must never hardcode or fall back to some other session's
  // token, even one this same daemon is also currently serving.
  const otherSessionMsgToken = messages[0]?.artifact_load_token;
  if (!otherSessionMsgToken) throw new Error('unreachable: messages.length === 1');
  expect(otherSessionMsgToken).toBe(otherLoad.artifactLoadToken);

  // A real, currently-valid token minted for the SHARED fixture session
  // (ctx.key) -- a different, unrelated session on the same daemon.
  const sharedSessionLoad = await beginArtifactLoad(ctx.port, ctx.key);
  expect(otherSessionMsgToken).not.toBe(sharedSessionLoad.artifactLoadToken);

  expect(isFromCurrentArtifactLoad({ artifact_load_token: otherSessionMsgToken }, sharedSessionLoad.artifactLoadToken)).toBe(
    false,
  );
  expect(isFromCurrentArtifactLoad({ artifact_load_token: otherSessionMsgToken }, otherLoad.artifactLoadToken)).toBe(true);
});

test("token invariant: a message from a stale (superseded) load is rejected against the session's current token", async ({
  page,
}) => {
  const { key: staleKey } = await openSessionFile(ctx, 'stale-session.html', FIXTURE_HTML);

  await page.addInitScript(() => {
    (window as unknown as { __received: unknown[] }).__received = [];
    window.addEventListener('message', (e) => {
      (window as unknown as { __received: unknown[] }).__received.push(e.data);
    });
  });

  // A real SDK boot and a real postMessage under a STALE (token, revision)
  // pair -- as if this session's artifact had since been reloaded to a
  // newer load the receiver now tracks, but this message is the one that
  // arrived from the earlier, now-superseded load.
  const { frame, load: staleLoad } = await openRealChromeShell(page, ctx.port, staleKey);

  // Supersede it: a second real begin call on the SAME session, AFTER the
  // iframe has already loaded under the stale pair -- the iframe (and its
  // already-booted SDK) never re-reads its own URL, so it keeps posting the
  // stale token even though the daemon now considers a different pair
  // current.
  const currentLoad = await beginArtifactLoad(ctx.port, staleKey);
  expect(currentLoad.artifactLoadToken).not.toBe(staleLoad.artifactLoadToken);

  await frame.locator('#heading').click();
  await frame.locator('.illum-chip', { hasText: 'Explain' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();

  const messages = await received(page, 1);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.artifact_load_token).toBe(staleLoad.artifactLoadToken);

  expect(isFromCurrentArtifactLoad(messages[0] as { artifact_load_token: string }, currentLoad.artifactLoadToken)).toBe(false);
  expect(isFromCurrentArtifactLoad(messages[0] as { artifact_load_token: string }, staleLoad.artifactLoadToken)).toBe(true);
});

test('token invariant: an artifact document with no artifact_load_token in its own URL never boots, so no message can ever be posted', async ({
  page,
}) => {
  const { key: noTokenKey } = await openSessionFile(ctx, 'missing-token-session.html', FIXTURE_HTML);
  await page.setContent(
    `<!DOCTYPE html><html><body>
      <iframe src="http://127.0.0.1:${ctx.port}/artifact/${noTokenKey}/" sandbox="${SANDBOX}"></iframe>
      <script>
        window.__received = [];
        window.addEventListener('message', (e) => { window.__received.push(e.data); });
      </script>
    </body></html>`,
  );

  // GET /artifact/:key/ 409s a missing token before the file is even read
  // (SERVE-08's real double-read guard) -- this proves the consequence one
  // layer up: through the full iframe embedding, that 409 response body has
  // no <script> tag at all, so there is structurally no SDK code running
  // inside this iframe, and the "missing token" case is rejected before any
  // message could ever be constructed -- not merely unposted by convention.
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('body')).toContainText('Missing or invalid artifact_load_token/artifact_revision.');

  const messages = await received(page);
  expect(messages).toEqual([]);
});

// --- 7. No free-text intent path exists ---

test('every posted intent is one of the 5 closed-set values -- never an arbitrary string', async ({ page }) => {
  await openFixtureChromeShell(page);
  const frame = page.frameLocator('iframe');
  const labels = ['Explain', 'Verify', 'Go deeper', 'Fix artifact', 'Fix code'];
  const expectedIntents = ['explain', 'verify', 'deeper', 'fix-artifact', 'fix-code'];

  for (let i = 0; i < labels.length; i++) {
    await frame.locator('#heading').click();
    await frame.locator('.illum-chip', { hasText: labels[i] as string }).click();
    await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();
  }

  const messages = await received(page, 5);
  expect(messages).toHaveLength(5);
  expect(messages.map((m) => m.payload?.intent)).toEqual(expectedIntents);
});

// --- 8. Clicking INSIDE an anchored block ---------------------------------
//
// The citation lives on the container; the reader clicks the prose. That made
// `e.target` a `<p>` with no `data-src` of its own, and the anchor lookup only
// ever read the clicked element -- so the single most ordinary interaction in
// the product dispatched with `anchor: null`. The agent got no source, answered
// from the claim alone, and said so politely in the card. Nothing failed, and
// the whole promise of a grounded explanation quietly did not happen.

test('clicking the prose inside an anchored block dispatches with that block anchor', async ({ page }) => {
  const load = await openFixtureChromeShell(page);
  const frame = page.frameLocator('iframe');

  await frame.locator('#blockprose').click();
  await frame.locator('.illum-chip', { hasText: 'Explain' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();

  const messages = await received(page, 1);
  const msg = messages[0];
  if (!msg) throw new Error('unreachable: messages.length === 1');
  expect(msg.artifact_load_token).toBe(load.artifactLoadToken);
  expect(msg.payload?.anchor).toEqual({
    src: 'src/example/block.ts',
    rev: 'abc123',
    anchorHash: 'block-anchor-hash',
  });
  // Retargeted to the block, not left pointing at the paragraph -- the block
  // is what carries the citation and what the hover affordance highlights.
  expect(msg.payload?.element.tag).toBe('div');
  expect(msg.payload?.element.selector).toBe('body > div#block');
});

test('clicking the citation line inside an anchored block anchors the same way', async ({ page }) => {
  await openFixtureChromeShell(page);
  const frame = page.frameLocator('iframe');

  await frame.locator('#blockcite').click();
  await frame.locator('.illum-chip', { hasText: 'Explain' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();

  const messages = await received(page, 1);
  expect(messages[0]?.payload?.anchor?.src).toBe('src/example/block.ts');
});

test('an element with nothing anchored above it still degrades gracefully', async ({ page }) => {
  // The retarget must not invent an anchor where there is none -- the
  // unanchored path is a real case, not a bug to paper over.
  await openFixtureChromeShell(page);
  const frame = page.frameLocator('iframe');

  await frame.locator('#footer').click();
  await frame.locator('.illum-chip', { hasText: 'Explain' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();

  const messages = await received(page, 1);
  expect(messages[0]?.payload?.anchor).toBeNull();
  expect(messages[0]?.payload?.element.tag).toBe('footer');
});

// --- 9. The picker opens where you pointed --------------------------------

test('the picker opens at the pointer, not at the corner of a full-width container', async ({ page }) => {
  // Clicking a page margin selects whatever full-width container is under it,
  // whose rect starts at x=0 and runs past the bottom of the viewport. Opening
  // below that rect flipped the menu above it, clamped to zero, and parked it
  // in the top-left corner -- nowhere near the click.
  await openFixtureChromeShell(page);
  const frame = page.frameLocator('iframe');

  const frameBox = await page.locator('iframe').boundingBox();
  expect(frameBox).not.toBeNull();
  if (!frameBox) return;
  const x = frameBox.x + frameBox.width - 60; // right margin, past the prose
  const y = frameBox.y + 320;
  await page.mouse.click(x, y);

  const menu = await frame.getByRole('dialog', { name: 'Review this element' }).boundingBox();
  expect(menu).not.toBeNull();
  if (!menu) return;
  // Tolerance is the composer's OWN size, not a fixed number: clicking near
  // the right edge legitimately shifts a 380px-wide popover left to keep it
  // on screen, and a fixed pixel budget would just encode whatever width it
  // happened to have when this was written. The property being asserted is
  // that it stays adjacent to the pointer rather than jumping to the corner
  // of some full-width container.
  expect(Math.abs(menu.x - x)).toBeLessThan(menu.width + 40);
  expect(Math.abs(menu.y - y)).toBeLessThan(menu.height + 40);
});
