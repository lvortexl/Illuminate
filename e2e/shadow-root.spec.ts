// SERVE-07's literal, automated acceptance test: the artifact SDK renders
// its overlay UI into a shadow root using adoptedStyleSheets, never
// document, and provably does not restyle the artifact. Runs against a real
// Chromium instance (Playwright), not jsdom -- shadow-root creation,
// adoptedStyleSheets, and layout measurement are genuinely DOM behavior
// this plan's node --test suites (test/sdk/*.test.ts) cannot exercise.
//
// Repointed at the REAL daemon (06-10-PLAN.md): `GET /artifact/:key/`
// (SDK-injected, sandboxed, real freshness-guarded tokens) instead of the
// now-retired e2e/server.ts fixture's `/artifact.html`. This spec never
// embeds the artifact inside the chrome shell's iframe -- every assertion
// here is about the SDK's own top-level behavior, so it navigates the real
// artifact document directly, exactly as the old fixture-backed version
// did against its own `/artifact.html` route.
import { test, expect } from '@playwright/test';
import { startRealSession, stopRealSession, beginArtifactLoad, artifactUrl, rawAssetUrl, type RealSessionContext } from './real-daemon.ts';

const FIXTURE_FILE = 'artifact.html';

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Fixture Artifact</title>
  </head>
  <body>
    <h1
      id="heading"
      data-src="src/example/widget.ts"
      data-rev="abc123"
      class="title"
      style="color: navy; font-family: Georgia, serif"
    >
      Anchored heading -- data-src/data-rev present
    </h1>
    <p
      id="paragraph"
      data-src="src/example/other.ts"
      data-rev="def456"
      class="body-text"
      style="font-style: italic; background: #eef"
    >
      Anchored paragraph -- a visibly different tag, class, and inline style
      from the heading above, so a "does not restyle" test has something
      real to diff.
    </p>
    <footer id="footer" class="unanchored">
      Unanchored footer -- deliberately no data-src, for the graceful-
      degradation fixture (an unanchored element still gets a typed intent,
      just without grounding).
    </footer>
  </body>
</html>
`;

const STYLE_PROPS = ['color', 'backgroundColor', 'fontSize', 'display', 'position'] as const;
const STYLED_ELEMENT_IDS = ['heading', 'paragraph', 'footer'] as const;

let ctx: RealSessionContext;

test.beforeAll(async () => {
  ctx = await startRealSession(FIXTURE_HTML, FIXTURE_FILE);
});

test.afterAll(async () => {
  await stopRealSession(ctx);
});

/** A fresh, real, currently-valid `GET /artifact/:key/` URL -- SDK-injected,
 * sandboxed, real freshness-guarded tokens. Each call mints its own pair
 * (via a real begin handshake) so tests never race a shared, supersedable
 * token. */
async function freshArtifactUrl(): Promise<string> {
  const load = await beginArtifactLoad(ctx.port, ctx.key);
  return artifactUrl(ctx.port, ctx.key, load);
}

async function readComputedStyles(page: import('@playwright/test').Page) {
  return page.evaluate(
    ({ ids, props }) => {
      const out: Record<string, Record<string, string>> = {};
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) throw new Error(`fixture element #${id} not found`);
        const cs = getComputedStyle(el);
        out[id] = {};
        for (const prop of props) {
          out[id][prop] = cs[prop as keyof CSSStyleDeclaration] as unknown as string;
        }
      }
      return out;
    },
    { ids: STYLED_ELEMENT_IDS, props: STYLE_PROPS },
  );
}

// --- 1. Non-restyle: the core SERVE-07 acceptance test ---

test('the artifact fixture is byte-identical in computed style whether the SDK is present or absent', async ({ browser }) => {
  const sdkContext = await browser.newContext();
  const controlContext = await browser.newContext();
  try {
    const sdkPage = await sdkContext.newPage();
    await sdkPage.goto(await freshArtifactUrl());
    await sdkPage.waitForFunction(() => Boolean((window as unknown as { illuminate?: unknown }).illuminate));
    const withSdk = await readComputedStyles(sdkPage);

    // The "control" (no SDK) page: the SAME on-disk fixture file, read via
    // the plain Phase 1 static-asset route (no injectScriptTag splice, no
    // sandbox CSP, no token check) -- a genuinely un-injected read of the
    // identical bytes, not a hand-duplicated second fixture with the
    // script tag regexed back out.
    const controlPage = await controlContext.newPage();
    await controlPage.goto(rawAssetUrl(ctx.port, FIXTURE_FILE));
    const withoutSdk = await readComputedStyles(controlPage);

    expect(withSdk).toEqual(withoutSdk);
  } finally {
    await sdkContext.close();
    await controlContext.close();
  }
});

// --- 2. adoptedStyleSheets: shadow root only, never document ---

test('adoptedStyleSheets is applied to the shadow root only, never document', async ({ page }) => {
  await page.goto(await freshArtifactUrl());
  await page.waitForFunction(() => Boolean((window as unknown as { illuminate?: unknown }).illuminate));

  const counts = await page.evaluate(() => {
    const host = document.querySelector('[data-illuminate-ui="overlay"]') as HTMLElement | null;
    if (!host || !host.shadowRoot) throw new Error('shadow host not found');
    return {
      shadowRootSheets: host.shadowRoot.adoptedStyleSheets.length,
      documentSheets: document.adoptedStyleSheets.length,
    };
  });

  expect(counts.shadowRootSheets).toBe(1);
  expect(counts.documentSheets).toBe(0);
});

// --- 3. window.illuminate is non-configurable / non-writable ---

test('window.illuminate cannot be deleted or reassigned once the SDK has booted', async ({ page }) => {
  await page.goto(await freshArtifactUrl());
  await page.waitForFunction(() => Boolean((window as unknown as { illuminate?: unknown }).illuminate));

  const result = await page.evaluate(() => {
    // Sloppy-mode page.evaluate: delete/assignment against a
    // non-configurable/non-writable property silently no-ops rather than
    // throwing -- exactly the tamper-resistance boot.ts relies on.
    delete (window as unknown as Record<string, unknown>).illuminate;
    (window as unknown as Record<string, unknown>).illuminate = { hacked: true };
    return (window as unknown as { illuminate: unknown }).illuminate;
  });

  expect(result).toEqual({ ready: true });
});

// --- 4. Keyboard reachability: triggers in document order, correct labels, unanchored element skipped ---

test('every data-src element has a keyboard-reachable trigger, in document order, with a tag-labelled aria-label', async ({
  page,
}) => {
  await page.goto(await freshArtifactUrl());
  await page.waitForFunction(() => Boolean((window as unknown as { illuminate?: unknown }).illuminate));

  await page.evaluate(() => document.body.focus());

  async function activeElementInfo() {
    return page.evaluate(() => {
      const host = document.querySelector('[data-illuminate-ui="overlay"]') as HTMLElement | null;
      const active =
        document.activeElement === host && host?.shadowRoot ? host.shadowRoot.activeElement : document.activeElement;
      if (!active) return null;
      return {
        tag: active.tagName.toLowerCase(),
        ariaLabel: active.getAttribute('aria-label'),
        id: active.id || null,
        insideShadow: host?.shadowRoot?.contains(active) ?? false,
      };
    });
  }

  await page.keyboard.press('Tab');
  const first = await activeElementInfo();
  expect(first?.insideShadow).toBe(true);
  expect(first?.tag).toBe('button');
  expect(first?.ariaLabel).toContain('h1');
  expect(first?.id).not.toBe('footer');

  await page.keyboard.press('Tab');
  const second = await activeElementInfo();
  expect(second?.insideShadow).toBe(true);
  expect(second?.tag).toBe('button');
  expect(second?.ariaLabel).toContain('p');
  expect(second?.id).not.toBe('footer');

  // The unanchored fixture element never receives focus via this sequence.
  const footerFocused = await page.evaluate(() => document.activeElement === document.getElementById('footer'));
  expect(footerFocused).toBe(false);
});

// --- 5. Mouse hover: highlight tracks the hovered element's real geometry ---

test('hovering an anchored fixture element positions the shadow root highlight over its real geometry', async ({ page }) => {
  await page.goto(await freshArtifactUrl());
  await page.waitForFunction(() => Boolean((window as unknown as { illuminate?: unknown }).illuminate));

  await page.hover('#heading');

  const result = await page.evaluate(() => {
    const host = document.querySelector('[data-illuminate-ui="overlay"]') as HTMLElement | null;
    const highlight = host?.shadowRoot?.querySelector('.illum-highlight') as HTMLElement | null;
    const heading = document.getElementById('heading');
    if (!highlight || !heading) throw new Error('highlight or heading not found');
    const cs = getComputedStyle(highlight);
    const rect = heading.getBoundingClientRect();
    return {
      highlight: {
        left: parseFloat(cs.left),
        top: parseFloat(cs.top),
        width: parseFloat(cs.width),
        height: parseFloat(cs.height),
      },
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    };
  });

  const TOLERANCE = 1;
  expect(Math.abs(result.highlight.left - result.rect.left)).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(result.highlight.top - result.rect.top)).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(result.highlight.width - result.rect.width)).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(result.highlight.height - result.rect.height)).toBeLessThanOrEqual(TOLERANCE);
});

// --- 6. Zero requests to a foreign origin during boot, hover, keyboard nav, and click ---

test('boot, hover, keyboard navigation, and click never trigger a request outside this daemon\'s own origin', async ({
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

  await page.goto(await freshArtifactUrl());
  await page.waitForFunction(() => Boolean((window as unknown as { illuminate?: unknown }).illuminate));

  await page.hover('#paragraph');
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.click('#heading');

  expect(violations).toEqual([]);
});
