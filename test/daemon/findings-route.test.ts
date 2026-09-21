import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { Server, IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LockRecord } from '../../src/daemon/lock.ts';
import { createDaemonServer } from '../../src/daemon/server.ts';
import { sessionStorePathFor } from '../../src/store/session-store.ts';
import { getRepoContext } from '../../src/router/pool-registry.ts';
import { createFixtureRepo } from '../fixtures/git-repo.ts';
import type { FixtureRepo } from '../fixtures/git-repo.ts';
import { FindingsStoreFile, recordDetection, findingFingerprint } from '../../src/store/findings-store.ts';
import type { FindingTarget } from '../../src/store/findings-store.ts';
import { ensureDaemonRunning } from '../../src/daemon/orchestrate.ts';
import { readLock, isPidAlive } from '../../src/daemon/lock.ts';
import { lockPathFor } from '../../src/daemon/state-dir.ts';
import { anchorHash } from '../../src/provenance/hash.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

/**
 * Plan 08-04's own live-wiring test suite for `GET /api/:key/findings`,
 * `POST /api/:key/findings/:fingerprint/dismiss`, and the dismiss route's own
 * structural non-import proof (STAL-05) -- everything in the first section
 * below drives the routes added in server.ts over REAL sockets against a REAL
 * running daemon (mirrors test/daemon/annotations-route.test.ts's own
 * established convention), never by calling a route handler directly. The
 * second section proves this plan's own env-var timing knobs
 * (`ILLUMINATE_FORCE_WATCHER_UNHEALTHY`/`ILLUMINATE_STALENESS_DEBOUNCE_MS`/
 * `ILLUMINATE_STALENESS_RECONCILE_MS`) against a REAL spawned daemon
 * subprocess, mirroring test/daemon/self-dispatch-disable-env.test.ts's own
 * `ensureDaemonRunning(dir, {env: {...}})` precedent.
 */

// ---------------------------------------------------------------------------
// Section 1: in-process route-level tests (createDaemonServer directly).
// ---------------------------------------------------------------------------

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

function extractSessionData(html: string): { chrome_load_token: string } {
  const match = html.match(/<script id="illuminate-session-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!match || match[1] === undefined) throw new Error('session-data script tag not found in chrome shell HTML');
  return JSON.parse(match[1]) as { chrome_load_token: string };
}

/** Full session-open -> begin handshake, mirroring test/daemon/artifact-routes.test.ts's
 * own `openAndBegin` helper -- this is the ONLY thing that starts a session's
 * staleness watcher (server.ts's handleBeginArtifactLoad), so any test that
 * needs `registry.isWatcherHealthy(key)` to reflect a real tracked watcher
 * must go through this, not just createSession. */
async function openAndBegin(port: number, file: string): Promise<string> {
  const key = await createSession(port, file);
  const opened = await rawRequest(port, { path: `/session/${key}` });
  const { chrome_load_token: chromeLoadToken } = extractSessionData(opened.body);
  const begun = await postJson(port, `/api/${key}/artifact-loads/begin`, { chromeLoadToken });
  assert.strictEqual(begun.status, 200, `begin failed: ${begun.body}`);
  return key;
}

interface FindingsBody {
  readonly protocol: string;
  readonly findings: ReadonlyArray<{ readonly fingerprint: string; readonly status: string }>;
  readonly meta: { readonly watcherHealthy: boolean };
}

async function getFindings(port: number, key: string): Promise<{ status: number; body: FindingsBody }> {
  const res = await rawRequest(port, { path: `/api/${key}/findings` });
  return { status: res.status, body: JSON.parse(res.body) as FindingsBody };
}

// ---------------------------------------------------------------------------
// GET /api/:key/findings -- basic shape, scoping, watcherHealthy reporting.
// ---------------------------------------------------------------------------

test('GET /api/:key/findings for an unknown key returns 404', async () => {
  await withServer(async ({ port }) => {
    const res = await rawRequest(port, { path: '/api/not-a-real-session-key/findings' });
    assert.strictEqual(res.status, 404);
  });
});

test('GET /api/:key/findings for a session with no findings yet returns an empty inbox, watcherHealthy true', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));
    const { status, body } = await getFindings(port, key);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.protocol, 'illuminate.findings/1');
    assert.deepStrictEqual(body.findings, []);
    assert.strictEqual(body.meta.watcherHealthy, true, 'no tracked watcher yet -- fail open');
  });
});

test('a successful begin handshake starts the session watcher -- watcherHealthy stays true for an ordinary, healthy session', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await openAndBegin(port, join(repo.root, 'artifact.html'));
    const { status, body } = await getFindings(port, key);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.meta.watcherHealthy, true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/:key/findings/:fingerprint/dismiss
// ---------------------------------------------------------------------------

test('dismissing a real, already-detected finding flips it to dismissed on the next GET', async () => {
  await withServer(async ({ port, repo }) => {
    const artifactPath = join(repo.root, 'artifact.html');
    const key = await createSession(port, artifactPath);

    const target: FindingTarget = { path: 'src/whatever.ts', startLine: null, endLine: null };
    const fingerprint = findingFingerprint('drift-touched', target);
    await new FindingsStoreFile(artifactPath).mutate((store) => ({
      next: recordDetection(store, { rule: 'drift-touched', target, revision: 'a'.repeat(40), at: new Date().toISOString() }),
      result: undefined,
    }));

    const before = await getFindings(port, key);
    assert.strictEqual(before.body.findings.length, 1);
    assert.strictEqual(before.body.findings[0]?.status, 'open');

    const dismissRes = await postJson(port, `/api/${key}/findings/${fingerprint}/dismiss`, {});
    assert.strictEqual(dismissRes.status, 200, `dismiss failed: ${dismissRes.body}`);

    const after = await getFindings(port, key);
    assert.strictEqual(after.body.findings.length, 1, 'dismissing must never remove the finding');
    assert.strictEqual(after.body.findings[0]?.fingerprint, fingerprint);
    assert.strictEqual(after.body.findings[0]?.status, 'dismissed');
  });
});

test('dismissing an unknown fingerprint against a real session is a documented no-op (200), never creates a phantom finding', async () => {
  await withServer(async ({ port, repo }) => {
    const key = await createSession(port, join(repo.root, 'artifact.html'));
    const unknownFingerprint = '0'.repeat(16);
    const res = await postJson(port, `/api/${key}/findings/${unknownFingerprint}/dismiss`, {});
    assert.strictEqual(res.status, 200);

    const { body } = await getFindings(port, key);
    assert.deepStrictEqual(body.findings, []);
  });
});

test('a malformed (non-16-hex) fingerprint segment never matches the dismiss route -- the handler is never reached, the seeded finding is left untouched', async () => {
  await withServer(async ({ port, repo }) => {
    const artifactPath = join(repo.root, 'artifact.html');
    const key = await createSession(port, artifactPath);

    const target: FindingTarget = { path: 'src/whatever2.ts', startLine: null, endLine: null };
    const fingerprint = findingFingerprint('drift-touched', target);
    await new FindingsStoreFile(artifactPath).mutate((store) => ({
      next: recordDetection(store, { rule: 'drift-touched', target, revision: 'a'.repeat(40), at: new Date().toISOString() }),
      result: undefined,
    }));

    // Too short, and contains an uppercase/non-hex character -- neither
    // shape satisfies the route's own [0-9a-f]{16} capture group.
    const tooShort = await postJson(port, `/api/${key}/findings/abc/dismiss`, {});
    assert.notStrictEqual(tooShort.status, 200);
    const wrongChars = await postJson(port, `/api/${key}/findings/ZZZZZZZZZZZZZZZZ/dismiss`, {});
    assert.notStrictEqual(wrongChars.status, 200);

    const { body } = await getFindings(port, key);
    assert.strictEqual(body.findings.length, 1);
    assert.strictEqual(body.findings[0]?.fingerprint, fingerprint);
    assert.strictEqual(body.findings[0]?.status, 'open', 'a malformed fingerprint must never reach dismissFinding');
  });
});

test('POST dismiss rejects a foreign Origin header, and allows one with no Origin at all', async () => {
  await withServer(async ({ port, repo }) => {
    const artifactPath = join(repo.root, 'artifact.html');
    const key = await createSession(port, artifactPath);
    const target: FindingTarget = { path: 'src/whatever3.ts', startLine: null, endLine: null };
    const fingerprint = findingFingerprint('drift-touched', target);
    await new FindingsStoreFile(artifactPath).mutate((store) => ({
      next: recordDetection(store, { rule: 'drift-touched', target, revision: 'a'.repeat(40), at: new Date().toISOString() }),
      result: undefined,
    }));

    const foreign = await postJson(port, `/api/${key}/findings/${fingerprint}/dismiss`, {}, { Origin: 'https://evil.example' });
    assert.strictEqual(foreign.status, 403);

    const trusted = await postJson(port, `/api/${key}/findings/${fingerprint}/dismiss`, {});
    assert.strictEqual(trusted.status, 200, `expected an absent Origin to be trusted: ${trusted.body}`);
  });
});

// ---------------------------------------------------------------------------
// STAL-05's structural non-import proof: the dismiss route handler's own
// marked region in server.ts must never reference this codebase's dispatch
// pipeline -- grep-verified against server.ts's own real source text, not
// just asserted in prose. Mirrors relocate.test.ts's own established
// "read the implementation file's own source at runtime" regression pattern.
// ---------------------------------------------------------------------------

test('regression: the dismiss route handler, between its own marked boundaries in server.ts, imports nothing from src/router/ and never references "router" at all', async () => {
  const serverPath = fileURLToPath(new URL('../../src/daemon/server.ts', import.meta.url));
  const source = await readFile(serverPath, 'utf8');

  const startMarker = '// illuminate:dismiss-route-boundary-start';
  const endMarker = '// illuminate:dismiss-route-boundary-end';
  const startIdx = source.indexOf(startMarker);
  const endIdx = source.indexOf(endMarker);
  assert.ok(startIdx !== -1, 'expected the dismiss-route-boundary-start marker to be present in server.ts');
  assert.ok(endIdx !== -1, 'expected the dismiss-route-boundary-end marker to be present in server.ts');
  assert.ok(endIdx > startIdx, 'the end marker must come after the start marker');

  const region = source.slice(startIdx, endIdx);
  assert.ok(!/from\s+['"]\.\.\/router/.test(region), 'the dismiss route handler must not import from ../router');
  assert.ok(!/from\s+['"]\.\.\/\.\.\/router/.test(region), 'the dismiss route handler must not import from ../../router');
  assert.ok(
    !/router/i.test(region),
    'the dismiss route handler must not reference "router" at all -- structural proof it cannot reach the dispatch pipeline',
  );
});

test('sanity: the whole server.ts file DOES import from src/router/ elsewhere (for other routes) -- proving the regression test above is a real, non-vacuous negative', async () => {
  const serverPath = fileURLToPath(new URL('../../src/daemon/server.ts', import.meta.url));
  const source = await readFile(serverPath, 'utf8');
  assert.ok(/from\s+['"]\.\.\/router/.test(source), 'sanity: server.ts as a whole is expected to import from ../router elsewhere');
});

// ---------------------------------------------------------------------------
// Section 2: env-var timing knobs against a REAL spawned daemon subprocess.
// Mirrors test/daemon/self-dispatch-disable-env.test.ts's own
// ensureDaemonRunning(dir, {env: {...}}) precedent exactly.
// ---------------------------------------------------------------------------

const HOST = '127.0.0.1';

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function pollUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(intervalMs);
  }
  return check();
}

/** Mirrors this suite's other integration files' shared cleanup helper. */
async function stopDaemon(artifactRoot: string): Promise<void> {
  const record = await readLock(lockPathFor(artifactRoot));
  if (!record) return;
  try {
    await fetch(`http://${HOST}:${record.port}/shutdown?token=${record.healthToken}`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // fall through to a direct signal below
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

async function createSessionViaFetch(port: number, file: string): Promise<string> {
  const res = await fetch(`http://${HOST}:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file }),
  });
  const text = await res.text();
  assert.strictEqual(res.status, 200, `session creation failed: ${text}`);
  const { key } = JSON.parse(text) as { key: string };
  return key;
}

async function openAndBeginViaFetch(port: number, file: string): Promise<string> {
  const key = await createSessionViaFetch(port, file);
  const opened = await fetch(`http://${HOST}:${port}/session/${key}`);
  const openedHtml = await opened.text();
  const { chrome_load_token: chromeLoadToken } = extractSessionData(openedHtml);
  const begun = await fetch(`http://${HOST}:${port}/api/${key}/artifact-loads/begin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chromeLoadToken }),
  });
  assert.strictEqual(begun.status, 200, `begin failed: ${await begun.text()}`);
  return key;
}

async function getFindingsViaFetch(port: number, key: string): Promise<FindingsBody> {
  const res = await fetch(`http://${HOST}:${port}/api/${key}/findings`);
  assert.strictEqual(res.status, 200);
  return (await res.json()) as FindingsBody;
}

test('ILLUMINATE_FORCE_WATCHER_UNHEALTHY=1 against a real spawned daemon subprocess makes GET /api/:key/findings report watcherHealthy:false immediately, with no real fs.watch ever needed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'illum-findings-forceunhealthy-'));
  try {
    const file = join(dir, 'artifact.html');
    await writeFile(file, '<!doctype html><html><body><p>hi</p></body></html>', 'utf8');
    const { port } = await ensureDaemonRunning(dir, { env: { ILLUMINATE_FORCE_WATCHER_UNHEALTHY: '1' } });
    const realFile = await realpath(file);
    const key = await openAndBeginViaFetch(port, realFile);

    const body = await getFindingsViaFetch(port, key);
    assert.strictEqual(body.meta.watcherHealthy, false);
  } finally {
    await stopDaemon(dir);
    await forceRemove(dir);
  }
});

test('an unset ILLUMINATE_FORCE_WATCHER_UNHEALTHY leaves a real spawned daemon subprocess watcher healthy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'illum-findings-healthy-control-'));
  try {
    const file = join(dir, 'artifact.html');
    await writeFile(file, '<!doctype html><html><body><p>hi</p></body></html>', 'utf8');
    const { port } = await ensureDaemonRunning(dir, { env: {} });
    const realFile = await realpath(file);
    const key = await openAndBeginViaFetch(port, realFile);

    const body = await getFindingsViaFetch(port, key);
    assert.strictEqual(body.meta.watcherHealthy, true);
  } finally {
    await stopDaemon(dir);
    await forceRemove(dir);
  }
});

test('ILLUMINATE_STALENESS_DEBOUNCE_MS/ILLUMINATE_STALENESS_RECONCILE_MS against a real spawned daemon subprocess produce a detectable finding within roughly that window after a real fixture-repo commit, without waiting out the real 30s production default', async (t) => {
  const repo = createFixtureRepo(false);
  t.after(async () => {
    await stopDaemon(repo.root);
    await forceRemove(repo.root);
  });

  const region = Array.from({ length: 20 }, (_, i) => `envtest line ${i + 1}`);
  const dataRev = repo.commitFile('src/envtest.ts', block(['ctx 0', ...region, 'tail 0']), 'add envtest.ts');
  const artifactPath = join(repo.root, 'report.html');
  await writeFile(
    artifactPath,
    `<!doctype html><html><body><div data-src="src/envtest.ts#L2-L21" data-rev="${dataRev}" data-anchor-hash="${anchorHash(region.join('\n'))}">rendered</div></body></html>`,
    'utf8',
  );

  const { port } = await ensureDaemonRunning(repo.root, {
    env: { ILLUMINATE_STALENESS_DEBOUNCE_MS: '50', ILLUMINATE_STALENESS_RECONCILE_MS: '300' },
  });
  const key = await openAndBeginViaFetch(port, artifactPath);

  // Nothing has drifted yet -- the initial rescan (fired immediately by
  // startForSession, ahead of any debounce/reconcile timer) must show zero
  // findings before the edit below.
  const before = await getFindingsViaFetch(port, key);
  assert.deepStrictEqual(before.findings, []);

  const editedRegion = [...region];
  editedRegion[9] = 'envtest line 10 EDITED';
  repo.commitFile('src/envtest.ts', block(['ctx 0', ...editedRegion, 'tail 0']), 'edit in place');

  const found = await pollUntil(async () => {
    const body = await getFindingsViaFetch(port, key);
    return body.findings.length === 1;
  }, 5000);
  assert.ok(found, 'expected a finding to be detected within the configured debounce/reconcile window');

  const after = await getFindingsViaFetch(port, key);
  assert.strictEqual(after.findings.length, 1);
  assert.strictEqual(after.findings[0]?.status, 'open');
});
