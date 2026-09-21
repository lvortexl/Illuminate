// Phase-wide backstop for the portability half of EXP-01: a real,
// exported file, produced by the real BUILT CLI, must never carry an
// un-warned CDN-hostname-shaped or live remote reference. Directly mirrors
// test/html/no-cdn.test.ts's own two-part structure (source-text regression
// + real, built, end-to-end proof) applied to EXPORTED BYTES instead of
// src/**/*.ts: SERVE-10 guarantees the SERVED artifact makes no outbound
// request; 09-03's remote-reference warning flags what it can see; this
// file is what keeps the exported-file half of that promise true as the
// code changes. Two parts spawn the BUILT cli (dist/cli.mjs), so
// `npm run build` must run first -- same ordering requirement as
// no-cdn.test.ts/smoke.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Reuses no-cdn.test.ts's own CDN detector directly -- findCdnMatches
// wraps CDN_HOSTNAMES/GENERIC_CDN_PATTERN internally, so importing it alone
// is sufficient; no second, competing copy of the hostname list or the
// generic pattern is defined here.
import { findCdnMatches } from '../html/no-cdn.test.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(HERE, '..', '..');
const CLI_PATH = join(ROOT_DIR, 'dist', 'cli.mjs');
const ARTIFACTS_FIXTURES_DIR = join(ROOT_DIR, 'test', 'fixtures', 'artifacts');
const EXPORT_FIXTURES_DIR = join(ROOT_DIR, 'test', 'fixtures', 'export');

function requireBuiltCli(): void {
  if (!existsSync(CLI_PATH)) {
    throw new Error('dist/cli.mjs does not exist -- run npm run build before node --test');
  }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-no-remote-refs-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

/** Runs the real, built CLI's `export` subcommand against `file` -- the
 * actual command a human types -- adapting no-cdn.test.ts's own
 * `openViaBuiltCli` pattern to export's own arg shape (`export <file>`,
 * not `<file> --no-open`). Returns the command's own stdout (carrying the
 * printed warning-count summary) and the resulting `<stem>.export.html`
 * path, per exportCommand's own sibling-file naming convention. */
function exportViaBuiltCli(file: string): { stdout: string; exportedPath: string } {
  const result = spawnSync(process.execPath, [CLI_PATH, 'export', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`illuminate export ${file} failed (status ${String(result.status)}): ${result.stderr}`);
  }
  return { stdout: result.stdout, exportedPath: file.replace(/\.html?$/i, '.export.html') };
}

function listHtmlFixtures(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.html'));
}

// ---------------------------------------------------------------------------
// Part 1 (structural): the fixture's one known live reference survives the
// export transform (illuminate never silently deletes author content) AND
// is explicitly named under a `remote-reference` warning count in the
// command's own printed output -- present AND flagged, never present and
// silent.
// ---------------------------------------------------------------------------

test('export: a surviving remote reference is left as a working link AND flagged under remote-reference in the command\'s own printed output', async () => {
  requireBuiltCli();
  await withTempDir(async (dir) => {
    await cp(EXPORT_FIXTURES_DIR, dir, { recursive: true });
    const file = join(dir, 'remote-reference.html');

    const { stdout, exportedPath } = exportViaBuiltCli(file);
    const exported = await readFile(exportedPath, 'utf8');

    assert.ok(
      exported.includes('https://cdn.example.com/lib.js'),
      `expected the fixture's own remote reference to survive, not be silently deleted: ${exported}`,
    );
    assert.match(
      stdout,
      /remote-reference: \d+/,
      `expected the command's own printed output to explicitly flag it under a remote-reference warning count: ${stdout}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Part 2 (regression backstop, the actual point of this file): every real
// fixture, exported through the real built CLI, either carries no
// CDN-hostname-shaped string at all, or -- for the two fixtures that
// deliberately DO (remote-reference.html's live script src,
// base-href.html's own `<base href>`, per 03-html-injection-pipeline's
// own existing fixture -- illuminate's `detectBaseHref` only detects
// PRESENCE, never classifies or strips the URL inside it, a deliberate
// 09-03 design decision, not an oversight) -- that surviving string is
// explicitly flagged in the command's own printed output. No fixture is
// ever exported with a CDN-shaped string present and silent.
// ---------------------------------------------------------------------------

/** Fixture name -> the pattern that MUST appear in the export command's own
 * stdout if that fixture's exported bytes carry a CDN-shaped hit. Every
 * fixture NOT in this map is expected to produce ZERO CDN-shaped hits. */
const EXPECTED_CDN_FLAG: Readonly<Record<string, RegExp>> = {
  'remote-reference.html': /remote-reference: \d+/,
  'base-href.html': /notice: base-href present/,
};

test('export: no fixture in test/fixtures/artifacts or test/fixtures/export ever produces an un-warned CDN-shaped string when exported through the real built CLI', async () => {
  requireBuiltCli();
  const offenders: string[] = [];

  for (const fixtureDir of [ARTIFACTS_FIXTURES_DIR, EXPORT_FIXTURES_DIR]) {
    await withTempDir(async (dir) => {
      // Copy the WHOLE fixture directory (not just one file) so a fixture
      // like local-asset.html travels with its real sibling .css/.png
      // assets -- exportArtifact resolves those relative to the file's
      // own directory, exactly like the real CLI does.
      await cp(fixtureDir, dir, { recursive: true });

      for (const name of listHtmlFixtures(dir)) {
        const file = join(dir, name);
        const { stdout, exportedPath } = exportViaBuiltCli(file);
        const exported = await readFile(exportedPath, 'utf8');
        const hits = findCdnMatches(exported);
        if (hits.length === 0) continue;

        const expectedFlag = EXPECTED_CDN_FLAG[name];
        if (expectedFlag === undefined) {
          for (const hit of hits) {
            offenders.push(`${name}:${hit.line} -- ${JSON.stringify(hit.match)} (no CDN hit expected for this fixture at all)`);
          }
          continue;
        }
        if (!expectedFlag.test(stdout)) {
          offenders.push(
            `${name}: CDN-shaped hit(s) ${JSON.stringify(hits)} present in exported output but NOT flagged by the command's own stdout (expected to match ${String(expectedFlag)}): ${stdout}`,
          );
        }
      }
    });
  }

  assert.deepStrictEqual(offenders, [], `un-warned CDN-shaped string(s) found in exported fixtures:\n${offenders.join('\n')}`);
});
