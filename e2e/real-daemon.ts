// Shared real-daemon lifecycle helper -- used by every Playwright spec in
// this repo from 06-10-PLAN.md forward. Retires e2e/server.ts (JOIN-
// CONTRACT.md §5's own explicit instruction: "Delete once the real chrome
// shell (Phase 6) lands ... do not migrate its code forward"): every spec
// now drives a REAL daemon subprocess (via ensureDaemonRunning, exactly the
// same entry point the real CLI uses), not an in-process stand-in.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page, FrameLocator } from '@playwright/test';
import { ensureDaemonRunning } from '../src/daemon/orchestrate.ts';
import { readLock, isPidAlive } from '../src/daemon/lock.ts';
import { lockPathFor } from '../src/daemon/state-dir.ts';
import { sessionStorePathFor } from '../src/store/session-store.ts';
import { forceRemove } from '../test/fixtures/cleanup.ts';

export interface RealSessionContext {
  readonly port: number;
  readonly key: string;
  readonly artifactRoot: string;
}

export interface ArtifactLoad {
  readonly artifactLoadToken: string;
  readonly artifactRevision: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * This suite must NEVER cause the real daemon it spawns to invoke a real
 * `claude` binary (06-11's discovered hazard -- self-dispatch is wired by
 * default, and `handleCreateDispatch`'s only guard against it, absent an
 * active poll for the dispatched session's key, is `createClaudeOnPathProbe`'s
 * real `claude --version` PATH probe). `daemon-entry.ts` now reads
 * `ILLUMINATE_DISABLE_SELF_DISPATCH` (added concurrently, alongside this
 * plan, closing the identical gap for `test/cli-answer.test.ts`/
 * `test/cli-audit.test.ts`'s own real spawned-daemon subprocesses) and, when
 * it is exactly `'1'`, passes `isClaudeOnPathOverride: async () => false`
 * into `createDaemonServer` -- the real, production `isClaudeOnPathOverride`
 * seam, reached here via the SAME `EnsureDaemonOptions.env`/
 * `SpawnDaemonOptions.env` injection point Plan 01-08's idle-e2e test
 * already established, scoped to only the one spawned daemon, never this
 * test process's own `process.env`. Mirrors `test/cli-answer.test.ts`'s own
 * `ensureDaemonRunning(dir, { env: { ILLUMINATE_DISABLE_SELF_DISPATCH: '1' } })`
 * usage exactly.
 */
const NO_SELF_DISPATCH_ENV: NodeJS.ProcessEnv = { ILLUMINATE_DISABLE_SELF_DISPATCH: '1' };

function extractChromeLoadToken(sessionHtml: string): string {
  const match = sessionHtml.match(/<script id="illuminate-session-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!match || match[1] === undefined) throw new Error('session-data script tag not found in chrome shell HTML');
  const data = JSON.parse(match[1]) as { chrome_load_token?: unknown };
  if (typeof data.chrome_load_token !== 'string' || data.chrome_load_token.length === 0) {
    throw new Error('#illuminate-session-data did not contain a chrome_load_token string');
  }
  return data.chrome_load_token;
}

/**
 * `POST /api/sessions` against an already-running real daemon for a file
 * that already exists under `ctx.artifactRoot`. Lets a spec open a SECOND
 * (or third) independent session -- its own distinct `key` -- on the SAME
 * daemon process, without disturbing whatever session/token state another
 * already-open session holds (each `sessionKey` is derived 1:1 from the
 * file's real path, so a different file always yields a different key).
 */
export async function openSessionFile(ctx: Pick<RealSessionContext, 'port' | 'artifactRoot'>, fileName: string, html: string): Promise<{ key: string }> {
  const filePath = join(ctx.artifactRoot, fileName);
  await writeFile(filePath, html, 'utf8');
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: filePath }),
  });
  const body = (await res.json()) as { key: string };
  return { key: body.key };
}

/**
 * Spawns a REAL daemon (a real subprocess, via `ensureDaemonRunning` --
 * `src/daemon/orchestrate.ts`, imported directly, exactly as this project's
 * own `node --test` integration suites already do) against a freshly
 * `mkdtemp`'d artifact directory containing `fixtureHtml`, then opens a real
 * session for it via `POST /api/sessions`. No fixture stand-in anywhere in
 * this path -- everything from here on is the real daemon's real route
 * table.
 */
export async function startRealSession(fixtureHtml: string, fileName = 'artifact.html'): Promise<RealSessionContext> {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'illum-e2e-real-'));
  const { port } = await ensureDaemonRunning(artifactRoot, { env: NO_SELF_DISPATCH_ENV });
  const { key } = await openSessionFile({ port, artifactRoot }, fileName, fixtureHtml);
  return { port, key, artifactRoot };
}

/**
 * Shuts the real daemon down (token-checked `/shutdown`, matching `illuminate
 * stop`'s own request shape), falls back to `SIGTERM` if it does not exit
 * gracefully within a bounded window (mirrors `test/daemon/idle-e2e.test.ts`'s
 * own `stopDaemon` convention), then removes the derived session-store state
 * file and the temp artifact root. Runs unconditionally from every spec's
 * `test.afterAll` (T-06-22) so a failed run never leaves an orphaned daemon
 * process or lockfile behind to collide with a later invocation.
 */
export async function stopRealSession(ctx: RealSessionContext): Promise<void> {
  const lockPath = lockPathFor(ctx.artifactRoot);
  const record = await readLock(lockPath);
  if (record) {
    try {
      await fetch(`http://127.0.0.1:${record.port}/shutdown?token=${record.healthToken}`, {
        method: 'POST',
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // Wedged, already gone, or a transient network hiccup -- the isPidAlive
      // poll below is the real source of truth, not this response.
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
  await rm(sessionStorePathFor(ctx.artifactRoot), { force: true });
  await forceRemove(ctx.artifactRoot);
}

/**
 * `GET /session/:key` (mints a fresh `chromeLoadToken`) immediately followed
 * by `POST /api/:key/artifact-loads/begin` with that same token -- the real
 * handshake `03-03-PLAN.md`'s two routes define. Returns the real, currently
 * -valid `(artifact_load_token, artifact_revision)` pair a real chrome shell
 * would use to address `GET /artifact/:key/` right now.
 */
export async function beginArtifactLoad(port: number, key: string): Promise<ArtifactLoad> {
  const opened = await fetch(`http://127.0.0.1:${port}/session/${key}`);
  const chromeLoadToken = extractChromeLoadToken(await opened.text());
  const begun = await fetch(`http://127.0.0.1:${port}/api/${key}/artifact-loads/begin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chromeLoadToken }),
  });
  const body = (await begun.json()) as { artifact_load_token: string; artifact_revision: number };
  return { artifactLoadToken: body.artifact_load_token, artifactRevision: body.artifact_revision };
}

/** The real, fully-qualified `GET /artifact/:key/` URL for a given
 * (freshly-begun) load -- the sandboxed-iframe document, SDK-injected. */
export function artifactUrl(port: number, key: string, load: ArtifactLoad): string {
  return `http://127.0.0.1:${port}/artifact/${key}/?artifact_load_token=${load.artifactLoadToken}&artifact_revision=${load.artifactRevision}`;
}

/** The real, fully-qualified raw asset URL for a file under the artifact
 * root -- the plain Phase 1 static route (no SDK injection, no sandbox CSP,
 * no token check). Used as the "control" (no-SDK) page for SERVE-07's
 * non-restyle proof: the SAME on-disk file, read via a route that performs
 * no injection at all, rather than a hand-duplicated second fixture. */
export function rawAssetUrl(port: number, fileName: string): string {
  return `http://127.0.0.1:${port}/${fileName}`;
}

/**
 * `GET /session/:key`'s real shell HTML renders its iframe with NO
 * navigable `src` of its own -- the real, shipped `chrome-client.js`
 * performs the begin handshake itself (`POST /api/:key/artifact-loads/begin`,
 * using the `chromeLoadToken` this same load just minted) and only then
 * addresses the sandboxed iframe at the resulting, genuinely fresh
 * `(artifact_load_token, artifact_revision)` pair. This helper drives that
 * real path with NO interception of any kind: a plain `page.goto`, then
 * reads the real minted pair back from the iframe's own `src` attribute --
 * the exact same place a real user's browser (and this file's own
 * assertions) would observe it -- once the real handshake has actually
 * landed.
 */
export async function gotoRealSessionShell(page: Page, port: number, key: string): Promise<ArtifactLoad> {
  const sessionUrl = `http://127.0.0.1:${port}/session/${key}`;
  await page.goto(sessionUrl);
  await page.waitForFunction(() => {
    const src = document.querySelector('iframe')?.getAttribute('src') ?? '';
    return src.includes('artifact_load_token=');
  });
  const src = await page.locator('iframe').getAttribute('src');
  if (!src) throw new Error('gotoRealSessionShell: iframe has no src after the real begin handshake');
  const parsed = new URL(src, sessionUrl);
  const artifactLoadToken = parsed.searchParams.get('artifact_load_token');
  const artifactRevisionRaw = parsed.searchParams.get('artifact_revision');
  if (!artifactLoadToken || artifactRevisionRaw === null) {
    throw new Error('gotoRealSessionShell: iframe src is missing artifact_load_token/artifact_revision');
  }
  return { artifactLoadToken, artifactRevision: Number(artifactRevisionRaw) };
}

/** `gotoRealSessionShell` plus waiting for the SDK to have actually booted
 * inside the now-correctly-addressed iframe (at least one keyboard trigger
 * rendered), returning both a FrameLocator scoped to it AND the real
 * (token, revision) pair that was minted -- mirrors Plan 04-04's own
 * `openFixtureChromeShell` contract, now against the real daemon, plus the
 * real token callers need to assert against (there is no fixed fixture
 * token anymore -- every load mints a genuinely fresh one). */
export async function openRealChromeShell(page: Page, port: number, key: string): Promise<{ frame: FrameLocator; load: ArtifactLoad }> {
  const load = await gotoRealSessionShell(page, port, key);
  const frame = page.frameLocator('iframe');
  await frame.locator('.illum-trigger').first().waitFor();
  return { frame, load };
}
