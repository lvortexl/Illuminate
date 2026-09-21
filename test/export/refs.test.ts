import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExportContext } from '../../src/export/types.ts';
import { forceRemove } from '../fixtures/cleanup.ts';
import {
  loadDataUri,
  isFileSchemeRef,
  isHtmlDocumentRef,
  isInert,
  containsFileUrl,
  resolveBytes,
  DEFAULT_MAX_ASSET_BYTES,
  DEFAULT_MAX_BUNDLE_BYTES,
} from '../../src/export/refs.ts';

let tempDir: string;
let confineDir: string;
let outsideSecretPath: string;

// 37 bytes of arbitrary, non-image content -- pickMime keys off the extension, not the content,
// so this exercises the same code path a real PNG would without needing a real image.
const LOGO_BYTES = Buffer.from('not-a-real-png-but-37-bytes-long!!!', 'utf8');

function makeCtx(overrides: Partial<ExportContext> = {}): ExportContext {
  return {
    baseDir: confineDir,
    confineDir,
    maxAssetBytes: DEFAULT_MAX_ASSET_BYTES,
    maxBundleBytes: DEFAULT_MAX_BUNDLE_BYTES,
    maxDepth: 8,
    inlinedBytes: 0,
    warnings: [],
    ...overrides,
  };
}

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'illuminate-export-refs-'));
  confineDir = join(tempDir, 'artifact');
  await mkdir(join(confineDir, 'img'), { recursive: true });
  await writeFile(join(confineDir, 'img', 'logo.png'), LOGO_BYTES);
  await writeFile(join(confineDir, '.env'), 'SECRET=1\n');

  const outsideDir = join(tempDir, 'outside');
  await mkdir(outsideDir, { recursive: true });
  outsideSecretPath = join(outsideDir, 'secret.txt');
  await writeFile(outsideSecretPath, 'top secret\n');
});

after(async () => {
  await forceRemove(tempDir);
});

// ---------------------------------------------------------------------------
// Happy path: relative ref -> real bytes -> data: URI
// ---------------------------------------------------------------------------

test('a relative ref resolved against a baseDir inside confineDir reads real bytes back as a data: URI whose MIME matches the extension', async () => {
  const ctx = makeCtx();
  const dataUri = await loadDataUri('img/logo.png', confineDir, ctx);
  assert.ok(dataUri, 'expected a data: URI, got null');
  assert.ok(dataUri.startsWith('data:image/png;base64,'));
  const encoded = dataUri.slice('data:image/png;base64,'.length);
  assert.ok(Buffer.from(encoded, 'base64').equals(LOGO_BYTES));
  assert.deepStrictEqual(ctx.warnings, []);
  assert.strictEqual(ctx.inlinedBytes, LOGO_BYTES.length);
});

// ---------------------------------------------------------------------------
// Containment: resolveAssetPath is the sole authority, not a hand-rolled check
// ---------------------------------------------------------------------------

test('a ref resolving outside confineDir is refused via resolveAssetPath -- not a second, hand-rolled traversal check -- and warns outside-root', async () => {
  // outsideSecretPath is a REAL file, sibling of confineDir (tempDir/outside/secret.txt vs.
  // confineDir === tempDir/artifact) -- a genuine filesystem escape, not a synthetic path.
  assert.ok(outsideSecretPath.includes(join('outside', 'secret.txt')));
  const traversalRef = '../outside/secret.txt';
  const ctx = makeCtx();
  const result = await loadDataUri(traversalRef, confineDir, ctx);
  assert.strictEqual(result, null);
  assert.deepStrictEqual(ctx.warnings, [{ kind: 'outside-root', ref: traversalRef }]);
  assert.strictEqual(ctx.inlinedBytes, 0);
});

test('a ref pointing at a dotfile is refused through the SAME confinement function as live serving (Phase 1), not a separate dotfile policy', async () => {
  const ctx = makeCtx();
  const result = await loadDataUri('.env', confineDir, ctx);
  assert.strictEqual(result, null);
  assert.deepStrictEqual(ctx.warnings, [{ kind: 'outside-root', ref: '.env' }]);
});

test('a ref pointing at a nonexistent local file produces a load-failed warning, not a crash', async () => {
  const ctx = makeCtx();
  const result = await loadDataUri('img/does-not-exist.png', confineDir, ctx);
  assert.strictEqual(result, null);
  assert.strictEqual(ctx.warnings.length, 1);
  assert.strictEqual(ctx.warnings[0]?.kind, 'load-failed');
});

// ---------------------------------------------------------------------------
// Budgets: per-asset cap and per-bundle cap, both enforced before reading
// ---------------------------------------------------------------------------

test('a ref whose file is larger than ctx.maxAssetBytes is refused with too-large and never read into memory', async () => {
  const ctx = makeCtx({ maxAssetBytes: 10 });
  const result = await loadDataUri('img/logo.png', confineDir, ctx);
  assert.strictEqual(result, null);
  assert.strictEqual(ctx.warnings.length, 1);
  assert.strictEqual(ctx.warnings[0]?.kind, 'too-large');
  assert.match(ctx.warnings[0]?.reason ?? '', /per-asset cap/);
  assert.strictEqual(ctx.inlinedBytes, 0);
});

test('once ctx.inlinedBytes would exceed ctx.maxBundleBytes, a further otherwise-inlineable ref is ALSO refused too-large, referencing the bundle cap, without mutating ctx.inlinedBytes', async () => {
  const ctx = makeCtx({ maxBundleBytes: LOGO_BYTES.length });
  const first = await loadDataUri('img/logo.png', confineDir, ctx);
  assert.ok(first, 'first read within budget should succeed');
  assert.strictEqual(ctx.inlinedBytes, LOGO_BYTES.length);

  const before = ctx.inlinedBytes;
  const second = await loadDataUri('img/logo.png', confineDir, ctx);
  assert.strictEqual(second, null);
  assert.strictEqual(ctx.inlinedBytes, before, 'refused attempt must not mutate inlinedBytes');
  const lastWarning = ctx.warnings[ctx.warnings.length - 1];
  assert.strictEqual(lastWarning?.kind, 'too-large');
  assert.match(lastWarning?.reason ?? '', /per-bundle cap/);
});

// ---------------------------------------------------------------------------
// Ref classification
// ---------------------------------------------------------------------------

test('isFileSchemeRef recognizes a file:// ref independent of whether it resolves inside or outside confineDir', () => {
  assert.strictEqual(isFileSchemeRef('file:///etc/hosts'), true);
  assert.strictEqual(isFileSchemeRef('file:///C:/Windows/win.ini'), true);
  assert.strictEqual(isFileSchemeRef('img/logo.png'), false);
  assert.strictEqual(isFileSchemeRef('https://example.com/a'), false);
});

test('isHtmlDocumentRef recognizes .html/.htm/.xhtml-shaped refs as nested-document references', () => {
  assert.strictEqual(isHtmlDocumentRef('frame.html'), true);
  assert.strictEqual(isHtmlDocumentRef('frame.htm'), true);
  assert.strictEqual(isHtmlDocumentRef('frame.xhtml'), true);
  assert.strictEqual(isHtmlDocumentRef('frame.html?x=1#y'), true);
  assert.strictEqual(isHtmlDocumentRef('style.css'), false);
  assert.strictEqual(isHtmlDocumentRef('img/logo.png'), false);
});

test('isInert recognizes fragment-only, data:, blob:, about:, javascript:, mailto:, and tel: refs', () => {
  assert.strictEqual(isInert('#section'), true);
  assert.strictEqual(isInert('data:text/plain,hi'), true);
  assert.strictEqual(isInert('javascript:void(0)'), true);
  assert.strictEqual(isInert('mailto:a@b.com'), true);
  assert.strictEqual(isInert(''), true);
  assert.strictEqual(isInert('img/logo.png'), false);
  assert.strictEqual(isInert('https://example.com'), false);
});

test('containsFileUrl detects a file: scheme appearing anywhere in a ref, e.g. inside a CSS url() value', () => {
  assert.strictEqual(containsFileUrl('file:///etc/hosts'), true);
  assert.strictEqual(containsFileUrl('background: url(file:///etc/hosts)'), true);
  assert.strictEqual(containsFileUrl('img/logo.png'), false);
});

// ---------------------------------------------------------------------------
// Budget resolution (env-var override pattern)
// ---------------------------------------------------------------------------

test('resolveBytes prefers an explicit positive option, then a positive integer env override, then the fallback', () => {
  assert.strictEqual(resolveBytes(5000, undefined, 100), 5000);
  assert.strictEqual(resolveBytes(undefined, '2048', 100), 2048);
  assert.strictEqual(resolveBytes(undefined, 'not-a-number', 100), 100);
  assert.strictEqual(resolveBytes(undefined, '-5', 100), 100);
  assert.strictEqual(resolveBytes(0, undefined, 100), 100);
  assert.strictEqual(resolveBytes(-1, '3000', 100), 3000);
});
