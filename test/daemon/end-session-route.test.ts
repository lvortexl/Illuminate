import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { Server, IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LockRecord } from '../../src/daemon/lock.ts';
import { createDaemonServer } from '../../src/daemon/server.ts';
import { sessionStorePathFor } from '../../src/store/session-store.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

/**
 * POLL-01's own documented, twice-confirmed gap (06-07-SUMMARY.md,
 * 06-08-SUMMARY.md): `dispatch-ledger.ts`'s `endSession` has existed and
 * been unit-tested since 06-03, and `poll.ts` (06-05) already resolves an
 * ended session to `{status:'ended'}` before ever looking at the queue --
 * but until this file, no HTTP route anywhere called `endSession`, so that
 * outcome was structurally coded and provably unreachable. This file wires
 * `POST /api/:key/end` and proves, over REAL sockets against a REAL running
 * daemon (this codebase's established convention -- never a direct handler
 * call), that the outcome is now genuinely reachable.
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
  // 06-11 deviation (Rule 1 -- bug): forces "claude is not on PATH" so this
  // file's dispatch-creation calls never trigger a real self-dispatch
  // subprocess on a machine that happens to have a real `claude` binary
  // installed -- see test/daemon/dispatch-routes.test.ts's identical note.
  createDaemonServer(server, root, record, { idleMs: null, isClaudeOnPathOverride: async () => false });
  return { server, port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

/** Real server, real mkdtemp'd artifact root -- mirrors
 * test/daemon/artifact-routes.test.ts's own withServer. No git repo or
 * anchor resolution is needed anywhere in this file: ending a session
 * never touches provenance. */
async function withServer<T>(fn: (ctx: { port: number; root: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'illum-end-session-'));
  await writeFile(join(root, 'artifact.html'), '<html><body>hi</body></html>\n', 'utf8');
  const { server, port } = await startTestServer(root);
  try {
    return await fn({ port, root });
  } finally {
    await closeServer(server);
    await rm(sessionStorePathFor(root), { force: true });
    await forceRemove(root);
  }
}

async function createSession(port: number, file: string): Promise<string> {
  const created = await postJson(port, '/api/sessions', { file });
  assert.strictEqual(created.status, 200, `session creation failed: ${created.body}`);
  const { key } = JSON.parse(created.body) as { key: string };
  return key;
}

test('POST /api/:key/end on an unknown session returns 404 and performs no mutation', async () => {
  await withServer(async ({ port }) => {
    const res = await postJson(port, '/api/no-such-key/end', {});
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(JSON.parse(res.body), { error: 'unknown session' });
  });
});

test('POST /api/:key/end rejects a foreign Origin header, and allows one with no Origin at all', async () => {
  await withServer(async ({ port, root }) => {
    const key = await createSession(port, join(root, 'artifact.html'));

    const foreign = await postJson(port, `/api/${key}/end`, {}, { Origin: 'https://evil.example' });
    assert.strictEqual(foreign.status, 403);

    const trusted = await postJson(port, `/api/${key}/end`, {});
    assert.strictEqual(trusted.status, 200, `expected an absent Origin to be trusted: ${trusted.body}`);
  });
});

test('POST /api/:key/end then GET /api/:key/poll resolves ended immediately, with no dispatches queued', async () => {
  await withServer(async ({ port, root }) => {
    const key = await createSession(port, join(root, 'artifact.html'));

    const ended = await postJson(port, `/api/${key}/end`, {});
    assert.strictEqual(ended.status, 200);
    assert.deepStrictEqual(JSON.parse(ended.body), {});

    const polled = await rawRequest(port, { path: `/api/${key}/poll?timeoutMs=1000` });
    assert.strictEqual(polled.status, 200);
    assert.deepStrictEqual(
      JSON.parse(polled.body),
      { status: 'ended', dispatches: [] },
      'POLL-01: a poll against an ended session must resolve ended immediately, not waiting',
    );
  });
});

/**
 * The decisive POLL-01 real-wire proof: a poll ALREADY blocked, waiting
 * (registered before /end is ever called), must wake and resolve 'ended'
 * immediately -- never waiting out its own heartbeat/timeout cadence.
 * Mirrors dispatch-routes.test.ts's own "wakes a blocked poll" proof for a
 * fresh dispatch, but for the session-end outcome instead.
 */
test('a real, already-waiting poll wakes immediately to ended when /end is called mid-poll', async () => {
  await withServer(async ({ port, root }) => {
    const key = await createSession(port, join(root, 'artifact.html'));

    const pollDone = new Promise<{ status: number; body: string }>((resolveDone, rejectDone) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: `/api/${key}/poll?timeoutMs=10000`, method: 'GET', agent: false },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolveDone({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
          });
        },
      );
      req.on('error', rejectDone);
      req.end();
    });

    // Generous window for the poll above to actually register its waiter
    // (events.on/conn.onClose) before /end is ever called -- otherwise this
    // test would only prove the already-covered immediate-resolution path.
    await new Promise((r) => setTimeout(r, 100));

    const ended = await postJson(port, `/api/${key}/end`, {});
    assert.strictEqual(ended.status, 200);

    const start = Date.now();
    const result = await pollDone;
    const elapsedMs = Date.now() - start;

    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(JSON.parse(result.body), { status: 'ended', dispatches: [] });
    assert.ok(
      elapsedMs < 5000,
      `expected the waiting poll to wake immediately on /end, not wait out its 10s timeout (took ${String(elapsedMs)}ms)`,
    );
  });
});

test('POST /api/:key/end is idempotent -- calling it twice still 200s, and a poll still resolves ended', async () => {
  await withServer(async ({ port, root }) => {
    const key = await createSession(port, join(root, 'artifact.html'));

    const first = await postJson(port, `/api/${key}/end`, {});
    assert.strictEqual(first.status, 200);
    const second = await postJson(port, `/api/${key}/end`, {});
    assert.strictEqual(second.status, 200);

    const polled = await rawRequest(port, { path: `/api/${key}/poll?timeoutMs=50` });
    assert.deepStrictEqual(JSON.parse(polled.body), { status: 'ended', dispatches: [] });
  });
});
