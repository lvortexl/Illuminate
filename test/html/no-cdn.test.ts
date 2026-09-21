// Phase-wide backstop for SERVE-10's "no CDN asset is ever injected" claim
// (T-03-10). Two parts spawn/read the BUILT cli + daemon
// (dist/cli.mjs, dist/daemon-entry.mjs, dist/sdk.js), so `npm run build`
// must run first -- same ordering requirement as smoke.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { mkdtemp, readFile, copyFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLock, isPidAlive } from '../../src/daemon/lock.ts';
import { lockPathFor } from '../../src/daemon/state-dir.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(HERE, '..', '..');
const SRC_DIR = join(ROOT_DIR, 'src');
const FIXTURE_PATH = join(ROOT_DIR, 'test', 'fixtures', 'artifacts', 'quirky-mutations.html');

/**
 * Known CDN hostnames -- exported so this list can grow later without
 * touching the walk/grep logic below (Task 2's own action note). This is
 * the reference implementation's actual Tailwind-CDN mistake, named
 * explicitly in PROJECT.md's Out of Scope and ARCHITECTURE.md's
 * anti-patterns -- these specific strings must never reappear in src/.
 */
export const CDN_HOSTNAMES = [
  'tailwindcss.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'jsdelivr.net',
] as const;

/** Backstop for CDN hosts not on the explicit list above: any `cdn.<label>.<tld>`-shaped substring. */
export const GENERIC_CDN_PATTERN = /\bcdn\.[a-z0-9-]+\.[a-z]{2,}\b/i;

export interface CdnHit {
  line: number;
  match: string;
}

/** Exported so 09-04's own real-exported-bytes backstop
 * (test/export/no-remote-refs.test.ts) reuses this exact scan rather than
 * redefining a second, competing copy of the same CDN-detection logic. */
export function findCdnMatches(text: string): CdnHit[] {
  const hits: CdnHit[] = [];
  const lines = text.split('\n');
  lines.forEach((lineText, idx) => {
    for (const hostname of CDN_HOSTNAMES) {
      if (lineText.includes(hostname)) hits.push({ line: idx + 1, match: hostname });
    }
    const generic = lineText.match(GENERIC_CDN_PATTERN);
    if (generic) hits.push({ line: idx + 1, match: generic[0] });
  });
  return hits;
}

function listTsFiles(rootDir: string): string[] {
  const entries = readdirSync(rootDir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(join(entry.parentPath, entry.name));
    }
  }
  return files;
}

function assertNoCdnStrings(files: { path: string; label: string }[]): void {
  const offenders: string[] = [];
  for (const { path, label } of files) {
    const text = readFileSync(path, 'utf8');
    for (const hit of findCdnMatches(text)) {
      offenders.push(`${label}:${hit.line} -- ${JSON.stringify(hit.match)}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `CDN-shaped string(s) found:\n${offenders.join('\n')}`);
}

test('no CDN-shaped string exists anywhere in src/**/*.ts (SERVE-10 structural backstop)', () => {
  const files = listTsFiles(SRC_DIR);
  assert.ok(files.length > 20, `expected to find many .ts files under src/, found ${files.length}`);
  assertNoCdnStrings(files.map((path) => ({ path, label: relative(SRC_DIR, path) })));
});

test('no CDN-shaped string exists anywhere in the BUILT output (dist/cli.mjs, dist/daemon-entry.mjs, dist/sdk.js)', () => {
  const relPaths = ['dist/cli.mjs', 'dist/daemon-entry.mjs', 'dist/sdk.js'];
  const files = relPaths.map((relPath) => {
    const path = join(ROOT_DIR, relPath);
    if (!existsSync(path)) throw new Error(`${relPath} does not exist -- run npm run build before node --test`);
    return { path, label: relPath };
  });
  assertNoCdnStrings(files);
});

// ---------------------------------------------------------------------------
// Real, built, end-to-end proofs (not just source-text regression): the
// fully-qualified script-URL contract, and the disk-never-mutated guarantee,
// both re-proven through the actual CLI -> daemon -> server path.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-no-cdn-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

/**
 * Starts the BUILT daemon directly (dist/daemon-entry.mjs), parented by
 * THIS long-lived test process rather than a short-lived spawned CLI --
 * sidesteps the same host-specific parent-exit-kills-child policy
 * documented in test/daemon/spawn.test.ts / test/cli-open.test.ts (this
 * dev host terminates every detached child the instant its immediate
 * parent exits, regardless of spawn flags). This pre-warmed daemon carries
 * the same real __ILLUMINATE_VERSION__ as the built CLI (both bundles are
 * `define`d from the same package.json read in the same `npm run build`
 * invocation), so when the built CLI is spawned against the same
 * artifactRoot below it ATTACHES to this daemon rather than restarting it
 * -- a real, legitimate code path (the common case once a human's first
 * `illuminate <file>` invocation is already serving their browser), not a
 * weakened test.
 */
async function startBuiltDaemon(artifactRoot: string): Promise<{ port: number }> {
  spawn(process.execPath, [join(ROOT_DIR, 'dist', 'daemon-entry.mjs'), artifactRoot], {
    stdio: 'ignore',
    windowsHide: true,
  }).unref();

  const lockPath = lockPathFor(artifactRoot);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const record = await readLock(lockPath).catch(() => null);
    if (record) {
      try {
        const res = await fetch(`http://127.0.0.1:${record.port}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return { port: record.port };
      } catch {
        // not listening yet -- keep polling within the same deadline
      }
    }
    await sleep(50);
  }
  throw new Error(`built daemon failed to start for artifact directory: ${artifactRoot}`);
}

async function stopDaemon(artifactRoot: string): Promise<void> {
  const record = await readLock(lockPathFor(artifactRoot));
  if (!record) return;
  try {
    await fetch(`http://127.0.0.1:${record.port}/shutdown?token=${record.healthToken}`, {
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

/** Runs the real, built CLI against a fixture -- the actual command a human types. */
function openViaBuiltCli(file: string): string {
  const result = spawnSync(process.execPath, [join(ROOT_DIR, 'dist', 'cli.mjs'), file, '--no-open'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`illuminate ${file} --no-open failed (status ${String(result.status)}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

function extractChromeLoadToken(html: string): string {
  const match = html.match(/<script id="illuminate-session-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!match || match[1] === undefined) throw new Error('session-data script tag not found in chrome shell HTML');
  return (JSON.parse(match[1]) as { chrome_load_token: string }).chrome_load_token;
}

/** Drives the real session -> artifact-load-begin -> artifact-entry handshake (Plan 03-03) over real HTTP. */
async function fetchArtifactEntryHtml(port: number, key: string): Promise<string> {
  const sessionRes = await fetch(`http://127.0.0.1:${port}/session/${key}`);
  const chromeLoadToken = extractChromeLoadToken(await sessionRes.text());

  const beginRes = await fetch(`http://127.0.0.1:${port}/api/${key}/artifact-loads/begin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chromeLoadToken }),
  });
  const begin = (await beginRes.json()) as { artifact_load_token: string; artifact_revision: number };

  const entryRes = await fetch(
    `http://127.0.0.1:${port}/artifact/${key}/?artifact_load_token=${begin.artifact_load_token}&artifact_revision=${String(begin.artifact_revision)}`,
  );
  return entryRes.text();
}

test('the injected script tag src is a fully-qualified, absolute, loopback-only URL -- proven through the real built CLI end-to-end path', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'quirky-mutations.html');
    await copyFile(FIXTURE_PATH, file);
    const { port } = await startBuiltDaemon(dir);
    try {
      const url = openViaBuiltCli(file);
      const key = url.split('/').pop();
      assert.ok(key, `could not extract a session key from CLI output: ${url}`);

      const entryHtml = await fetchArtifactEntryHtml(port, key);
      const scriptMatch = entryHtml.match(/<script src="([^"]+)"><\/script>/);
      assert.ok(scriptMatch?.[1], `expected an injected <script src="..."></script> tag in: ${entryHtml}`);
      assert.match(scriptMatch[1], /^http:\/\/127\.0\.0\.1:\d+\/sdk\.js/);
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('opening a fixture through the full built CLI path never mutates it on disk (re-proving 03-01\'s guarantee end-to-end)', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'quirky-mutations.html');
    await copyFile(FIXTURE_PATH, file);
    const before = await readFile(file);

    const { port } = await startBuiltDaemon(dir);
    try {
      const url = openViaBuiltCli(file);
      const key = url.split('/').pop();
      assert.ok(key, `could not extract a session key from CLI output: ${url}`);

      // "poll the URL once" -- one real GET of the artifact entry document,
      // which is exactly where readArtifactWithFreshnessGuard reads the
      // file's bytes off disk.
      await fetchArtifactEntryHtml(port, key);

      const after = await readFile(file);
      assert.ok(before.equals(after), 'fixture bytes changed on disk after being served through the real CLI/daemon path');
    } finally {
      await stopDaemon(dir);
    }
  });
});
