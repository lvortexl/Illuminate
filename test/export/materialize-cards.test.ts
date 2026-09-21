import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { materializeCards } from '../../src/export/materialize-cards.ts';
import { emptyAnnotationStore } from '../../src/store/annotation-store.ts';
import type { AnnotationStore, Card, CardSource, CardThreadEntry } from '../../src/store/annotation-store.ts';
import type { ElementSnapshot, OrphanRecord } from '../../src/provenance/identity.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function makeSnapshot(overrides: Partial<ElementSnapshot> = {}): ElementSnapshot {
  return {
    elementUid: null,
    anchor: null,
    textContent: 'default snapshot text',
    prefixContext: null,
    suffixContext: null,
    structuralPath: 'body>div:nth-child(1)',
    ...overrides,
  };
}

function makeSource(overrides: Partial<CardSource> = {}): CardSource {
  return {
    path: 'src/a.ts',
    rev: 'abc123',
    range: { startLine: 1, endLine: 5 },
    status: 'unchanged',
    content: 'const x = 1;',
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
    markdown: 'This is the answer markdown.',
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
    lastMissRevision: 'rev-2',
    confirmedOrphan: true,
    ...overrides,
  };
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    cardId: 'card-1',
    snapshot: makeSnapshot(),
    thread: [makeEntry()],
    orphan: null,
    ...overrides,
  };
}

function makeStore(cards: readonly Card[]): AnnotationStore {
  return { protocol: emptyAnnotationStore().protocol, cards };
}

// ---------------------------------------------------------------------------
// Empty store
// ---------------------------------------------------------------------------

test('materializeCards on an empty store never throws and produces no card entries', () => {
  assert.doesNotThrow(() => materializeCards(emptyAnnotationStore()));
  const html = materializeCards(emptyAnnotationStore());
  assert.ok(!html.includes('illum-export-card"'), 'no card entries for an empty store (the wrapper id is "illum-export-cards", plural, distinct from a card entry\'s "illum-export-card" class)');
});

test('materializeCards on an empty store does not render a "no cards yet, ask a question" style prompt', () => {
  const html = materializeCards(emptyAnnotationStore());
  assert.ok(!/ask a question/i.test(html));
  assert.ok(!/no cards yet/i.test(html));
});

test('materializeCards output always carries a stable, greppable wrapper id, even when empty', () => {
  const html = materializeCards(emptyAnnotationStore());
  assert.ok(html.includes('id="illum-export-cards"'), 'wrapper id present even for an empty store');
});

// ---------------------------------------------------------------------------
// One card, one thread entry, anchored, no orphan
// ---------------------------------------------------------------------------

test('materializeCards renders an anchored card\'s path#Lstart-Lend, intent label, model/tier, and full markdown verbatim', () => {
  const card = makeCard({
    snapshot: makeSnapshot({ anchor: { path: 'src/widget.ts', startLine: 10, endLine: 20 } }),
    thread: [
      makeEntry({
        intent: 'explain',
        model: 'claude-haiku',
        tier: 'haiku',
        markdown: 'The widget renders a button.',
      }),
    ],
  });
  const html = materializeCards(makeStore([card]));

  assert.ok(html.includes('src/widget.ts#L10-L20'), 'anchor path#Lstart-Lend present');
  assert.ok(html.includes('Explain'), 'intent label present via labelFor');
  assert.ok(html.includes('claude-haiku'), 'model present');
  assert.ok(html.includes('haiku'), 'tier present');
  assert.ok(html.includes('The widget renders a button.'), 'full markdown present verbatim');
});

test('materializeCards renders the full cited source text verbatim when source.content is non-null -- no truncation', () => {
  const longSource = 'x'.repeat(500);
  const card = makeCard({
    thread: [makeEntry({ source: makeSource({ content: longSource }) })],
  });
  const html = materializeCards(makeStore([card]));
  assert.ok(html.includes(longSource), 'the full 500-character source text is present, not truncated');
});

test('materializeCards does not truncate a long markdown body -- no space constraint on a static appendix', () => {
  const longMarkdown = 'y'.repeat(500);
  const card = makeCard({ thread: [makeEntry({ markdown: longMarkdown })] });
  const html = materializeCards(makeStore([card]));
  assert.ok(html.includes(longMarkdown), 'the full 500-character markdown is present, not truncated');
});

test('materializeCards renders an unanchored card with a literal (unanchored) label', () => {
  const card = makeCard({ snapshot: makeSnapshot({ anchor: null }) });
  const html = materializeCards(makeStore([card]));
  assert.ok(html.includes('(unanchored)'));
});

test('materializeCards renders a whole-file anchor (no range) as the path alone', () => {
  const card = makeCard({
    snapshot: makeSnapshot({ anchor: { path: 'src/whole-file.ts', startLine: null, endLine: null } }),
  });
  const html = materializeCards(makeStore([card]));
  assert.ok(html.includes('src/whole-file.ts'));
  assert.ok(!html.includes('src/whole-file.ts#L'), 'no range suffix when the anchor carries no range');
});

// ---------------------------------------------------------------------------
// Orphaned card
// ---------------------------------------------------------------------------

test('materializeCards renders a plain literal label naming lastMissRevision for an orphaned card, alongside its thread', () => {
  const card = makeCard({
    orphan: makeOrphan({ lastMissRevision: 'rev-xyz' }),
    thread: [makeEntry({ markdown: 'still-present markdown' })],
  });
  const html = materializeCards(makeStore([card]));
  assert.ok(/no longer found.*rev-xyz/i.test(html), 'orphan label names lastMissRevision');
  assert.ok(html.includes('still-present markdown'), 'the thread is still rendered alongside the orphan label');
});

// ---------------------------------------------------------------------------
// Verdict + deciding lines, always visible (no toggle, no JS)
// ---------------------------------------------------------------------------

test('materializeCards renders the verdict label and decidingLines text verbatim, always visible', () => {
  const card = makeCard({
    thread: [makeEntry({ verdict: 'contradicted', decidingLines: 'line 4: the check is inverted' })],
  });
  const html = materializeCards(makeStore([card]));
  assert.ok(/contradicted/i.test(html));
  assert.ok(html.includes('line 4: the check is inverted'));
});

test('materializeCards output has no <script>, no <button>, and no "hidden" attribute -- no JS-driven toggle anywhere', () => {
  const card = makeCard({
    thread: [
      makeEntry({
        verdict: 'supported',
        decidingLines: 'deciding lines text',
        source: makeSource({ content: 'const y = 2;' }),
      }),
    ],
  });
  const html = materializeCards(makeStore([card]));
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<button/i.test(html));
  assert.ok(!/\bhidden\b/i.test(html));
});

// ---------------------------------------------------------------------------
// Escaping -- every untrusted field, HTML-escaped, never interpreted as markup
// ---------------------------------------------------------------------------

test('materializeCards escapes adversarial HTML-looking text in every untrusted field -- markdown, learnerNote, decidingLines, source.content, snapshot.textContent', () => {
  const payload = '<script>alert(1)</script>';
  const card = makeCard({
    snapshot: makeSnapshot({ textContent: payload }),
    thread: [
      makeEntry({
        markdown: payload,
        learnerNote: payload,
        verdict: 'not-determinable',
        decidingLines: payload,
        source: makeSource({ content: payload }),
      }),
    ],
  });
  const html = materializeCards(makeStore([card]));

  assert.ok(!html.includes(payload), 'the raw, unescaped payload must never appear in the output');
  const escapedCount = html.split('&lt;script&gt;alert(1)&lt;/script&gt;').length - 1;
  assert.ok(escapedCount >= 5, `expected the escaped payload to appear at least 5 times (once per untrusted field), found ${escapedCount}`);
});

// ---------------------------------------------------------------------------
// Learner note
// ---------------------------------------------------------------------------

test('materializeCards renders learnerNote distinctly, labeled, when present', () => {
  const card = makeCard({ thread: [makeEntry({ learnerNote: 'I think this is a cache.' })] });
  const html = materializeCards(makeStore([card]));
  assert.ok(html.includes('I think this is a cache.'));
});

test('materializeCards renders nothing extra for learnerNote when it is null', () => {
  const withNote = makeCard({ cardId: 'c-note', thread: [makeEntry({ learnerNote: 'a note' })] });
  const withoutNote = makeCard({ cardId: 'c-no-note', thread: [makeEntry({ learnerNote: null })] });
  const htmlWith = materializeCards(makeStore([withNote]));
  const htmlWithout = materializeCards(makeStore([withoutNote]));
  assert.ok(htmlWith.includes('illum-export-learner-note'), 'a learner-note block renders when learnerNote is set');
  assert.ok(!htmlWithout.includes('illum-export-learner-note'), 'no learner-note block renders when learnerNote is null');
});

// ---------------------------------------------------------------------------
// Multiple thread entries, multiple cards
// ---------------------------------------------------------------------------

test('materializeCards renders every thread entry for a card with a multi-entry thread -- none dropped', () => {
  const card = makeCard({
    thread: [
      makeEntry({ dispatchId: 'd1', markdown: 'first answer' }),
      makeEntry({ dispatchId: 'd2', parentDispatchId: 'd1', depth: 2, markdown: 'second, deeper answer' }),
    ],
  });
  const html = materializeCards(makeStore([card]));
  assert.ok(html.includes('first answer'));
  assert.ok(html.includes('second, deeper answer'));
});

test('materializeCards renders two cards as two distinct entries, in store.cards array order', () => {
  const cardA = makeCard({ cardId: 'card-a', thread: [makeEntry({ markdown: 'answer A' })] });
  const cardB = makeCard({ cardId: 'card-b', thread: [makeEntry({ markdown: 'answer B' })] });
  const html = materializeCards(makeStore([cardA, cardB]));

  const indexA = html.indexOf('answer A');
  const indexB = html.indexOf('answer B');
  assert.notStrictEqual(indexA, -1);
  assert.notStrictEqual(indexB, -1);
  assert.ok(indexA < indexB, 'card A must render before card B, matching store.cards array order');
});

test('materializeCards drops no card across a mixed store: anchored, unanchored, and orphaned all present', () => {
  const anchored = makeCard({ cardId: 'anchored', snapshot: makeSnapshot({ anchor: { path: 'a.ts', startLine: 1, endLine: 2 } }), thread: [makeEntry({ markdown: 'anchored answer' })] });
  const unanchored = makeCard({ cardId: 'unanchored', snapshot: makeSnapshot({ anchor: null }), thread: [makeEntry({ markdown: 'unanchored answer' })] });
  const orphaned = makeCard({ cardId: 'orphaned', orphan: makeOrphan(), thread: [makeEntry({ markdown: 'orphaned answer' })] });
  const html = materializeCards(makeStore([anchored, unanchored, orphaned]));

  assert.ok(html.includes('anchored answer'));
  assert.ok(html.includes('unanchored answer'));
  assert.ok(html.includes('orphaned answer'));
});

// ---------------------------------------------------------------------------
// Source-text regressions: no DOM, no lavish-axi attribution
// ---------------------------------------------------------------------------

test('source-text regression: materialize-cards.ts does no DOM manipulation -- no innerHTML, no document.*', () => {
  const source = readFileSync(join(HERE, '../../src/export/materialize-cards.ts'), 'utf8');
  assert.ok(!source.includes('innerHTML'), 'must never use innerHTML');
  assert.ok(!/\bdocument\./.test(source), 'must never reference the DOM document global');
});

test('source-text regression: materialize-cards.ts carries no lavish-axi attribution comment -- this is original illuminate code', () => {
  const source = readFileSync(join(HERE, '../../src/export/materialize-cards.ts'), 'utf8');
  assert.ok(!/lavish-axi/i.test(source) || /no lavish-axi equivalent/i.test(source), 'no borrowed-code attribution comment');
});
