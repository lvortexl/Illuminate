import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { exportArtifact } from '../../src/export/inline-html.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = join(HERE, '../fixtures/artifacts');
const EXPORT_FIXTURES_DIR = join(HERE, '../fixtures/export');

function readArtifactFixture(name: string): string {
  return readFileSync(join(ARTIFACTS_DIR, name), 'utf8');
}

function readExportFixture(name: string): string {
  return readFileSync(join(EXPORT_FIXTURES_DIR, name), 'utf8');
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-inline-html-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

// ---------------------------------------------------------------------------
// Local asset inlining: <img src>, <link rel=stylesheet>, CSS url() (both
// inside an inline <style> block AND a style="..." attribute), <script src>
// ---------------------------------------------------------------------------

test('a local <img src> is inlined as a data: URI, no remaining local-asset.png reference', async () => {
  const html = readExportFixture('local-asset.html');
  const result = await exportArtifact(html, { baseDir: EXPORT_FIXTURES_DIR, confineDir: EXPORT_FIXTURES_DIR });
  const imgMatch = result.html.match(/<img src="([^"]+)"/);
  assert.ok(imgMatch?.[1], `expected an <img src="..."> in: ${result.html}`);
  assert.ok(imgMatch[1].startsWith('data:image/png;base64,'), `expected a data: URI, got: ${imgMatch[1]}`);
});

test('a local <link rel=stylesheet> is inlined as an inline <style> block, no remaining <link> element', async () => {
  const html = readExportFixture('local-asset.html');
  const result = await exportArtifact(html, { baseDir: EXPORT_FIXTURES_DIR, confineDir: EXPORT_FIXTURES_DIR });
  assert.ok(!/<link[^>]*rel="stylesheet"/.test(result.html), `expected no remaining <link rel=stylesheet>: ${result.html}`);
  assert.ok(result.html.includes('font-family: sans-serif'), `expected the CSS file's own rule text inlined: ${result.html}`);
});

test('a CSS url() reference inside an inline <style> block is inlined as a data: URI', async () => {
  const html = readExportFixture('local-asset.html');
  const result = await exportArtifact(html, { baseDir: EXPORT_FIXTURES_DIR, confineDir: EXPORT_FIXTURES_DIR });
  assert.match(result.html, /\.hero\s*\{\s*background-image:\s*url\("data:image\/png;base64,/);
});

test('every reference to the local-asset.png filename itself is gone from the output (both the <img> and the CSS url() were inlined)', async () => {
  const html = readExportFixture('local-asset.html');
  const result = await exportArtifact(html, { baseDir: EXPORT_FIXTURES_DIR, confineDir: EXPORT_FIXTURES_DIR });
  assert.ok(!result.html.includes('local-asset.png'), `expected no remaining "local-asset.png" text: ${result.html}`);
  assert.ok(!result.html.includes('local-asset.css'), `expected no remaining "local-asset.css" text: ${result.html}`);
});

test('a CSS url() reference inside a style="..." attribute is inlined as a data: URI', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'dot.png'), readFileSync(join(EXPORT_FIXTURES_DIR, 'local-asset.png')));
    const html = `<!doctype html><html><body><div style="background: url(dot.png) no-repeat;"></div></body></html>`;
    const result = await exportArtifact(html, { baseDir: dir, confineDir: dir });
    assert.match(result.html, /style="background: url\(data:image\/png;base64,[^)]+\) no-repeat;"/);
    assert.ok(!result.html.includes('dot.png'));
  });
});

test('a local <script src> whose target exists is inlined as an inline <script> with the same content, no remaining src attribute', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'greet.js'), 'console.log("hello from greet.js");');
    const html = `<!doctype html><html><body><script src="greet.js"></script></body></html>`;
    const result = await exportArtifact(html, { baseDir: dir, confineDir: dir });
    assert.ok(result.html.includes('console.log("hello from greet.js");'), `expected the script's content inlined: ${result.html}`);
    assert.ok(!/<script[^>]*\ssrc=/.test(result.html), `expected no remaining <script src=...>: ${result.html}`);
  });
});

// ---------------------------------------------------------------------------
// Unresolvable / out-of-bounds refs: correctly classified warning, reference left UNCHANGED
// ---------------------------------------------------------------------------

test('a ref pointing outside confineDir is left UNCHANGED in the output and produces an outside-root warning', async () => {
  await withTempDir(async (dir) => {
    const confineDir = join(dir, 'artifact');
    const outsideDir = join(dir, 'outside');
    await mkdir(confineDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, 'secret.png'), Buffer.from('not-a-real-png'));
    const html = `<!doctype html><html><body><img src="../outside/secret.png"></body></html>`;
    const result = await exportArtifact(html, { baseDir: confineDir, confineDir });
    assert.ok(result.html.includes('src="../outside/secret.png"'), `expected the ref left unchanged: ${result.html}`);
    assert.ok(result.warnings.some((w) => w.kind === 'outside-root'), `expected an outside-root warning: ${JSON.stringify(result.warnings)}`);
  });
});

test('a ref to a nonexistent local file is left UNCHANGED and produces a load-failed warning', async () => {
  await withTempDir(async (dir) => {
    const html = `<!doctype html><html><body><img src="does-not-exist.png"></body></html>`;
    const result = await exportArtifact(html, { baseDir: dir, confineDir: dir });
    assert.ok(result.html.includes('src="does-not-exist.png"'), `expected the ref left unchanged: ${result.html}`);
    assert.ok(result.warnings.some((w) => w.kind === 'load-failed'), `expected a load-failed warning: ${JSON.stringify(result.warnings)}`);
  });
});

test('a ref to a file over maxAssetBytes is left UNCHANGED and produces a too-large warning', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'big.png'), Buffer.alloc(64, 1));
    const html = `<!doctype html><html><body><img src="big.png"></body></html>`;
    const result = await exportArtifact(html, { baseDir: dir, confineDir: dir, maxAssetBytes: 10 });
    assert.ok(result.html.includes('src="big.png"'), `expected the ref left unchanged: ${result.html}`);
    assert.ok(result.warnings.some((w) => w.kind === 'too-large'), `expected a too-large warning: ${JSON.stringify(result.warnings)}`);
  });
});

// ---------------------------------------------------------------------------
// file:// scrubbing (new export-specific fixture)
// ---------------------------------------------------------------------------

test('a file:// reference is redacted to about:blank and produces a file-url-redacted warning', async () => {
  const html = readExportFixture('file-url.html');
  const result = await exportArtifact(html, { baseDir: EXPORT_FIXTURES_DIR, confineDir: EXPORT_FIXTURES_DIR });
  assert.ok(result.html.includes('href="about:blank"'), `expected the file:// ref redacted: ${result.html}`);
  assert.ok(!result.html.includes('file:///C:/Users/example/secret.txt'), `expected no remaining file:// ref: ${result.html}`);
  assert.ok(
    result.warnings.some((w) => w.kind === 'file-url-redacted' && w.ref === 'file:///C:/Users/example/secret.txt'),
    `expected a file-url-redacted warning naming the ref: ${JSON.stringify(result.warnings)}`,
  );
});

// ---------------------------------------------------------------------------
// remote-reference: illuminate's own stricter-than-reference divergence
// ---------------------------------------------------------------------------

test('a surviving remote (http/https) reference is left UNCHANGED as a working link and produces a remote-reference warning', async () => {
  const html = readExportFixture('remote-reference.html');
  const result = await exportArtifact(html, { baseDir: EXPORT_FIXTURES_DIR, confineDir: EXPORT_FIXTURES_DIR });
  assert.ok(result.html.includes('src="https://cdn.example.com/lib.js"'), `expected the remote ref left unchanged: ${result.html}`);
  assert.ok(
    result.warnings.some((w) => w.kind === 'remote-reference' && w.ref === 'https://cdn.example.com/lib.js'),
    `expected a remote-reference warning naming the ref: ${JSON.stringify(result.warnings)}`,
  );
});

test('an ordinary <a href> to a remote page does NOT produce a remote-reference warning (never a fetchable resource attribute)', async () => {
  const html = `<!doctype html><html><body><a href="https://example.com/page">a normal link</a></body></html>`;
  const result = await exportArtifact(html, { baseDir: EXPORT_FIXTURES_DIR, confineDir: EXPORT_FIXTURES_DIR });
  assert.ok(!result.warnings.some((w) => w.kind === 'remote-reference'), `expected no remote-reference warning: ${JSON.stringify(result.warnings)}`);
  assert.ok(result.html.includes('href="https://example.com/page"'));
});

// ---------------------------------------------------------------------------
// base-href.html / author-csp-meta.html: exportArtifact itself stays silent and unmodifying
// ---------------------------------------------------------------------------

test('exportArtifact carries no base-href-specific warning and does not rewrite or strip the <base> tag', async () => {
  const html = readArtifactFixture('base-href.html');
  const result = await exportArtifact(html, { baseDir: ARTIFACTS_DIR, confineDir: ARTIFACTS_DIR });
  assert.ok(result.html.includes('<base href="https://cdn.example.com/">'), `expected <base> left untouched: ${result.html}`);
  assert.ok(!result.warnings.some((w) => w.kind === 'remote-reference' && w.ref.includes('cdn.example.com')));
});

test('exportArtifact carries no CSP-specific warning and does not rewrite or strip the author CSP <meta> tag', async () => {
  const html = readArtifactFixture('author-csp-meta.html');
  const result = await exportArtifact(html, { baseDir: ARTIFACTS_DIR, confineDir: ARTIFACTS_DIR });
  assert.ok(
    result.html.includes('<meta http-equiv="Content-Security-Policy" content="script-src \'self\'">'),
    `expected the CSP meta left untouched: ${result.html}`,
  );
});

// ---------------------------------------------------------------------------
// body-in-srcdoc.html: iframe srcdoc nested HTML left completely unchanged
// ---------------------------------------------------------------------------

test('an iframe srcdoc attribute\'s nested HTML is byte-identical in the output -- not inlined, not scrubbed, not touched', async () => {
  const html = readArtifactFixture('body-in-srcdoc.html');
  const result = await exportArtifact(html, { baseDir: ARTIFACTS_DIR, confineDir: ARTIFACTS_DIR });
  assert.ok(
    result.html.includes('srcdoc="<html><body>nested fake content, closes with a body tag: </body></html>"'),
    `expected the srcdoc attribute byte-identical: ${result.html}`,
  );
});

// ---------------------------------------------------------------------------
// All 10 existing adversarial fixtures: exportArtifact never throws, and each
// fixture's own distinguishing marker text survives (proof against the REAL
// transform, not just the tokenizer in isolation).
// ---------------------------------------------------------------------------

const ADVERSARIAL_FIXTURE_MARKERS: Record<string, string> = {
  'author-csp-meta.html': 'Has an author CSP meta tag',
  'base-href.html': 'Has a base href',
  'body-in-comment.html': 'Decoy: an HTML comment mentions a body close tag',
  'body-in-pre-code.html': 'Decoy: a code sample shows a body close tag, escaped and literal',
  'body-in-script.html': 'Decoy: a closing body tag string lives inside a script below',
  'body-in-srcdoc.html': 'Decoy: a nested iframe srcdoc attribute contains a body close tag',
  'body-in-style.html': 'Decoy: a style rule contains a body close tag as a string',
  'bom-crlf.html': 'BOM plus CRLF line endings',
  'no-body-tag.html': 'No explicit closing tags',
  'quirky-mutations.html': 'hi',
};

test('all 10 existing adversarial fixtures round-trip through exportArtifact without throwing, marker text intact', async () => {
  assert.strictEqual(Object.keys(ADVERSARIAL_FIXTURE_MARKERS).length, 10);
  for (const [name, marker] of Object.entries(ADVERSARIAL_FIXTURE_MARKERS)) {
    const html = readArtifactFixture(name);
    const result = await exportArtifact(html, { baseDir: ARTIFACTS_DIR, confineDir: ARTIFACTS_DIR });
    assert.ok(result.html.includes(marker), `${name}: expected marker text ${JSON.stringify(marker)} to survive in: ${result.html}`);
  }
});

test('all 3 new export-specific fixtures round-trip through exportArtifact without throwing', async () => {
  for (const name of ['local-asset.html', 'file-url.html', 'remote-reference.html']) {
    const html = readExportFixture(name);
    await assert.doesNotReject(exportArtifact(html, { baseDir: EXPORT_FIXTURES_DIR, confineDir: EXPORT_FIXTURES_DIR }));
  }
});
