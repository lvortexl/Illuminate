// The interaction model (ADR-101): left-click SELECTS, right-click ACTS.
//
// The defect that started this: a capture-phase `click` listener on
// `document` opened the intent picker on every left click anywhere in the
// artifact -- including page margins, and including the click that ends a
// text selection. Reading an artifact was impossible without the menu
// appearing.
//
// Freeing left-click is also what makes multi-select affordable: selection
// needs a gesture, and inventing a modifier chord while the most natural
// gesture sits unused would be the worse trade.
import { test, expect, type FrameLocator } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startRealSession, stopRealSession, openRealChromeShell, type RealSessionContext } from './real-daemon.ts';

const FILE_A = 'alpha.ts';
const FILE_B = 'beta.ts';

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Interaction Model Fixture</title></head>
  <body>
    <p id="alpha" data-src="${FILE_A}" style="width: 300px">Alpha section, anchored at alpha.ts.</p>
    <p id="beta" data-src="${FILE_B}" style="width: 300px">Beta section, anchored at beta.ts.</p>
    <p id="plain" style="width: 300px">A plain paragraph that anchors nothing at all.</p>
  </body>
</html>
`;

let ctx: RealSessionContext;

test.beforeAll(async () => {
  ctx = await startRealSession(FIXTURE_HTML);
  await writeFile(join(ctx.artifactRoot, FILE_A), 'export const alpha = 1;\n', 'utf8');
  await writeFile(join(ctx.artifactRoot, FILE_B), 'export const beta = 2;\n', 'utf8');
});

test.afterAll(async () => {
  await stopRealSession(ctx);
});

/** The poll route's wire shape: `{ status, dispatches: [envelope, ...] }`. */
interface PollBody {
  readonly status: string;
  readonly dispatches: readonly {
    readonly targets: readonly { readonly source: { readonly path: string } | null }[];
  }[];
}

/** The composer is open when its intent chips are on screen. */
function composer(frame: FrameLocator) {
  return frame.locator('.illum-chip', { hasText: 'Verify' });
}

test('a left-click does NOT open the composer -- reading is not interrupted', async ({ page }) => {
  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);

  await frame.locator('#alpha').click();

  await expect(composer(frame)).toHaveCount(0);
});

test('a left-click on empty page margin opens nothing either', async ({ page }) => {
  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);

  // The original defect's worst case: the click lands on <body>, whose rect
  // starts at x=0 and runs past the viewport.
  await page.mouse.click(5, 5);

  await expect(composer(frame)).toHaveCount(0);
});

test('a right-click opens the composer', async ({ page }) => {
  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);

  await frame.locator('#alpha').click({ button: 'right' });

  await expect(composer(frame).first()).toBeVisible();
});

test('the keyboard trigger still opens the composer on a normal activation', async ({ page }) => {
  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);

  // Accessibility path: the per-anchored-element trigger button is an
  // explicit affordance and must keep working with a plain activation --
  // a right-click-only contract would strand keyboard users entirely.
  await frame.locator('.illum-trigger').first().click();

  await expect(composer(frame).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// ADR-102: several sections, one dispatch.
// ---------------------------------------------------------------------------

test('left-clicking two sections selects both, and clicking one again deselects it', async ({ page }) => {
  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);

  await frame.locator('#alpha').click();
  await expect(frame.locator('.illum-selected')).toHaveCount(1);

  await frame.locator('#beta').click();
  await expect(frame.locator('.illum-selected')).toHaveCount(2);

  await frame.locator('#beta').click();
  await expect(frame.locator('.illum-selected')).toHaveCount(1);
});

test('a multi-section selection reaches the agent as ONE dispatch carrying every section', async ({ page }) => {
  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);

  // Poll first: an actively-polling harness takes priority over self-dispatch.
  const polled = fetch(`http://127.0.0.1:${String(ctx.port)}/api/${ctx.key}/poll?timeoutMs=15000`).then(
    (res) => res.json() as Promise<PollBody>,
  );

  await frame.locator('#alpha').click();
  await frame.locator('#beta').click();
  // Right-click a section that IS in the selection -> acts on the whole set.
  await frame.locator('#alpha').click({ button: 'right' });
  await frame.locator('.illum-chip', { hasText: 'Explain' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();

  const body = await polled;
  expect(body.status).toBe('dispatch');
  // ONE dispatch, not two: the user chose one agent reasoning across the
  // whole selection over N independent answers.
  expect(body.dispatches).toHaveLength(1);
  const targets = body.dispatches[0]?.targets ?? [];
  expect(targets).toHaveLength(2);
  const paths = targets.map((t) => t.source?.path);
  expect(paths).toContain(FILE_A);
  expect(paths).toContain(FILE_B);
});

test('right-clicking OUTSIDE the selection acts on that one section only', async ({ page }) => {
  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);

  const polled = fetch(`http://127.0.0.1:${String(ctx.port)}/api/${ctx.key}/poll?timeoutMs=15000`).then(
    (res) => res.json() as Promise<PollBody>,
  );

  await frame.locator('#alpha').click();
  // #beta is NOT in the selection -- pointing elsewhere means that one
  // section is the subject, and the selection is left alone.
  await frame.locator('#beta').click({ button: 'right' });
  await frame.locator('.illum-chip', { hasText: 'Explain' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();

  const body = await polled;
  const targets = body.dispatches[0]?.targets ?? [];
  expect(targets).toHaveLength(1);
  expect(targets[0]?.source?.path).toBe(FILE_B);
});
