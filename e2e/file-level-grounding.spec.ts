// ADR-001's real-browser, real-daemon proof: a section that NAMES a file but
// carries no `data-anchor-hash` now reaches the answering agent WITH that
// file's actual code.
//
// The defect this guards against, end to end: such a section used to resolve
// to `refused`, which made `isUngroundable` true, which made `verify`
// short-circuit to "no resolved source content is available to check this
// claim against" -- WITHOUT EVER OPENING THE FILE SITTING RIGHT THERE, and
// without any model ever being asked. Stamping a hash needs a git repo and a
// clean tree, which no ordinary agent-generated artifact has done, so every
// verify in real use hit this.
//
// Proven at the one boundary that actually matters: `GET /api/:key/poll` is
// where an answering agent receives its envelope, so asserting the real code
// is present there is asserting the agent can see it. A card-level assertion
// alone would not distinguish "the agent got the code" from "some card
// rendered".
//
// The opposite guard is proven too: a genuinely unanchored element -- nothing
// named, nothing to read -- must STILL short-circuit. The fix must not buy
// grounding by starting to guess.
import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startRealSession, stopRealSession, openRealChromeShell, type RealSessionContext } from './real-daemon.ts';

const TARGET_FILE = 'file-level-target.ts';
// A marker string that exists ONLY inside the real file on disk. Finding it in
// the dispatch envelope proves the bytes were read from that file, rather than
// echoed from the artifact or synthesized.
const TARGET_MARKER = 'the-grounded-marker-9f3a';
const TARGET_CONTENT = `export function target(): string {\n  return '${TARGET_MARKER}';\n}\n`;

// server.ts's own literal for the EDU-07 shortcut. Matching it is what proves
// a card is (or is not) the shortcut's output rather than a real answer.
const SHORTCUT_MARKER = 'no resolved source content is available to check this claim against';

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>File-level Grounding Fixture</title></head>
  <body>
    <p id="hashless" data-src="${TARGET_FILE}" style="width: 320px">
      This section names a real file but was never hash-stamped -- exactly what
      an ordinary agent-generated artifact produces.
    </p>
    <p id="unanchored" style="width: 320px">
      This section names nothing at all; there is genuinely nothing to read.
    </p>
  </body>
</html>
`;

let ctx: RealSessionContext;

test.beforeAll(async () => {
  ctx = await startRealSession(FIXTURE_HTML);
  await writeFile(join(ctx.artifactRoot, TARGET_FILE), TARGET_CONTENT, 'utf8');
});

test.afterAll(async () => {
  await stopRealSession(ctx);
});

async function verifyClick(page: Page, frame: FrameLocator, selector: string): Promise<void> {
  await frame.locator(selector).click({ button: 'right' });
  await frame.locator('.illum-chip', { hasText: 'Verify' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();
}

/** The poll route's own wire shape: `{ status, dispatches: [envelope, ...] }`
 * (server.ts's handlePoll), never a bare envelope. */
interface PollBody {
  readonly status: string;
  readonly dispatches: readonly {
    readonly targets: readonly { readonly source: { readonly status: string; readonly content: string | null } | null }[];
  }[];
}

test('a hash-less section hands the answering agent the real file content', async ({ page }) => {
  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);

  // Poll FIRST, then click. An actively-polling harness takes priority over
  // self-dispatch (server.ts's documented precedence), so this both receives
  // the envelope and keeps a real `claude` on PATH from racing for it.
  const polled = fetch(`http://127.0.0.1:${String(ctx.port)}/api/${ctx.key}/poll?timeoutMs=15000`).then(
    (res) => res.json() as Promise<PollBody>,
  );

  await verifyClick(page, frame, '#hashless');

  const body = await polled;

  expect(body.status).toBe('dispatch');
  expect(body.dispatches.length).toBeGreaterThan(0);
  const source = body.dispatches[0]?.targets[0]?.source ?? null;
  expect(source).not.toBeNull();
  // The tier is named on the envelope, so a working-tree read can never be
  // mistaken in the record for a revision-pinned one (ADR-003).
  expect(source?.status).toBe('file-level');
  // The actual regression assertion: real bytes from the real file on disk.
  expect(source?.content ?? '').toContain(TARGET_MARKER);
});

test('a hash-less section produces no "no resolved source" shortcut card', async ({ page }) => {
  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);

  const answerRequestUrls: string[] = [];
  page.on('request', (req) => {
    if (/\/api\/dispatches\/[^/]+\/answer$/.test(req.url())) answerRequestUrls.push(req.url());
  });

  await verifyClick(page, frame, '#hashless');

  // The shortcut card lands within the ~5s heartbeat sync when it fires at
  // all, so waiting past that and finding nothing is the real negative.
  await page.waitForTimeout(8000);
  await expect(page.locator('.il-card').filter({ hasText: SHORTCUT_MARKER })).toHaveCount(0);
  expect(answerRequestUrls).toEqual([]);
});

test('an element naming nothing STILL short-circuits -- the fix never guesses a path', async ({ page }) => {
  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);

  await verifyClick(page, frame, '#unanchored');

  const card = page.locator('.il-card').filter({ hasText: SHORTCUT_MARKER });
  await expect(card).toBeVisible({ timeout: 8000 });
  await expect(card.locator('.il-verdict')).toHaveAttribute('data-v', 'not-determinable');
  await expect(card).toContainText('illuminate (no model call)');
});
