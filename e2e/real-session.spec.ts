// The one plan in Phase 6 that drives a REAL browser against a REAL daemon:
// a real click on a real anchored element, through the real /session/:key
// and /artifact/:key/ routes, all the way to a real dispatch ledger entry --
// and a real browser-tab close observably stopping real presence heartbeats,
// without waiting out the full production disconnect-grace window. No
// fixture stand-in and no test-side workaround anywhere in this file: the
// real, shipped `chrome-client.js` performs its own begin handshake (setting
// the iframe's `src`) and its own dispatch-forwarding fetch, exactly as a
// real user's browser would.
//
// Deviation 1 (documented in 06-10-SUMMARY.md, still applicable):
// `GET /api/:key/dispatches` (the audit route, `summarizeForAudit`/
// `AuditSummary`, src/router/ingest.ts) deliberately reports ONLY aggregate
// totals (cost/tokens/deviations/refusals) -- ROUT-08's own doc comment:
// excludes any per-dispatch field, reinforcing EDU-02 discipline. It
// structurally cannot carry an `intent`/`role`/`model_tier` assertion for
// one specific dispatch. `GET /api/:key/poll`'s `PollResponse.dispatches`
// (the OTHER real, already-shipped EDU-02 surface, router/types.ts) is a
// `readonly DispatchEnvelope[]` and is exactly what a real harness consumes
// in production -- this file asserts against that instead, and additionally
// confirms the audit route is live.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startRealSession, stopRealSession, openRealChromeShell, type RealSessionContext } from './real-daemon.ts';
import { sessionStorePathFor } from '../src/store/session-store.ts';
import type { IlluminateState, SessionRecord } from '../src/store/session-store.ts';
import type { DispatchEnvelope } from '../src/router/types.ts';

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Real Session Fixture</title></head>
  <body>
    <h1 id="heading" data-src="src/example/widget.ts" data-rev="abc123" data-anchor-hash="real-session-anchor-hash">
      Anchored heading -- a real click on this drives a real dispatch
    </h1>
  </body>
</html>
`;

let ctx: RealSessionContext;

test.beforeAll(async () => {
  ctx = await startRealSession(FIXTURE_HTML);
});

test.afterAll(async () => {
  await stopRealSession(ctx);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function readSessionRecord(): Promise<SessionRecord> {
  const raw = await readFile(sessionStorePathFor(ctx.artifactRoot), 'utf8');
  const state = JSON.parse(raw) as IlluminateState;
  const record = state.sessions[ctx.key];
  if (!record) throw new Error('session record missing from the real state file');
  return record;
}

test('a real click on a real anchored element, through the real chrome shell, produces a real dispatch delivered by a real poll', async ({
  page,
}) => {
  // A real GET /api/:key/poll, open BEFORE the click -- the real production
  // consumption path (a harness awaiting the next dispatch), and belt-and-
  // suspenders against 06-11's self-dispatch hazard: startRealSession
  // (real-daemon.ts) already spawns this daemon with
  // ILLUMINATE_DISABLE_SELF_DISPATCH=1 (daemon-entry.ts's own real,
  // production isClaudeOnPathOverride seam, added concurrently alongside
  // this plan), so no real `claude` binary can be invoked regardless -- but
  // an open poll ALSO makes handleCreateDispatch's own
  // `!activePolls.isActive(key)` guard false, so even without that env var
  // this specific dispatch could never reach the probe.
  const pollPromise = fetch(`http://127.0.0.1:${ctx.port}/api/${ctx.key}/poll?timeoutMs=20000`).then(
    (r) => r.json() as Promise<{ status: string; dispatches: DispatchEnvelope[] }>,
  );
  // Generous, not a tight race: activePolls.enter(key) runs synchronously,
  // well before resolvePoll's own first await, the instant the server
  // receives this request -- this just gives the request time to actually
  // arrive before anything else happens below.
  await sleep(200);

  const { frame } = await openRealChromeShell(page, ctx.port, ctx.key);
  await frame.locator('#heading').click();
  await frame.locator('.illum-chip', { hasText: 'Explain' }).click();
  await frame.locator('.illum-composer-actions button', { hasText: 'Send' }).click();

  // No test-side forwarding of any kind below this line: the real, shipped
  // `chrome-client.js` performs the real `POST /api/:key/dispatches` call
  // itself, using the real message the real SDK really posted, validated
  // against the real artifact_load_token it obtained from its own begin
  // handshake. This poll resolving IS the proof.
  const pollResult = await pollPromise;
  expect(pollResult.status).toBe('dispatch');
  expect(pollResult.dispatches).toHaveLength(1);
  const envelope = pollResult.dispatches[0];
  if (!envelope) throw new Error('unreachable: dispatches.length === 1');
  expect(envelope.intent).toBe('explain');
  expect(envelope.role).toBe('tutor');
  expect(envelope.model_tier).toBe('haiku');
  expect(envelope.element.selector).toBe('body > h1#heading');
  expect(envelope.element.tag).toBe('h1');

  // The audit route is real and reachable, even though (by design) it
  // cannot itself carry this test's intent/role/tier assertion -- see this
  // file's header comment (Deviation 1).
  const audit = await fetch(`http://127.0.0.1:${ctx.port}/api/${ctx.key}/dispatches`);
  expect(audit.status).toBe(200);
});

test('closing the real browser tab stops real heartbeat requests from arriving, without waiting out the full disconnect-grace period', async ({
  page,
}) => {
  await openRealChromeShell(page, ctx.port, ctx.key);

  // Wait for at least one real heartbeat (chrome-client.js's own 5s
  // interval, entirely independent of the message-forwarding path -- the
  // heartbeat route never calls extractTypedIntent) to have actually
  // landed -- bounded polling of the real state file, never a fixed
  // sleep-and-hope.
  const bootDeadline = Date.now() + 10_000;
  let sawHeartbeat = false;
  while (Date.now() < bootDeadline) {
    const record = await readSessionRecord();
    if (record.browserLastSeenAt !== null) {
      sawHeartbeat = true;
      break;
    }
    await sleep(200);
  }
  expect(sawHeartbeat).toBe(true);

  const beforeCloseRecord = await readSessionRecord();
  const beforeCloseSeenAt = beforeCloseRecord.browserLastSeenAt;
  expect(beforeCloseSeenAt).not.toBeNull();
  // "recent" -- a real heartbeat arrived within the last ~10s.
  expect(Date.now() - Date.parse(beforeCloseSeenAt as string)).toBeLessThan(10_000);

  await page.close();

  // A short settle buffer BEFORE taking the "at close" snapshot: a
  // heartbeat fetch() already in flight (dispatched microseconds before
  // close) is a real HTTP request the server can still receive and record
  // even after page.close()'s own promise has resolved -- Chromium tearing
  // down the page does not retroactively un-send bytes already on the
  // wire. This is not a race in the PRODUCT (a genuinely dead browser
  // eventually falls silent regardless), only in how soon after `close()`
  // it is safe to call a request "the last one" for this assertion's own
  // baseline.
  await sleep(1000);
  const atCloseRecord = await readSessionRecord();
  const atCloseSeenAt = atCloseRecord.browserLastSeenAt;

  // A few more real heartbeat intervals' worth (chrome-client.js's fixed 5s
  // cadence) -- bounded and generous, never racing an exact deadline.
  await sleep(14_000);

  const afterWaitRecord = await readSessionRecord();
  expect(afterWaitRecord.browserLastSeenAt).toBe(atCloseSeenAt);
});
