import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { AnchorInput } from '../../src/provenance/anchor.ts';
import type { ResolveResult, DriftState } from '../../src/provenance/types.ts';
import type { ScanObservation } from '../../src/store/findings-store.ts';
import type { AnchorClassification } from '../../src/daemon/staleness.ts';
import { planScanObservations, runStalenessScan } from '../../src/daemon/staleness.ts';
import { resolve } from '../../src/provenance/resolve.ts';
import { createFixtureRepo } from '../fixtures/git-repo.ts';
import type { FixtureRepo } from '../fixtures/git-repo.ts';
import { getRepoContext } from '../../src/router/pool-registry.ts';
import { FindingsStoreFile } from '../../src/store/findings-store.ts';
import { anchorHash } from '../../src/provenance/hash.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

const REVISION = 'a'.repeat(40);
const AT = '2026-09-11T00:00:00.000Z';

function makeResult(status: DriftState, eligibleForStaleness: boolean): ResolveResult {
  return {
    status,
    content: status === 'unchanged' || status === 'moved' || status === 'touched' ? 'some content' : null,
    resolvedRev: eligibleForStaleness ? REVISION : null,
    resolvedRange: null,
    eligibleForStaleness,
    reason: eligibleForStaleness ? null : `synthetic ${status} for test`,
  };
}

function classification(
  input: AnchorInput,
  status: DriftState,
  eligibleForStaleness: boolean,
): AnchorClassification {
  return { input, result: makeResult(status, eligibleForStaleness) };
}

const WHOLE_FILE_INPUT: AnchorInput = { path: 'src/a.ts', anchorHash: 'hash1' };
const RANGED_INPUT: AnchorInput = { path: 'src/b.ts', range: 'L5-L10', rev: 'deadbeef', anchorHash: 'hash2' };

// ---------------------------------------------------------------------------
// Task 2: planScanObservations -- the pure fail-open decision function
// ---------------------------------------------------------------------------

test('planScanObservations: status "touched" + eligible produces exactly one drift-touched detected observation', () => {
  const observations = planScanObservations([classification(RANGED_INPUT, 'touched', true)], REVISION, AT);

  assert.deepStrictEqual(observations, [
    {
      rule: 'drift-touched',
      target: { path: 'src/b.ts', startLine: 5, endLine: 10 },
      outcome: 'detected',
      revision: REVISION,
      at: AT,
    },
  ] satisfies ScanObservation[]);
});

test('planScanObservations: status "lost" + eligible produces exactly one drift-lost detected observation', () => {
  const observations = planScanObservations([classification(RANGED_INPUT, 'lost', true)], REVISION, AT);

  assert.deepStrictEqual(observations, [
    {
      rule: 'drift-lost',
      target: { path: 'src/b.ts', startLine: 5, endLine: 10 },
      outcome: 'detected',
      revision: REVISION,
      at: AT,
    },
  ] satisfies ScanObservation[]);
});

test('planScanObservations: status "unchanged" + eligible produces TWO absent observations, one per rule, same target', () => {
  const observations = planScanObservations([classification(WHOLE_FILE_INPUT, 'unchanged', true)], REVISION, AT);

  assert.deepStrictEqual(observations, [
    {
      rule: 'drift-touched',
      target: { path: 'src/a.ts', startLine: null, endLine: null },
      outcome: 'absent',
      revision: REVISION,
      at: AT,
    },
    {
      rule: 'drift-lost',
      target: { path: 'src/a.ts', startLine: null, endLine: null },
      outcome: 'absent',
      revision: REVISION,
      at: AT,
    },
  ] satisfies ScanObservation[]);
});

test('planScanObservations: status "moved" + eligible produces the SAME two-observation absent pair as unchanged', () => {
  const observations = planScanObservations([classification(RANGED_INPUT, 'moved', true)], REVISION, AT);

  assert.deepStrictEqual(observations, [
    {
      rule: 'drift-touched',
      target: { path: 'src/b.ts', startLine: 5, endLine: 10 },
      outcome: 'absent',
      revision: REVISION,
      at: AT,
    },
    {
      rule: 'drift-lost',
      target: { path: 'src/b.ts', startLine: 5, endLine: 10 },
      outcome: 'absent',
      revision: REVISION,
      at: AT,
    },
  ] satisfies ScanObservation[]);
});

// Fail-open: eligibleForStaleness: false produces ZERO observations,
// regardless of what result.status says -- each of the four non-core
// outcomes is asserted as an INDEPENDENT case, not one combined assertion.
for (const status of ['cannot-determine', 'refused', 'no-git', 'unanchored'] as const) {
  test(`planScanObservations: eligibleForStaleness: false with status "${status}" produces ZERO observations (fail-open)`, () => {
    const observations = planScanObservations([classification(WHOLE_FILE_INPUT, status, false)], REVISION, AT);
    assert.deepStrictEqual(observations, []);
  });
}

test('planScanObservations: eligibleForStaleness: false with status "touched" (the unpinned-anchor case) ALSO produces ZERO observations -- eligibility, not status, gates every decision', () => {
  const observations = planScanObservations([classification(WHOLE_FILE_INPUT, 'touched', false)], REVISION, AT);
  assert.deepStrictEqual(observations, []);
});

test('planScanObservations: revision/at are threaded through verbatim onto every observation; a multi-classification array produces one target per classification, none conflated', () => {
  const otherInput: AnchorInput = { path: 'src/c.ts', range: 'L1-L1', anchorHash: 'hash3' };
  const observations = planScanObservations(
    [
      classification(RANGED_INPUT, 'touched', true),
      classification(otherInput, 'lost', true),
      classification(WHOLE_FILE_INPUT, 'cannot-determine', false),
    ],
    REVISION,
    AT,
  );

  assert.strictEqual(observations.length, 2);
  assert.ok(observations.every((o) => o.revision === REVISION && o.at === AT));
  assert.deepStrictEqual(observations[0]?.target, { path: 'src/b.ts', startLine: 5, endLine: 10 });
  assert.deepStrictEqual(observations[1]?.target, { path: 'src/c.ts', startLine: 1, endLine: 1 });
  assert.strictEqual(observations[0]?.rule, 'drift-touched');
  assert.strictEqual(observations[1]?.rule, 'drift-lost');
});

// ---------------------------------------------------------------------------
// Task 3: runStalenessScan -- real-fixture-repo integration proof
// ---------------------------------------------------------------------------

/** Joins lines with a single trailing newline, matching git's own convention
 * (mirrors resolve.test.ts's/drift.test.ts's own `block` helper). */
function block(lines: readonly string[]): string {
  return lines.join('\n') + '\n';
}
function usingFixture(t: TestContext): FixtureRepo {
  const repo = createFixtureRepo(false);
  t.after(async () => {
    const { pool } = getRepoContext(repo.root);
    pool.close();
    await forceRemove(repo.root);
  });
  return repo;
}

/** Writes an artifact HTML file, untracked, directly in the fixture repo's
 * own root -- `getRepoContext(artifactDir)` still resolves the SAME repo
 * root and shares the SAME cached pool regardless of whether the artifact
 * itself is a tracked file. Carries exactly one data-src anchor whose
 * data-rev/data-anchor-hash are the REAL pinned values this integration
 * test computed, mirroring drift.test.ts's own real-hash convention (never
 * a placeholder hash -- classifyDrift genuinely compares it). */
function writeArtifact(
  repo: FixtureRepo,
  name: string,
  anchor: { readonly src: string; readonly rev: string; readonly hash: string },
): string {
  const path = join(repo.root, name);
  const html =
    `<!doctype html><html><body>` +
    `<div data-src="${anchor.src}" data-rev="${anchor.rev}" data-anchor-hash="${anchor.hash}">rendered</div>` +
    `</body></html>`;
  writeFileSync(path, html);
  return path;
}

test('runStalenessScan: a clean checkout with an unmodified anchored file produces detectedCount: 0, no findings recorded', async (t) => {
  const repo = usingFixture(t);
  const region = Array.from({ length: 8 }, (_, i) => `clean line ${i + 1}`);
  const dataRev = repo.commitFile('src/clean.ts', block(['ctx 0', ...region, 'tail 0']), 'add clean.ts');
  const artifactPath = writeArtifact(repo, 'report.html', {
    src: 'src/clean.ts#L2-L9',
    rev: dataRev,
    hash: anchorHash(region.join('\n')),
  });
  const findingsStoreFile = new FindingsStoreFile(artifactPath);

  const result = await runStalenessScan(artifactPath, repo.root, findingsStoreFile);

  assert.strictEqual(result.scannedAnchorCount, 1);
  assert.strictEqual(result.eligibleCount, 1);
  assert.strictEqual(result.skippedCount, 0);
  assert.strictEqual(result.detectedCount, 0);
  assert.strictEqual(result.headRevision, dataRev);

  const store = await new FindingsStoreFile(artifactPath).read();
  assert.deepStrictEqual(store.findings, []);
});

test('runStalenessScan: editing the anchored region produces detectedCount: 1 with a finding landed in the sidecar; a later scan after reverting resolves it (never deletes it)', async (t) => {
  const repo = usingFixture(t);
  const region = Array.from({ length: 20 }, (_, i) => `touch line ${i + 1}`);
  const dataRev = repo.commitFile('src/touched.ts', block(['ctx 0', ...region, 'tail 0']), 'add touched.ts');
  const artifactPath = writeArtifact(repo, 'report.html', {
    src: 'src/touched.ts#L2-L21',
    rev: dataRev,
    hash: anchorHash(region.join('\n')),
  });
  const findingsStoreFile = new FindingsStoreFile(artifactPath);

  // Edit two of the twenty region lines in place (~10%) -- the same real
  // fixture this project's own drift.test.ts uses to land 'touched'.
  const editedRegion = [...region];
  editedRegion[9] = 'touch line 10 EDITED';
  editedRegion[14] = 'touch line 15 EDITED';
  repo.commitFile(
    'src/touched.ts',
    block(['ctx 0', ...editedRegion, 'tail 0']),
    'edit two lines inside the region, in place',
  );

  const firstScan = await runStalenessScan(artifactPath, repo.root, findingsStoreFile);
  assert.strictEqual(firstScan.eligibleCount, 1);
  assert.strictEqual(firstScan.skippedCount, 0);
  assert.strictEqual(firstScan.detectedCount, 1, 'the in-place edit must be detected as touched or lost');

  const afterFirstScan = await new FindingsStoreFile(artifactPath).read();
  assert.strictEqual(afterFirstScan.findings.length, 1);
  const finding = afterFirstScan.findings[0]!;
  assert.ok(finding.rule === 'drift-touched' || finding.rule === 'drift-lost');
  assert.strictEqual(finding.status, 'open');
  assert.strictEqual(finding.target.path, 'src/touched.ts');
  assert.deepStrictEqual(finding.target, { path: 'src/touched.ts', startLine: 2, endLine: 21 });

  // A LATER commit fixes the file back to its original content -- a fresh
  // HEAD sha strictly newer than the touched commit, which is what lets
  // recordAbsence (findings-store.ts) actually transition the finding
  // rather than treating this as a same-revision re-check.
  repo.commitFile('src/touched.ts', block(['ctx 0', ...region, 'tail 0']), 'revert to the original content');

  const secondScan = await runStalenessScan(artifactPath, repo.root, findingsStoreFile);
  assert.strictEqual(secondScan.detectedCount, 0, 'the reverted content must classify as unchanged, never re-detected');

  const afterSecondScan = await new FindingsStoreFile(artifactPath).read();
  assert.strictEqual(afterSecondScan.findings.length, 1, 'the finding is never deleted');
  assert.strictEqual(afterSecondScan.findings[0]!.fingerprint, finding.fingerprint);
  assert.strictEqual(afterSecondScan.findings[0]!.status, 'resolved');
});

test('runStalenessScan: inserting 50 unrelated lines above the anchored region relocates silently -- detectedCount: 0 against REAL git history', async (t) => {
  const repo = usingFixture(t);
  const region = Array.from({ length: 10 }, (_, i) => `region line ${i + 1}`);
  const after = ['after line 1', 'after line 2', 'after line 3'];
  const dataRev = repo.commitFile('src/moved.ts', block([...region, ...after]), 'add moved.ts');
  const artifactPath = writeArtifact(repo, 'report.html', {
    src: 'src/moved.ts#L1-L10',
    rev: dataRev,
    hash: anchorHash(region.join('\n')),
  });
  const findingsStoreFile = new FindingsStoreFile(artifactPath);

  const inserted = Array.from({ length: 50 }, (_, i) => `insert line ${i + 1}`);
  repo.commitFile('src/moved.ts', block([...inserted, ...region, ...after]), 'insert 50 unrelated lines above the region');

  const result = await runStalenessScan(artifactPath, repo.root, findingsStoreFile);

  assert.strictEqual(result.eligibleCount, 1);
  assert.strictEqual(result.skippedCount, 0);
  assert.strictEqual(result.detectedCount, 0, 'content-based relocation (STAL-03) must silently absorb the shift');

  const store = await new FindingsStoreFile(artifactPath).read();
  assert.deepStrictEqual(store.findings, [], 'a relocated (moved) anchor must never produce a finding');
});

test('runStalenessScan: a dirty working tree at the cited file produces detectedCount: 0, skippedCount reflects the dirty-tree cannot-determine -- fails open', async (t) => {
  const repo = usingFixture(t);
  const region = Array.from({ length: 8 }, (_, i) => `dirty line ${i + 1}`);
  const dataRev = repo.commitFile('src/dirty.ts', block(['ctx 0', ...region, 'tail 0']), 'add dirty.ts');
  const artifactPath = writeArtifact(repo, 'report.html', {
    src: 'src/dirty.ts#L2-L9',
    rev: dataRev,
    hash: anchorHash(region.join('\n')),
  });
  const findingsStoreFile = new FindingsStoreFile(artifactPath);

  // Uncommitted change at the cited path -- never committed, produces the
  // dirty-working-tree cannot-determine outcome.
  repo.writeDirty('src/dirty.ts', block(['ctx 0', ...region, 'uncommitted change', 'tail 0']));

  const result = await runStalenessScan(artifactPath, repo.root, findingsStoreFile);

  assert.strictEqual(result.eligibleCount, 0);
  assert.strictEqual(result.skippedCount, 1, 'the dirty-tree cannot-determine outcome must be counted as skipped');
  assert.strictEqual(result.detectedCount, 0, 'an in-progress, uncommitted edit must never produce a finding');

  const store = await new FindingsStoreFile(artifactPath).read();
  assert.deepStrictEqual(store.findings, []);
});

test('runStalenessScan: one anchor whose resolver throws is recorded as cannot-determine and the other anchors still scan', async (t) => {
  // usingFixture (not a bare createFixtureRepo + forceRemove) -- this test
  // drives one real resolve() call (src/a.ts), which spawns this fixture's
  // GitBatchPool subprocess via getRepoContext; closing it before teardown
  // is required (see GitBatchPool.close()'s own doc comment), or `rmdir`
  // fights a still-running `git cat-file` process for the whole fixture
  // directory, same as every other runStalenessScan test in this file.
  const repo = usingFixture(t);
  const region = ['alpha 1', 'alpha 2'];
  const rev = repo.commitFile('src/a.ts', `${region.join('\n')}\n`, 'add a');
  const artifactPath = join(repo.root, 'artifact.html');
  writeFileSync(
    artifactPath,
    `<!doctype html><html><body>
<p data-src="src/a.ts#L1-L2" data-rev="${rev}" data-anchor-hash="${anchorHash(region.join('\n'))}">a</p>
<p data-src="src/b.ts#L1-L2" data-rev="${rev}" data-anchor-hash="${anchorHash('never resolved')}">b</p>
</body></html>`,
    'utf8',
  );
  const findingsStoreFile = new FindingsStoreFile(artifactPath);

  const result = await runStalenessScan(artifactPath, repo.root, findingsStoreFile, {
    resolveAnchor: (repoRoot, input, pool) =>
      input?.path === 'src/b.ts' ? Promise.reject(new Error('git exploded')) : resolve(repoRoot, input, pool),
  });

  assert.strictEqual(result.scannedAnchorCount, 2, 'both anchors are counted');
  assert.strictEqual(result.eligibleCount, 1, 'the healthy anchor still resolved');
  assert.strictEqual(result.skippedCount, 1, 'the throwing anchor is skipped, not fatal');
});
