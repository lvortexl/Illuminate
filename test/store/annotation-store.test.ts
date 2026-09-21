import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANNOTATION_PROTOCOL_VERSION,
  emptyAnnotationStore,
  annotationStorePathFor,
  readAnnotationStore,
  snapshotFromDispatchElement,
  appendCardEntry,
  applyReattachment,
  AnnotationStoreFile,
} from '../../src/store/annotation-store.ts';
import type { Card, CardThreadEntry } from '../../src/store/annotation-store.ts';
import type { ElementSnapshot, OrphanRecord } from '../../src/provenance/identity.ts';
import type { DispatchElement, DispatchSource } from '../../src/router/types.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

function makeDispatchElement(overrides: Partial<DispatchElement> = {}): DispatchElement {
  return {
    uid: 'e1',
    selector: 'body>p:nth-child(1)',
    tag: 'p',
    text: 'element text',
    prefixContext: null,
    suffixContext: null,
    ...overrides,
  };
}

function makeDispatchSource(overrides: Partial<DispatchSource> = {}): DispatchSource {
  return {
    path: 'src/a.ts',
    rev: 'abc123',
    range: { startLine: 1, endLine: 5 },
    status: 'unchanged',
    content: 'const x = 1;',
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<ElementSnapshot> = {}): ElementSnapshot {
  return {
    elementUid: null,
    anchor: null,
    textContent: 'default text',
    prefixContext: null,
    suffixContext: null,
    structuralPath: 'body>div:nth-child(1)',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<CardThreadEntry> = {}): CardThreadEntry {
  return {
    dispatchId: 'd1',
    intent: 'explain',
    depth: 1,
    parentDispatchId: null,
    learnerNote: null,
    markdown: 'answer markdown',
    verdict: null,
    decidingLines: null,
    model: 'claude-haiku',
    tier: 'haiku',
    source: null,
    answeredAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeOrphan(overrides: Partial<OrphanRecord> = {}): OrphanRecord {
  return {
    element: makeSnapshot(),
    firstMissRevision: 'rev-1',
    lastMissRevision: 'rev-1',
    confirmedOrphan: false,
    ...overrides,
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-annotation-store-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

// ---------------------------------------------------------------------------
// Task 1: types, path derivation, snapshot construction, readAnnotationStore
// ---------------------------------------------------------------------------

test('emptyAnnotationStore returns the protocol tag and zero cards', () => {
  const store = emptyAnnotationStore();
  assert.strictEqual(store.protocol, ANNOTATION_PROTOCOL_VERSION);
  assert.deepStrictEqual(store.cards, []);
});

test('annotationStorePathFor appends .illum.json as a plain string suffix, no hashing', () => {
  assert.strictEqual(annotationStorePathFor('/repo/roadmap.html'), '/repo/roadmap.html.illum.json');
});

test('readAnnotationStore on a path that does not exist (ENOENT) resolves to emptyAnnotationStore, never throws', async () => {
  await withTempDir(async (dir) => {
    const missing = join(dir, 'nope.illum.json');
    const store = await readAnnotationStore(missing);
    assert.deepStrictEqual(store, emptyAnnotationStore());
  });
});

test('readAnnotationStore on a path containing valid JSON returns it parsed as-is', async () => {
  const fixture = { protocol: ANNOTATION_PROTOCOL_VERSION, cards: [] };
  const store = await readAnnotationStore('/fake/path.illum.json', async () => JSON.stringify(fixture));
  assert.deepStrictEqual(store, fixture);
});

test('readAnnotationStore rethrows any error other than ENOENT', async () => {
  const boom: NodeJS.ErrnoException = Object.assign(new Error('boom'), { code: 'EACCES' });
  await assert.rejects(
    readAnnotationStore('/fake/path.illum.json', () => Promise.reject(boom)),
    /boom/,
  );
});

test('snapshotFromDispatchElement (unanchored): anchor is null, textContent/context/structuralPath map from the element', () => {
  const element = makeDispatchElement({
    text: 'hello world',
    prefixContext: 'before-text',
    suffixContext: 'after-text',
    selector: 'body>p:nth-child(2)',
  });
  const snapshot = snapshotFromDispatchElement(element, null);
  assert.deepStrictEqual(snapshot, {
    elementUid: null,
    anchor: null,
    textContent: 'hello world',
    prefixContext: 'before-text',
    suffixContext: 'after-text',
    structuralPath: 'body>p:nth-child(2)',
  });
});

test('snapshotFromDispatchElement (anchored, ranged source): anchor carries the resolved path + range', () => {
  const element = makeDispatchElement();
  const source = makeDispatchSource({ path: 'src/b.ts', range: { startLine: 10, endLine: 20 } });
  const snapshot = snapshotFromDispatchElement(element, source);
  assert.deepStrictEqual(snapshot.anchor, { path: 'src/b.ts', startLine: 10, endLine: 20 });
  assert.strictEqual(snapshot.elementUid, null, 'no data-illum-id authoring convention exists yet');
});

test('snapshotFromDispatchElement (anchored, whole-file source): anchor carries null start/end lines', () => {
  const element = makeDispatchElement();
  const source = makeDispatchSource({ path: 'src/c.ts', range: null });
  const snapshot = snapshotFromDispatchElement(element, source);
  assert.deepStrictEqual(snapshot.anchor, { path: 'src/c.ts', startLine: null, endLine: null });
});

// ---------------------------------------------------------------------------
// Task 2: appendCardEntry / applyReattachment reducers
// ---------------------------------------------------------------------------

test('appendCardEntry on an empty store creates exactly one card with a single-entry thread and no orphan', () => {
  const snapshot = makeSnapshot();
  const entry = makeEntry({ dispatchId: 'd1' });
  const store = appendCardEntry(emptyAnnotationStore(), { parentDispatchId: null, snapshot, entry });

  assert.strictEqual(store.cards.length, 1);
  assert.deepStrictEqual(store.cards[0]?.thread, [entry]);
  assert.strictEqual(store.cards[0]?.orphan, null);
  assert.strictEqual(store.cards[0]?.snapshot, snapshot);
});

test('appendCardEntry chains a follow-up entry onto the SAME card via parentDispatchId', () => {
  const snapshot = makeSnapshot();
  const first = makeEntry({ dispatchId: 'd1' });
  const afterFirst = appendCardEntry(emptyAnnotationStore(), { parentDispatchId: null, snapshot, entry: first });

  const second = makeEntry({ dispatchId: 'd2', parentDispatchId: 'd1', depth: 2 });
  const afterSecond = appendCardEntry(afterFirst, { parentDispatchId: 'd1', snapshot, entry: second });

  assert.strictEqual(afterSecond.cards.length, 1, 'still exactly one card');
  assert.strictEqual(afterSecond.cards[0]?.thread.length, 2);
  assert.deepStrictEqual(afterSecond.cards[0]?.thread, [first, second]);
});

test('appendCardEntry with a parentDispatchId matching nothing creates a NEW card rather than throwing or dropping the entry', () => {
  const snapshot = makeSnapshot();
  const first = makeEntry({ dispatchId: 'd1' });
  const afterFirst = appendCardEntry(emptyAnnotationStore(), { parentDispatchId: null, snapshot, entry: first });

  const orphanedFollowUp = makeEntry({ dispatchId: 'd2', parentDispatchId: 'predates-this-sidecar' });
  const secondSnapshot = makeSnapshot({ structuralPath: 'body>div:nth-child(2)' });
  const afterSecond = appendCardEntry(afterFirst, {
    parentDispatchId: 'predates-this-sidecar',
    snapshot: secondSnapshot,
    entry: orphanedFollowUp,
  });

  assert.strictEqual(afterSecond.cards.length, 2, 'a new card is created, nothing is dropped');
  assert.deepStrictEqual(afterSecond.cards[1]?.thread, [orphanedFollowUp]);
  assert.strictEqual(afterSecond.cards[0]?.thread.length, 1, 'the first card is untouched by the unmatched chain attempt');
});

test('appendCardEntry never mutates its input store', () => {
  const before = emptyAnnotationStore();
  const beforeCardsRef = before.cards;
  const snapshot = makeSnapshot();
  const entry = makeEntry();

  const after = appendCardEntry(before, { parentDispatchId: null, snapshot, entry });

  assert.notStrictEqual(after, before, 'a new store object is returned');
  assert.strictEqual(before.cards, beforeCardsRef, "the input store's own cards array reference is untouched");
  assert.deepStrictEqual(before.cards, [], 'the input store is still empty after the call');
});

test('appendCardEntry chaining never mutates the store it was called with', () => {
  const snapshot = makeSnapshot();
  const first = makeEntry({ dispatchId: 'd1' });
  const afterFirst = appendCardEntry(emptyAnnotationStore(), { parentDispatchId: null, snapshot, entry: first });
  const cardsRef = afterFirst.cards;
  const firstCardRef = afterFirst.cards[0];

  const second = makeEntry({ dispatchId: 'd2', parentDispatchId: 'd1' });
  appendCardEntry(afterFirst, { parentDispatchId: 'd1', snapshot, entry: second });

  assert.strictEqual(afterFirst.cards, cardsRef, 'afterFirst.cards array identity is unchanged');
  assert.strictEqual(afterFirst.cards[0], firstCardRef, 'afterFirst.cards[0] identity is unchanged');
  assert.strictEqual(afterFirst.cards[0]?.thread.length, 1, 'afterFirst thread still holds only the original entry');
});

test('applyReattachment sets .orphan on exactly the mapped card, leaves every other card untouched, never removes a card', () => {
  const entryA = makeEntry({ dispatchId: 'da' });
  const entryB = makeEntry({ dispatchId: 'db' });
  let store = appendCardEntry(emptyAnnotationStore(), {
    parentDispatchId: null,
    snapshot: makeSnapshot({ structuralPath: 'a' }),
    entry: entryA,
  });
  store = appendCardEntry(store, {
    parentDispatchId: null,
    snapshot: makeSnapshot({ structuralPath: 'b' }),
    entry: entryB,
  });
  const cardA = store.cards[0];
  const cardB = store.cards[1];
  assert.ok(cardA && cardB);

  const orphan = makeOrphan();
  const next = applyReattachment(store, new Map([[cardA.cardId, orphan]]));

  assert.strictEqual(next.cards.length, 2, 'no card removed');
  assert.strictEqual(next.cards.find((c: Card) => c.cardId === cardA.cardId)?.orphan, orphan);
  assert.strictEqual(
    next.cards.find((c: Card) => c.cardId === cardB.cardId)?.orphan,
    null,
    'untouched card keeps its prior orphan value',
  );
});

test('applyReattachment a second time with a promoted (confirmed) OrphanRecord overwrites the prior record, never merges', () => {
  const snapshot = makeSnapshot();
  const entry = makeEntry();
  const store = appendCardEntry(emptyAnnotationStore(), { parentDispatchId: null, snapshot, entry });
  const card = store.cards[0];
  assert.ok(card);

  const unconfirmed = makeOrphan({ confirmedOrphan: false });
  const afterFirst = applyReattachment(store, new Map([[card.cardId, unconfirmed]]));
  assert.strictEqual(afterFirst.cards[0]?.orphan, unconfirmed);

  const confirmed = makeOrphan({ confirmedOrphan: true, lastMissRevision: 'rev-2' });
  const afterSecond = applyReattachment(afterFirst, new Map([[card.cardId, confirmed]]));

  assert.strictEqual(afterSecond.cards[0]?.orphan, confirmed, 'overwritten with the exact caller-supplied record');
  assert.notStrictEqual(afterSecond.cards[0]?.orphan, unconfirmed);
  assert.strictEqual(afterSecond.cards.length, 1, 'still exactly one card');
});

test('applyReattachment never changes cards.length across repeated calls with varying maps', () => {
  let store = emptyAnnotationStore();
  for (let i = 0; i < 5; i++) {
    store = appendCardEntry(store, {
      parentDispatchId: null,
      snapshot: makeSnapshot({ structuralPath: `card-${String(i)}` }),
      entry: makeEntry({ dispatchId: `d-${String(i)}` }),
    });
  }
  assert.strictEqual(store.cards.length, 5);
  const ids = store.cards.map((c) => c.cardId);

  store = applyReattachment(store, new Map([[ids[0] ?? '', makeOrphan()]]));
  assert.strictEqual(store.cards.length, 5, 'length invariant after first applyReattachment call');

  store = applyReattachment(
    store,
    new Map([
      [ids[1] ?? '', makeOrphan()],
      [ids[2] ?? '', makeOrphan({ confirmedOrphan: true })],
    ]),
  );
  assert.strictEqual(store.cards.length, 5, 'length invariant after second applyReattachment call');

  store = applyReattachment(store, new Map());
  assert.strictEqual(store.cards.length, 5, 'length invariant when no cards are mapped at all');
});

// ---------------------------------------------------------------------------
// Task 3: AnnotationStoreFile -- mutex-guarded, atomic-write, real-fs wrapper
// ---------------------------------------------------------------------------

test('AnnotationStoreFile.mutate performs a real round-trip write+read against the filesystem', async () => {
  await withTempDir(async (dir) => {
    const artifactPath = join(dir, 'artifact.html');
    const storeFile = new AnnotationStoreFile(artifactPath);
    const snapshot = makeSnapshot();
    const entry = makeEntry({ dispatchId: 'd1' });

    await storeFile.mutate((store) => ({
      next: appendCardEntry(store, { parentDispatchId: null, snapshot, entry }),
      result: undefined,
    }));

    const after = await storeFile.read();
    assert.strictEqual(after.cards.length, 1);
    assert.deepStrictEqual(after.cards[0]?.thread, [entry]);
  });
});

test('two concurrent mutate() calls on the SAME AnnotationStoreFile instance, each appending a DIFFERENT card, both land', async () => {
  await withTempDir(async (dir) => {
    const artifactPath = join(dir, 'artifact-concurrent.html');
    const storeFile = new AnnotationStoreFile(artifactPath);
    const entryA = makeEntry({ dispatchId: 'da' });
    const entryB = makeEntry({ dispatchId: 'db' });
    const snapshotA = makeSnapshot({ structuralPath: 'a' });
    const snapshotB = makeSnapshot({ structuralPath: 'b' });

    const appendA = (store: Awaited<ReturnType<typeof storeFile.read>>) => ({
      next: appendCardEntry(store, { parentDispatchId: null, snapshot: snapshotA, entry: entryA }),
      result: undefined,
    });
    const appendB = (store: Awaited<ReturnType<typeof storeFile.read>>) => ({
      next: appendCardEntry(store, { parentDispatchId: null, snapshot: snapshotB, entry: entryB }),
      result: undefined,
    });

    await Promise.all([storeFile.mutate(appendA), storeFile.mutate(appendB)]);

    const after = await storeFile.read();
    assert.strictEqual(
      after.cards.length,
      2,
      'neither concurrent append was lost -- the mutex serialized the two read-modify-writes',
    );
    const dispatchIds = after.cards.flatMap((c) => c.thread.map((t) => t.dispatchId));
    assert.ok(dispatchIds.includes('da'));
    assert.ok(dispatchIds.includes('db'));
  });
});

test('25 concurrent mutate() calls each appending one uniquely-identified card all land -- no lost update under real concurrency', async () => {
  await withTempDir(async (dir) => {
    const artifactPath = join(dir, 'artifact-25.html');
    const storeFile = new AnnotationStoreFile(artifactPath);

    const calls = Array.from({ length: 25 }, (_, i) =>
      storeFile.mutate((store) => ({
        next: appendCardEntry(store, {
          parentDispatchId: null,
          snapshot: makeSnapshot({ structuralPath: `card-${String(i)}` }),
          entry: makeEntry({ dispatchId: `dispatch-${String(i)}` }),
        }),
        result: undefined,
      })),
    );
    await Promise.all(calls);

    const after = await storeFile.read();
    assert.strictEqual(after.cards.length, 25, 'no update was lost to a race');
    const dispatchIds = after.cards.flatMap((c) => c.thread.map((t) => t.dispatchId));
    for (let i = 0; i < 25; i++) {
      assert.ok(dispatchIds.includes(`dispatch-${String(i)}`), `dispatch-${String(i)} present`);
    }
  });
});
