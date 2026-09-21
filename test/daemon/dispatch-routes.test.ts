import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { Server, IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { LockRecord } from '../../src/daemon/lock.ts';
import { createDaemonServer } from '../../src/daemon/server.ts';
import { sessionStorePathFor } from '../../src/store/session-store.ts';
import { getRepoContext } from '../../src/router/pool-registry.ts';
import { createFixtureRepo } from '../fixtures/git-repo.ts';
import type { FixtureRepo } from '../fixtures/git-repo.ts';
import { buildTypedIntentPayload } from '../../src/shared/intent.ts';
import type { IntentElement, IntentAnchor, Intent } from '../../src/shared/intent.ts';
import { anchorHash } from '../../src/provenance/hash.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

/**
 * 06-07's own live-wiring test suite -- everything below drives the routes
 * added in server.ts over REAL sockets against a REAL running daemon (this
 * codebase's established convention, per test/daemon/artifact-routes.test.ts),
 * never by calling a route handler directly. This file's centerpiece is the
 * authoritative EDU-02 black-box proof (Task 3, below): 20 real, distinct,
 * uniquely-marked explanations, answered over real HTTP, then grepped for
 * in a real poll response's RAW bytes.
 */

const ELEMENT: IntentElement = {
  uid: 'e1',
  selector: '#main > p:nth-child(2)',
  tag: 'p',
  text: 'some text',
  prefixContext: null,
  suffixContext: null,
};

/** Joins lines with a single trailing newline, matching git's own convention
 * (mirrors test/router/envelope.test.ts's own `block` helper). */
function block(lines: readonly string[]): string {
  return lines.join('\n') + '\n';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Same rationale as test/daemon/artifact-routes.test.ts's own rawRequest:
 * node:http's client sends the raw request line and headers exactly as
 * given -- a real request over a real socket against a real server, not a
 * mock.
 */
function rawRequest(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: options.path,
        method: options.method ?? 'GET',
        agent: false,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', rejectPromise);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function postJson(
  port: number,
  path: string,
  payload: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  const body = JSON.stringify(payload);
  return rawRequest(port, {
    method: 'POST',
    path,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
      ...extraHeaders,
    },
    body,
  });
}

interface TestServerOpts {
  pollHeartbeatMs?: number;
  disconnectGraceMs?: number;
}

async function startTestServer(root: string, serverOpts: TestServerOpts = {}): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.once('listening', () => resolvePromise());
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo from an ephemeral listen()');
  }
  const port = address.port;
  const record: LockRecord = {
    pid: process.pid,
    port,
    version: 'test',
    startedAt: new Date().toISOString(),
    healthToken: randomUUID(),
  };
  createDaemonServer(server, root, record, {
    idleMs: null,
    pollHeartbeatMs: serverOpts.pollHeartbeatMs,
    disconnectGraceMs: serverOpts.disconnectGraceMs,
    // 06-11 deviation (Rule 1 -- bug): this suite predates the self-dispatch
    // adapter and asserts against the real `/api/dispatches/:id/answer`
    // route directly; without this override, any machine that happens to
    // have a real `claude` binary on PATH (this one included) would have
    // every dispatch created here silently trigger a REAL `claude -p`
    // subprocess as an unintended side effect -- slow, non-deterministic,
    // and exactly what this plan's own hard constraints forbid for tests.
    // Forces "claude is not on PATH" for this whole file so none of these
    // pre-existing, non-self-dispatch-focused tests ever spawn a real
    // process; self-dispatch's own behavior is proven in
    // test/daemon/self-dispatch.test.ts instead.
    isClaudeOnPathOverride: async () => false,
  });
  return { server, port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

/**
 * Real server, real GIT REPO as the artifact root (not a plain mkdtemp'd
 * directory, unlike artifact-routes.test.ts's own withServer) -- this
 * plan's routes call `buildDispatchEnvelope`, which resolves anchors
 * through the real git-plumbing pipeline (`getRepoContext` + `resolve()`),
 * so the server's `root` must genuinely be (or be inside) a git repo for
 * an anchored dispatch to resolve real content. `artifact.html` is
 * committed once, up front, for every test's session-creation needs.
 *
 * `serverOpts` -- additive, optional overrides (DaemonServerOptions)
 * threaded straight through to createDaemonServer: `pollHeartbeatMs` lets
 * the POLL-03 heartbeat test observe a real whitespace heartbeat without
 * waiting out the real ~15s production cadence; `disconnectGraceMs` lets
 * the POLL-04 test observe a real `browser_disconnected` outcome without
 * waiting out the real 10s production grace window.
 */
async function withServer<T>(
  fn: (ctx: { port: number; repo: FixtureRepo }) => Promise<T>,
  serverOpts: TestServerOpts = {},
): Promise<T> {
  const repo = createFixtureRepo(false);
  repo.commitFile('artifact.html', '<html><body>hi</body></html>\n', 'add artifact.html');
  const { server, port } = await startTestServer(repo.root, serverOpts);
  try {
    return await fn({ port, repo });
  } finally {
    await closeServer(server);
    const { pool } = getRepoContext(repo.root);
    pool.close();
    await rm(sessionStorePathFor(repo.root), { force: true });
    await forceRemove(repo.root);
  }
}

async function createSession(port: number, file: string): Promise<string> {
  const created = await postJson(port, '/api/sessions', { file });
  assert.strictEqual(created.status, 200, `session creation failed: ${created.body}`);
  const { key } = JSON.parse(created.body) as { key: string };
  return key;
}

/** POSTs an unanchored dispatch for a freshly-uid'd element -- distinct
 * `uid`s are what keep `enqueueDispatch`'s dedupe key from collapsing
 * multiple, deliberately-separate dispatches into "the same click asked
 * twice" (dispatch-ledger.ts's own documented dedupe semantics). */
async function dispatchUnanchored(port: number, key: string, uid: string, intent: Intent = 'explain'): Promise<string> {
  const payload = buildTypedIntentPayload({ intent, element: { ...ELEMENT, uid, selector: `#${uid}` }, anchor: null });
  const res = await postJson(port, `/api/${key}/dispatches`, payload);
  assert.strictEqual(res.status, 200, `dispatch creation failed: ${res.body}`);
  const body = JSON.parse(res.body) as { dispatch_id: string };
  return body.dispatch_id;
}

// ---------------------------------------------------------------------------
// Task 3.1: the full round trip -- dispatch, poll delivers it, answer,
// a second poll sees nothing new. Exercises buildDispatchEnvelope against a
// REAL anchor in a REAL fixture repo, through the real route, not a direct
// function call.
// ---------------------------------------------------------------------------

test('full round trip: a real anchored dispatch is delivered by poll, answered, and a follow-up poll sees nothing new', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));

    const region = ['export function add(a: number, b: number): number {', '  return a + b;', '}'];
    const rev = repo.commitFile('src/math.ts', block(region), 'add math.ts');
    const anchor: IntentAnchor = { src: 'src/math.ts#L1-L3', rev, anchorHash: anchorHash(region.join('\n')) };
    const payload = buildTypedIntentPayload({ intent: 'explain', element: ELEMENT, anchor });

    const created = await postJson(port, `/api/${key}/dispatches`, payload);
    assert.strictEqual(created.status, 200);
    const { dispatch_id: dispatchId } = JSON.parse(created.body) as { dispatch_id: string };
    assert.ok(typeof dispatchId === 'string' && dispatchId.length > 0);

    const firstPoll = await rawRequest(port, { path: `/api/${key}/poll?timeoutMs=1000` });
    assert.strictEqual(firstPoll.status, 200);
    const firstBody = JSON.parse(firstPoll.body) as {
      status: string;
      dispatches: Array<{ dispatch_id: string; role: string; model_tier: string; source: { content: string | null } | null }>;
    };
    assert.strictEqual(firstBody.status, 'dispatch');
    assert.strictEqual(firstBody.dispatches.length, 1);
    assert.strictEqual(firstBody.dispatches[0]?.dispatch_id, dispatchId);
    assert.strictEqual(firstBody.dispatches[0]?.role, 'tutor');
    assert.strictEqual(firstBody.dispatches[0]?.model_tier, 'haiku');
    assert.strictEqual(firstBody.dispatches[0]?.source?.content, region.join('\n'));

    const answerRes = await postJson(port, `/api/dispatches/${dispatchId}/answer`, {
      markdown: 'This adds two numbers together and returns the sum.',
      model: 'claude-test-model',
      tier: 'haiku',
      tokensIn: 400,
      tokensOut: 120,
      cacheReadInputTokens: 0,
      costUsd: 0.0004,
      wallMs: 900,
    });
    assert.strictEqual(answerRes.status, 200, `answer failed: ${answerRes.body}`);
    assert.strictEqual(answerRes.headers['content-type'], 'text/plain');
    assert.match(answerRes.body, new RegExp(`^ok ${dispatchId} tutor/haiku 520 tokens 0\\.9s -> artifact\\.html$`));

    const secondPoll = await rawRequest(port, { path: `/api/${key}/poll?timeoutMs=50` });
    assert.strictEqual(secondPoll.status, 200);
    assert.deepStrictEqual(
      JSON.parse(secondPoll.body),
      { status: 'waiting', dispatches: [] },
      'the answered dispatch must never be re-delivered, and nothing new was queued',
    );
  });
});

// ---------------------------------------------------------------------------
// POLL-03, real wire: a no-timeout poll streams a real whitespace heartbeat
// over a real socket and still terminates as valid JSON. Uses the
// pollHeartbeatMs test seam (DaemonServerOptions) so this observes a real
// heartbeat without waiting out the ~15s production cadence -- the
// heartbeat CADENCE itself is already exhaustively proven with real timers
// in test/daemon/poll.test.ts; this test's own job is proving the ACTUAL
// BYTES over the ACTUAL wire, and that JSON.parse succeeds on the full
// accumulated body (leading whitespace is legal JSON, per ARCHITECTURE.md).
// ---------------------------------------------------------------------------

test('POLL-03 real wire: a no-timeout poll streams real whitespace heartbeat bytes over a real socket and still terminates as valid JSON', async () => {
  await withServer(
    async ({ port, repo }) => {
      const key = await createSession(port, join(repo.root, 'artifact.html'));

      const chunks: Buffer[] = [];
      let responseHeaders: IncomingMessage['headers'] | undefined;
      const responseDone = new Promise<{ status: number; body: string }>((resolveDone, rejectDone) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path: `/api/${key}/poll`, method: 'GET', agent: false },
          (res) => {
            responseHeaders = res.headers;
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              resolveDone({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
            });
          },
        );
        req.on('error', rejectDone);
        req.end();
      });

      // Generous window for the 20ms test-only heartbeat cadence to write
      // several real whitespace bytes over the real socket before anything
      // is ever enqueued.
      await sleep(150);
      const beforeDispatch = Buffer.concat(chunks).toString('utf8');
      assert.ok(beforeDispatch.length > 0, 'expected at least one real whitespace heartbeat byte to have arrived over the wire');
      assert.ok(
        /^\s+$/.test(beforeDispatch),
        `expected ONLY whitespace before any dispatch is queued, got: ${JSON.stringify(beforeDispatch)}`,
      );

      // Now enqueue a dispatch -- the still-open poll must wake, drain, and
      // terminate with a valid JSON body, even though it already streamed
      // whitespace ahead of it.
      await dispatchUnanchored(port, key, 'poll03-heartbeat');

      const final = await responseDone;
      assert.strictEqual(final.status, 200);
      assert.strictEqual(responseHeaders?.['content-type'], 'application/json');

      // The decisive POLL-03 assertion: JSON.parse succeeds on the FULL
      // accumulated body -- heartbeat whitespace AND the terminal JSON
      // together -- with no custom client parser, exactly as
      // ARCHITECTURE.md specifies.
      const parsed = JSON.parse(final.body) as { status: string; dispatches: Array<{ dispatch_id: string }> };
      assert.strictEqual(parsed.status, 'dispatch');
      assert.strictEqual(parsed.dispatches.length, 1);
    },
    { pollHeartbeatMs: 20 },
  );
});

// ---------------------------------------------------------------------------
// POLL-04, real wire: a browser gone past its reconnect grace surfaces as a
// distinct, resumable `browser_disconnected` state, not an error and not a
// dropped connection. Uses the disconnectGraceMs test seam
// (DaemonServerOptions) for the same reason pollHeartbeatMs exists above --
// the re-arm-at-fire-time LOGIC is already exhaustively proven with real
// timers in test/daemon/poll.test.ts; this test's job is proving the real
// route (real heartbeat POST -> real poll GET) reaches that same outcome
// over the real wire.
// ---------------------------------------------------------------------------

test('POLL-04 real wire: a browser gone past its real reconnect grace surfaces as browser_disconnected, not an error, over a real poll', async () => {
  await withServer(
    async ({ port, repo }) => {
      const key = await createSession(port, join(repo.root, 'artifact.html'));

      // Establishes a genuine "last seen" via the real heartbeat route --
      // without this, browserLastSeenAt stays null, which isBrowserConnected
      // treats as "not yet proven disconnected" (a deliberate simplification
      // this test must not accidentally exercise).
      const heartbeat = await postJson(port, `/api/${key}/heartbeat`, {});
      assert.strictEqual(heartbeat.status, 200);

      // A generous overall timeoutMs so the ONLY way this poll can resolve
      // is via disconnect-grace expiry -- never the ordinary timeout branch
      // (which would also legitimately return 'waiting', masking a real bug
      // in the disconnect-grace wiring).
      const res = await rawRequest(port, { path: `/api/${key}/poll?timeoutMs=5000` });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(
        JSON.parse(res.body),
        { status: 'browser_disconnected', dispatches: [] },
        'a real poll must surface the real grace expiry as its own named state, never a thrown error or a bare timeout',
      );
    },
    { disconnectGraceMs: 60 },
  );
});

// ---------------------------------------------------------------------------
// Task 3.2: aborting a real, live poll connection mid-drain restores the
// dispatch(es), in order, to the front of the queue -- proven via a real
// socket destroy, not the fake PollConnection poll.test.ts already uses.
//
// This is inherently a best-effort race from a pure black-box HTTP client:
// there is no observable signal, from outside, of the exact instant the
// server has drained the queue but not yet flushed the response (the
// filesystem round trip inside store.mutate() is what "mid-drain" actually
// straddles). The approach taken: wait for the client's own 'finish' event
// (the full request has genuinely been written to the socket, so the
// server WILL receive it) before calling req.destroy() -- this reliably
// exercises the real network path while still destroying long before the
// disk-backed store.mutate() call the server is awaiting can resolve, and
// retries across several freshly-uid'd dispatch pairs to absorb any
// remaining scheduler jitter. Two dispatches per attempt (not one) so the
// test also proves ORDER survives the restore, not just that the id is not
// lost.
// ---------------------------------------------------------------------------

test('aborting a real, live poll mid-drain restores its dispatches to the front of the queue, in order, for the very next real poll', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));

    let restored = false;
    const attempts = 15;
    for (let attempt = 0; attempt < attempts && !restored; attempt++) {
      const idA = await dispatchUnanchored(port, key, `abort-${attempt}-a`);
      const idB = await dispatchUnanchored(port, key, `abort-${attempt}-b`);

      await new Promise<void>((resolveAbort) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path: `/api/${key}/poll`, method: 'GET', agent: false },
          () => {
            // A response arriving after we've already destroyed the
            // request is not interesting to this test either way.
          },
        );
        req.on('error', () => {
          // req.destroy() intentionally produces a client-side error
          // event -- expected, not a test failure.
        });
        req.once('finish', () => {
          req.destroy();
          resolveAbort();
        });
        req.end();
      });

      await sleep(50); // generous window for the server to notice the close and run restoreToQueue

      const followUp = await rawRequest(port, { path: `/api/${key}/poll?timeoutMs=300` });
      const followUpBody = JSON.parse(followUp.body) as {
        status: string;
        dispatches: Array<{ dispatch_id: string }>;
      };
      if (
        followUpBody.status === 'dispatch' &&
        followUpBody.dispatches.length === 2 &&
        followUpBody.dispatches[0]?.dispatch_id === idA &&
        followUpBody.dispatches[1]?.dispatch_id === idB
      ) {
        restored = true;
      }
    }
    assert.ok(restored, `expected both dispatches to be restored, in order, within ${attempts} attempts`);
  });
});

// ---------------------------------------------------------------------------
// Task 3.3: the authoritative EDU-02 black-box proof. 20 real, distinct
// explanations, each answered with a unique, high-entropy marker (a real
// crypto-random UUID) embedded in its markdown, over real HTTP. The RAW
// response text of a real poll taken after all 20 are answered must
// contain NONE of the 20 markers, and must stay small and bounded.
// ---------------------------------------------------------------------------

test('EDU-02 black-box proof: 20 real, distinct, uniquely-marked explanations never appear in a real poll response, raw bytes', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));

    const MARKER_COUNT = 20;
    const markers = Array.from({ length: MARKER_COUNT }, () => randomUUID());
    const dispatchIds: string[] = [];
    for (let i = 0; i < MARKER_COUNT; i++) {
      dispatchIds.push(await dispatchUnanchored(port, key, `edu02-${i}`));
    }
    assert.strictEqual(new Set(dispatchIds).size, MARKER_COUNT, 'sanity: 20 genuinely distinct dispatch ids');
    assert.strictEqual(new Set(markers).size, MARKER_COUNT, 'sanity: 20 genuinely distinct, non-reused markers');

    // Drain all 20 in one real poll -- proves the drain path scales to a
    // real fan-out, and hands back the ids in delivery order for the
    // answer loop below.
    const drainRes = await rawRequest(port, { path: `/api/${key}/poll?timeoutMs=1000` });
    assert.strictEqual(drainRes.status, 200);
    const drainBody = JSON.parse(drainRes.body) as { status: string; dispatches: Array<{ dispatch_id: string }> };
    assert.strictEqual(drainBody.status, 'dispatch');
    assert.strictEqual(drainBody.dispatches.length, MARKER_COUNT);

    // Answer every one of the 20 with a real, distinct markdown body
    // carrying exactly ONE unique marker each -- never reused, never
    // present anywhere else in this test file or its fixtures.
    for (let i = 0; i < MARKER_COUNT; i++) {
      const marker = markers[i];
      const answerRes = await postJson(port, `/api/dispatches/${dispatchIds[i]}/answer`, {
        markdown: `## Explanation ${String(i)}\n\nThis is a genuinely distinct, verbose explanation body meant to stand in for a real subagent's markdown answer. It discusses the anchored code region at some length, quotes a fabricated evidence line, and includes its own unique proof-of-uniqueness marker so this test can prove that marker never leaks into any orchestrator-reachable schema: ${marker}\n`,
        model: 'claude-test-model',
        tier: 'haiku',
        tokensIn: 500 + i,
        tokensOut: 300 + i,
        cacheReadInputTokens: 0,
        costUsd: 0.0012,
        wallMs: 2500,
      });
      assert.strictEqual(answerRes.status, 200, `answer ${String(i)} failed: ${answerRes.body}`);
    }

    // The decisive check: a real poll response, over the real wire, taken
    // immediately after 20 completed explanations, contains NONE of the 20
    // markers -- grepped against the RAW response text (res.body here is
    // the literal bytes read off the socket), never a parsed/re-serialized
    // object, so a leak via an unexpected field or a debug echo would
    // still be caught.
    const finalRes = await rawRequest(port, { path: `/api/${key}/poll?timeoutMs=50` });
    assert.strictEqual(finalRes.status, 200);
    assert.deepStrictEqual(
      JSON.parse(finalRes.body),
      { status: 'waiting', dispatches: [] },
      'nothing new is queued -- 20 completed answers must not resurrect as poll deliveries',
    );

    const finalByteLength = Buffer.byteLength(finalRes.body, 'utf8');
    assert.ok(finalByteLength < 2048, `expected the final poll response under 2KB, got ${String(finalByteLength)} bytes`);

    for (const marker of markers) {
      assert.ok(!finalRes.body.includes(marker), `marker ${marker} leaked into the final poll response's raw bytes`);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 3.4: same-origin guard (T-06-13).
// ---------------------------------------------------------------------------

test('a mutating dispatch route rejects a request bearing a foreign Origin header, and allows one with no Origin at all', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));
    const payload = buildTypedIntentPayload({ intent: 'explain', element: ELEMENT, anchor: null });

    const foreign = await postJson(port, `/api/${key}/dispatches`, payload, { Origin: 'https://evil.example' });
    assert.strictEqual(foreign.status, 403);

    const trusted = await postJson(port, `/api/${key}/dispatches`, payload);
    assert.strictEqual(trusted.status, 200, `expected an absent Origin to be trusted: ${trusted.body}`);
  });
});

// ---------------------------------------------------------------------------
// Task 3.5: ROUT-06's hard refusal, proven over real HTTP (not just the
// pure ingestAnswer unit test in test/router/ingest.test.ts).
// ---------------------------------------------------------------------------

test('ROUT-06 real refusal over real HTTP: a fix-code answer below the opus floor is 403, the ledger entry stays open, and no cost is recorded', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));
    const payload = buildTypedIntentPayload({ intent: 'fix-code', element: ELEMENT, anchor: null });

    const created = await postJson(port, `/api/${key}/dispatches`, payload);
    assert.strictEqual(created.status, 200);
    const { dispatch_id: dispatchId } = JSON.parse(created.body) as { dispatch_id: string };

    const refusedRes = await postJson(port, `/api/dispatches/${dispatchId}/answer`, {
      markdown: 'an attempted fix, below the required floor',
      model: 'claude-test-model',
      tier: 'haiku',
      tokensIn: 100,
      tokensOut: 50,
      cacheReadInputTokens: 0,
      costUsd: 0.01,
      wallMs: 500,
    });
    assert.strictEqual(refusedRes.status, 403);
    const refusedBody = JSON.parse(refusedRes.body) as { error: string };
    assert.match(refusedBody.error, /opus/, 'refusal reason must name the required floor');

    const auditRes = await rawRequest(port, { path: `/api/${key}/dispatches` });
    assert.strictEqual(auditRes.status, 200);
    const audit = JSON.parse(auditRes.body) as {
      totalCostUsd: number;
      totalTokensIn: number;
      totalTokensOut: number;
      totalCacheReadInputTokens: number;
      deviations: unknown[];
      refusals: unknown[];
    };
    assert.strictEqual(audit.totalCostUsd, 0, 'the refused attempt must never be billed');
    assert.strictEqual(audit.totalTokensIn, 0);
    assert.strictEqual(audit.totalTokensOut, 0);
    assert.deepStrictEqual(audit.deviations, []);
    assert.deepStrictEqual(audit.refusals, []);

    // Proves the ledger entry was left genuinely, byte-for-byte unchanged
    // by the hard refusal (still open/delivered, not silently marked
    // terminal) -- an already-terminal dispatch would 409 here instead.
    const acceptedRes = await postJson(port, `/api/dispatches/${dispatchId}/answer`, {
      markdown: 'a real opus-tier fix',
      model: 'claude-test-model',
      tier: 'opus',
      tokensIn: 4000,
      tokensOut: 900,
      cacheReadInputTokens: 0,
      costUsd: 0.45,
      wallMs: 60_000,
    });
    assert.strictEqual(acceptedRes.status, 200, `expected the dispatch to still be answerable: ${acceptedRes.body}`);
  });
});
