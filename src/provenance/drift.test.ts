import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { createFixtureRepo } from '../../test/fixtures/git-repo.ts';
import type { FixtureRepo } from '../../test/fixtures/git-repo.ts';
import { GitBatchPool } from './git-batch-pool.ts';
import { anchorHash } from './hash.ts';
import { classifyDrift } from './drift.ts';
import type { DriftState } from './types.ts';
import { forceRemove } from '../../test/fixtures/cleanup.ts';
function useRepoAndPool(
  t: import('node:test').TestContext,
  autocrlf: boolean,
): { repo: FixtureRepo; pool: GitBatchPool } {
  const repo = createFixtureRepo(autocrlf);
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
// Exhaustiveness bookkeeping (shared across every test below): a runtime set
// of every state actually observed, checked against the full core-state list
// at the end, PLUS a compile-time `never` proof that the core-state union
// hasn't silently grown without a case being added here. Assigning the
// narrowed OBJECT itself to `never` (not re-reading a `.type`/discriminant
// property off it) is required — TypeScript's strip-only runtime rejects
// enum/namespace, and separately, re-reading a property after the switch has
// already narrowed the whole union to `never` is a compile error, not just a
// style choice.
// ---------------------------------------------------------------------------

type CoreDriftState = Exclude<DriftState, 'refused' | 'no-git' | 'unanchored'>;

const observedStates = new Set<CoreDriftState>();

function recordState(state: DriftState): void {
  if (state === 'refused' || state === 'no-git' || state === 'unanchored') {
    throw new Error(`classifyDrift produced an out-of-scope state for this plan: ${state}`);
  }
  observedStates.add(state);
}

// ---------------------------------------------------------------------------
// Task 1: one test per Four-State Model case this module owns.
// ---------------------------------------------------------------------------

test('unchanged: dataRev === headRev (trivial case)', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const region = Array.from({ length: 6 }, (_, i) => `line ${i + 1}`);
  const dataRev = repo.commitFile('u-trivial.txt', block(region), 'add u-trivial.txt');
  const anchor = {
    path: 'u-trivial.txt',
    startLine: 1,
    endLine: region.length,
    anchorHash: anchorHash(region.join('\n')),
  };

  const result = await classifyDrift(pool, repo.root, anchor, dataRev, dataRev);

  assert.strictEqual(result.state, 'unchanged');
  assert.deepStrictEqual(result.resolvedRange, { startLine: 1, endLine: region.length });
  assert.strictEqual(result.content, region.join('\n'));
  recordState(result.state);
});

test('unchanged: headRev is a later commit that only touched an unrelated part of the file', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const before = ['ctx 1', 'ctx 2'];
  const region = Array.from({ length: 5 }, (_, i) => `region line ${i + 1}`);
  const dataRev = repo.commitFile(
    'u-unrelated.txt',
    block([...before, ...region, 'tail 1']),
    'add u-unrelated.txt',
  );
  const headRev = repo.commitFile(
    'u-unrelated.txt',
    block([...before, ...region, 'tail 1 EDITED']),
    'edit only the unrelated tail line',
  );
  const originalRange = { startLine: before.length + 1, endLine: before.length + region.length };
  const anchor = {
    path: 'u-unrelated.txt',
    startLine: originalRange.startLine,
    endLine: originalRange.endLine,
    anchorHash: anchorHash(region.join('\n')),
  };

  const result = await classifyDrift(pool, repo.root, anchor, dataRev, headRev);

  assert.strictEqual(result.state, 'unchanged');
  assert.deepStrictEqual(result.resolvedRange, originalRange);
  assert.strictEqual(result.content, region.join('\n'));
  recordState(result.state);
});

test('moved (silent): 50 unrelated lines inserted above the anchored region', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const region = Array.from({ length: 10 }, (_, i) => `region line ${i + 1}`);
  const after = ['after line 1', 'after line 2', 'after line 3'];
  const dataRev = repo.commitFile('moved.txt', block([...region, ...after]), 'add moved.txt');
  const inserted = Array.from({ length: 50 }, (_, i) => `insert line ${i + 1}`);
  const headRev = repo.commitFile(
    'moved.txt',
    block([...inserted, ...region, ...after]),
    'insert 50 unrelated lines above the region',
  );
  const anchor = { path: 'moved.txt', startLine: 1, endLine: 10, anchorHash: anchorHash(region.join('\n')) };

  const result = await classifyDrift(pool, repo.root, anchor, dataRev, headRev);

  assert.strictEqual(result.state, 'moved');
  assert.deepStrictEqual(result.resolvedRange, { startLine: 51, endLine: 60 });
  assert.strictEqual(result.content, region.join('\n'));
  recordState(result.state);
});

test('touched: an in-place edit inside the cited region changes ~10% of its lines', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const region = Array.from({ length: 20 }, (_, i) => `touch line ${i + 1}`);
  const dataRev = repo.commitFile('touched.txt', block(['ctx 0', ...region, 'tail 0']), 'add touched.txt');
  const editedRegion = [...region];
  editedRegion[9] = 'touch line 10 EDITED';
  editedRegion[14] = 'touch line 15 EDITED';
  const headRev = repo.commitFile(
    'touched.txt',
    block(['ctx 0', ...editedRegion, 'tail 0']),
    'edit two lines inside the region, in place',
  );
  const anchor = { path: 'touched.txt', startLine: 2, endLine: 21, anchorHash: anchorHash(region.join('\n')) };

  const result = await classifyDrift(pool, repo.root, anchor, dataRev, headRev);

  assert.strictEqual(result.state, 'touched');
  assert.deepStrictEqual(result.resolvedRange, { startLine: 2, endLine: 21 });
  assert.strictEqual(result.content, editedRegion.join('\n'));
  recordState(result.state);
});

test('lost: the cited content is replaced entirely with unrelated text, file still exists', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
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
  const anchor = { path: 'lost.txt', startLine: 3, endLine: 12, anchorHash: anchorHash(region.join('\n')) };

  const result = await classifyDrift(pool, repo.root, anchor, dataRev, headRev);

  assert.strictEqual(result.state, 'lost');
  assert.strictEqual(result.resolvedRange, null);
  assert.strictEqual(result.content, null);
  recordState(result.state);
});

test('lost: the file is deleted between dataRev and headRev, with no rename signal', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const region = Array.from({ length: 6 }, (_, i) => `gone line ${i + 1}`);
  const dataRev = repo.commitFile('deleted.txt', block(region), 'add deleted.txt');
  const headRev = repo.deleteFile('deleted.txt', 'delete deleted.txt');
  const anchor = {
    path: 'deleted.txt',
    startLine: 1,
    endLine: region.length,
    anchorHash: anchorHash(region.join('\n')),
  };

  const result = await classifyDrift(pool, repo.root, anchor, dataRev, headRev);

  assert.strictEqual(result.state, 'lost');
  assert.strictEqual(result.resolvedRange, null);
  assert.strictEqual(result.content, null);
  recordState(result.state);
});

test('moved: an unambiguous rename (git mv), content otherwise unchanged at the new path', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const region = Array.from({ length: 6 }, (_, i) => `stable line ${i + 1}`);
  const dataRev = repo.commitFile('old-name.txt', block(region), 'add old-name.txt');
  const headRev = repo.renameFile('old-name.txt', 'new-name.txt', 'rename old-name.txt to new-name.txt');
  const anchor = {
    path: 'old-name.txt',
    startLine: 1,
    endLine: region.length,
    anchorHash: anchorHash(region.join('\n')),
  };

  const result = await classifyDrift(pool, repo.root, anchor, dataRev, headRev);

  assert.strictEqual(result.state, 'moved');
  assert.deepStrictEqual(result.resolvedRange, { startLine: 1, endLine: region.length });
  assert.strictEqual(result.content, region.join('\n'));
  recordState(result.state);
});

// Reuses the exact ambiguous-rename construction git-meta.test.ts documents
// as EMPIRICALLY UNREACHABLE on this machine's git (2.53.0.windows.1): a
// two-tree `git diff --name-status` cannot emit two `R` lines sharing one
// destination — diffcore-rename performs a proper 1:1 match, so the "loser"
// is always reported as a plain `D`, never a second `R`. Per this plan's own
// instruction ("if you cannot build a fixture that reaches it, assert the
// real observed outcome... do NOT fabricate a passing test"), this test
// asserts the two REAL, deterministic per-file outcomes instead of a
// fabricated `cannot-determine`. `classifyMissingAtHead`'s `ambiguous` branch
// (mapping to `cannot-determine`) is implemented to spec in drift.ts but is
// not exercised by any test in this suite — documented in the SUMMARY as a
// Known Limitation, matching Plan 04's precedent for the same structural gap
// in `detectRename` itself.
test('ambiguous-rename construction (documented limitation — see comment above): real per-file outcomes, never a fabricated cannot-determine', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const commonLines = Array.from({ length: 18 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');

  repo.commitFile('fileX.ts', `// fileX specific header\n${commonLines}\n// fileX tail\n`, 'add fileX.ts');
  const rev = repo.commitFile(
    'fileY.ts',
    `// fileY specific header\n${commonLines}\n// fileY tail\n`,
    'add fileY.ts',
  );
  execFileSync('git', ['rm', '-q', 'fileX.ts', 'fileY.ts'], { cwd: repo.root });
  const headRev = repo.commitFile(
    'fileZ.ts',
    `// fileZ specific header\n${commonLines}\n// fileZ tail\n`,
    'delete fileX.ts and fileY.ts, add fileZ.ts',
  );

  // fileX.ts: the deterministic winner — detectRename resolves "single",
  // so the same whole-file range is compared at fileZ.ts. Header/tail text
  // differs, so the hash mismatches at that position: a confident "touched",
  // never a silent "unchanged" that would hide the wording change.
  const fileXAnchor = {
    path: 'fileX.ts',
    startLine: 1,
    endLine: 20,
    anchorHash: anchorHash(`// fileX specific header\n${commonLines}\n// fileX tail`),
  };
  const fileXResult = await classifyDrift(pool, repo.root, fileXAnchor, rev, headRev);
  assert.strictEqual(fileXResult.state, 'touched');

  // fileY.ts: the "loser" — no R line is emitted for it at all, so
  // detectRename reports "none" and classifyDrift honestly reports "lost",
  // never a silently-wrong "moved".
  const fileYAnchor = {
    path: 'fileY.ts',
    startLine: 1,
    endLine: 20,
    anchorHash: anchorHash(`// fileY specific header\n${commonLines}\n// fileY tail`),
  };
  const fileYResult = await classifyDrift(pool, repo.root, fileYAnchor, rev, headRev);
  assert.strictEqual(fileYResult.state, 'lost');

  recordState(fileXResult.state);
  recordState(fileYResult.state);
});

// The ambiguous-rename construction above (per its own comment) cannot reach
// `cannot-determine` on this machine's git — this test reaches the SAME
// state through a different, equally real code path instead of fabricating
// a pass: a whole-file anchor (`#Lx-Ly` absent, `startLine`/`endLine` both
// `null`) whose cited path never existed at `dataRev` at all.
// `resolveOriginalRange` cannot establish even a whole-file range to reason
// about in that case, so this is honestly `cannot-determine` — never a
// guessed `lost`, since a "lost" verdict implies the classifier knows there
// WAS content to lose, which it does not here.
test('cannot-determine: a whole-file anchor whose path never existed at dataRev at all', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const dataRev = repo.commitFile('present.txt', block(['irrelevant content']), 'add present.txt');
  const headRev = repo.commitFile('present.txt', block(['irrelevant content', 'more']), 'unrelated later commit');
  const anchor = {
    path: 'never-existed.txt',
    startLine: null,
    endLine: null,
    anchorHash: anchorHash('does not matter'),
  };

  const result = await classifyDrift(pool, repo.root, anchor, dataRev, headRev);

  assert.strictEqual(result.state, 'cannot-determine');
  assert.strictEqual(result.resolvedRange, null);
  assert.strictEqual(result.content, null);
  recordState(result.state);
});

test('out-of-bounds: the file shrinks below the anchor\'s original endLine — bound-checked before any slice, never throws', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const prefix = ['ctx 1', 'ctx 2'];
  const region = Array.from({ length: 10 }, (_, i) => `oob line ${i + 1}`);
  const tail = ['tail 1', 'tail 2', 'tail 3'];
  const dataRev = repo.commitFile('oob.txt', block([...prefix, ...region, ...tail]), 'add oob.txt');
  const headRev = repo.commitFile(
    'oob.txt',
    block(tail),
    'delete the prefix and the whole cited region, keep only the tail',
  );
  const anchor = { path: 'oob.txt', startLine: 3, endLine: 12, anchorHash: anchorHash(region.join('\n')) };

  const result = await classifyDrift(pool, repo.root, anchor, dataRev, headRev);

  // Deterministic for this construction: the shrunk file (3 lines) is
  // smaller than Stage B's minimum candidate window (8 lines for a 10-line
  // region), so no relocatable candidate scores at all — "lost", not
  // "touched". A different construction (a same-sized remnant elsewhere)
  // would legitimately score "touched" instead; either is a valid, honest
  // answer per this plan's spec — what must never happen is a thrown
  // exception or a silent "unchanged"/"moved".
  assert.strictEqual(result.state, 'lost');
  assert.strictEqual(result.resolvedRange, null);
  assert.strictEqual(result.content, null);
  recordState(result.state);
});

test('ANCH-06 proof (1/2): a clean CRLF checkout (core.autocrlf=true, no modifications) classifies unchanged', async (t) => {
  const { repo, pool } = useRepoAndPool(t, true);
  const region = ['function greet() {', '  return "hi";', '}'];
  const dataRev = repo.commitFile('crlf-clean.js', block(region), 'add crlf-clean.js', { crlf: true });
  const anchor = {
    path: 'crlf-clean.js',
    startLine: 1,
    endLine: region.length,
    anchorHash: anchorHash(region.join('\n')),
  };

  const result = await classifyDrift(pool, repo.root, anchor, dataRev, dataRev);

  assert.strictEqual(result.state, 'unchanged');
  recordState(result.state);
});

// The literal ROADMAP success criterion: "`prettier --write` across the repo
// produces zero 'changed' classifications." Constructed with ONLY line-ending
// normalization (CRLF -> LF) and trailing-whitespace removal — both within
// hash.ts's A1 normalization boundary — and NO wording/indentation change
// anywhere, which would fall OUTSIDE that boundary and should still drift.
// `autocrlf: false` at repo creation is deliberate: it preserves the exact
// CRLF bytes this test authors at `dataRev` in the stored blob itself
// (autocrlf=true would have git's own clean filter silently convert them to
// LF on commit, masking the very thing under test).
test('ANCH-06 proof (2/2): line-ending normalization + trailing-whitespace strip, no wording change, classifies unchanged', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);
  const original = ['function greet(name) {   ', '\tconsole.log("hi " + name);  ', '}'];
  const messyContent = original.join('\r\n') + '\r\n';
  const dataRev = repo.commitFile('reformat.js', messyContent, 'add reformat.js');
  const cleanedContent = original.map((l) => l.replace(/[ \t]+$/, '')).join('\n') + '\n';
  const headRev = repo.commitFile(
    'reformat.js',
    cleanedContent,
    'reformat: strip trailing whitespace, normalize to LF',
  );
  const anchor = {
    path: 'reformat.js',
    startLine: 1,
    endLine: original.length,
    anchorHash: anchorHash(messyContent),
  };

  const result = await classifyDrift(pool, repo.root, anchor, dataRev, headRev);

  assert.strictEqual(result.state, 'unchanged');
  recordState(result.state);
});

// Task 3 (REFACTOR): the closest this plan gets to the ROADMAP's literal
// "`prettier --write` across the repo" wording without pulling in an actual
// `prettier` dependency (would violate the zero-new-npm-dependency
// constraint) — a hand-constructed multi-file reformat (line-ending
// normalization + trailing-whitespace strip, no wording change anywhere,
// same A1-boundary construction as the single-region proof above) exercised
// at the scale the success criterion describes: 4 anchored regions across 3
// files, all classified in one pass, none of them the single region Task 1
// already covered.
test('multi-file reformat regression: every anchor across 3 files classifies unchanged after a repo-wide reformat', async (t) => {
  const { repo, pool } = useRepoAndPool(t, false);

  const messyBlock = (lines: readonly string[]): string => lines.join('\r\n') + '\r\n';
  const cleanBlock = (lines: readonly string[]): string =>
    lines.map((l) => l.replace(/[ \t]+$/, '')).join('\n') + '\n';

  const aLines = [
    'export function a1() {   ',
    '  return 1;\t',
    '}',
    'export function a2() {  ',
    '  return 2;   ',
    '}',
  ];
  const bLines = ['export const b = {  ', '  value: 42,\t', '};'];
  const cLines = ['export const c = [  ', '  1, 2, 3,\t', '];'];

  repo.commitFile('multi/a.ts', messyBlock(aLines), 'add multi/a.ts (messy)');
  repo.commitFile('multi/b.ts', messyBlock(bLines), 'add multi/b.ts (messy)');
  const dataRev = repo.commitFile('multi/c.ts', messyBlock(cLines), 'add multi/c.ts (messy)');

  repo.commitFile('multi/a.ts', cleanBlock(aLines), 'reformat multi/a.ts');
  repo.commitFile('multi/b.ts', cleanBlock(bLines), 'reformat multi/b.ts');
  const headRev = repo.commitFile('multi/c.ts', cleanBlock(cLines), 'reformat multi/c.ts');

  const anchors = [
    { path: 'multi/a.ts', startLine: 1, endLine: 3, anchorHash: anchorHash(aLines.slice(0, 3).join('\r\n')) },
    { path: 'multi/a.ts', startLine: 4, endLine: 6, anchorHash: anchorHash(aLines.slice(3, 6).join('\r\n')) },
    { path: 'multi/b.ts', startLine: 1, endLine: 3, anchorHash: anchorHash(bLines.join('\r\n')) },
    { path: 'multi/c.ts', startLine: 1, endLine: 3, anchorHash: anchorHash(cLines.join('\r\n')) },
  ];

  for (const anchor of anchors) {
    const result = await classifyDrift(pool, repo.root, anchor, dataRev, headRev);
    assert.strictEqual(
      result.state,
      'unchanged',
      `expected unchanged for ${anchor.path}#L${String(anchor.startLine)}-L${String(anchor.endLine)}, got ${result.state}`,
    );
    recordState(result.state);
  }
});

// ---------------------------------------------------------------------------
// Exhaustiveness: every core DriftState value this module can produce
// (unchanged/moved/touched/lost/cannot-determine) is exercised by at least
// one test above.
// ---------------------------------------------------------------------------

test('exhaustiveness: every core DriftState value is produced by at least one case above', () => {
  const required: readonly CoreDriftState[] = ['unchanged', 'moved', 'touched', 'lost', 'cannot-determine'];
  const missing = required.filter((state) => !observedStates.has(state));
  assert.deepStrictEqual(missing, [], `no test case produced state(s): ${missing.join(', ')}`);

  // Compile-time exhaustiveness: if `DriftState` ever grows a NEW core value
  // without a `case` being added here, `state` in the `default` branch stops
  // being `never` and this file fails to typecheck. Assign the whole
  // narrowed value to `never` directly — re-reading a discriminant property
  // off it after the switch has already narrowed the object itself is a
  // compile error (TS narrows the OBJECT, not a fresh property read).
  for (const state of observedStates) {
    switch (state) {
      case 'unchanged':
      case 'moved':
      case 'touched':
      case 'lost':
      case 'cannot-determine':
        break;
      default: {
        const exhaustive: never = state;
        throw new Error(`unhandled core DriftState: ${String(exhaustive)}`);
      }
    }
  }
});
