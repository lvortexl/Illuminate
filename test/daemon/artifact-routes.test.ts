import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server, IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, mkdir, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LockRecord } from '../../src/daemon/lock.ts';
import { createDaemonServer } from '../../src/daemon/server.ts';
import { sessionStorePathFor } from '../../src/store/session-store.ts';
import { injectScriptTag } from '../../src/html/inject.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '../fixtures/artifacts');
// 06-09: GET /sdk.js and GET /chrome-client.js now read these real built
// files (resolveDistFile, server.ts) instead of the retired sdk-stub.ts
// placeholder -- `npm run build` must run before this test file, same
// requirement as test/html/no-cdn.test.ts's own note.
const ROOT_DIR = join(HERE, '..', '..');

const SANDBOX_CSP =
  'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads';

/**
 * Same rationale as test/serve/asset.test.ts's own rawRequest: node:http's
 * client sends the raw request line and headers exactly as given -- a real
 * request over a real socket against a real server, not a mock.
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
        // agent: false -- a fresh, unpooled socket per request, closed
        // immediately once the response ends. Without this, Node's default
        // keep-alive agent leaves the connection open and withServer's
        // server.close() (which waits for all open connections to drain,
        // not just to stop accepting new ones) stalls for up to the
        // server's default 5000ms keepAliveTimeout on whichever test
        // happens to leave the last live connection behind.
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
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  const body = JSON.stringify(payload);
  return rawRequest(port, {
    method: 'POST',
    path,
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
    body,
  });
}

function extractSessionData(html: string): { chrome_load_token: string } {
  const match = html.match(/<script id="illuminate-session-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!match || match[1] === undefined) throw new Error('session-data script tag not found in chrome shell HTML');
  return JSON.parse(match[1]) as { chrome_load_token: string };
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
  createDaemonServer(server, root, record, { idleMs: null });
  return { server, port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

/**
 * Real server, real mkdtemp'd artifact root, real SessionStore backed by
 * the real stateDir() (derived deterministically from `root`, per this
 * project's own Phase 1 decision to accept that coupling for testability
 * rather than adding a path-injection point to SessionStore). Cleans up
 * the server, the derived state file, and the temp root in `finally` so
 * nothing leaks into later test files under --test-concurrency=1.
 */
async function withServer<T>(
  setupFiles: (root: string) => Promise<void>,
  fn: (ctx: { port: number; root: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'illum-artifact-routes-'));
  const { server, port } = await startTestServer(root);
  try {
    await setupFiles(root);
    return await fn({ port, root });
  } finally {
    await closeServer(server);
    await rm(sessionStorePathFor(root), { force: true });
    await forceRemove(root);
  }
}

/**
 * Full session-open -> begin handshake against a real running server:
 * POST /api/sessions, GET /session/:key (for the chromeLoadToken), POST
 * /api/:key/artifact-loads/begin. Returns everything a Task 2 test needs to
 * drive GET /artifact/:key/? with a genuinely live (token, revision) pair.
 */
async function openAndBegin(
  port: number,
  file: string,
): Promise<{ key: string; artifactLoadToken: string; artifactRevision: number }> {
  const created = await postJson(port, '/api/sessions', { file });
  const { key } = JSON.parse(created.body) as { key: string };
  const opened = await rawRequest(port, { path: `/session/${key}` });
  const { chrome_load_token: chromeLoadToken } = extractSessionData(opened.body);
  const begun = await postJson(port, `/api/${key}/artifact-loads/begin`, { chromeLoadToken });
  const { artifact_load_token: artifactLoadToken, artifact_revision: artifactRevision } = JSON.parse(begun.body) as {
    artifact_load_token: string;
    artifact_revision: number;
  };
  return { key, artifactLoadToken, artifactRevision };
}

// ---------------------------------------------------------------------------
// Task 1: POST /api/sessions, GET /session/:key, POST /api/:key/artifact-loads/begin
// ---------------------------------------------------------------------------

test('POST /api/sessions with a file under root returns 200 {key}, idempotent on a repeat call', async () => {
  await withServer(
    async (root) => {
      await writeFile(join(root, 'artifact.html'), '<html><body>hi</body></html>', 'utf8');
    },
    async ({ port, root }) => {
      const file = join(root, 'artifact.html');
      const first = await postJson(port, '/api/sessions', { file });
      assert.strictEqual(first.status, 200);
      const firstBody = JSON.parse(first.body) as { key: string };
      assert.ok(typeof firstBody.key === 'string' && firstBody.key.length > 0);

      const second = await postJson(port, '/api/sessions', { file });
      assert.strictEqual(second.status, 200);
      const secondBody = JSON.parse(second.body) as { key: string };
      assert.strictEqual(secondBody.key, firstBody.key, 'same file -> same key, idempotent upsert');
    },
  );
});

test('POST /api/sessions with a file resolving outside root returns 403', async () => {
  await withServer(
    async (root) => {
      await mkdir(join(root, '..', 'outside'), { recursive: true }).catch(() => undefined);
    },
    async ({ port, root }) => {
      const outsideDir = join(root, '..', 'outside-artifact-routes-secret');
      await mkdir(outsideDir, { recursive: true });
      const outsideFile = join(outsideDir, 'secret.html');
      await writeFile(outsideFile, '<html></html>', 'utf8');
      try {
        const res = await postJson(port, '/api/sessions', { file: outsideFile });
        assert.strictEqual(res.status, 403);
      } finally {
        await forceRemove(outsideDir);
      }
    },
  );
});

test('POST /api/sessions with a file under a dot-prefixed directory returns 403 (ADR-105 binds every caller of resolveAssetPath)', async () => {
  await withServer(
    async (root) => {
      await mkdir(join(root, '.hidden'), { recursive: true });
      await writeFile(join(root, '.hidden', 'artifact.html'), '<html><body>hi</body></html>', 'utf8');
    },
    async ({ port, root }) => {
      const res = await postJson(port, '/api/sessions', { file: join(root, '.hidden', 'artifact.html') });
      assert.strictEqual(res.status, 403);
    },
  );
});

test('POST /api/sessions with a file that does not exist returns 404', async () => {
  await withServer(
    async () => undefined,
    async ({ port, root }) => {
      const res = await postJson(port, '/api/sessions', { file: join(root, 'does-not-exist.html') });
      assert.strictEqual(res.status, 404);
    },
  );
});

test('GET /session/:key for an unknown key returns 404', async () => {
  await withServer(
    async () => undefined,
    async ({ port }) => {
      const res = await rawRequest(port, { path: '/session/no-such-key' });
      assert.strictEqual(res.status, 404);
    },
  );
});

test('GET /session/:key for a known key serves a sandboxed iframe shell with clickjacking headers', async () => {
  await withServer(
    async (root) => {
      await writeFile(join(root, 'artifact.html'), '<html><body>hi</body></html>', 'utf8');
    },
    async ({ port, root }) => {
      const file = join(root, 'artifact.html');
      const created = await postJson(port, '/api/sessions', { file });
      const { key } = JSON.parse(created.body) as { key: string };

      const res = await rawRequest(port, { path: `/session/${key}` });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['content-type'], 'text/html');
      assert.strictEqual(res.headers['x-frame-options'], 'DENY');
      assert.strictEqual(res.headers['content-security-policy'], "frame-ancestors 'none'");

      const iframeMatch = res.body.match(/<iframe\s+([^>]*)>/);
      assert.ok(iframeMatch, 'shell HTML contains an <iframe> element');
      const iframeAttrs = iframeMatch?.[1] ?? '';
      assert.match(iframeAttrs, /sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"/);
      assert.ok(!iframeAttrs.includes('allow-same-origin'));
      assert.match(iframeAttrs, /id="illuminate-artifact-frame"/);
      // No navigable src of its own -- the real chrome-client.js performs
      // the begin handshake itself and addresses this iframe dynamically,
      // only once it has a genuinely fresh (artifact_load_token,
      // artifact_revision) pair. A bare, tokenless `/artifact/:key/` src
      // would 409 on arrival (see the fix this closes, 06-10-SUMMARY.md's
      // Threat Flags / deferred-items.md).
      assert.ok(!iframeAttrs.includes('src='), 'iframe has no src attribute in the raw server response');
    },
  );
});

test('GET /session/:key includes both the inert session-data script tag AND the real chrome-client script tag (06-09)', async () => {
  await withServer(
    async (root) => {
      await writeFile(join(root, 'artifact.html'), '<html><body>hi</body></html>', 'utf8');
    },
    async ({ port, root }) => {
      const file = join(root, 'artifact.html');
      const created = await postJson(port, '/api/sessions', { file });
      const { key } = JSON.parse(created.body) as { key: string };

      const res = await rawRequest(port, { path: `/session/${key}` });
      assert.strictEqual(res.status, 200);
      assert.ok(
        res.body.includes('<script id="illuminate-session-data" type="application/json">'),
        'the inert session-data script tag is still present',
      );
      assert.ok(
        res.body.includes('<script src="/chrome-client.js"></script>'),
        'the real chrome-client script tag is now injected alongside it',
      );
    },
  );
});

test('GET /session/:key mints a fresh chromeLoadToken on every call, even for an already-open session', async () => {
  await withServer(
    async (root) => {
      await writeFile(join(root, 'artifact.html'), '<html><body>hi</body></html>', 'utf8');
    },
    async ({ port, root }) => {
      const file = join(root, 'artifact.html');
      const created = await postJson(port, '/api/sessions', { file });
      const { key } = JSON.parse(created.body) as { key: string };

      const first = await rawRequest(port, { path: `/session/${key}` });
      const second = await rawRequest(port, { path: `/session/${key}` });

      const firstToken = extractSessionData(first.body).chrome_load_token;
      const secondToken = extractSessionData(second.body).chrome_load_token;
      assert.ok(firstToken.length > 0 && secondToken.length > 0);
      assert.notStrictEqual(firstToken, secondToken, 'two sequential GETs mint two different tokens');
    },
  );
});

test('POST /api/:key/artifact-loads/begin with the current chromeLoadToken returns 200', async () => {
  await withServer(
    async (root) => {
      await writeFile(join(root, 'artifact.html'), '<html><body>hi</body></html>', 'utf8');
    },
    async ({ port, root }) => {
      const file = join(root, 'artifact.html');
      const created = await postJson(port, '/api/sessions', { file });
      const { key } = JSON.parse(created.body) as { key: string };

      const opened = await rawRequest(port, { path: `/session/${key}` });
      const { chrome_load_token: chromeLoadToken } = extractSessionData(opened.body);

      const res = await postJson(port, `/api/${key}/artifact-loads/begin`, { chromeLoadToken });
      assert.strictEqual(res.status, 200);
      const body = JSON.parse(res.body) as { artifact_load_token: string; artifact_revision: number };
      assert.ok(typeof body.artifact_load_token === 'string' && body.artifact_load_token.length > 0);
      assert.strictEqual(body.artifact_revision, 1);
    },
  );
});

test('POST /api/:key/artifact-loads/begin with a stale chromeLoadToken returns 409 with a named take-over path', async () => {
  await withServer(
    async (root) => {
      await writeFile(join(root, 'artifact.html'), '<html><body>hi</body></html>', 'utf8');
    },
    async ({ port, root }) => {
      const file = join(root, 'artifact.html');
      const created = await postJson(port, '/api/sessions', { file });
      const { key } = JSON.parse(created.body) as { key: string };

      const firstOpen = await rawRequest(port, { path: `/session/${key}` });
      const { chrome_load_token: staleToken } = extractSessionData(firstOpen.body);

      // A second tab opens the same session, superseding the first.
      await rawRequest(port, { path: `/session/${key}` });

      const res = await postJson(port, `/api/${key}/artifact-loads/begin`, { chromeLoadToken: staleToken });
      assert.strictEqual(res.status, 409);
      const body = JSON.parse(res.body) as { status: string; message: string; take_over: string };
      assert.strictEqual(body.status, 'superseded');
      assert.ok(body.message.length > 0);
      assert.ok(body.take_over.includes(`/session/${key}`), 'take_over names the concrete take-over path');
    },
  );
});

test('POST /api/:key/artifact-loads/begin for an unknown key returns 404', async () => {
  await withServer(
    async () => undefined,
    async ({ port }) => {
      const res = await postJson(port, '/api/no-such-key/artifact-loads/begin', { chromeLoadToken: 'irrelevant' });
      assert.strictEqual(res.status, 404);
    },
  );
});

// ---------------------------------------------------------------------------
// Task 2: GET /artifact/:key/ (entry doc), GET /artifact/:key/<subpath>
// (sibling assets), GET /sdk.js -- freshness guard, injection, CSP sandbox
// ---------------------------------------------------------------------------

test('GET /artifact/:key/ with missing artifact_load_token/artifact_revision returns 409 expired', async () => {
  await withServer(
    async (root) => {
      await writeFile(join(root, 'artifact.html'), '<html><body>hi</body></html>', 'utf8');
    },
    async ({ port, root }) => {
      const { key } = await openAndBegin(port, join(root, 'artifact.html'));
      const res = await rawRequest(port, { path: `/artifact/${key}/` });
      assert.strictEqual(res.status, 409);
      const body = JSON.parse(res.body) as { status: string };
      assert.strictEqual(body.status, 'expired');
    },
  );
});

test('GET /artifact/:key/ with a non-matching artifact_load_token returns 409 expired', async () => {
  await withServer(
    async (root) => {
      await writeFile(join(root, 'artifact.html'), '<html><body>hi</body></html>', 'utf8');
    },
    async ({ port, root }) => {
      const { key, artifactRevision } = await openAndBegin(port, join(root, 'artifact.html'));
      const res = await rawRequest(port, {
        path: `/artifact/${key}/?artifact_load_token=wrong-token&artifact_revision=${artifactRevision}`,
      });
      assert.strictEqual(res.status, 409);
    },
  );
});

test('GET /artifact/:key/ with a matching token+revision returns 200 with the fully-qualified injected script and the CSP sandbox header', async () => {
  await withServer(
    async (root) => {
      await writeFile(join(root, 'artifact.html'), '<html><body>hi</body></html>', 'utf8');
    },
    async ({ port, root }) => {
      const { key, artifactLoadToken, artifactRevision } = await openAndBegin(port, join(root, 'artifact.html'));
      const res = await rawRequest(port, {
        path: `/artifact/${key}/?artifact_load_token=${artifactLoadToken}&artifact_revision=${artifactRevision}`,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['content-type'], 'text/html');
      assert.strictEqual(res.headers['content-security-policy'], SANDBOX_CSP);
      assert.ok(res.body.includes(`<script src="http://127.0.0.1:${port}/sdk.js?key=${key}"></script>`));
      assert.strictEqual(res.headers['x-illuminate-warnings'], undefined);
    },
  );
});

test('GET /artifact/:key/ for an unknown key returns 404', async () => {
  await withServer(
    async () => undefined,
    async ({ port }) => {
      const res = await rawRequest(port, {
        path: '/artifact/no-such-key/?artifact_load_token=x&artifact_revision=1',
      });
      assert.strictEqual(res.status, 404);
    },
  );
});

test('GET /artifact/:key/ surfaces X-Illuminate-Warnings for base-href and author-csp-meta fixtures, absent for a plain fixture', async () => {
  await withServer(
    async (root) => {
      await Promise.all([
        writeFile(join(root, 'base-href.html'), await readFile(join(FIXTURES_DIR, 'base-href.html'), 'utf8'), 'utf8'),
        writeFile(
          join(root, 'author-csp-meta.html'),
          await readFile(join(FIXTURES_DIR, 'author-csp-meta.html'), 'utf8'),
          'utf8',
        ),
        writeFile(
          join(root, 'plain.html'),
          await readFile(join(FIXTURES_DIR, 'body-in-comment.html'), 'utf8'),
          'utf8',
        ),
      ]);
    },
    async ({ port, root }) => {
      const baseHref = await openAndBegin(port, join(root, 'base-href.html'));
      const baseHrefRes = await rawRequest(port, {
        path: `/artifact/${baseHref.key}/?artifact_load_token=${baseHref.artifactLoadToken}&artifact_revision=${baseHref.artifactRevision}`,
      });
      assert.strictEqual(baseHrefRes.headers['x-illuminate-warnings'], 'base-href');

      const cspMeta = await openAndBegin(port, join(root, 'author-csp-meta.html'));
      const cspMetaRes = await rawRequest(port, {
        path: `/artifact/${cspMeta.key}/?artifact_load_token=${cspMeta.artifactLoadToken}&artifact_revision=${cspMeta.artifactRevision}`,
      });
      assert.strictEqual(cspMetaRes.headers['x-illuminate-warnings'], 'csp-meta');

      const plain = await openAndBegin(port, join(root, 'plain.html'));
      const plainRes = await rawRequest(port, {
        path: `/artifact/${plain.key}/?artifact_load_token=${plain.artifactLoadToken}&artifact_revision=${plain.artifactRevision}`,
      });
      assert.strictEqual(plainRes.headers['x-illuminate-warnings'], undefined);
    },
  );
});

test('GET /artifact/:key/<subpath> serves a real sibling file via serveAsset with the same CSP sandbox header', async () => {
  await withServer(
    async (root) => {
      await writeFile(join(root, 'artifact.html'), '<html><body>hi</body></html>', 'utf8');
      await writeFile(join(root, 'style.css'), 'body { color: red; }', 'utf8');
    },
    async ({ port, root }) => {
      const { key } = await openAndBegin(port, join(root, 'artifact.html'));
      const res = await rawRequest(port, { path: `/artifact/${key}/style.css` });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body, 'body { color: red; }');
      assert.strictEqual(res.headers['content-security-policy'], SANDBOX_CSP);
      assert.ok(res.headers['etag'], 'ETag/Range/MIME still come from the existing serveAsset');
    },
  );
});

test('GET /artifact/:key/<subpath> with a raw dot-segment traversal path never resolves to 200', async () => {
  // Deviation, same rationale as test/serve/asset.test.ts's own row-10 test:
  // server.ts (like the existing Phase 1 asset route) parses the request
  // via `new URL(req.url, ...)`, and the WHATWG URL Standard's own path
  // normalization strips literal AND percent-encoded dot-segments (".",
  // "..", "%2e", "%2e%2e", case-insensitively) before routing ever sees
  // them -- a raw "../" (or "%2e%2e/") traversal string can never survive
  // into url.pathname on this server, so it either lands back inside root
  // (harmless) or outside the /artifact/:key/ prefix entirely (falls
  // through to a different route and 404s there). Either way it never
  // reaches resolveAssetPath in a state where the target is genuinely
  // outside root, so 403 is not reachable via this specific payload shape
  // -- the decisive proof that resolveAssetPath's 'forbidden' branch maps
  // to 403 through this route is the symlink-escape test below.
  await withServer(
    async (root) => {
      await writeFile(join(root, 'artifact.html'), '<html><body>hi</body></html>', 'utf8');
    },
    async ({ port, root }) => {
      const { key } = await openAndBegin(port, join(root, 'artifact.html'));
      const res = await rawRequest(port, { path: `/artifact/${key}/../../outside/secret.txt` });
      assert.notStrictEqual(res.status, 200);
    },
  );
});

test('GET /artifact/:key/<subpath> via a symlink inside root pointing outside it returns 403 (T-03-06, decisive proof)', async (t) => {
  await withServer(
    async (root) => {
      await writeFile(join(root, 'artifact.html'), '<html><body>hi</body></html>', 'utf8');
    },
    async ({ port, root }) => {
      const outsideDir = join(root, '..', 'outside-artifact-sibling-secret');
      await mkdir(outsideDir, { recursive: true });
      const outsideFile = join(outsideDir, 'secret.txt');
      await writeFile(outsideFile, 'should never be reachable from root', 'utf8');
      const linkPath = join(root, 'escape-link.txt');
      try {
        await symlink(outsideFile, linkPath, 'file');
      } catch (err) {
        t.skip(
          `could not create a symlink in this environment (Windows requires elevated privileges or Developer Mode): ${(err as Error).message}`,
        );
        await forceRemove(outsideDir);
        return;
      }
      try {
        const { key } = await openAndBegin(port, join(root, 'artifact.html'));
        const res = await rawRequest(port, { path: `/artifact/${key}/escape-link.txt` });
        assert.strictEqual(res.status, 403);
      } finally {
        await forceRemove(outsideDir);
      }
    },
  );
});

// The Phase 3 placeholder (SDK_STUB / sdk-stub.ts) is gone as of 06-09 --
// GET /sdk.js now reads the real built dist/sdk.js file (resolveDistFile,
// server.ts). This constant is the exact retired placeholder string, kept
// here ONLY as a negative assertion that the route no longer serves it.
const RETIRED_SDK_STUB_TEXT =
  '// illuminate SDK placeholder -- Phase 4 implements the real artifact SDK\n(function () {})();\n';

test('GET /sdk.js serves the real built dist/sdk.js content, not the retired Phase 3 placeholder', async () => {
  await withServer(
    async () => undefined,
    async ({ port }) => {
      const res = await rawRequest(port, { path: '/sdk.js' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['content-type'], 'text/javascript; charset=utf-8');
      assert.ok(res.body.length > 0, 'response body must be non-empty');
      assert.notStrictEqual(res.body, RETIRED_SDK_STUB_TEXT, 'must differ from the old placeholder string');
      const realSdkJs = await readFile(join(ROOT_DIR, 'dist', 'sdk.js'), 'utf8');
      assert.strictEqual(res.body, realSdkJs, 'route content must be byte-identical to the real built file');
      assert.doesNotThrow(() => new Function(res.body), 'real sdk.js body must be syntactically valid JS');
    },
  );
});

test('GET /chrome-client.js serves the real built dist/chrome-client.js content', async () => {
  await withServer(
    async () => undefined,
    async ({ port }) => {
      const res = await rawRequest(port, { path: '/chrome-client.js' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['content-type'], 'text/javascript; charset=utf-8');
      assert.ok(res.body.length > 0, 'response body must be non-empty');
      const realChromeClientJs = await readFile(join(ROOT_DIR, 'dist', 'chrome-client.js'), 'utf8');
      assert.strictEqual(res.body, realChromeClientJs, 'route content must be byte-identical to the real built file');
      assert.doesNotThrow(() => new Function(res.body), 'real chrome-client.js body must be syntactically valid JS');
    },
  );
});

// ---------------------------------------------------------------------------
// Task 3: end-to-end integration proof over a real server -- the full
// session-open -> begin -> artifact-load -> supersede -> take-over
// lifecycle, byte-fidelity against the real route (not just the pure
// function), and the CSP sandbox header's exact shape on both response
// families.
// ---------------------------------------------------------------------------

test('end-to-end byte-fidelity: the real route produces exactly injectScriptTag\'s own output for a real 03-01 fixture', async () => {
  await withServer(
    async (root) => {
      await writeFile(
        join(root, 'quirky-mutations.html'),
        await readFile(join(FIXTURES_DIR, 'quirky-mutations.html'), 'utf8'),
        'utf8',
      );
    },
    async ({ port, root }) => {
      const originalHtml = await readFile(join(root, 'quirky-mutations.html'), 'utf8');
      const { key, artifactLoadToken, artifactRevision } = await openAndBegin(port, join(root, 'quirky-mutations.html'));

      const res = await rawRequest(port, {
        path: `/artifact/${key}/?artifact_load_token=${artifactLoadToken}&artifact_revision=${artifactRevision}`,
      });
      assert.strictEqual(res.status, 200);

      // Not just "contains a script tag" -- the FULL route's output must be
      // byte-identical to the pure function's own output for the actual
      // fully-qualified URL used, proving the real route (readFile -> parse5
      // splice -> response) never diverges from injectScriptTag in practice.
      const scriptUrl = `http://127.0.0.1:${port}/sdk.js?key=${key}`;
      const expected = injectScriptTag(originalHtml, scriptUrl);
      assert.strictEqual(res.body, expected.html);
    },
  );
});

test('end-to-end freshness 409: a same-tab reload (second begin) invalidates the first begin\'s (token, revision) pair', async () => {
  await withServer(
    async (root) => {
      await writeFile(join(root, 'artifact.html'), '<html><body>hi</body></html>', 'utf8');
    },
    async ({ port, root }) => {
      const created = await postJson(port, '/api/sessions', { file: join(root, 'artifact.html') });
      const { key } = JSON.parse(created.body) as { key: string };
      const opened = await rawRequest(port, { path: `/session/${key}` });
      const { chrome_load_token: chromeLoadToken } = extractSessionData(opened.body);

      const firstBegin = await postJson(port, `/api/${key}/artifact-loads/begin`, { chromeLoadToken });
      const stale = JSON.parse(firstBegin.body) as { artifact_load_token: string; artifact_revision: number };

      // Simulate the same tab reloading BEFORE the first entry-document GET
      // ever lands -- a second begin with the SAME (still-current)
      // chromeLoadToken bumps the revision and mints a new artifactLoadToken.
      await postJson(port, `/api/${key}/artifact-loads/begin`, { chromeLoadToken });

      // The FIRST (now stale) pair must 409, never serve a mixed read.
      const res = await rawRequest(port, {
        path: `/artifact/${key}/?artifact_load_token=${stale.artifact_load_token}&artifact_revision=${stale.artifact_revision}`,
      });
      assert.strictEqual(res.status, 409);
      const body = JSON.parse(res.body) as { status: string };
      assert.strictEqual(body.status, 'expired');
    },
  );
});

test('end-to-end supersession + take-over: tab A supersedes tab B supersedes tab A, reversibly, never a dead end', async () => {
  await withServer(
    async (root) => {
      await writeFile(join(root, 'artifact.html'), '<html><body>hi</body></html>', 'utf8');
    },
    async ({ port, root }) => {
      const created = await postJson(port, '/api/sessions', { file: join(root, 'artifact.html') });
      const { key } = JSON.parse(created.body) as { key: string };

      // Tab A opens and begins successfully.
      const tabAOpen1 = await rawRequest(port, { path: `/session/${key}` });
      const tabAToken1 = extractSessionData(tabAOpen1.body).chrome_load_token;
      const tabABegin1 = await postJson(port, `/api/${key}/artifact-loads/begin`, { chromeLoadToken: tabAToken1 });
      assert.strictEqual(tabABegin1.status, 200);

      // Tab B opens, superseding tab A.
      const tabBOpen = await rawRequest(port, { path: `/session/${key}` });
      const tabBToken = extractSessionData(tabBOpen.body).chrome_load_token;

      // Tab A's next begin (still using its original token) now 409s, named take-over path included.
      const tabABeginAfterSupersede = await postJson(port, `/api/${key}/artifact-loads/begin`, {
        chromeLoadToken: tabAToken1,
      });
      assert.strictEqual(tabABeginAfterSupersede.status, 409);
      const tabABeginAfterSupersedeBody = JSON.parse(tabABeginAfterSupersede.body) as {
        status: string;
        take_over: string;
      };
      assert.strictEqual(tabABeginAfterSupersedeBody.status, 'superseded');
      assert.ok(tabABeginAfterSupersedeBody.take_over.includes(`/session/${key}`));

      // Tab A takes the session back by re-GETting /session/:key itself.
      const tabAOpen2 = await rawRequest(port, { path: `/session/${key}` });
      const tabAToken2 = extractSessionData(tabAOpen2.body).chrome_load_token;
      assert.notStrictEqual(tabAToken2, tabAToken1, 'take-over mints a genuinely new token');

      // Tab A's new begin now succeeds -- supersession is bidirectional, never a dead end.
      const tabABegin2 = await postJson(port, `/api/${key}/artifact-loads/begin`, { chromeLoadToken: tabAToken2 });
      assert.strictEqual(tabABegin2.status, 200);

      // And tab B, now the superseded party, gets 409 in turn.
      const tabBBegin = await postJson(port, `/api/${key}/artifact-loads/begin`, { chromeLoadToken: tabBToken });
      assert.strictEqual(tabBBegin.status, 409);
    },
  );
});

test('CSP sandbox header is the exact token string, present on both the entry document and a sibling asset, and never contains allow-same-origin', async () => {
  await withServer(
    async (root) => {
      await writeFile(join(root, 'artifact.html'), '<html><body>hi</body></html>', 'utf8');
      await writeFile(join(root, 'style.css'), 'body {}', 'utf8');
    },
    async ({ port, root }) => {
      const { key, artifactLoadToken, artifactRevision } = await openAndBegin(port, join(root, 'artifact.html'));

      const entryRes = await rawRequest(port, {
        path: `/artifact/${key}/?artifact_load_token=${artifactLoadToken}&artifact_revision=${artifactRevision}`,
      });
      const entryCsp = entryRes.headers['content-security-policy'];
      assert.strictEqual(entryCsp, SANDBOX_CSP);
      assert.ok(typeof entryCsp === 'string' && !entryCsp.includes('allow-same-origin'));

      const siblingRes = await rawRequest(port, { path: `/artifact/${key}/style.css` });
      const siblingCsp = siblingRes.headers['content-security-policy'];
      assert.strictEqual(siblingCsp, SANDBOX_CSP);
      assert.ok(typeof siblingCsp === 'string' && !siblingCsp.includes('allow-same-origin'));
    },
  );
});

test('end-to-end containment: POST /api/sessions with a literal ../-shaped path escaping the fixture root returns 403', async () => {
  await withServer(
    async () => undefined,
    async ({ port, root }) => {
      const outsideDir = join(root, '..', 'outside-e2e-containment-secret');
      await mkdir(outsideDir, { recursive: true });
      await writeFile(join(outsideDir, 'secret.txt'), 'should never be reachable', 'utf8');
      try {
        // Literal '../../'-shaped path string, mirroring Plan 01-05's own
        // traversal probe style -- resolve() inside handleCreateSession
        // normalizes this lexically before resolveAssetPath's realpath
        // containment check ever runs.
        const res = await postJson(port, '/api/sessions', { file: `${root}/../outside-e2e-containment-secret/secret.txt` });
        assert.strictEqual(res.status, 403);
      } finally {
        await forceRemove(outsideDir);
      }
    },
  );
});
