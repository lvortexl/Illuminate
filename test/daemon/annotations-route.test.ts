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
 * 07-04's own live-wiring test suite for `GET /api/:key/annotations`, the
 * shared answer-append helper (`appendAnsweredDispatchToAnnotationStore`),
 * and the deterministic EDU-07 verify-shortcut. Everything below drives the
 * routes added in server.ts over REAL sockets against a REAL running daemon
 * (mirrors test/daemon/dispatch-routes.test.ts's own established
 * convention), never by calling a route handler directly. Test helpers are
 * duplicated locally (never imported across test files) per this codebase's
 * own per-file-duplication convention for small test helpers.
 *
 * This file's centerpiece is the EXTENDED context-isolation regression
 * proof (the last test below): the same 20-uniquely-marked-explanations
 * pattern dispatch-routes.test.ts already proves against /poll, but with
 * TWO new checks this phase's own brief calls for: a negative on
 * /dispatches (audit) and a POSITIVE CONTROL on /annotations -- proving the
 * negative results are a deliberate, working separation, not an accident of
 * nothing being wired up yet.
 */

const ELEMENT: IntentElement = {
  uid: 'e1',
  selector: '#main > p:nth-child(2)',
  tag: 'p',
  text: 'some text',
  prefixContext: null,
  suffixContext: null,
};

/** Joins lines with a single trailing newline, matching git's own convention. */
function block(lines: readonly string[]): string {
  return lines.join('\n') + '\n';
}
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

async function startTestServer(root: string): Promise<{ server: Server; port: number }> {
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
    // Same rationale as dispatch-routes.test.ts's own override: forces
    // "claude is not on PATH" for this whole file so no real `claude`
    // process is ever spawned by a real machine's own PATH.
    isClaudeOnPathOverride: async () => false,
  });
  return { server, port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

async function withServer<T>(fn: (ctx: { port: number; repo: FixtureRepo }) => Promise<T>): Promise<T> {
  const repo = createFixtureRepo(false);
  repo.commitFile('artifact.html', '<html><body>hi</body></html>\n', 'add artifact.html');
  const { server, port } = await startTestServer(repo.root);
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

async function dispatchUnanchored(port: number, key: string, uid: string, intent: Intent = 'explain'): Promise<string> {
  const payload = buildTypedIntentPayload({ intent, targets: [{ element: { ...ELEMENT, uid, selector: `#${uid}` }, anchor: null }] });
  const res = await postJson(port, `/api/${key}/dispatches`, payload);
  assert.strictEqual(res.status, 200, `dispatch creation failed: ${res.body}`);
  const body = JSON.parse(res.body) as { dispatch_id: string };
  return body.dispatch_id;
}

interface AnnotationStoreBody {
  readonly protocol: string;
  readonly cards: ReadonlyArray<{
    readonly cardId: string;
    readonly thread: ReadonlyArray<{
      readonly dispatchId: string;
      readonly markdown: string;
      readonly model: string;
      readonly tier: string;
      readonly verdict: string | null;
      readonly decidingLines: string | null;
    }>;
  }>;
}

/** Callers that need the 404/unknown-key shape use `rawRequest` directly
 * (see the "unknown key" test below) -- every call site of this helper
 * expects a genuine 200 {AnnotationStore} response. */
async function getAnnotations(port: number, key: string): Promise<{ status: number; body: AnnotationStoreBody }> {
  const res = await rawRequest(port, { path: `/api/${key}/annotations` });
  return { status: res.status, body: JSON.parse(res.body) as AnnotationStoreBody };
}

// ---------------------------------------------------------------------------
// GET /api/:key/annotations -- basic shape and scoping.
// ---------------------------------------------------------------------------

test('GET /api/:key/annotations for a session with no cards yet returns an empty store', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));
    const { status, body } = await getAnnotations(port, key);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { protocol: 'illuminate.annotations/1', cards: [] });
  });
});

test('GET /api/:key/annotations for an unknown key returns 404', async () => {
  await withServer(async ({ port }) => {
    // Plain-text 404 body, mirroring handleAudit's own GET-route convention
    // for an unknown key -- not routed through getAnnotations's JSON.parse.
    const res = await rawRequest(port, { path: `/api/not-a-real-session-key/annotations` });
    assert.strictEqual(res.status, 404);
  });
});

test('after answering a dispatch, GET /api/:key/annotations reflects exactly one card carrying the answer markdown/model/tier/verdict/decidingLines', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));
    const dispatchId = await dispatchUnanchored(port, key, 'annot-1');

    const answerRes = await postJson(port, `/api/dispatches/${dispatchId}/answer`, {
      markdown: 'This is the full explanation body.',
      model: 'claude-test-model',
      tier: 'haiku',
      tokensIn: 400,
      tokensOut: 120,
      cacheReadInputTokens: 0,
      costUsd: 0.0004,
      wallMs: 900,
      verdict: 'supported',
      decidingLines: 'the cited evidence line',
    });
    assert.strictEqual(answerRes.status, 200, `answer failed: ${answerRes.body}`);

    const { status, body } = await getAnnotations(port, key);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.protocol, 'illuminate.annotations/1');
    assert.strictEqual(body.cards.length, 1);
    const [card] = body.cards;
    assert.strictEqual(card?.thread.length, 1);
    const [entry] = card?.thread ?? [];
    assert.strictEqual(entry?.dispatchId, dispatchId);
    assert.strictEqual(entry?.markdown, 'This is the full explanation body.');
    assert.strictEqual(entry?.model, 'claude-test-model');
    assert.strictEqual(entry?.tier, 'haiku');
    assert.strictEqual(entry?.verdict, 'supported');
    assert.strictEqual(entry?.decidingLines, 'the cited evidence line');
  });
});

// ---------------------------------------------------------------------------
// EDU-07's deterministic verify-shortcut.
// ---------------------------------------------------------------------------

test('a verify dispatch on an unanchored element is answered synchronously inside the create-dispatch request, zero-cost, verdict not-determinable', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));
    const payload = buildTypedIntentPayload({ intent: 'verify', targets: [{ element: { ...ELEMENT, uid: 'verify-1' }, anchor: null }] });

    const created = await postJson(port, `/api/${key}/dispatches`, payload);
    assert.strictEqual(created.status, 200, `dispatch creation failed: ${created.body}`);
    const { dispatch_id: dispatchId } = JSON.parse(created.body) as { dispatch_id: string };
    assert.ok(typeof dispatchId === 'string' && dispatchId.length > 0);

    // Zero additional requests beyond this one GET -- confirms the shortcut
    // already landed inside the SAME create-dispatch request, not on some
    // later delayed write.
    const { status, body } = await getAnnotations(port, key);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.cards.length, 1);
    const [entry] = body.cards[0]?.thread ?? [];
    assert.strictEqual(entry?.dispatchId, dispatchId);
    assert.strictEqual(entry?.verdict, 'not-determinable');

    // A second, real answer attempt against the same dispatch id must find
    // it already-terminal (T-07-11's documented idempotency guarantee).
    const doubleAnswer = await postJson(port, `/api/dispatches/${dispatchId}/answer`, {
      markdown: 'a real answer arriving late',
      model: 'claude-test-model',
      tier: 'haiku',
      tokensIn: 10,
      tokensOut: 10,
      cacheReadInputTokens: 0,
      costUsd: 0.001,
      wallMs: 100,
    });
    assert.strictEqual(doubleAnswer.status, 409);
  });
});

test('costUsd/tokensIn/tokensOut on the shortcut-answered verify dispatch are all zero', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));
    const payload = buildTypedIntentPayload({ intent: 'verify', targets: [{ element: { ...ELEMENT, uid: 'verify-cost' }, anchor: null }] });
    await postJson(port, `/api/${key}/dispatches`, payload);

    const auditRes = await rawRequest(port, { path: `/api/${key}/dispatches` });
    assert.strictEqual(auditRes.status, 200);
    const audit = JSON.parse(auditRes.body) as { totalCostUsd: number; totalTokensIn: number; totalTokensOut: number };
    assert.strictEqual(audit.totalCostUsd, 0);
    assert.strictEqual(audit.totalTokensIn, 0);
    assert.strictEqual(audit.totalTokensOut, 0);
  });
});

test('the ungroundable-verify shortcut dispatch is never delivered by a subsequent poll -- it never enters an open, poll-visible state', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));
    const payload = buildTypedIntentPayload({ intent: 'verify', targets: [{ element: { ...ELEMENT, uid: 'verify-poll' }, anchor: null }] });
    await postJson(port, `/api/${key}/dispatches`, payload);

    const pollRes = await rawRequest(port, { path: `/api/${key}/poll?timeoutMs=50` });
    assert.strictEqual(pollRes.status, 200);
    assert.deepStrictEqual(
      JSON.parse(pollRes.body),
      { status: 'waiting', dispatches: [] },
      'a deterministically-answered verify dispatch must never appear on a poll',
    );
  });
});

test('an ordinary explain dispatch on an anchored element with real resolvable content is unaffected -- still delivered by poll, isUngroundable never short-circuits it', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));
    const region = ['export function add(a: number, b: number): number {', '  return a + b;', '}'];
    const rev = repo.commitFile('src/math.ts', block(region), 'add math.ts');
    const anchor: IntentAnchor = { src: 'src/math.ts#L1-L3', rev, anchorHash: anchorHash(region.join('\n')) };
    const payload = buildTypedIntentPayload({ intent: 'explain', targets: [{ element: ELEMENT, anchor }] });

    const created = await postJson(port, `/api/${key}/dispatches`, payload);
    assert.strictEqual(created.status, 200);
    const { dispatch_id: dispatchId } = JSON.parse(created.body) as { dispatch_id: string };

    const pollRes = await rawRequest(port, { path: `/api/${key}/poll?timeoutMs=1000` });
    assert.strictEqual(pollRes.status, 200);
    const pollBody = JSON.parse(pollRes.body) as { status: string; dispatches: Array<{ dispatch_id: string }> };
    assert.strictEqual(pollBody.status, 'dispatch');
    assert.strictEqual(pollBody.dispatches.length, 1);
    assert.strictEqual(pollBody.dispatches[0]?.dispatch_id, dispatchId);

    // Not auto-answered -- annotations has no card yet.
    const { body: annotations } = await getAnnotations(port, key);
    assert.strictEqual(annotations.cards.length, 0);
  });
});

test('an anchored verify dispatch with real resolvable content is also unaffected by the shortcut -- isUngroundable is false, delivered by poll', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));
    const region = ['export function subtract(a: number, b: number): number {', '  return a - b;', '}'];
    const rev = repo.commitFile('src/math2.ts', block(region), 'add math2.ts');
    const anchor: IntentAnchor = { src: 'src/math2.ts#L1-L3', rev, anchorHash: anchorHash(region.join('\n')) };
    const payload = buildTypedIntentPayload({ intent: 'verify', targets: [{ element: { ...ELEMENT, uid: 'verify-anchored' }, anchor }] });

    const created = await postJson(port, `/api/${key}/dispatches`, payload);
    assert.strictEqual(created.status, 200);
    const { dispatch_id: dispatchId } = JSON.parse(created.body) as { dispatch_id: string };

    const pollRes = await rawRequest(port, { path: `/api/${key}/poll?timeoutMs=1000` });
    const pollBody = JSON.parse(pollRes.body) as { status: string; dispatches: Array<{ dispatch_id: string }> };
    assert.strictEqual(pollBody.status, 'dispatch');
    assert.strictEqual(pollBody.dispatches.length, 1);
    assert.strictEqual(pollBody.dispatches[0]?.dispatch_id, dispatchId);

    const { body: annotations } = await getAnnotations(port, key);
    assert.strictEqual(annotations.cards.length, 0, 'a groundable verify dispatch must not be auto-answered by the shortcut');
  });
});

// ---------------------------------------------------------------------------
// 07-07's ungroundable-self-explanation shortcut -- mirrors the ungroundable-
// verify shortcut above, but distinguished by learnerNote presence, not
// intent === 'verify', and never sets a Verdict (self-explanation grading is
// never a Verdict -- that field stays verify-only).
// ---------------------------------------------------------------------------

test('a self-explanation (learnerNote set) on an unanchored element is answered synchronously inside the create-dispatch request, zero-cost, verdict null', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));
    const payload = buildTypedIntentPayload({
      intent: 'explain',
      targets: [{ element: { ...ELEMENT, uid: 'self-explain-1' }, anchor: null }],
      learnerNote: 'I think this function adds two numbers together.',
      note: null,
    });

    const created = await postJson(port, `/api/${key}/dispatches`, payload);
    assert.strictEqual(created.status, 200, `dispatch creation failed: ${created.body}`);
    const { dispatch_id: dispatchId } = JSON.parse(created.body) as { dispatch_id: string };
    assert.ok(typeof dispatchId === 'string' && dispatchId.length > 0);

    // Zero additional requests beyond this one GET -- confirms the shortcut
    // already landed inside the SAME create-dispatch request.
    const { status, body } = await getAnnotations(port, key);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.cards.length, 1);
    const [entry] = body.cards[0]?.thread ?? [];
    assert.strictEqual(entry?.dispatchId, dispatchId);
    // Self-explanation grading is never a Verdict -- distinct from the
    // verify-shortcut's 'not-determinable', which this path must never set.
    assert.strictEqual(entry?.verdict, null);
    assert.ok(
      entry?.markdown.length > 0 && !entry.markdown.toLowerCase().includes('not determinable from this anchor'),
      'the self-explanation shortcut must use its own honest markdown, not reuse the verify-shortcut\'s wording',
    );

    // A second, real answer attempt against the same dispatch id must find
    // it already-terminal, mirroring the verify-shortcut's own idempotency
    // guarantee.
    const doubleAnswer = await postJson(port, `/api/dispatches/${dispatchId}/answer`, {
      markdown: 'a real answer arriving late',
      model: 'claude-test-model',
      tier: 'haiku',
      tokensIn: 10,
      tokensOut: 10,
      cacheReadInputTokens: 0,
      costUsd: 0.001,
      wallMs: 100,
    });
    assert.strictEqual(doubleAnswer.status, 409);
  });
});

test('the ungroundable-self-explanation shortcut is never delivered by a subsequent poll', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));
    const payload = buildTypedIntentPayload({
      intent: 'explain',
      targets: [{ element: { ...ELEMENT, uid: 'self-explain-poll' }, anchor: null }],
      learnerNote: 'my guess',
      note: null,
    });
    await postJson(port, `/api/${key}/dispatches`, payload);

    const pollRes = await rawRequest(port, { path: `/api/${key}/poll?timeoutMs=50` });
    assert.strictEqual(pollRes.status, 200);
    assert.deepStrictEqual(
      JSON.parse(pollRes.body),
      { status: 'waiting', dispatches: [] },
      'a deterministically-answered self-explanation dispatch must never appear on a poll',
    );
  });
});

test('an anchored self-explanation with real resolvable content is unaffected by the shortcut -- delivered by poll, not auto-answered', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));
    const region = ['export function multiply(a: number, b: number): number {', '  return a * b;', '}'];
    const rev = repo.commitFile('src/math3.ts', block(region), 'add math3.ts');
    const anchor: IntentAnchor = { src: 'src/math3.ts#L1-L3', rev, anchorHash: anchorHash(region.join('\n')) };
    const payload = buildTypedIntentPayload({
      intent: 'explain',
      targets: [{ element: { ...ELEMENT, uid: 'self-explain-anchored' }, anchor }],
      learnerNote: 'I think this multiplies two numbers.',
      note: null,
    });

    const created = await postJson(port, `/api/${key}/dispatches`, payload);
    assert.strictEqual(created.status, 200);
    const { dispatch_id: dispatchId } = JSON.parse(created.body) as { dispatch_id: string };

    const pollRes = await rawRequest(port, { path: `/api/${key}/poll?timeoutMs=1000` });
    const pollBody = JSON.parse(pollRes.body) as { status: string; dispatches: Array<{ dispatch_id: string }> };
    assert.strictEqual(pollBody.status, 'dispatch');
    assert.strictEqual(pollBody.dispatches.length, 1);
    assert.strictEqual(pollBody.dispatches[0]?.dispatch_id, dispatchId);

    const { body: annotations } = await getAnnotations(port, key);
    assert.strictEqual(annotations.cards.length, 0, 'a groundable self-explanation must not be auto-answered by the shortcut');
  });
});

test('the ungroundable-verify shortcut and the ungroundable-self-explanation shortcut are independent -- both can fire, on different dispatches, without interfering', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));

    const verifyPayload = buildTypedIntentPayload({ intent: 'verify', targets: [{ element: { ...ELEMENT, uid: 'both-verify' }, anchor: null }] });
    const verifyRes = await postJson(port, `/api/${key}/dispatches`, verifyPayload);
    assert.strictEqual(verifyRes.status, 200);
    const { dispatch_id: verifyDispatchId } = JSON.parse(verifyRes.body) as { dispatch_id: string };

    const selfExplainPayload = buildTypedIntentPayload({
      intent: 'explain',
      targets: [{ element: { ...ELEMENT, uid: 'both-self-explain' }, anchor: null }],
      learnerNote: 'my own guess',
      note: null,
    });
    const selfExplainRes = await postJson(port, `/api/${key}/dispatches`, selfExplainPayload);
    assert.strictEqual(selfExplainRes.status, 200);
    const { dispatch_id: selfExplainDispatchId } = JSON.parse(selfExplainRes.body) as { dispatch_id: string };

    const { body } = await getAnnotations(port, key);
    assert.strictEqual(body.cards.length, 2);
    const byDispatchId = new Map(body.cards.map((card) => [card.thread[0]?.dispatchId, card.thread[0]]));

    const verifyEntry = byDispatchId.get(verifyDispatchId);
    assert.strictEqual(verifyEntry?.verdict, 'not-determinable');

    const selfExplainEntry = byDispatchId.get(selfExplainDispatchId);
    assert.strictEqual(selfExplainEntry?.verdict, null);
  });
});

// ---------------------------------------------------------------------------
// The extended EDU-02/EDU-13 context-isolation regression: 20 real,
// distinct, uniquely-marked explanations. Negative on /poll AND /dispatches
// (audit); POSITIVE CONTROL on /annotations.
// ---------------------------------------------------------------------------

test('EDU-02 extended proof: 20 uniquely-marked explanations never leak into poll or audit raw bytes, but DO appear in annotations raw bytes (positive control)', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));

    const MARKER_COUNT = 20;
    const markers = Array.from({ length: MARKER_COUNT }, () => randomUUID());
    const dispatchIds: string[] = [];
    for (let i = 0; i < MARKER_COUNT; i++) {
      dispatchIds.push(await dispatchUnanchored(port, key, `edu02x-${i}`));
    }
    assert.strictEqual(new Set(dispatchIds).size, MARKER_COUNT, 'sanity: 20 genuinely distinct dispatch ids');
    assert.strictEqual(new Set(markers).size, MARKER_COUNT, 'sanity: 20 genuinely distinct, non-reused markers');

    const drainRes = await rawRequest(port, { path: `/api/${key}/poll?timeoutMs=1000` });
    const drainBody = JSON.parse(drainRes.body) as { status: string; dispatches: Array<{ dispatch_id: string }> };
    assert.strictEqual(drainBody.status, 'dispatch');
    assert.strictEqual(drainBody.dispatches.length, MARKER_COUNT);

    for (let i = 0; i < MARKER_COUNT; i++) {
      const marker = markers[i];
      const answerRes = await postJson(port, `/api/dispatches/${dispatchIds[i]}/answer`, {
        markdown: `## Explanation ${String(i)}\n\nA genuinely distinct, verbose markdown answer body carrying its own unique proof-of-uniqueness marker: ${marker}\n`,
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

    // Negative on /poll -- nothing new queued, raw bytes clean.
    const finalPoll = await rawRequest(port, { path: `/api/${key}/poll?timeoutMs=50` });
    assert.strictEqual(finalPoll.status, 200);
    assert.deepStrictEqual(JSON.parse(finalPoll.body), { status: 'waiting', dispatches: [] });
    for (const marker of markers) {
      assert.ok(!finalPoll.body.includes(marker), `marker ${marker} leaked into the poll response's raw bytes`);
    }

    // Negative on /dispatches (audit) -- this phase's own brief calls this
    // out as not previously covered with this specific proof.
    const auditRes = await rawRequest(port, { path: `/api/${key}/dispatches` });
    assert.strictEqual(auditRes.status, 200);
    for (const marker of markers) {
      assert.ok(!auditRes.body.includes(marker), `marker ${marker} leaked into the audit response's raw bytes`);
    }

    // POSITIVE CONTROL on /annotations -- proves the negative checks above
    // are a deliberate, working separation, not an accident of nothing
    // being wired up (a future refactor that broke prose delivery entirely
    // would make the negative checks pass vacuously; this positive control
    // is what keeps them meaningful).
    const annotationsRes = await rawRequest(port, { path: `/api/${key}/annotations` });
    assert.strictEqual(annotationsRes.status, 200);
    for (const marker of markers) {
      assert.ok(annotationsRes.body.includes(marker), `marker ${marker} was expected to appear in /annotations's raw bytes but did not`);
    }
  });
});
