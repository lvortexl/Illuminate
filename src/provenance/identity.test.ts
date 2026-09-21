import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reattach, computeOrphanRate, type ElementSnapshot } from './identity.ts';

function makeElement(overrides: Partial<ElementSnapshot> = {}): ElementSnapshot {
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

test('reattach (tier 1): element_uid match short-circuits lower tiers even when a decoy would win them', () => {
  const before = makeElement({
    elementUid: 'el_abc123',
    anchor: { path: 'src/a.ts', startLine: 1, endLine: 5 },
    textContent: 'alpha',
    structuralPath: 'body>div:nth-child(1)',
  });

  // Shares before's anchor + text + structuralPath (would win tiers 2-4) but
  // carries the WRONG uid — proves tier 1 alone decides, not a "best of all
  // tiers" vote.
  const decoyWithWrongUid = makeElement({
    elementUid: 'el_zzz',
    anchor: { path: 'src/a.ts', startLine: 1, endLine: 5 },
    textContent: 'alpha',
    structuralPath: 'body>div:nth-child(1)',
  });

  // Carries the RIGHT uid but nothing else matches before.
  const correctByUidOnly = makeElement({
    elementUid: 'el_abc123',
    anchor: { path: 'src/b.ts', startLine: 99, endLine: 100 },
    textContent: 'totally different text',
    structuralPath: 'body>section:nth-child(9)',
  });

  const { matched, orphans } = reattach([before], [decoyWithWrongUid, correctByUidOnly], 'rev-1');
  assert.strictEqual(matched.get(before), correctByUidOnly);
  assert.strictEqual(orphans.length, 0);
});

test('reattach (tier 2): anchor equality matches when exactly one candidate overlaps path + range', () => {
  const before = makeElement({
    anchor: { path: 'src/a.ts', startLine: 10, endLine: 20 },
    textContent: 'before text',
    structuralPath: 'body>p:nth-child(1)',
  });
  const overlappingCandidate = makeElement({
    anchor: { path: 'src/a.ts', startLine: 15, endLine: 25 },
    textContent: 'after text (changed)',
    structuralPath: 'body>p:nth-child(2)',
  });
  const differentPathDecoy = makeElement({
    anchor: { path: 'src/other.ts', startLine: 1, endLine: 2 },
    textContent: 'unrelated',
    structuralPath: 'body>p:nth-child(3)',
  });

  const { matched, orphans } = reattach(
    [before],
    [differentPathDecoy, overlappingCandidate],
    'rev-1',
  );
  assert.strictEqual(matched.get(before), overlappingCandidate);
  assert.strictEqual(orphans.length, 0);
});

test('reattach (tier 2, ambiguous): multiple candidates overlapping the same range is not confident, falls through to tier 3', () => {
  const before = makeElement({
    anchor: { path: 'src/a.ts', startLine: 10, endLine: 20 },
    textContent: 'unique surviving text',
    structuralPath: 'body>p:nth-child(1)',
  });
  // A file split in two: both new elements cite the same original range.
  const sameRangeWrongText = makeElement({
    anchor: { path: 'src/a.ts', startLine: 10, endLine: 20 },
    textContent: 'not the same text at all',
    structuralPath: 'body>p:nth-child(2)',
  });
  const sameRangeRightText = makeElement({
    anchor: { path: 'src/a.ts', startLine: 10, endLine: 20 },
    textContent: 'unique surviving text',
    structuralPath: 'body>p:nth-child(3)',
  });

  const { matched, orphans } = reattach(
    [before],
    [sameRangeWrongText, sameRangeRightText],
    'rev-1',
  );
  assert.strictEqual(matched.get(before), sameRangeRightText);
  assert.strictEqual(orphans.length, 0);
});

test('reattach (tier 3): exact-after-whitespace-collapse text match when exactly one candidate matches', () => {
  const before = makeElement({
    textContent: '  Hello   world  \n  this is the body ',
  });
  const candidate = makeElement({
    textContent: 'Hello world this is the body',
  });
  const decoy = makeElement({ textContent: 'completely different' });

  const { matched, orphans } = reattach([before], [decoy, candidate], 'rev-1');
  assert.strictEqual(matched.get(before), candidate);
  assert.strictEqual(orphans.length, 0);
});

test('reattach (tier 3, disambiguation): identical text on multiple candidates is resolved by prefix/suffix context', () => {
  const before = makeElement({
    textContent: 'shared text',
    prefixContext: 'the answer is:',
    suffixContext: 'end of section',
  });
  const wrongContext = makeElement({
    textContent: 'shared text',
    prefixContext: 'unrelated prefix',
    suffixContext: 'unrelated suffix',
  });
  const rightContext = makeElement({
    textContent: 'shared text',
    prefixContext: 'the answer is:',
    suffixContext: 'end of section',
  });

  const { matched, orphans } = reattach([before], [wrongContext, rightContext], 'rev-1');
  assert.strictEqual(matched.get(before), rightContext);
  assert.strictEqual(orphans.length, 0);
});

test('reattach (tier 4): structural path matches as the last resort when no other tier is confident', () => {
  const before = makeElement({
    textContent: 'will not match anything',
    structuralPath: 'body>div:nth-child(2)>p:nth-child(1)',
  });
  const candidate = makeElement({
    textContent: 'entirely rewritten text',
    structuralPath: 'body>div:nth-child(2)>p:nth-child(1)',
  });
  const decoy = makeElement({
    textContent: 'also rewritten',
    structuralPath: 'body>div:nth-child(5)>p:nth-child(1)',
  });

  const { matched, orphans } = reattach([before], [decoy, candidate], 'rev-1');
  assert.strictEqual(matched.get(before), candidate);
  assert.strictEqual(orphans.length, 0);
});

test('reattach (orphan): an element matched at no tier becomes an explicit orphan with a first-strike record, never silently dropped', () => {
  const before = makeElement({
    textContent: 'this element is gone',
    structuralPath: 'body>div:nth-child(9)',
  });
  const after = [
    makeElement({ textContent: 'unrelated', structuralPath: 'body>div:nth-child(1)' }),
  ];

  const { matched, orphans } = reattach([before], after, 'rev-1');
  assert.strictEqual(matched.has(before), false);
  assert.strictEqual(orphans.length, 1);
  assert.strictEqual(orphans[0]?.element, before);
  assert.strictEqual(orphans[0]?.firstMissRevision, 'rev-1');
  assert.strictEqual(orphans[0]?.lastMissRevision, 'rev-1');
  assert.strictEqual(orphans[0]?.confirmedOrphan, false);
});

test('reattach (never-delete invariant): an orphan record survives 3 sequential calls across before -> mid -> after and confirms on a second, distinct-revision miss', () => {
  const stableNeighbor = makeElement({ elementUid: 'el_stable', textContent: 'stable neighbor' });
  const orphanElement = makeElement({
    textContent: 'will never be found again',
    structuralPath: 'body>div:nth-child(9)',
  });
  const before = [stableNeighbor, orphanElement];

  const mid = [
    makeElement({ elementUid: 'el_stable', textContent: 'stable neighbor' }),
    makeElement({ textContent: 'not the orphan', structuralPath: 'body>div:nth-child(1)' }),
  ];
  const after = [
    makeElement({ elementUid: 'el_stable', textContent: 'stable neighbor' }),
    makeElement({ textContent: 'still not the orphan', structuralPath: 'body>div:nth-child(2)' }),
  ];

  // Call 1: before -> mid. orphanElement misses for the first time, at rev-A.
  const call1 = reattach(before, mid, 'rev-A');
  assert.strictEqual(call1.orphans.length, 1);
  assert.strictEqual(call1.orphans[0]?.element, orphanElement);
  assert.strictEqual(call1.orphans[0]?.firstMissRevision, 'rev-A');
  assert.strictEqual(call1.orphans[0]?.lastMissRevision, 'rev-A');
  assert.strictEqual(call1.orphans[0]?.confirmedOrphan, false);

  // Call 2: before -> after, carrying call 1's orphans forward. orphanElement
  // misses again at a DIFFERENT revision (rev-B) -> confirmed, never deleted.
  const call2 = reattach(before, after, 'rev-B', call1.orphans);
  assert.strictEqual(call2.orphans.length, 1);
  assert.strictEqual(call2.orphans[0]?.element, orphanElement);
  assert.strictEqual(call2.orphans[0]?.firstMissRevision, 'rev-A');
  assert.strictEqual(call2.orphans[0]?.lastMissRevision, 'rev-B');
  assert.strictEqual(call2.orphans[0]?.confirmedOrphan, true);

  // Call 3: same pair, same revision as call 2 (a re-check, not a new miss).
  // The store must still neither shrink nor spuriously grow.
  const call3 = reattach(before, after, 'rev-B', call2.orphans);
  assert.strictEqual(call3.orphans.length, 1);
  assert.strictEqual(call3.orphans[0]?.element, orphanElement);
  assert.strictEqual(call3.orphans[0]?.firstMissRevision, 'rev-A');
  assert.strictEqual(call3.orphans[0]?.lastMissRevision, 'rev-B');
  assert.strictEqual(call3.orphans[0]?.confirmedOrphan, true);
});

test('computeOrphanRate: 10 previously-attached elements with 3 unmatched yields exactly 0.3', () => {
  const attached = Array.from({ length: 7 }, (_unused, i) =>
    makeElement({ elementUid: `el_${String(i)}`, textContent: `stable-${String(i)}` }),
  );
  const orphaned = Array.from({ length: 3 }, (_unused, i) =>
    makeElement({
      textContent: `gone-${String(i)}`,
      structuralPath: `body>div:nth-child(${String(i + 100)})`,
    }),
  );
  const before = [...attached, ...orphaned];
  const after = attached.map((el) =>
    makeElement({ elementUid: el.elementUid, textContent: el.textContent }),
  );

  const { orphans } = reattach(before, after, 'rev-1');
  assert.strictEqual(orphans.length, 3);
  assert.strictEqual(computeOrphanRate(before.length, orphans.length), 0.3);
});
