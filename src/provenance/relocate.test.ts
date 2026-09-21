import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createFixtureRepo } from '../../test/fixtures/git-repo.ts';
import type { FixtureRepo } from '../../test/fixtures/git-repo.ts';
import { GitBatchPool } from './git-batch-pool.ts';
import { anchorHash } from './hash.ts';
import { forceRemove } from '../../test/fixtures/cleanup.ts';
import {
  relocateWithinFile,
  lineSimilarity,
  RELOCATION_TOUCHED_THRESHOLD,
  RELOCATION_LOST_THRESHOLD,
} from './relocate.ts';
function useRepoAndPool(t: import('node:test').TestContext): { repo: FixtureRepo; pool: GitBatchPool } {
  const repo = createFixtureRepo(false);
  const pool = new GitBatchPool(repo.root);
  t.after(async () => {
    pool.close();
    await forceRemove(repo.root);
  });
  return { repo, pool };
}

/** Joins lines with a single trailing newline, matching git's own convention. */
function block(lines: readonly string[]): string {
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Stage A: cheap diff-hunk line-shift, always confirmed by an exact hash
// re-check before being trusted.
// ---------------------------------------------------------------------------

test('Stage A confirmed: inserting lines above the anchored region relocates it silently, exact hash re-checked', async (t) => {
  const { repo, pool } = useRepoAndPool(t);

  const region = Array.from({ length: 10 }, (_, i) => `region line ${i + 1}`);
  const after = ['after line 1', 'after line 2', 'after line 3'];
  const dataRev = repo.commitFile('file.txt', block([...region, ...after]), 'add file');

  const inserted = Array.from({ length: 50 }, (_, i) => `insert line ${i + 1}`);
  const headRev = repo.commitFile(
    'file.txt',
    block([...inserted, ...region, ...after]),
    'insert 50 unrelated lines above the region',
  );

  const originalRange = { startLine: 1, endLine: 10 };
  const originalHash = anchorHash(region.join('\n'));

  const result = await relocateWithinFile(pool, repo.root, 'file.txt', dataRev, headRev, originalRange, originalHash);

  assert.deepStrictEqual(result, {
    state: 'moved',
    newRange: { startLine: 51, endLine: 60 },
    confirmed: true,
  });
});

test('Stage A skipped on overlap: an in-place edit inside the range is never reported as a clean move from line-shift arithmetic alone', async (t) => {
  const { repo, pool } = useRepoAndPool(t);

  const prefix = ['ctx 1', 'ctx 2', 'ctx 3', 'ctx 4'];
  const region = Array.from({ length: 10 }, (_, i) => `over line ${i + 1}`);
  const suffix = ['tail 1', 'tail 2', 'tail 3'];
  const dataRev = repo.commitFile('over.txt', block([...prefix, ...region, ...suffix]), 'add over.txt');

  const editedRegion = [...region];
  editedRegion[4] = 'over line 5 EDITED'; // ~10% of the region, in place — no lines added/removed anywhere
  const headRev = repo.commitFile(
    'over.txt',
    block([...prefix, ...editedRegion, ...suffix]),
    'edit one line inside the region, in place',
  );

  const originalRange = { startLine: 5, endLine: 14 }; // prefix is 4 lines, so the region starts at line 5
  const originalHash = anchorHash(region.join('\n'));

  // Proof the hash-confirmation step is real, not decorative: because no
  // hunk starts before the range, a naive line-shift-without-confirmation
  // implementation would compute delta=0 and claim the region is still at
  // its original position, unmoved. That claim IS at the original position —
  // but the content there has changed, so trusting it blindly would report a
  // false "moved" (or worse, silently miss the edit entirely). Confirm the
  // trap is real: the current content at the original position does NOT
  // hash-match the stored original.
  const headBlob = await pool.contents(`${headRev}:over.txt`);
  assert.strictEqual(headBlob.found, true);
  const headLines = headBlob.found ? headBlob.content.toString('utf8').replace(/\n$/, '').split('\n') : [];
  const sameSpotText = headLines.slice(4, 14).join('\n');
  assert.notStrictEqual(anchorHash(sameSpotText), originalHash);

  const result = await relocateWithinFile(pool, repo.root, 'over.txt', dataRev, headRev, originalRange, originalHash);

  assert.strictEqual(result.state, 'touched');
});

// ---------------------------------------------------------------------------
// Stage B: bounded fuzzy line-similarity search, only when Stage A is
// inconclusive.
// ---------------------------------------------------------------------------

test('Stage B exact match: content copied byte-for-byte to a distant, non-adjacent position is a confirmed move', async (t) => {
  const { repo, pool } = useRepoAndPool(t);

  const prefix = ['ctx 1', 'ctx 2'];
  const region = Array.from({ length: 10 }, (_, i) => `moved line ${i + 1}`);
  const tail = ['tail 1', 'tail 2', 'tail 3', 'tail 4', 'tail 5'];
  const dataRev = repo.commitFile('distant.txt', block([...prefix, ...region, ...tail]), 'add distant.txt');

  // At the old spot, something else entirely replaces the region (so
  // Stage A's hunk-overlap check rules out the line-shift path cleanly).
  // The original region reappears byte-for-byte far below, past a gap, at a
  // distant non-adjacent position.
  const replacement = Array.from({ length: 10 }, (_, i) => `replacement line ${i + 1}`);
  const gap = ['gap 1', 'gap 2'];
  const headRev = repo.commitFile(
    'distant.txt',
    block([...prefix, ...replacement, ...tail, ...gap, ...region]),
    'replace the region in place, and re-add it verbatim far below',
  );

  const originalRange = { startLine: 3, endLine: 12 };
  const originalHash = anchorHash(region.join('\n'));

  const result = await relocateWithinFile(pool, repo.root, 'distant.txt', dataRev, headRev, originalRange, originalHash);

  assert.deepStrictEqual(result, {
    state: 'moved',
    newRange: { startLine: 20, endLine: 29 },
    confirmed: true,
  });
});

test('Stage B touched: an in-place edit of ~10% of the region\'s lines scores at or above the touched threshold', async (t) => {
  const { repo, pool } = useRepoAndPool(t);

  const region = Array.from({ length: 20 }, (_, i) => `touch line ${i + 1}`);
  const dataRev = repo.commitFile('touch.txt', block(['ctx 0', ...region, 'tail 0']), 'add touch.txt');

  const editedRegion = [...region];
  editedRegion[9] = 'touch line 10 EDITED'; // 2 of 20 lines changed in place = 10%
  editedRegion[14] = 'touch line 15 EDITED';
  const headRev = repo.commitFile(
    'touch.txt',
    block(['ctx 0', ...editedRegion, 'tail 0']),
    'edit two lines inside the region, in place',
  );

  const originalRange = { startLine: 2, endLine: 21 };
  const originalHash = anchorHash(region.join('\n'));

  const result = await relocateWithinFile(pool, repo.root, 'touch.txt', dataRev, headRev, originalRange, originalHash);

  assert.strictEqual(result.state, 'touched');
  assert.deepStrictEqual((result as { newRange: unknown }).newRange, { startLine: 2, endLine: 21 });
});

test('Stage B lost: the region is replaced entirely and no similar window exists anywhere else in the file', async (t) => {
  const { repo, pool } = useRepoAndPool(t);

  const prefix = ['ctx A', 'ctx B'];
  const region = Array.from({ length: 10 }, (_, i) => `region line ${i + 1}`);
  const tail = ['tail A', 'tail B', 'tail C', 'tail D', 'tail E'];
  const dataRev = repo.commitFile('lost.txt', block([...prefix, ...region, ...tail]), 'add lost.txt');

  const unrelated = Array.from({ length: 10 }, (_, i) => `unrelated line ${i + 1}`);
  const headRev = repo.commitFile(
    'lost.txt',
    block([...prefix, ...unrelated, ...tail]),
    'replace the region with wholly unrelated content',
  );

  const originalRange = { startLine: 3, endLine: 12 };
  const originalHash = anchorHash(region.join('\n'));

  const result = await relocateWithinFile(pool, repo.root, 'lost.txt', dataRev, headRev, originalRange, originalHash);

  assert.deepStrictEqual(result, { state: 'lost' });
});

// ---------------------------------------------------------------------------
// lineSimilarity, extracted and exported on its own (refactor step) so
// Phase 5 can unit-test or swap the scorer independently of the ladder's
// orchestration logic above.
// ---------------------------------------------------------------------------

test('lineSimilarity: identical line arrays score 1, and a half-matching pair scores 0.5', () => {
  assert.strictEqual(lineSimilarity(['a', 'b', 'c'], ['a', 'b', 'c']), 1);
  assert.strictEqual(lineSimilarity(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'y']), 0.5);
  assert.strictEqual(lineSimilarity([], []), 1);
});

test('Ambiguous band defaults to "touched": a ~50%-similar candidate resolves to the cautious middle state, never silently "moved" nor straight to "lost"', async (t) => {
  const { repo, pool } = useRepoAndPool(t);

  const region = Array.from({ length: 10 }, (_, i) => `amb line ${i + 1}`);
  const dataRev = repo.commitFile('amb.txt', block(['ctx 0', ...region, 'tail 0']), 'add amb.txt');

  // Keep every odd-indexed line, replace every even-indexed line in place —
  // order-preserving, so the LCS-based similarity is exactly half.
  const edited = region.map((line, i) => (i % 2 === 0 ? line : `diff line ${i + 1}`));
  const headRev = repo.commitFile(
    'amb.txt',
    block(['ctx 0', ...edited, 'tail 0']),
    'replace half the region lines in place',
  );

  const originalRange = { startLine: 2, endLine: 11 };
  const originalHash = anchorHash(region.join('\n'));

  const result = await relocateWithinFile(pool, repo.root, 'amb.txt', dataRev, headRev, originalRange, originalHash);

  assert.strictEqual(result.state, 'touched');
});

// ---------------------------------------------------------------------------
// Boundary inclusivity: exactly at RELOCATION_TOUCHED_THRESHOLD and exactly
// at RELOCATION_LOST_THRESHOLD.
// ---------------------------------------------------------------------------

test('Boundary inclusivity: a candidate scoring exactly at the touched threshold is treated as "touched" (>= is inclusive)', async (t) => {
  const { repo, pool } = useRepoAndPool(t);

  const region = Array.from({ length: 10 }, (_, i) => `bnd line ${i + 1}`);
  const dataRev = repo.commitFile('bnd-hi.txt', block(['ctx 0', ...region, 'tail 0']), 'add bnd-hi.txt');

  const keep = Math.round(region.length * RELOCATION_TOUCHED_THRESHOLD); // 7 of 10
  const edited = region.map((line, i) => (i < keep ? line : `changed line ${i + 1}`));
  const headRev = repo.commitFile(
    'bnd-hi.txt',
    block(['ctx 0', ...edited, 'tail 0']),
    'change the trailing 30% of the region, in place',
  );

  const originalRange = { startLine: 2, endLine: 11 };
  const originalHash = anchorHash(region.join('\n'));

  const result = await relocateWithinFile(pool, repo.root, 'bnd-hi.txt', dataRev, headRev, originalRange, originalHash);

  assert.strictEqual(result.state, 'touched');
});

test('Boundary inclusivity: a candidate scoring exactly at the lost threshold is NOT automatically "lost" (falls into the ambiguous touched band)', async (t) => {
  const { repo, pool } = useRepoAndPool(t);

  const region = Array.from({ length: 10 }, (_, i) => `bnd line ${i + 1}`);
  const dataRev = repo.commitFile('bnd-lo.txt', block(['ctx 0', ...region, 'tail 0']), 'add bnd-lo.txt');

  const keep = Math.round(region.length * RELOCATION_LOST_THRESHOLD); // 3 of 10
  const edited = region.map((line, i) => (i < keep ? line : `changed line ${i + 1}`));
  const headRev = repo.commitFile(
    'bnd-lo.txt',
    block(['ctx 0', ...edited, 'tail 0']),
    'change the trailing 70% of the region, in place',
  );

  const originalRange = { startLine: 2, endLine: 11 };
  const originalHash = anchorHash(region.join('\n'));

  const result = await relocateWithinFile(pool, repo.root, 'bnd-lo.txt', dataRev, headRev, originalRange, originalHash);

  assert.notStrictEqual(result.state, 'lost');
  assert.strictEqual(result.state, 'touched');
});

// ---------------------------------------------------------------------------
// Behavioral coverage of the now-wired RELOCATION_TOUCHED_THRESHOLD branch:
// verbatim relocation, a fuzzy match clearly (not just barely) above 0.7,
// and values strictly on either side of both named thresholds.
// ---------------------------------------------------------------------------

test('Verbatim relocation (score 1.0): byte-identical content moved to a new position is reported as "moved", never "touched"', async (t) => {
  const { repo, pool } = useRepoAndPool(t);

  const prefix = ['ctx 1', 'ctx 2'];
  const region = Array.from({ length: 12 }, (_, i) => `verbatim line ${i + 1}`);
  const tail = ['tail 1', 'tail 2', 'tail 3'];
  const dataRev = repo.commitFile('verbatim.txt', block([...prefix, ...region, ...tail]), 'add verbatim.txt');

  // Confirm the constructed region really does score a perfect 1.0 against
  // itself via the same similarity function Stage B uses internally — this
  // is what "verbatim" means for this test, not just an assumption.
  assert.strictEqual(lineSimilarity(region, region), 1);

  const replacement = Array.from({ length: 12 }, (_, i) => `replacement line ${i + 1}`);
  const gap = ['gap 1', 'gap 2', 'gap 3'];
  const headRev = repo.commitFile(
    'verbatim.txt',
    block([...prefix, ...replacement, ...tail, ...gap, ...region]),
    'replace the region in place, and re-add it byte-for-byte far below',
  );

  const originalRange = { startLine: 3, endLine: 14 };
  const originalHash = anchorHash(region.join('\n'));

  const result = await relocateWithinFile(pool, repo.root, 'verbatim.txt', dataRev, headRev, originalRange, originalHash);

  // The exact-hash priority pass (Stage B, before the fuzzy scorer ever
  // runs) is what catches this, not the fuzzy similarity band at all —
  // this is the "moved" outcome for verbatim content described by
  // 02-RESEARCH.md's Four-State Model table, and it is unaffected by
  // where RELOCATION_TOUCHED_THRESHOLD is set.
  assert.strictEqual(result.state, 'moved');
  assert.strictEqual((result as { confirmed: unknown }).confirmed, true);
});

test('Fuzzy match clearly above the touched threshold (not merely at the boundary) is "touched", never silently promoted to "moved"', async (t) => {
  const { repo, pool } = useRepoAndPool(t);

  const region = Array.from({ length: 20 }, (_, i) => `above line ${i + 1}`);
  const dataRev = repo.commitFile('above.txt', block(['ctx 0', ...region, 'tail 0']), 'add above.txt');

  const keep = Math.round(region.length * (RELOCATION_TOUCHED_THRESHOLD + 0.1)); // 0.8: clearly above 0.7, still < 1.0
  const edited = region.map((line, i) => (i < keep ? line : `changed line ${i + 1}`));
  const headRev = repo.commitFile(
    'above.txt',
    block(['ctx 0', ...edited, 'tail 0']),
    'change a small trailing slice of the region, in place',
  );

  const originalRange = { startLine: 2, endLine: 21 };
  const originalHash = anchorHash(region.join('\n'));

  const result = await relocateWithinFile(pool, repo.root, 'above.txt', dataRev, headRev, originalRange, originalHash);

  assert.strictEqual(result.state, 'touched');
  assert.strictEqual('confirmed' in result, false);
});

test('Boundary: a candidate scoring just below the lost threshold is "lost"', async (t) => {
  const { repo, pool } = useRepoAndPool(t);

  const region = Array.from({ length: 20 }, (_, i) => `below-lost line ${i + 1}`);
  const dataRev = repo.commitFile('below-lost.txt', block(['ctx 0', ...region, 'tail 0']), 'add below-lost.txt');

  const keep = Math.round(region.length * (RELOCATION_LOST_THRESHOLD - 0.05)); // 0.25: clearly below 0.3
  const edited = region.map((line, i) => (i < keep ? line : `changed line ${i + 1}`));
  const headRev = repo.commitFile(
    'below-lost.txt',
    block(['ctx 0', ...edited, 'tail 0']),
    'change most of the region, in place',
  );

  const originalRange = { startLine: 2, endLine: 21 };
  const originalHash = anchorHash(region.join('\n'));

  const result = await relocateWithinFile(
    pool,
    repo.root,
    'below-lost.txt',
    dataRev,
    headRev,
    originalRange,
    originalHash,
  );

  assert.strictEqual(result.state, 'lost');
});

test('Boundary: a candidate scoring just below the touched threshold still resolves to "touched" (the ambiguous middle band)', async (t) => {
  const { repo, pool } = useRepoAndPool(t);

  const region = Array.from({ length: 20 }, (_, i) => `below-touched line ${i + 1}`);
  const dataRev = repo.commitFile('below-touched.txt', block(['ctx 0', ...region, 'tail 0']), 'add below-touched.txt');

  const keep = Math.round(region.length * (RELOCATION_TOUCHED_THRESHOLD - 0.05)); // 0.65: below 0.7, above 0.3
  const edited = region.map((line, i) => (i < keep ? line : `changed line ${i + 1}`));
  const headRev = repo.commitFile(
    'below-touched.txt',
    block(['ctx 0', ...edited, 'tail 0']),
    'change roughly a third of the region, in place',
  );

  const originalRange = { startLine: 2, endLine: 21 };
  const originalHash = anchorHash(region.join('\n'));

  const result = await relocateWithinFile(
    pool,
    repo.root,
    'below-touched.txt',
    dataRev,
    headRev,
    originalRange,
    originalHash,
  );

  assert.strictEqual(result.state, 'touched');
});

// ---------------------------------------------------------------------------
// Constant isolation regression guard: the two threshold literals must exist
// ONLY on their own `export const` declaration lines in relocate.ts's own
// source text — never re-embedded as a scattered literal in the
// implementation body. Deliberately a plain-text source check, not an
// executed-behavior test.
// ---------------------------------------------------------------------------

test('constant isolation: the threshold literals appear only on their export const declaration lines', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'relocate.ts'), 'utf8');
  const sourceLines = source.split('\n');

  const isDeclarationLine = (line: string): boolean =>
    line.includes('RELOCATION_TOUCHED_THRESHOLD =') || line.includes('RELOCATION_LOST_THRESHOLD =');

  const offendingLines = sourceLines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !isDeclarationLine(line))
    .filter(({ line }) => /\b0\.7\b/.test(line) || /\b0\.3\b/.test(line));

  assert.deepStrictEqual(
    offendingLines,
    [],
    `threshold literal 0.7/0.3 found outside its export const line: ${JSON.stringify(offendingLines)}`,
  );

  // Sanity check the two declaration lines DO exist and carry the expected
  // values, so this guard can't pass merely because the constants were
  // renamed or removed.
  assert.ok(sourceLines.some((l) => isDeclarationLine(l) && l.includes('0.7')));
  assert.ok(sourceLines.some((l) => isDeclarationLine(l) && l.includes('0.3')));
});

// ---------------------------------------------------------------------------
// Constant USAGE regression guard: presence (the check above) is not the
// same claim as use. This is the check that would have caught the shipped
// bug this file's boundary tests above now exercise behaviorally —
// RELOCATION_TOUCHED_THRESHOLD existed as a named, exported constant but was
// never referenced inside any conditional anywhere in relocate.ts, so
// anything scoring >= RELOCATION_LOST_THRESHOLD silently fell through to
// "touched" regardless of how close to 1.0 its similarity actually was.
// ---------------------------------------------------------------------------

test('constant usage: both threshold constants are referenced inside a real conditional, not merely declared', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'relocate.ts'), 'utf8');
  const sourceLines = source.split('\n');

  const isDeclarationLine = (line: string): boolean =>
    line.includes('RELOCATION_TOUCHED_THRESHOLD =') || line.includes('RELOCATION_LOST_THRESHOLD =');

  // A "used in a conditional" line: an `if (...)` condition (on the same
  // source line, matching this file's existing single-line `if` style) that
  // also references the constant's name, on a non-declaration line.
  const usedInConditional = (name: string): boolean =>
    sourceLines.some((line) => !isDeclarationLine(line) && /\bif\s*\(/.test(line) && line.includes(name));

  assert.ok(
    usedInConditional('RELOCATION_TOUCHED_THRESHOLD'),
    'RELOCATION_TOUCHED_THRESHOLD must be referenced inside an `if (...)` condition, not merely declared -- a ' +
      'presence-only check cannot catch a threshold that exists but is never branched on',
  );
  assert.ok(
    usedInConditional('RELOCATION_LOST_THRESHOLD'),
    'RELOCATION_LOST_THRESHOLD must be referenced inside an `if (...)` condition, not merely declared',
  );
});
