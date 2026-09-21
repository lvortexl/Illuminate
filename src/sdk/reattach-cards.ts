/// <reference lib="dom" />
// See addressing.ts's own top-of-file comment for why this directive is
// needed here too: this file is imported both by tsconfig.browser.json
// (lib: DOM) and, transitively, by any future test/sdk test file under the
// root tsconfig.json (lib: ES2022, no DOM).

import { reattach } from '../provenance/identity.ts';
import type { ElementSnapshot, OrphanRecord } from '../provenance/identity.ts';
import { computeElementSnapshot } from './snapshot.ts';

/** One stored card's identity-relevant fields, as received from the
 * annotation store (Plan 07-04's GET /api/:key/annotations response) --
 * deliberately NOT importing store/annotation-store.ts's own `Card` type
 * here: this module runs in the browser bundle and must not accidentally
 * pull in a Node-side module graph. Field-for-field identical by
 * convention, not by import (mirrors router/types.ts's own DispatchElement
 * vs shared/intent.ts's IntentElement precedent -- same shape, declared
 * twice, on purpose, at a module-graph boundary). */
export interface ReattachableCard {
  readonly cardId: string;
  readonly snapshot: ElementSnapshot;
  readonly orphan: OrphanRecord | null;
}

/** Every element in `root` whose trimmed textContent is non-empty, OR which
 * carries a `data-src` attribute, excluding `excludeRoot`'s own subtree
 * (the SDK's own shadow host) -- the candidate pool `reattach()`'s `after`
 * side searches. `Node.contains()` treats a node as containing itself, so
 * this one check also excludes `excludeRoot` when it happens to be in
 * `root`'s own results. Bounded to ordinary artifact sizes (roadmap/
 * architecture-style documents); walking every node of an arbitrarily large
 * generated page is a known, disclosed v1 scaling limit, not a correctness
 * bug (no requirement in this phase specifies a performance budget for this
 * path). */
export function collectCandidateElements(root: ParentNode, excludeRoot: Node): Element[] {
  return Array.from(root.querySelectorAll('*')).filter((el) => {
    if (excludeRoot.contains(el)) return false;
    const hasText = (el.textContent ?? '').trim().length > 0;
    const hasSrc = el.hasAttribute('data-src');
    return hasText || hasSrc;
  });
}

export interface ReattachOutcome {
  readonly matchedElements: ReadonlyMap<string, Element>; // cardId -> live element
  readonly orphans: ReadonlyMap<string, OrphanRecord>; // cardId -> current orphan record, for EVERY card that has one (matched or not -- identity.ts never clears on re-match)
}

/** The correlation wrapper around identity.ts's reattach(). `revision` is
 * the artifact's own `artifact_revision` (already minted per-load by
 * load-token.ts), stringified -- reused as identity.ts's revision
 * discriminator rather than inventing a second one. CRITICAL: prior orphan
 * records are re-keyed onto the SAME snapshot object references passed as
 * `before` (never the `.element` reference embedded in the store's own
 * JSON-deserialized OrphanRecord) -- identity.ts's reattach() looks up
 * prior orphans by object identity in a Map, so a reference mismatch here
 * would silently behave as "no prior orphan record", not throw. */
export function reattachCards(
  cards: readonly ReattachableCard[],
  root: ParentNode,
  excludeRoot: Node,
  revision: string,
): ReattachOutcome {
  const beforeList: ElementSnapshot[] = cards.map((c) => c.snapshot);

  // Re-key every prior orphan onto beforeList's own object references --
  // NEVER trust whatever `.element` value came out of the JSON-deserialized
  // store, which is a structurally-equal but reference-DISTINCT copy.
  const priorOrphans: OrphanRecord[] = [];
  cards.forEach((card, i) => {
    const snapshot = beforeList[i];
    if (card.orphan && snapshot) {
      priorOrphans.push({ ...card.orphan, element: snapshot });
    }
  });

  const candidates = collectCandidateElements(root, excludeRoot);
  const afterSnapshots = candidates.map(computeElementSnapshot);

  const { matched, orphans } = reattach(beforeList, afterSnapshots, revision, priorOrphans);

  // Correlate identity.ts's ElementSnapshot-keyed Maps back to cardId by
  // locating each snapshot's index in beforeList/afterSnapshots -- these
  // arrays are small (single-digit-to-low-hundreds per artifact), so
  // reference-identity .indexOf is correct and sufficient here.
  const matchedElements = new Map<string, Element>();
  cards.forEach((card, i) => {
    const beforeSnapshot = beforeList[i];
    if (!beforeSnapshot) return;
    const matchedSnapshot = matched.get(beforeSnapshot);
    if (!matchedSnapshot) return;
    const candidateIndex = afterSnapshots.indexOf(matchedSnapshot);
    const el = candidateIndex === -1 ? undefined : candidates[candidateIndex];
    if (el) matchedElements.set(card.cardId, el);
  });

  const orphanMap = new Map<string, OrphanRecord>();
  for (const record of orphans) {
    const beforeIndex = beforeList.indexOf(record.element);
    if (beforeIndex === -1) continue; // defensive: reattach() only ever emits records keyed to a beforeList/priorOrphans element
    const card = cards[beforeIndex];
    if (card) orphanMap.set(card.cardId, record);
  }

  return { matchedElements, orphans: orphanMap };
}
