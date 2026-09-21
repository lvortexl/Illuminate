// NOTE: this test spawns the BUILT cli (`dist/cli.mjs`), so `npm run build`
// must run before `npm test` -- same ordering requirement as smoke.test.ts.
//
// `illuminate export <file.html> [--out <path>]` (09-04) is the one CLI
// command that needs neither a real spawned daemon nor
// ILLUMINATE_DISABLE_SELF_DISPATCH -- it never reaches the router at all,
// since it is a pure filesystem transform. Real, simpler, faster than most
// of this codebase's other CLI tests, matching Task 1's own behavior list
// one-for-one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLock } from '../src/daemon/lock.ts';
import { lockPathFor } from '../src/daemon/state-dir.ts';
import { forceRemove } from './fixtures/cleanup.ts';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-cli-export-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

function runExport(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['dist/cli.mjs', 'export', ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const ARTIFACT_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Export Fixture</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Hello, export</h1>
  <img src="pixel.png" alt="a tiny local image">
</body>
</html>
`;

const STYLE_CSS = 'body { font-family: cli-export-fixture-font, sans-serif; }\n';

// A minimal, valid 1x1 transparent PNG -- real bytes, not a placeholder.
const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function writeArtifactFixture(dir: string): Promise<string> {
  const file = join(dir, 'artifact.html');
  await writeFile(file, ARTIFACT_HTML, 'utf8');
  await writeFile(join(dir, 'style.css'), STYLE_CSS, 'utf8');
  await writeFile(join(dir, 'pixel.png'), Buffer.from(PIXEL_PNG_BASE64, 'base64'));
  return file;
}

/** A real, hand-written `.illum.json` sidecar matching `AnnotationStore`'s
 * actual shape (src/store/annotation-store.ts) -- a single card, single
 * thread entry, adapted from test/store/annotation-store.test.ts's own
 * realistic literals. */
function sidecarFixture(markdown: string): string {
  return JSON.stringify(
    {
      protocol: 'illuminate.annotations/1',
      cards: [
        {
          cardId: 'card-1',
          snapshot: {
            elementUid: null,
            anchor: { path: 'src/a.ts', startLine: 1, endLine: 5 },
            textContent: 'Hello, export',
            prefixContext: null,
            suffixContext: null,
            structuralPath: 'body>h1:nth-child(1)',
          },
          thread: [
            {
              dispatchId: 'd1',
              intent: 'explain',
              depth: 1,
              parentDispatchId: null,
              learnerNote: null,
              note: null,
              markdown,
              verdict: null,
              decidingLines: null,
              model: 'claude-haiku',
              tier: 'haiku',
              source: null,
              answeredAt: '2020-01-01T00:00:00.000Z',
            },
          ],
          orphan: null,
        },
      ],
    },
    null,
    2,
  );
}

test('illuminate export <file.html>: writes a sibling <stem>.export.html, exits 0, prints a compact summary', async () => {
  await withTempDir(async (dir) => {
    const file = await writeArtifactFixture(dir);
    const result = runExport([file]);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.strictEqual(result.stderr, '');
    assert.match(result.stdout, /^exported \d+ bytes -> .*artifact\.export\.html\n/);
    assert.match(result.stdout, /warnings: none/);

    const exported = await readFile(join(dir, 'artifact.export.html'), 'utf8');
    assert.ok(exported.includes('Hello, export'), 'expected the artifact\'s own content in the exported file');
  });
});

test('illuminate export: local assets (stylesheet, image) are actually inlined into the written file, no remaining sibling-filename reference', async () => {
  await withTempDir(async (dir) => {
    const file = await writeArtifactFixture(dir);
    const result = runExport([file]);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const exported = await readFile(join(dir, 'artifact.export.html'), 'utf8');
    assert.ok(exported.includes('cli-export-fixture-font'), 'expected the stylesheet rule text inlined');
    assert.ok(exported.includes('data:image/png;base64,'), 'expected the image inlined as a data: URI');
    assert.ok(!exported.includes('style.css'), 'expected no remaining "style.css" reference');
    assert.ok(!exported.includes('pixel.png'), 'expected no remaining "pixel.png" reference');
  });
});

test('illuminate export <file.html> --out <path>: writes to the given path instead of the sibling-file convention', async () => {
  await withTempDir(async (dir) => {
    const file = await writeArtifactFixture(dir);
    const outPath = join(dir, 'nested', 'custom-name.html');
    const result = runExport([file, '--out', outPath]);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`-> .*custom-name\\.html`));

    const exported = await readFile(outPath, 'utf8');
    assert.ok(exported.includes('Hello, export'));

    // The sibling-convention file must NOT have been written when --out is given.
    await assert.rejects(readFile(join(dir, 'artifact.export.html'), 'utf8'));
  });
});

test('illuminate export missing.html: fails with a clear stderr message and exit 1, before any read past the existence check', async () => {
  await withTempDir(async (dir) => {
    const missing = join(dir, 'does-not-exist.html');
    const result = runExport([missing]);
    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout, '');
    assert.match(result.stderr, /illuminate export:/);
    assert.match(result.stderr, /does not exist/);
  });
});

test('illuminate export not-html.txt: fails with a clear stderr message and exit 1', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'note.txt');
    await writeFile(file, 'not an html file', 'utf8');
    const result = runExport([file]);
    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout, '');
    assert.match(result.stderr, /illuminate export:/);
    assert.match(result.stderr, /is not an \.html file/);
  });
});

test('illuminate export: missing <file.html> argument prints a usage-style message and exits 1', () => {
  const result = runExport([]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /illuminate export: missing <file\.html> argument/);
});

test('illuminate export: the original input file\'s bytes are unchanged on disk after the command runs', async () => {
  await withTempDir(async (dir) => {
    const file = await writeArtifactFixture(dir);
    const before = await readFile(file);
    const result = runExport([file]);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const after = await readFile(file);
    assert.ok(before.equals(after), 'the source artifact must never be mutated on disk by export');
  });
});

test('illuminate export: with a real .illum.json sidecar carrying one card, the card\'s markdown text appears as real markup in the exported file', async () => {
  await withTempDir(async (dir) => {
    const file = await writeArtifactFixture(dir);
    const marker = 'UNIQUE_CARD_MARKDOWN_MARKER_09_04';
    await writeFile(`${file}.illum.json`, sidecarFixture(marker), 'utf8');

    const result = runExport([file]);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const exported = await readFile(join(dir, 'artifact.export.html'), 'utf8');
    assert.ok(exported.includes(marker), 'expected the sidecar card\'s markdown text spliced into the exported file');
    assert.ok(exported.includes('illum-export-cards'), 'expected the card appendix wrapper section');
  });
});

test('illuminate export: with NO sidecar present, the command still succeeds', async () => {
  await withTempDir(async (dir) => {
    const file = await writeArtifactFixture(dir);
    const result = runExport([file]);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.strictEqual(result.stderr, '');
  });
});

test('illuminate export: a base-href notice surfaces in the command\'s own printed output when the artifact declares <base href>', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'artifact.html');
    await writeFile(
      file,
      '<!doctype html><html><head><base href="https://example.com/"></head><body><p>hi</p></body></html>',
      'utf8',
    );
    const result = runExport([file]);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /base-href/);
  });
});

test('illuminate export: a csp-meta notice surfaces in the command\'s own printed output when the artifact declares an author CSP meta', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'artifact.html');
    await writeFile(
      file,
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"></head><body><p>hi</p></body></html>',
      'utf8',
    );
    const result = runExport([file]);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /csp-meta/);
  });
});

test('illuminate export: running the command starts no daemon and creates no lockfile for the artifact directory', async () => {
  await withTempDir(async (dir) => {
    const file = await writeArtifactFixture(dir);
    const result = runExport([file]);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const record = await readLock(lockPathFor(dir));
    assert.strictEqual(record, null, 'illuminate export must never spawn/attach a daemon or write a lockfile');
  });
});
