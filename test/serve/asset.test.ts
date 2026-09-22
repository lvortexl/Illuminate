import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server, IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAssetPath, isAllowedHost } from '../../src/serve/containment.ts';
import { serveAsset } from '../../src/serve/asset.ts';
import { mimeFor } from '../../src/serve/mime.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

// Deviation from the plan's literal "drive it with fetch" wording, made
// deliberately: `fetch`'s WHATWG URL parser collapses `../` dot-segments
// before the request line is even constructed (verified empirically —
// `new URL('http://x/../../../etc/passwd').pathname` normalizes to
// '/etc/passwd', so the raw traversal-shaped payload never reaches the
// wire), and Node's `fetch` (undici) silently overrides any `Host` header
// override with the real connection host. Both behaviors make 2 of the 13
// required §6.7 probes (row 10's literal dot-segment path, row 12's Host
// override) inexpressible via `fetch`. `node:http`'s client sends the raw,
// unnormalized `path` string and an overridden `Host` header exactly as
// given — still a real HTTP request over a real socket against a real
// server, matching "don't mock the transport," just via a lower-level API.
function rawRequest(
  port: number,
  options: { path: string; headers?: Record<string, string> },
): Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: options.path,
        method: 'GET',
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('error', rejectPromise);
    req.end();
  });
}

// One file per src/serve/mime.ts extension entry, mirrored here so the
// fixture set matches RESEARCH.md §6.1's table exactly.
const MIME_EXTENSIONS = [
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.map', '.svg', '.png',
  '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif', '.woff', '.woff2',
  '.ttf', '.otf', '.txt', '.pdf', '.mp4', '.webm', '.wasm',
];

// 100 bytes of known, positionally-unique content (byte value === index) so
// every Range sub-case (full/partial/suffix/unsatisfiable) has an
// unambiguous expected slice, not just "10 bytes that happen to match."
const RANGE_FIXTURE_BYTES = Buffer.from(Array.from({ length: 100 }, (_, i) => i));

let tempDir: string;
let root: string;
let outsideSecretPath: string;
let server: Server;
let port: number;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'illuminate-asset-'));
  root = join(tempDir, 'root');
  await mkdir(root, { recursive: true });

  // MIME fixture files — one per extension, content includes the extension
  // so any mismatch is legible in a failure message.
  for (const ext of MIME_EXTENSIONS) {
    await writeFile(join(root, `asset${ext}`), `content for ${ext} fixture`, 'utf8');
  }

  // Dotfile inside root — denied unconditionally regardless of containment.
  await writeFile(join(root, '.env'), 'SECRET=should-never-be-served', 'utf8');

  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf8');
  await mkdir(join(root, '.hidden', 'sub'), { recursive: true });
  await writeFile(join(root, '.hidden', 'sub', 'file.txt'), 'hidden\n', 'utf8');
  await mkdir(join(root, 'v1.2'), { recursive: true });
  await writeFile(join(root, 'v1.2', 'file.txt'), 'dotted dir name\n', 'utf8');

  // 100-byte fixture for the Range test rows.
  await writeFile(join(root, 'range-fixture.bin'), RANGE_FIXTURE_BYTES);

  // A subdirectory OUTSIDE root, with a file genuinely existing inside it —
  // the traversal-escape target. Containment must refuse this even though
  // the file is real (T-01-12: tested against a real filesystem, not
  // string-pattern matching alone).
  const outsideDir = join(tempDir, 'outside');
  await mkdir(outsideDir, { recursive: true });
  outsideSecretPath = join(outsideDir, 'secret.txt');
  await writeFile(outsideSecretPath, 'should never be reachable from root', 'utf8');

  server = createServer((req, res) => {
    void (async () => {
      if (!isAllowedHost(req)) {
        res.statusCode = 403;
        res.end();
        return;
      }
      const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
      let requestPath: string;
      try {
        requestPath = decodeURIComponent(rawPath);
      } catch {
        // Malformed percent-encoding — pass through undecoded; containment
        // will resolve it to a nonexistent/forbidden path either way.
        requestPath = rawPath;
      }
      const result = await resolveAssetPath(root, requestPath);
      if (result.kind === 'not-found') {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (result.kind === 'forbidden') {
        res.statusCode = 403;
        res.end();
        return;
      }
      await serveAsset(req, res, result.path);
    })();
  });

  await new Promise<void>((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to bind an AddressInfo, not a pipe/string');
  }
  port = address.port;
});

after(async () => {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((err) => (err ? rejectPromise(err) : resolvePromise()));
  });
  await forceRemove(tempDir);
});

// ---------------------------------------------------------------------------
// Task 1 behavior: direct unit coverage of resolveAssetPath / isAllowedHost,
// folded into this file per the plan's verification note.
// ---------------------------------------------------------------------------

test('resolveAssetPath: an existing file inside root resolves to { kind: "ok" }', async () => {
  const result = await resolveAssetPath(root, '/asset.txt');
  assert.strictEqual(result.kind, 'ok');
});

test('resolveAssetPath: a missing file resolves to { kind: "not-found" } (maps to 404)', async () => {
  const result = await resolveAssetPath(root, '/does-not-exist.txt');
  assert.deepStrictEqual(result, { kind: 'not-found' });
});

test('resolveAssetPath: a path escaping root via ../ resolves to { kind: "forbidden" } (maps to 403), even though the target file genuinely exists', async () => {
  const result = await resolveAssetPath(root, '/../outside/secret.txt');
  assert.deepStrictEqual(result, { kind: 'forbidden' });
});

test('resolveAssetPath: a dotfile directly inside root is forbidden regardless of containment', async () => {
  const result = await resolveAssetPath(root, '/.env');
  assert.deepStrictEqual(result, { kind: 'forbidden' });
});

test('resolveAssetPath: a file nested inside a dot-directory (.git/config) is forbidden, not served', async () => {
  const result = await resolveAssetPath(root, '/.git/config');
  assert.deepStrictEqual(result, { kind: 'forbidden' });
});

test('resolveAssetPath: a file two levels under a dot-directory is forbidden', async () => {
  const result = await resolveAssetPath(root, '/.hidden/sub/file.txt');
  assert.deepStrictEqual(result, { kind: 'forbidden' });
});

test('resolveAssetPath: a directory whose name merely contains a dot (v1.2/file.txt) is still served', async () => {
  const result = await resolveAssetPath(root, '/v1.2/file.txt');
  assert.strictEqual(result.kind, 'ok');
});

test('resolveAssetPath: a symlink inside root pointing outside it is forbidden', async (t) => {
  const linkPath = join(root, 'escape-link.txt');
  try {
    await symlink(outsideSecretPath, linkPath, 'file');
  } catch (err) {
    t.skip(
      `could not create a symlink in this environment (Windows requires elevated privileges or Developer Mode): ${(err as Error).message}`,
    );
    return;
  }
  try {
    const result = await resolveAssetPath(root, '/escape-link.txt');
    assert.deepStrictEqual(result, { kind: 'forbidden' });
  } finally {
    await rm(linkPath, { force: true });
  }
});

test('isAllowedHost: localhost, 127.0.0.1, 127.0.0.1:4319, [::1], ::1 are allowed', () => {
  for (const host of ['localhost', '127.0.0.1', '127.0.0.1:4319', '[::1]', '::1']) {
    const req = { headers: { host } } as IncomingMessage;
    assert.strictEqual(isAllowedHost(req), true, `expected ${host} to be allowed`);
  }
});

test('isAllowedHost: evil.com and a missing Host header are rejected', () => {
  const evil = { headers: { host: 'evil.com' } } as IncomingMessage;
  assert.strictEqual(isAllowedHost(evil), false);
  const missing = { headers: {} } as IncomingMessage;
  assert.strictEqual(isAllowedHost(missing), false);
});

// ---------------------------------------------------------------------------
// Task 2: the 13-row RESEARCH.md §6.7 spike exit-criteria matrix, driven
// against a real node:http server over real sockets. Row 13 ("Effort") is
// not machine-testable and is recorded directly in SPIKE-VERDICT.md instead.
// ---------------------------------------------------------------------------

test('1. MIME — every fixture extension returns its exact Content-Type', async () => {
  for (const ext of MIME_EXTENSIONS) {
    const res = await rawRequest(port, { path: `/asset${ext}` });
    assert.strictEqual(res.status, 200, `expected 200 for asset${ext}`);
    assert.strictEqual(
      res.headers['content-type'],
      mimeFor(`asset${ext}`),
      `wrong Content-Type for ${ext}`,
    );
  }
});

test('2. ETag / 304 — a second request with matching If-None-Match returns 304, no body, no Content-Length', async () => {
  const first = await rawRequest(port, { path: '/asset.txt' });
  assert.strictEqual(first.status, 200);
  const etag = first.headers.etag;
  assert.ok(typeof etag === 'string' && etag.length > 0);

  const second = await rawRequest(port, {
    path: '/asset.txt',
    headers: { 'If-None-Match': etag },
  });
  assert.strictEqual(second.status, 304);
  assert.strictEqual(second.body.length, 0);
  assert.strictEqual(second.headers['content-length'], undefined);
});

test('3. ETag validity for Range — the ETag never carries a W/ prefix', async () => {
  const res = await rawRequest(port, { path: '/asset.txt' });
  const etag = res.headers.etag;
  assert.ok(typeof etag === 'string');
  assert.ok(!etag.startsWith('W/'), `expected a strong ETag, got ${etag}`);
});

test('4. Range: full-file — bytes=0- returns 206, correct Content-Range, and the full byte stream', async () => {
  const res = await rawRequest(port, {
    path: '/range-fixture.bin',
    headers: { Range: 'bytes=0-' },
  });
  assert.strictEqual(res.status, 206);
  assert.strictEqual(res.headers['content-range'], 'bytes 0-99/100');
  assert.ok(res.body.equals(RANGE_FIXTURE_BYTES));
});

test('5. Range: partial — bytes=10-19 returns exactly 10 bytes, Content-Range: bytes 10-19/100', async () => {
  const res = await rawRequest(port, {
    path: '/range-fixture.bin',
    headers: { Range: 'bytes=10-19' },
  });
  assert.strictEqual(res.status, 206);
  assert.strictEqual(res.headers['content-range'], 'bytes 10-19/100');
  assert.strictEqual(res.body.length, 10);
  assert.ok(res.body.equals(RANGE_FIXTURE_BYTES.subarray(10, 20)));
});

test('6. Range: suffix — bytes=-10 returns the last 10 bytes', async () => {
  const res = await rawRequest(port, {
    path: '/range-fixture.bin',
    headers: { Range: 'bytes=-10' },
  });
  assert.strictEqual(res.status, 206);
  assert.strictEqual(res.headers['content-range'], 'bytes 90-99/100');
  assert.ok(res.body.equals(RANGE_FIXTURE_BYTES.subarray(90, 100)));
});

test('7. Range: unsatisfiable — bytes=999999- on the 100-byte fixture returns 416, Content-Range: bytes */100, empty body', async () => {
  const res = await rawRequest(port, {
    path: '/range-fixture.bin',
    headers: { Range: 'bytes=999999-' },
  });
  assert.strictEqual(res.status, 416);
  assert.strictEqual(res.headers['content-range'], 'bytes */100');
  assert.strictEqual(res.body.length, 0);
});

test('8. Range: malformed — Range: not-a-range returns 200 with the full body, not an error', async () => {
  const res = await rawRequest(port, {
    path: '/range-fixture.bin',
    headers: { Range: 'not-a-range' },
  });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.equals(RANGE_FIXTURE_BYTES));
});

test('9. If-Range: stale — a stale If-Range plus a Range header returns 200 full body, not 206', async () => {
  const res = await rawRequest(port, {
    path: '/range-fixture.bin',
    headers: { Range: 'bytes=10-19', 'If-Range': '"stale-etag-does-not-match"' },
  });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.equals(RANGE_FIXTURE_BYTES));
});

test('10. Traversal — dot-segment and URL-encoded traversal never resolve to 200', async () => {
  // Literal, unnormalized dot-segment path shaped exactly as RESEARCH.md
  // §6.7 names it. Most likely resolves to a genuinely nonexistent target
  // on the test machine (404); either 403 or 404 satisfies the row.
  const literal = await rawRequest(port, { path: '/../../../etc/passwd' });
  assert.ok(
    literal.status === 403 || literal.status === 404,
    `expected 403 or 404, got ${literal.status}`,
  );

  // URL-encoded variant (%2f decodes to a literal slash server-side).
  const encoded = await rawRequest(port, { path: '/..%2f..%2fsecrets' });
  assert.ok(
    encoded.status === 403 || encoded.status === 404,
    `expected 403 or 404, got ${encoded.status}`,
  );

  // Stronger check against a genuinely existing target outside root — the
  // fixture's real escape-target file. Must be forbidden even though the
  // destination exists on disk (T-01-12: real-filesystem containment, not
  // string-pattern matching).
  const realTarget = await rawRequest(port, { path: '/../outside/secret.txt' });
  assert.strictEqual(realTarget.status, 403);
});

test('11. Dotfile — GET /.env returns 403', async () => {
  const res = await rawRequest(port, { path: '/.env' });
  assert.strictEqual(res.status, 403);
});

test('12. Host header — a request with Host: evil.com returns 403', async () => {
  const res = await rawRequest(port, {
    path: '/asset.txt',
    headers: { Host: 'evil.com' },
  });
  assert.strictEqual(res.status, 403);
});
