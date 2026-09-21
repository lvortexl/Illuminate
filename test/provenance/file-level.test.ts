import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolve } from '../../src/provenance/resolve.ts';
import { isUngroundable } from '../../src/router/verify.ts';

/**
 * File-level grounding (ADR-001).
 *
 * The defect these cover: an artifact section that names a real, readable
 * file but carries no `data-anchor-hash` was refused outright, so `verify`
 * short-circuited to "no resolved source content is available" WITHOUT EVER
 * READING THE FILE SITTING RIGHT THERE. Stamping a hash requires a git repo
 * and a clean tree (.demo/stamp-anchors.mjs refuses on a dirty one), which
 * no ordinary agent-generated artifact has done.
 *
 * The fix is a separate, weaker tier -- never a relaxation of the mandatory
 * hash rule for PINNED anchors, whose staleness guarantee depends on it.
 */

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'illum-filelevel-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'widget.ts'),
    ['export function widget() {', '  return 42;', '}', '// trailing line'].join('\n'),
    'utf8',
  );
  return root;
}

const pool = {} as never;

test('a hash-less data-src naming a readable file yields real content, not a refusal', async () => {
  const root = fixtureRepo();
  try {
    const result = await resolve(root, { path: 'src/widget.ts', anchorHash: '' }, pool);
    assert.equal(result.status, 'file-level');
    assert.ok(result.content !== null, 'content must be served, not null');
    assert.match(result.content, /return 42/);
    assert.equal(isUngroundable({ path: 'src/widget.ts', rev: null, range: null, status: result.status, content: result.content }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('file-level grounding is never eligible for staleness -- there is no pinned rev', async () => {
  const root = fixtureRepo();
  try {
    const result = await resolve(root, { path: 'src/widget.ts', anchorHash: '' }, pool);
    assert.equal(result.eligibleForStaleness, false);
    assert.equal(result.resolvedRev, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a hash-less reference honours its line range', async () => {
  const root = fixtureRepo();
  try {
    const result = await resolve(root, { path: 'src/widget.ts', range: 'L2-L2', anchorHash: '' }, pool);
    assert.equal(result.status, 'file-level');
    assert.equal(result.content, '  return 42;');
    assert.deepEqual(result.resolvedRange, { startLine: 2, endLine: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('containment still refuses an escaping path even without a hash', async () => {
  const root = fixtureRepo();
  try {
    const result = await resolve(root, { path: '../../../etc/passwd', anchorHash: '' }, pool);
    assert.equal(result.status, 'refused');
    assert.equal(result.content, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a hash-less reference to a file that does not exist stays ungroundable, with a reason', async () => {
  const root = fixtureRepo();
  try {
    const result = await resolve(root, { path: 'src/nope.ts', anchorHash: '' }, pool);
    assert.equal(result.content, null);
    assert.ok(result.reason !== null && result.reason.length > 0, 'must say why');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an element with no data-src at all is still unanchored -- nothing to guess from', async () => {
  const root = fixtureRepo();
  try {
    const result = await resolve(root, null, pool);
    assert.equal(result.status, 'unanchored');
    assert.equal(result.content, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed range is still a refusal, not silently ignored', async () => {
  const root = fixtureRepo();
  try {
    const result = await resolve(root, { path: 'src/widget.ts', range: 'banana', anchorHash: '' }, pool);
    assert.equal(result.status, 'refused');
    assert.equal(result.content, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
