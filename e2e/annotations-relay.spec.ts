// 07-04's chrome shell relay proof: the two new chrome->artifact message
// types (illuminate:syncAnnotations / illuminate:dispatchCreated) actually
// land inside the REAL sandboxed artifact iframe, over the REAL chrome
// shell and REAL daemon -- not a fixture stand-in.
//
// Load-bearing mechanism: Playwright's `page.addInitScript` runs "whenever
// the page is navigated or whenever a child frame is attached/navigated
// (evaluated in the context of the newly attached frame)" (Playwright's own
// docs). The SAME init script this file installs on the top page also runs
// inside the sandboxed, opaque-origin artifact iframe on its own
// navigation, letting this file observe messages posted directly to the
// iframe's own `contentWindow` (illuminate:syncAnnotations/dispatchCreated
// are never forwarded through the top page) by reading them back via a
// frame-scoped `.evaluate()` call -- mirrors this codebase's own
// `frame.locator('body').evaluate(...)` convention (e2e/intent-flow.spec.ts).
import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import { startRealSession, stopRealSession, openRealChromeShell, type RealSessionContext } from './real-daemon.ts';

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Annotations Relay Fixture</title></head>
  <body>
    <h1 id="heading" data-src="src/example/widget.ts" data-rev="abc123" data-anchor-hash="relay-fixture-anchor-hash">
      Anchored heading -- a real click on this drives a real dispatch
    </h1>
  </body>
</html>
`;

interface FromChromeMessage {
  readonly type: string;
  readonly payload?: {
    readonly protocol?: string;
    readonly dispatchId?: string;
    readonly elementUid?: string;
  };
}

let ctx: RealSessionContext;

test.beforeAll(async () => {
  ctx = await startRealSession(FIXTURE_HTML);
});

test.afterAll(async () => {
  await stopRealSession(ctx);
});

/** Installs this file's own passive message recorder (page-wide -- applies
 * to the sandboxed artifact iframe too, per Playwright's own addInitScript
 * semantics, confirmed by this file's own header comment), then opens the
 * real chrome shell (real GET /session/:key, real begin handshake, real
 * sandboxed GET /artifact/:key/), waiting for the SDK to have actually
 * booted. */
async function openFixtureChromeShell(page: Page): Promise<FrameLocator> {
  await page.addInitScript(() => {
    (window as unknown as { __fromChrome: unknown[] }).__fromChrome = [];
    window.addEventListener('message', (e) => {
      (window as unknown as { __fromChrome: unknown[] }).__fromChrome.push(e.data);
    });
  });
  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);
  return frame;
}

/**
 * Reads back `window.__fromChrome` from INSIDE the sandboxed iframe's own
 * context (never the top page). Polls (bounded) until `predicate` matches
 * some message or `timeoutMs` elapses -- mirrors e2e/intent-flow.spec.ts's
 * own `received()`: a cross-frame postMessage is genuinely asynchronous, so
 * a bare read immediately after an action can race delivery.
 */
async function waitForFromChrome(
  frame: FrameLocator,
  predicate: (m: FromChromeMessage) => boolean,
  timeoutMs = 7000,
): Promise<FromChromeMessage | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const messages = await frame
      .locator('body')
      .evaluate(() => (window as unknown as { __fromChrome?: FromChromeMessage[] }).__fromChrome ?? []);
    const found = messages.find(predicate);
    if (found) return found;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
}

test('illuminate:syncAnnotations arrives inside the real sandboxed iframe within the heartbeat window, carrying the real annotation-store protocol tag', async ({
  page,
}) => {
  const frame = await openFixtureChromeShell(page);

  // Bounded up to ~7s -- comfortably past chrome-client.js's real 5s
  // HEARTBEAT_INTERVAL_MS cadence, which this plan's own design note
  // deliberately reuses for card delivery instead of a WebSocket.
  const found = await waitForFromChrome(frame, (m) => m.type === 'illuminate:syncAnnotations', 7000);
  expect(found).toBeDefined();
  expect(found?.payload?.protocol).toBe('illuminate.annotations/1');
});

test('illuminate:dispatchCreated arrives inside the real sandboxed iframe shortly after a real "Explain" click, carrying a non-empty dispatchId', async ({
  page,
}) => {
  const frame = await openFixtureChromeShell(page);

  await frame.locator('#heading').click({ button: 'right' });
  await frame.locator('.illum-chip', { hasText: 'Explain' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();

  const found = await waitForFromChrome(frame, (m) => m.type === 'illuminate:dispatchCreated', 7000);
  expect(found).toBeDefined();
  expect(typeof found?.payload?.dispatchId).toBe('string');
  expect((found?.payload?.dispatchId ?? '').length).toBeGreaterThan(0);
});
