import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateDir } from '../../src/daemon/state-dir.ts';
import { annotationStorePathFor } from '../../src/store/annotation-store.ts';
import {
  FINDINGS_PROTOCOL_VERSION,
  emptyFindingsStore,
  findingsStorePathFor,
  findingFingerprint,
  readFindingsStore,
  recordDetection,
  recordAbsence,
  dismissFinding,
  applyScanObservations,
  FindingsStoreFile,
} from '../../src/store/findings-store.ts';
import type { FindingTarget, FindingsStore, RecordObservation, ScanObservation } from '../../src/store/findings-store.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-findings-store-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

function makeTarget(overrides: Partial<FindingTarget> = {}): FindingTarget {
  return {
    path: 'src/x.ts',
    startLine: 10,
    endLine: 20,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Task 1: types, fingerprint scheme, path derivation, emptyFindingsStore,
// readFindingsStore
// ---------------------------------------------------------------------------

test('emptyFindingsStore returns the protocol tag and zero findings', () => {
  const store = emptyFindingsStore();
  assert.strictEqual(store.protocol, FINDINGS_PROTOCOL_VERSION);
  assert.deepStrictEqual(store.findings, []);
});

// The sidecar split: findings are DERIVED, so they live in the state dir.
// The annotation store stays beside the artifact because it holds the user's
// own irreproducible cards. These tests pin both halves of that decision.
test('findingsStorePathFor puts findings in the state dir, never beside the artifact', () => {
  const p = findingsStorePathFor('/repo/roadmap.html');
  assert.ok(p.startsWith(stateDir()), `expected a state-dir path, got ${p}`);
  assert.ok(!p.includes('roadmap.html'), 'the artifact path must not leak into the findings filename');
  assert.match(p, /[/\\]findings[/\\][0-9a-f]{16}\.json$/);
});

test('findingsStorePathFor is case-insensitive, so one artifact never keys two findings files on NTFS', () => {
  assert.strictEqual(
    findingsStorePathFor(String.raw`C:\Repo\Roadmap.html`),
    findingsStorePathFor(String.raw`c:\repo\roadmap.html`),
  );
});

test('findingsStorePathFor keys on the artifact FILE, so two artifacts in one directory keep separate findings', () => {
  assert.notStrictEqual(
    findingsStorePathFor('/repo/a.html'),
    findingsStorePathFor('/repo/b.html'),
  );
});

test('the annotation store still travels WITH the artifact -- the other half of the split', () => {
  assert.strictEqual(annotationStorePathFor('/repo/roadmap.html'), '/repo/roadmap.html.illum.json');
  assert.ok(!annotationStorePathFor('/repo/roadmap.html').startsWith(stateDir()));
});

test('findingFingerprint is a 16-hex-char string, deterministic across calls with identical inputs', () => {
  const target = makeTarget();
  const first = findingFingerprint('drift-touched', target);
  const second = findingFingerprint('drift-touched', target);
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.strictEqual(first, second);
});

test('findingFingerprint differs when rule differs (same target)', () => {
  const target = makeTarget();
  const touched = findingFingerprint('drift-touched', target);
  const lost = findingFingerprint('drift-lost', target);
  assert.notStrictEqual(touched, lost);
});

test('findingFingerprint differs when target.path differs (same rule/range)', () => {
  const a = findingFingerprint('drift-touched', makeTarget({ path: 'src/x.ts' }));
  const b = findingFingerprint('drift-touched', makeTarget({ path: 'src/y.ts' }));
  assert.notStrictEqual(a, b);
});

test('findingFingerprint differs when startLine/endLine differ (same rule/path)', () => {
  const a = findingFingerprint('drift-touched', makeTarget({ startLine: 10, endLine: 20 }));
  const b = findingFingerprint('drift-touched', makeTarget({ startLine: 11, endLine: 20 }));
  assert.notStrictEqual(a, b);
});

test('findingFingerprint for a whole-file target (startLine/endLine both null) differs from the same rule/path WITH a range', () => {
  const wholeFile = findingFingerprint('drift-lost', makeTarget({ path: 'src/x.ts', startLine: null, endLine: null }));
  const ranged = findingFingerprint('drift-lost', makeTarget({ path: 'src/x.ts', startLine: 10, endLine: 20 }));
  assert.notStrictEqual(wholeFile, ranged);
});

test('readFindingsStore on a path that does not exist (ENOENT) resolves to emptyFindingsStore, never throws', async () => {
  const store = await readFindingsStore('/definitely/does/not/exist.illum-findings.json', () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return Promise.reject(err);
  });
  assert.deepStrictEqual(store, emptyFindingsStore());
});

test('readFindingsStore on a path containing valid JSON returns it parsed as-is', async () => {
  const fixture = { protocol: FINDINGS_PROTOCOL_VERSION, findings: [] };
  const store = await readFindingsStore('/fake/path.illum-findings.json', () => Promise.resolve(JSON.stringify(fixture)));
  assert.deepStrictEqual(store, fixture);
});

test('readFindingsStore rethrows any error other than ENOENT', async () => {
  const boom: NodeJS.ErrnoException = Object.assign(new Error('boom'), { code: 'EACCES' });
  await assert.rejects(
    readFindingsStore('/fake/path.illum-findings.json', () => Promise.reject(boom)),
    /boom/,
  );
});

// ---------------------------------------------------------------------------
// Task 2: recordDetection / recordAbsence / dismissFinding reducers
// ---------------------------------------------------------------------------

function makeObservation(overrides: Partial<RecordObservation> = {}): RecordObservation {
  return {
    rule: 'drift-touched',
    target: makeTarget(),
    revision: 'rev-1',
    at: '2026-09-11T00:00:00.000Z',
    ...overrides,
  };
}

test('recordDetection on an empty store creates exactly one open Finding with a single detected history entry', () => {
  const obs = makeObservation();
  const store = recordDetection(emptyFindingsStore(), obs);

  assert.strictEqual(store.findings.length, 1);
  const finding = store.findings[0];
  assert.ok(finding);
  assert.strictEqual(finding.status, 'open');
  assert.deepStrictEqual(finding.history, [{ at: obs.at, revision: obs.revision, event: 'detected' }]);
  assert.strictEqual(finding.firstSeenRevision, obs.revision);
  assert.strictEqual(finding.lastSeenRevision, obs.revision);
});

test('recordDetection called again with the SAME fingerprint and SAME revision returns the store UNCHANGED (reference equality)', () => {
  const obs = makeObservation();
  const afterFirst = recordDetection(emptyFindingsStore(), obs);
  const afterSecond = recordDetection(afterFirst, obs);

  assert.strictEqual(afterSecond, afterFirst, 'idempotent same-revision re-check returns the identical store reference');
});

test('recordDetection called again with the SAME fingerprint and a NEWER revision updates lastSeenAt/lastSeenRevision, still one Finding, no new history entry', () => {
  const obs = makeObservation({ revision: 'rev-1' });
  const afterFirst = recordDetection(emptyFindingsStore(), obs);
  const historyLengthAfterFirst = afterFirst.findings[0]?.history.length;

  const newerObs = makeObservation({ revision: 'rev-2', at: '2026-09-12T00:00:00.000Z' });
  const afterThird = recordDetection(afterFirst, newerObs);

  assert.strictEqual(afterThird.findings.length, 1, 'still exactly one Finding');
  const finding = afterThird.findings[0];
  assert.ok(finding);
  assert.strictEqual(finding.lastSeenRevision, 'rev-2');
  assert.strictEqual(finding.lastSeenAt, '2026-09-12T00:00:00.000Z');
  assert.strictEqual(finding.history.length, historyLengthAfterFirst, 'no new history entry appended');
});

test('recordAbsence on a store with an OPEN finding, called with a NEWER revision, resolves it and appends a resolved history entry', () => {
  const detected = recordDetection(emptyFindingsStore(), makeObservation({ revision: 'rev-1' }));
  const absence = makeObservation({ revision: 'rev-2', at: '2026-09-12T00:00:00.000Z' });
  const resolved = recordAbsence(detected, absence);

  const finding = resolved.findings[0];
  assert.ok(finding);
  assert.strictEqual(finding.status, 'resolved');
  assert.deepStrictEqual(finding.history.at(-1), { at: absence.at, revision: absence.revision, event: 'resolved' });
});

test('recordAbsence on a store with NO Finding for that fingerprint returns the store UNCHANGED (reference equality)', () => {
  const empty = emptyFindingsStore();
  const result = recordAbsence(empty, makeObservation());
  assert.strictEqual(result, empty);
});

test('recordAbsence on a store whose Finding is already resolved returns the store UNCHANGED', () => {
  const detected = recordDetection(emptyFindingsStore(), makeObservation({ revision: 'rev-1' }));
  const resolved = recordAbsence(detected, makeObservation({ revision: 'rev-2' }));
  const resolvedAgain = recordAbsence(resolved, makeObservation({ revision: 'rev-3' }));
  assert.strictEqual(resolvedAgain, resolved);
});

test('recordAbsence on a store whose Finding is already dismissed returns the store UNCHANGED', () => {
  const detected = recordDetection(emptyFindingsStore(), makeObservation({ revision: 'rev-1' }));
  const fingerprint = detected.findings[0]?.fingerprint;
  assert.ok(fingerprint);
  const dismissed = dismissFinding(detected, fingerprint);
  const afterAbsence = recordAbsence(dismissed, makeObservation({ revision: 'rev-2' }));
  assert.strictEqual(afterAbsence, dismissed);
});

test('dismissFinding on an open Finding sets status dismissed, dismissedAtRevision to lastSeenRevision, and appends a dismissed history entry', () => {
  const detected = recordDetection(emptyFindingsStore(), makeObservation({ revision: 'rev-1' }));
  const fingerprint = detected.findings[0]?.fingerprint;
  assert.ok(fingerprint);

  const dismissed = dismissFinding(detected, fingerprint);
  const finding = dismissed.findings[0];
  assert.ok(finding);
  assert.strictEqual(finding.status, 'dismissed');
  assert.strictEqual(finding.dismissedAtRevision, 'rev-1');
  assert.strictEqual(finding.history.at(-1)?.event, 'dismissed');
});

test('dismissFinding on an unknown fingerprint returns the store UNCHANGED', () => {
  const empty = emptyFindingsStore();
  const result = dismissFinding(empty, 'nonexistent-fingerprint');
  assert.strictEqual(result, empty);
});

test('recordDetection called again at the SAME revision as a just-dismissed Finding dismissedAtRevision returns the store UNCHANGED (stays dismissed)', () => {
  const detected = recordDetection(emptyFindingsStore(), makeObservation({ revision: 'rev-1' }));
  const fingerprint = detected.findings[0]?.fingerprint;
  assert.ok(fingerprint);
  const dismissed = dismissFinding(detected, fingerprint);

  const sameRevisionAgain = recordDetection(dismissed, makeObservation({ revision: 'rev-1' }));
  assert.strictEqual(sameRevisionAgain, dismissed, 'stays dismissed, no reopen at the dismissed revision');
});

test('recordDetection called again at a NEWER revision than a dismissed Finding dismissedAtRevision reopens it', () => {
  const detected = recordDetection(emptyFindingsStore(), makeObservation({ revision: 'rev-1' }));
  const fingerprint = detected.findings[0]?.fingerprint;
  assert.ok(fingerprint);
  const dismissed = dismissFinding(detected, fingerprint);

  const reopened = recordDetection(dismissed, makeObservation({ revision: 'rev-2', at: '2026-09-13T00:00:00.000Z' }));
  const finding = reopened.findings[0];
  assert.ok(finding);
  assert.strictEqual(finding.status, 'open');
  assert.strictEqual(finding.dismissedAtRevision, null);
  assert.strictEqual(finding.history.at(-1)?.event, 'reopened');
});

test('recordDetection re-detecting a RESOLVED Finding at any revision reopens it identically to the dismissed case', () => {
  const detected = recordDetection(emptyFindingsStore(), makeObservation({ revision: 'rev-1' }));
  const resolved = recordAbsence(detected, makeObservation({ revision: 'rev-2' }));

  const reopened = recordDetection(resolved, makeObservation({ revision: 'rev-3', at: '2026-09-14T00:00:00.000Z' }));
  const finding = reopened.findings[0];
  assert.ok(finding);
  assert.strictEqual(finding.status, 'open');
  assert.strictEqual(finding.dismissedAtRevision, null);
  assert.strictEqual(finding.history.at(-1)?.event, 'reopened');
});

test('across every reducer call combination, store.findings.length never changes from calling ANY of the three reducers', () => {
  let store: FindingsStore = recordDetection(emptyFindingsStore(), makeObservation({ revision: 'rev-1' }));
  assert.strictEqual(store.findings.length, 1);
  const fingerprint = store.findings[0]?.fingerprint;
  assert.ok(fingerprint);

  // idempotent same-revision detection
  store = recordDetection(store, makeObservation({ revision: 'rev-1' }));
  assert.strictEqual(store.findings.length, 1);

  // newer-revision detection (still open)
  store = recordDetection(store, makeObservation({ revision: 'rev-2', at: '2026-09-12T00:00:00.000Z' }));
  assert.strictEqual(store.findings.length, 1);

  // absence on a store with no matching finding -- unrelated fingerprint
  store = recordAbsence(store, makeObservation({ target: makeTarget({ path: 'src/unrelated.ts' }) }));
  assert.strictEqual(store.findings.length, 1);

  // resolve
  store = recordAbsence(store, makeObservation({ revision: 'rev-3', at: '2026-09-13T00:00:00.000Z' }));
  assert.strictEqual(store.findings.length, 1);
  assert.strictEqual(store.findings[0]?.status, 'resolved');

  // reopen via re-detection
  store = recordDetection(store, makeObservation({ revision: 'rev-4', at: '2026-09-14T00:00:00.000Z' }));
  assert.strictEqual(store.findings.length, 1);
  assert.strictEqual(store.findings[0]?.status, 'open');

  // dismiss
  store = dismissFinding(store, fingerprint);
  assert.strictEqual(store.findings.length, 1);
  assert.strictEqual(store.findings[0]?.status, 'dismissed');

  // dismiss again (idempotent no-op)
  store = dismissFinding(store, fingerprint);
  assert.strictEqual(store.findings.length, 1);

  // dismiss unknown fingerprint (no-op)
  store = dismissFinding(store, 'unknown');
  assert.strictEqual(store.findings.length, 1);

  // reopen via re-detection at a newer revision
  store = recordDetection(store, makeObservation({ revision: 'rev-5', at: '2026-09-15T00:00:00.000Z' }));
  assert.strictEqual(store.findings.length, 1);
  assert.strictEqual(store.findings[0]?.status, 'open');
});

// ---------------------------------------------------------------------------
// Task 3: applyScanObservations batching + FindingsStoreFile durable wrapper
// ---------------------------------------------------------------------------

function makeScanObservation(overrides: Partial<ScanObservation> = {}): ScanObservation {
  return {
    rule: 'drift-touched',
    target: makeTarget(),
    outcome: 'detected',
    revision: 'rev-1',
    at: '2026-09-11T00:00:00.000Z',
    ...overrides,
  };
}

test('applyScanObservations against a mixed array (detected + absent) produces the same end state as calling the reducers manually in sequence', () => {
  const touchedTarget = makeTarget({ path: 'src/touched.ts' });
  const lostTarget = makeTarget({ path: 'src/lost.ts', startLine: null, endLine: null });

  const manual = recordAbsence(
    recordDetection(
      recordDetection(emptyFindingsStore(), { rule: 'drift-touched', target: touchedTarget, revision: 'rev-1', at: 'a1' }),
      { rule: 'drift-lost', target: lostTarget, revision: 'rev-1', at: 'a2' },
    ),
    { rule: 'drift-touched', target: touchedTarget, revision: 'rev-2', at: 'a3' },
  );

  const batched = applyScanObservations(emptyFindingsStore(), [
    makeScanObservation({ rule: 'drift-touched', target: touchedTarget, outcome: 'detected', revision: 'rev-1', at: 'a1' }),
    makeScanObservation({ rule: 'drift-lost', target: lostTarget, outcome: 'detected', revision: 'rev-1', at: 'a2' }),
    makeScanObservation({ rule: 'drift-touched', target: touchedTarget, outcome: 'absent', revision: 'rev-2', at: 'a3' }),
  ]);

  assert.deepStrictEqual(batched, manual);
});

test('FindingsStoreFile.mutate performs a real round-trip write+read against the filesystem', async () => {
  await withTempDir(async (dir) => {
    const artifactPath = join(dir, 'artifact.html');
    const storeFile = new FindingsStoreFile(artifactPath);

    await storeFile.mutate((store) => ({
      next: applyScanObservations(store, [makeScanObservation()]),
      result: undefined,
    }));

    const after = await storeFile.read();
    assert.strictEqual(after.findings.length, 1);
    assert.strictEqual(after.findings[0]?.status, 'open');
  });
});

test('two concurrent mutate() calls on the SAME FindingsStoreFile instance, each recording a DIFFERENT finding, both land', async () => {
  await withTempDir(async (dir) => {
    const artifactPath = join(dir, 'artifact-concurrent.html');
    const storeFile = new FindingsStoreFile(artifactPath);

    const targetA = makeTarget({ path: 'src/a.ts' });
    const targetB = makeTarget({ path: 'src/b.ts' });

    const applyA = (store: FindingsStore) => ({
      next: applyScanObservations(store, [makeScanObservation({ target: targetA })]),
      result: undefined,
    });
    const applyB = (store: FindingsStore) => ({
      next: applyScanObservations(store, [makeScanObservation({ target: targetB })]),
      result: undefined,
    });

    await Promise.all([storeFile.mutate(applyA), storeFile.mutate(applyB)]);

    const after = await storeFile.read();
    assert.strictEqual(after.findings.length, 2, 'neither concurrent append was lost -- the mutex serialized the two read-modify-writes');
    const paths = after.findings.map((f) => f.target.path);
    assert.ok(paths.includes('src/a.ts'));
    assert.ok(paths.includes('src/b.ts'));
  });
});

test('25 concurrent mutate() calls each recording one uniquely-identified finding all land -- no lost update under real concurrency', async () => {
  await withTempDir(async (dir) => {
    const artifactPath = join(dir, 'artifact-25.html');
    const storeFile = new FindingsStoreFile(artifactPath);

    const calls = Array.from({ length: 25 }, (_, i) =>
      storeFile.mutate((store: FindingsStore) => ({
        next: applyScanObservations(store, [
          makeScanObservation({ target: makeTarget({ path: `src/file-${String(i)}.ts` }) }),
        ]),
        result: undefined,
      })),
    );
    await Promise.all(calls);

    const after = await storeFile.read();
    assert.strictEqual(after.findings.length, 25, 'no update was lost to a race');
    const paths = after.findings.map((f) => f.target.path);
    for (let i = 0; i < 25; i++) {
      assert.ok(paths.includes(`src/file-${String(i)}.ts`), `src/file-${String(i)}.ts present`);
    }
  });
});
