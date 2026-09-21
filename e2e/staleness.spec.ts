// Plan 08-05's own real-lifecycle proof, closing STAL-02 and STAL-05: a
// REAL fixture git repository (test/fixtures/git-repo.ts), a REAL daemon
// subprocess spawned directly against that repo's own root (never
// startRealSession -- that mkdtemp's its own root, but this spec needs the
// artifact to live INSIDE the real fixture repo so findRepoRoot resolves
// it), and a REAL browser drive the whole detect -> mark -> dismiss ->
// reopen -> lost lifecycle, plus a second, separate daemon proving the
// degraded-watcher indicator. Zero mocks anywhere in this file -- every
// assertion is against real, observable page state or a real GET route on
// a real running daemon.
import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anchorHash } from '../src/provenance/hash.ts';
import { ensureDaemonRunning } from '../src/daemon/orchestrate.ts';
import { createFixtureRepo, type FixtureRepo } from '../test/fixtures/git-repo.ts';
import { openSessionFile, stopRealSession, openRealChromeShell, type RealSessionContext } from './real-daemon.ts';

// Mirrors real-daemon.ts's own NO_SELF_DISPATCH_ENV precedent -- this
// suite must never cause its spawned daemons to invoke a real `claude`
// binary. Declared locally rather than imported: real-daemon.ts does not
// export its own copy, and this file must not modify that shared,
// contended module.
const NO_SELF_DISPATCH_ENV: NodeJS.ProcessEnv = { ILLUMINATE_DISABLE_SELF_DISPATCH: '1' };

const WIDGET_FILE = 'widget.ts';
// Exactly two lines (+ trailing newline) -- the WHOLE file IS the cited
// L1-L2 range, so anchorHash(content) computed directly over the file's
// own full text is identical to what the real resolver computes when it
// slices headLines[0..2].join('\n') and re-normalizes (hash.ts's A1
// boundary trims/re-adds the same trailing newline either way).
const WIDGET_V1 = 'export const widgetLabel = "v1";\nexport const widgetVersion = 1;\n';
const WIDGET_V2 = 'export const widgetLabel = "v2-edited";\nexport const widgetVersion = 1;\n';
const WIDGET_V3 = 'export const widgetLabel = "v3-edited-again";\nexport const widgetVersion = 1;\n';
const WIDGET_ANCHOR_HASH = anchorHash(WIDGET_V1);

function lifecycleArtifactHtml(dataRev: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Staleness Lifecycle Fixture</title></head>
  <body>
    <h1 id="target" data-src="${WIDGET_FILE}#L1-L2" data-rev="${dataRev}" data-anchor-hash="${WIDGET_ANCHOR_HASH}">
      Anchored heading -- cites widget.ts lines 1-2
    </h1>
  </body>
</html>
`;
}

// No real anchor needed here -- this fixture only needs SOME [data-src]
// element so a .illum-trigger renders (openRealChromeShell's own wait
// condition), and a missing data-anchor-hash makes this anchor resolve to
// `refused` regardless, so it never produces a finding of its own that
// could confound the degraded-indicator assertion below.
const DEGRADED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Degraded Watcher Fixture</title></head>
  <body>
    <p data-src="nonexistent.ts">Not a real anchor -- exists only so a keyboard trigger renders.</p>
  </body>
</html>
`;

/** The real, spawned daemon's own `GET /api/:key/findings` route -- fetched
 * directly (not through the SDK/chrome shell) so the "unchanged produces no
 * finding" proof below does not depend on chrome-client.js's own 5s
 * heartbeat cadence to become non-vacuous. */
async function fetchFindings(
  port: number,
  key: string,
): Promise<{
  readonly findings: ReadonlyArray<{ readonly fingerprint: string; readonly rule: string; readonly status: string }>;
  readonly meta: { readonly watcherHealthy: boolean };
}> {
  const res = await fetch(`http://127.0.0.1:${port}/api/${key}/findings`);
  return (await res.json()) as {
    findings: ReadonlyArray<{ fingerprint: string; rule: string; status: string }>;
    meta: { watcherHealthy: boolean };
  };
}

/** Resolves once the chrome shell's own heartbeat-driven `GET .../findings`
 * has actually round-tripped -- registered BEFORE the action that should
 * trigger it, so the FIRST post-action sync (not some earlier, stale one)
 * is what this promise observes. Makes the "quiet default" proof below a
 * real one: the SDK is asserted to render nothing only AFTER a real
 * illuminate:syncFindings payload has actually reached it, never merely
 * because no payload has arrived yet. */
function waitForChromeFindingsSync(page: Page): Promise<void> {
  return page
    .waitForResponse(
      (res) => new URL(res.url()).pathname.endsWith('/findings') && res.request().method() === 'GET',
      { timeout: 15000 },
    )
    .then(() => undefined);
}

/** The trigger's own rendered fill.
 *
 * Was `getComputedStyle(el, '::after').backgroundColor` -- the state used to
 * be a second dot pinned to the corner of a "command" glyph. The trigger is
 * now itself a dot, so a stale one changes ITS OWN colour: one mark per
 * element instead of a mark on a mark. Still read from real computed style
 * in the real shadow root, which is the part of this assertion that matters
 * -- a class name alone would not prove the two states LOOK different. */
async function triggerBackgroundColor(frame: FrameLocator, selector: string): Promise<string> {
  return frame.locator(selector).evaluate((el) => getComputedStyle(el).backgroundColor);
}


test.describe('staleness lifecycle: detect -> mark -> dismiss -> reopen -> lost', () => {
  let repo: FixtureRepo;
  let ctx: RealSessionContext;

  test.beforeAll(async () => {
    repo = createFixtureRepo(false);
    const initialSha = repo.commitFile(WIDGET_FILE, WIDGET_V1, 'add widget');

    const { port } = await ensureDaemonRunning(repo.root, {
      env: {
        ...NO_SELF_DISPATCH_ENV,
        ILLUMINATE_STALENESS_DEBOUNCE_MS: '50',
        ILLUMINATE_STALENESS_RECONCILE_MS: '300',
      },
    });
    const { key } = await openSessionFile({ port, artifactRoot: repo.root }, 'artifact.html', lifecycleArtifactHtml(initialSha));
    ctx = { port, key, artifactRoot: repo.root };
  });

  test.afterAll(async () => {
    // Removes the daemon process AND recursively deletes repo.root (the
    // whole fixture repo, .git included) -- real-daemon.ts's own documented
    // cleanup contract.
    await stopRealSession(ctx);
  });

  test('the full real lifecycle: unchanged is silent, an edit marks touched, dismiss clears it, a later edit reopens it, and deletion marks lost -- visually distinct from touched', async ({
    page,
  }) => {
    // This single test drives SIX real state transitions end-to-end, each
    // potentially spanning a full 5s chrome-shell heartbeat tick (the real,
    // fixed cadence this plan's own env vars deliberately never override) --
    // comfortably exceeds Playwright's own 30s per-test default. A per-test
    // override, not a change to the shared playwright.config.ts.
    test.setTimeout(120_000);

    // --- (1) Clean checkout: immediately after the begin handshake, the
    // trigger carries neither marker class. Non-vacuous: this waits for a
    // REAL findings sync to land first (see waitForChromeFindingsSync's own
    // doc comment), and directly confirms via the real GET route that the
    // scanner itself produced zero findings, not merely that the SDK
    // hasn't been told anything yet. ---
    const firstSync = waitForChromeFindingsSync(page);
    const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);
    await firstSync;

    await expect
      .poll(async () => (await fetchFindings(ctx.port, ctx.key)).findings.length, { timeout: 10000 })
      .toBe(0);

    await expect(frame.locator('.illum-trigger')).not.toHaveClass(/illum-trigger--touched/);
    await expect(frame.locator('.illum-trigger')).not.toHaveClass(/illum-trigger--lost/);

    // --- (2) An in-place edit (same two lines, different content) marks
    // the trigger touched. Auto-retrying expect, bounded by a generous
    // timeout that spans the debounce/reconcile scan latency AND the real,
    // fixed 5s chrome heartbeat cadence (never itself overridden by this
    // plan's env vars). ---
    repo.commitFile(WIDGET_FILE, WIDGET_V2, 'edit widget (v2)');
    await expect(frame.locator('.illum-trigger')).toHaveClass(/illum-trigger--touched/, { timeout: 15000 });
    // Polled like the lost read below: these are two observations of a
    // surface a live daemon keeps reconciling, and the value must be the
    // settled one, not whatever a single read happens to catch.
    await expect
      .poll(async () => triggerBackgroundColor(frame, '.illum-trigger'), { timeout: 15000 })
      .toBe('rgba(217, 164, 65, 0.35)'); // --il-accent, softened
    const touchedColor = await triggerBackgroundColor(frame, '.illum-trigger');

    // --- (3) The drawer, opened by clicking its toggle, shows exactly one
    // entry naming widget.ts. ---
    await page.locator('#il-tab-findings').click();
    const entries = page.locator('.il-finding');
    await expect(entries).toHaveCount(1, { timeout: 8000 });
    await expect(entries.first()).toContainText(WIDGET_FILE);

    // --- (4) Dismissing that entry clears BOTH the drawer entry and the
    // trigger's marker class. Waits for the real dismiss POST to actually
    // round-trip first (not merely the click event) -- both assertions then
    // transition from a just-proven-present state (step 2/3 above) to
    // absent, so neither is vacuous. ---
    const dismissResponsePromise = page.waitForResponse(
      (res) => new URL(res.url()).pathname.includes('/dismiss') && res.request().method() === 'POST',
    );
    await entries.first().getByRole('button', { name: 'Dismiss' }).click();
    const dismissResponse = await dismissResponsePromise;
    expect(dismissResponse.status()).toBe(200);
    await expect(page.locator('.il-finding')).toHaveCount(0, { timeout: 10000 });
    await expect(frame.locator('.illum-trigger')).not.toHaveClass(/illum-trigger--touched/, { timeout: 10000 });

    // --- (5) A second edit, still touching the same two lines, at a NEWER
    // revision than the dismissal -- reopens the SAME finding: the marker
    // reappears and the drawer entry returns. Proves the revision-scoped
    // dismiss/reopen lifecycle (findings-store.ts, Plan 08-01) end-to-end,
    // not just at the unit level. ---
    repo.commitFile(WIDGET_FILE, WIDGET_V3, 'edit widget (v3, reopen)');
    await expect(frame.locator('.illum-trigger')).toHaveClass(/illum-trigger--touched/, { timeout: 20000 });
    await expect(page.locator('.il-finding')).toHaveCount(1, { timeout: 8000 });
    await expect(page.locator('.il-finding').first()).toContainText(WIDGET_FILE);

    // --- (6) Deleting the cited file is the REAL action a reader would
    // trigger -- a genuine git commit removing widget.ts from this real
    // fixture repo. It transitions the trigger to lost -- a VISUALLY
    // DISTINCT class AND a visually distinct rendered color from touched,
    // asserted directly against the shadow-root-rendered computed style
    // (never merely "some marker present").
    //
    // STAL-03: this step used to seed the `drift-lost` Finding directly,
    // because `confineToRepoRoot` refused any path that failed
    // `realpathSync` -- including a validly-cited file that had since been
    // DELETED -- so `classifyDrift`'s own correct `lost` branch was
    // structurally unreachable through the real pipeline. That is fixed:
    // containment now tolerates a provably-absent tail while still
    // resolving every segment that exists, so the LIVE scanner produces
    // this finding on its own. Nothing is seeded here any more -- a real
    // deletion, detected by the real daemon, rendered by the real SDK. ---
    repo.deleteFile(WIDGET_FILE, 'remove widget');
    await expect(frame.locator('.illum-trigger')).toHaveClass(/illum-trigger--lost/, { timeout: 15000 });
    await expect(frame.locator('.illum-trigger')).not.toHaveClass(/illum-trigger--touched/);
    // Polled, not read once: the class assertion above and this style read
    // are two separate observations of a surface a live daemon keeps
    // reconciling, and a single read can land on the frame between them.
    // The claim -- lost LOOKS different from touched -- is unchanged.
    await expect
      .poll(async () => triggerBackgroundColor(frame, '.illum-trigger'), { timeout: 15000 })
      .toBe('rgba(229, 105, 95, 0.35)'); // --il-bad, softened
    const lostColor = await triggerBackgroundColor(frame, '.illum-trigger');
    expect(lostColor).not.toBe(touchedColor);
    expect(touchedColor).toBe('rgba(217, 164, 65, 0.35)'); // --il-accent, softened
  });
});

test.describe('staleness lifecycle: degraded watcher indicator', () => {
  let degradedRoot: string;
  let degradedCtx: RealSessionContext;

  test.beforeAll(async () => {
    degradedRoot = await mkdtemp(join(tmpdir(), 'illum-e2e-staleness-degraded-'));
    const { port } = await ensureDaemonRunning(degradedRoot, {
      env: { ...NO_SELF_DISPATCH_ENV, ILLUMINATE_FORCE_WATCHER_UNHEALTHY: '1' },
    });
    const { key } = await openSessionFile({ port, artifactRoot: degradedRoot }, 'artifact.html', DEGRADED_HTML);
    degradedCtx = { port, key, artifactRoot: degradedRoot };
  });

  test.afterAll(async () => {
    await stopRealSession(degradedCtx);
  });

  test('a SEPARATE daemon started with ILLUMINATE_FORCE_WATCHER_UNHEALTHY=1 says so in the findings tab immediately after the begin handshake, with no real watcher failure ever induced', async ({
    page,
  }) => {
    await openRealChromeShell(page, degradedCtx.port, degradedCtx.key);
    // The rail states the degraded condition in words rather than by
    // restyling a corner toggle -- "findings may be out of date" is the fact
    // the human needs, and an amber border was never going to carry it.
    await page.locator('#il-tab-findings').click();
    await expect(page.locator('.il-degraded')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.il-degraded')).toContainText('out of date');
  });
});
