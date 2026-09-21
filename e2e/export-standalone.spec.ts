// 09-05's own capstone proof for EXP-01: the claim that `illuminate export
// <file.html>` produces a portable, self-contained copy is a claim about
// TOTAL ISOLATION from everything that built it -- the daemon that produced
// the file, and the network itself. No in-process unit test can honestly
// simulate that (09-03/09-04 already proved the structural/CLI half). This
// file proves it for real: a real click-to-explain round trip through a
// real daemon and a real chrome shell produces a real card in the real
// `.illum.json` sidecar; the real built CLI's `export` subcommand turns
// that into a single file; the daemon that produced it is then stopped
// ENTIRELY (not idle -- gone); and a fresh, real browser context, with
// request interception armed before the very first navigation, opens that
// file via a `file://` URL and is proven to issue zero outbound requests
// while still rendering the original content, the inlined local assets,
// and the materialized card text.
//
// Same real-daemon, real-browser discipline as every other e2e/*.spec.ts
// file in this project -- see education-cards.spec.ts's own header comment
// for why: the fixture harness that let Phase 6's dead click path slip past
// 617 passing tests has since been deleted.
//
// DESIGN NOTE -- why the exported file is NOT written into ctx.artifactRoot:
// `stopRealSession` (e2e/real-daemon.ts, off-limits to modify per this
// plan's own concurrency note) unconditionally `rm`s the ENTIRE
// `artifactRoot` recursively as part of its documented teardown. Writing
// the export there (the CLI's own default sibling-file location) would mean
// the very file this suite exists to test is deleted the moment the daemon
// producing it is stopped. `illuminate export --out <path>` (09-04's own
// flag) is used instead to route the export into an independent temp
// directory that outlives `ctx.artifactRoot`'s teardown -- the daemon is
// still the one that answered the dispatch and the export still reads that
// daemon's own on-disk artifact + sidecar; only the OUTPUT location is
// relocated, which is exactly what `--out` is for.
import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import { writeFile, mkdtemp, rm, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { anchorHash } from '../src/provenance/hash.ts';
import { readLock, isPidAlive } from '../src/daemon/lock.ts';
import { lockPathFor } from '../src/daemon/state-dir.ts';
import { sessionStorePathFor } from '../src/store/session-store.ts';
import { startRealSession, openRealChromeShell, type RealSessionContext } from './real-daemon.ts';
import { forceRemove } from '../test/fixtures/cleanup.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(HERE, '..');
const CLI_PATH = join(ROOT_DIR, 'dist', 'cli.mjs');

const WIDGET_FILE = 'widget.ts';
const WIDGET_CONTENT = 'export function widget(): string {\n  return "hello from the export-standalone fixture";\n}\n';
const WIDGET_ANCHOR_HASH = anchorHash(WIDGET_CONTENT);

const STYLE_CSS = 'body { font-family: export-standalone-fixture-font, sans-serif; color: rgb(1, 2, 3); }\n';
// A minimal, valid 1x1 transparent PNG -- real bytes, matching
// test/cli-export.test.ts's own fixture literal exactly (proven-valid PNG,
// not a placeholder).
const PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const HEADING_TEXT = 'Export Standalone Fixture Heading';
const MARKER = 'ILLUM-MARKER-EXPORT-STANDALONE-9c47e1';

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Export Standalone Fixture</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <h1 id="heading" data-src="${WIDGET_FILE}" data-anchor-hash="${WIDGET_ANCHOR_HASH}">
      ${HEADING_TEXT}
    </h1>
    <img id="pixel" src="pixel.png" alt="a tiny local image -- proves real asset inlining, not just text" />
  </body>
</html>
`;

let ctx: RealSessionContext;
let exportOutDir: string;
let exportedPath: string;
let relocatedDir: string | undefined;

/**
 * Clicks `selector` then "Explain" in the real intent picker, capturing the
 * real `dispatch_id` off the real `POST /api/:key/dispatches` response --
 * mirrors education-cards.spec.ts's own `explainClickDispatchId` verbatim
 * (each e2e spec file in this project keeps its own copy rather than
 * importing across spec files -- see education-capstone.spec.ts's own
 * identical duplication).
 */
async function explainClickDispatchId(page: Page, frame: FrameLocator, selector: string): Promise<string> {
  const responsePromise = page.waitForResponse((res) => res.url().includes('/dispatches') && res.request().method() === 'POST');
  await frame.locator(selector).click({ button: 'right' });
  await frame.locator('.illum-chip', { hasText: 'Explain' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();
  const response = await responsePromise;
  const body = (await response.json()) as { dispatch_id: string };
  return body.dispatch_id;
}

/**
 * `POST /api/dispatches/:id/answer` directly -- simulating a subagent,
 * never spawning a real `claude` process. Mirrors education-cards.spec.ts's
 * own `postAnswer` verbatim.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Stops the real daemon (token-checked `/shutdown`, SIGTERM fallback --
 * identical sequence to real-daemon.ts's own `stopRealSession`) WITHOUT
 * removing `ctx.artifactRoot`. Deliberately NOT `stopRealSession` itself
 * (off-limits to modify, and its own unconditional `rm` of `artifactRoot`
 * would remove nothing this suite still needs -- the export already lives
 * in `exportOutDir` by the time this runs -- but duplicating this smaller,
 * root-preserving shutdown mirrors education-capstone.spec.ts's own
 * `stopDaemonKeepingRoot` precedent exactly, and keeps this file free of
 * any dependency on `stopRealSession`'s specific cleanup side effects).
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

test.beforeAll(async ({ browser }) => {
  ctx = await startRealSession(FIXTURE_HTML);
  // Real sibling files under the same (git-less) artifact root: `widget.ts`
  // is the provenance anchor target (education-cards.spec.ts's own
  // chicken-and-egg-avoiding pattern); `style.css`/`pixel.png` are real
  // local assets the export transform must actually inline, not merely
  // leave as relative references that happen to still resolve.
  await writeFile(join(ctx.artifactRoot, WIDGET_FILE), WIDGET_CONTENT, 'utf8');
  await writeFile(join(ctx.artifactRoot, 'style.css'), STYLE_CSS, 'utf8');
  await writeFile(join(ctx.artifactRoot, 'pixel.png'), Buffer.from(PIXEL_PNG_BASE64, 'base64'));

  // One real click-to-explain round trip through the real chrome shell,
  // driven by the worker-scoped `browser` fixture (the only Playwright
  // fixture available inside `beforeAll` -- `page` is test-scoped and
  // cannot be requested here).
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);
    const dispatchId = await explainClickDispatchId(page, frame, '#heading');
    // Proves the real dispatchCreated relay fired before answering it.
    await expect(page.locator('.il-card[data-state="pending"]')).toBeVisible({ timeout: 5000 });

    await postAnswer(ctx.port, dispatchId, `${MARKER} -- real daemon-answered card, materialized into the export appendix.`, {
      model: 'export-standalone-test-model',
      tier: 'haiku',
    });
  } finally {
    await context.close();
  }

  // `handleAnswer` (server.ts) awaits `appendAnsweredDispatchToAnnotationStore`
  // before responding 200 -- `postAnswer` resolving successfully already
  // guarantees the sidecar write landed. Confirmed directly here anyway
  // (not just inferred), independent of any browser-side heartbeat sync,
  // since `illuminate export` reads the sidecar file, never the live UI.
  const annotationsRes = await fetch(`http://127.0.0.1:${ctx.port}/api/${ctx.key}/annotations`);
  const annotations = (await annotationsRes.json()) as {
    readonly cards: ReadonlyArray<{ readonly thread: ReadonlyArray<{ readonly markdown: string }> }>;
  };
  const recorded = annotations.cards.some((card) => card.thread.some((entry) => entry.markdown.includes(MARKER)));
  if (!recorded) {
    throw new Error('expected the posted answer to be durably recorded in the annotation store sidecar before export');
  }

  // The real built CLI's `export` subcommand, against the real artifact --
  // `--out` routes the output to an independent temp directory (see this
  // file's own header comment for why).
  const fixtureFile = join(ctx.artifactRoot, 'artifact.html');
  exportOutDir = await mkdtemp(join(tmpdir(), 'illum-e2e-export-out-'));
  exportedPath = join(exportOutDir, 'artifact.export.html');

  const result = spawnSync(process.execPath, [CLI_PATH, 'export', fixtureFile, '--out', exportedPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`illuminate export ${fixtureFile} --out ${exportedPath} failed (status ${String(result.status)}): ${result.stderr}`);
  }
  if (!existsSync(exportedPath)) {
    throw new Error(`expected ${exportedPath} to exist after a successful export`);
  }

  // The daemon that served the click-to-explain flow and produced the
  // export is now genuinely gone, not merely idle -- every test in this
  // file runs against an artifact whose producing daemon no longer exists.
  await stopDaemonKeepingRoot(ctx.artifactRoot);
});

test.afterAll(async () => {
  await rm(sessionStorePathFor(ctx.artifactRoot), { force: true });
  // `fs.rm`'s `maxRetries` defaults to 0, which causes real Windows `EBUSY`
  // flakes on recursive temp-dir cleanup in this project (this plan's own
  // hard constraint) -- retried explicitly on every recursive removal below.
  await forceRemove(ctx.artifactRoot);
  await forceRemove(exportOutDir);
  if (relocatedDir !== undefined) {
    await forceRemove(relocatedDir);
  }
});

/**
 * Arms unconditional request interception (every request, every resource
 * type -- T-09-09's own mitigation: an allowlist would silently under-report)
 * BEFORE navigating, so even the very first request is caught, navigates to
 * `fileUrl`, then asserts all three of this plan's required properties.
 *
 * EMPIRICAL FINDING (documented here, not assumed -- the task's own
 * instruction, since it explicitly warned this might not be true):
 * contrary to the plan's own speculation that `page.route` might not
 * surface a `file://` document's own top-level navigation, a real run on
 * this project's actual Playwright/Chromium version shows the OPPOSITE --
 * `page.route('**\/*', ...)` DOES intercept the top-level `file://`
 * navigation request itself, and `route.abort()`ing it makes `page.goto`
 * throw `net::ERR_FAILED` (confirmed by first running this function with an
 * unconditional `route.abort()` on every request: both tests failed with
 * exactly that error). This is actually a STRONGER proof surface than the
 * plan anticipated: total interception coverage, including the main
 * document itself, is achievable here. The one request that must be
 * allowed through is the navigation the test ITSELF asked for (opening the
 * exported file, an unavoidable local-disk read -- not an outbound network
 * request in any meaningful sense, the same act as double-clicking the file
 * in a file explorer); every other request of any kind is aborted. The
 * assertion below is therefore not "zero entries" but the strictly
 * stronger "the recorded list is EXACTLY the one expected local navigation
 * and nothing else" -- any additional request, of any resource type, to
 * any origin (including a second `file://` sub-resource fetch for a
 * reference that survived un-inlined), would show up here and fail it.
 */
async function assertRendersStandaloneWithZeroRequests(page: Page, fileUrl: string): Promise<void> {
  const seenRequests: { readonly url: string; readonly resourceType: string }[] = [];
  await page.route('**/*', (route) => {
    const request = route.request();
    seenRequests.push({ url: request.url(), resourceType: request.resourceType() });
    if (request.url() === fileUrl && request.resourceType() === 'document') {
      void route.continue();
    } else {
      void route.abort();
    }
  });

  await page.goto(fileUrl);

  // (a) The document actually rendered -- not just that `goto` didn't
  // throw. Includes proof the inlined local assets are genuinely live: the
  // CSS rule (spliced into a real <style> block) is applied, and the image
  // (a real data: URI, not a network fetch) actually decoded.
  // Scoped to the original `<h1 id="heading">` specifically (not a bare
  // `getByText`, empirically found ambiguous: the same heading text is
  // ALSO quoted, truncated, inside the materialized card appendix's own
  // anchor label -- `materializeCards`'s real, intended behavior, not a
  // bug -- so a text-only locator matches both).
  await expect(page.locator('#heading')).toBeVisible();
  await expect(page.locator('#heading')).toContainText(HEADING_TEXT);
  const bodyColor = await page.evaluate(() => getComputedStyle(document.body).color);
  expect(bodyColor).toBe('rgb(1, 2, 3)');
  const pixelNaturalWidth = await page.locator('#pixel').evaluate((img) => (img as HTMLImageElement).naturalWidth);
  expect(pixelNaturalWidth).toBeGreaterThan(0);

  // (b) No request of any kind occurred beyond the one, unavoidable local
  // navigation this test itself performed -- see this function's own
  // header comment for the exact, empirically-confirmed interception
  // behavior this assertion relies on.
  expect(seenRequests).toEqual([{ url: fileUrl, resourceType: 'document' }]);

  // (c) The real, daemon-answered card's content is visible as real text.
  await expect(page.getByText(MARKER)).toBeVisible();
}

test('exported file renders standalone with zero network requests, daemon stopped', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await assertRendersStandaloneWithZeroRequests(page, pathToFileURL(exportedPath).href);
  } finally {
    await context.close();
  }
});

test('exported file survives relocation to a directory with none of its original siblings or sidecar', async ({ browser }) => {
  relocatedDir = await mkdtemp(join(tmpdir(), 'illum-e2e-export-relocated-'));
  const relocatedPath = join(relocatedDir, 'artifact.export.html');
  await copyFile(exportedPath, relocatedPath);

  // Confirms the strengthened claim directly: nothing else is on disk
  // beside the exported file itself -- no original artifact, no sibling
  // asset files, no `.illum.json` sidecar -- for a stray relative reference
  // to accidentally still resolve against.
  const siblingEntries = await readdir(relocatedDir);
  expect(siblingEntries).toEqual(['artifact.export.html']);

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await assertRendersStandaloneWithZeroRequests(page, pathToFileURL(relocatedPath).href);
  } finally {
    await context.close();
  }
});
