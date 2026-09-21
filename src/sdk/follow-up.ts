/// <reference lib="dom" />
// See addressing.ts's own top-of-file comment for why this directive is
// needed here: this file lives under tsconfig.browser.json (lib: DOM) and
// is imported from cards.ts, which a Node-side test may pull in.

import { computeElementSnapshot } from './snapshot.ts';
import { buildUid } from './addressing.ts';
import { readAnchorAttributes } from './anchor-read.ts';
import { buildTypedIntentPayload } from '../shared/intent.ts';
import type { TypedIntentPayload } from '../shared/intent.ts';
import type { WireCardThreadEntry } from './protocol-in.ts';

/**
 * The single construction for a card follow-up -- "go deeper" (EDU-05's
 * next rung) and "explain it back" (EDU-06's learner-initiated grading).
 *
 * Extracted because there are now TWO places a follow-up can be triggered
 * from: the in-artifact card's own action buttons
 * (card-action-deeper.ts / card-action-self-explain.ts) and the chrome
 * rail, which has no live element of its own and asks the artifact to run
 * the action on its behalf (`illuminate:cardAction`). Both must produce a
 * byte-identical payload; two copies of this would have drifted.
 *
 * ## The invariant this file exists to hold
 *
 * The element is re-read HERE, at trigger time, via
 * `computeElementSnapshot` -- never from anything cached when the card was
 * first created (T-07-17). A follow-up is always grounded in what the
 * artifact says right now. This is also exactly why the rail cannot build
 * the payload itself: it holds a card's stored SNAPSHOT, which is by
 * definition what the artifact said earlier.
 *
 * ## Why depth differs between the two actions
 *
 * `deeper` increments depth -- it is the next rung on the
 * explain -> deeper -> show-code ladder. `self-explain` leaves depth
 * UNCHANGED: it is a parallel, learner-initiated branch off the same rung,
 * not a step down it. Both chain via `parent_dispatch`.
 */
export function buildFollowUpPayload(
  element: Element,
  latestEntry: WireCardThreadEntry,
  action: 'deeper' | 'self-explain',
  learnerNote: string | null,
): TypedIntentPayload {
  const snapshot = computeElementSnapshot(element);
  const uid = buildUid(snapshot.structuralPath, snapshot.textContent);
  const anchor = readAnchorAttributes(element.getAttribute.bind(element));

  return buildTypedIntentPayload({
    intent: action === 'deeper' ? 'deeper' : 'explain',
    // A follow-up is always about the ONE card being deepened, so it is a
    // single-target payload even though the shape is a list (ADR-102).
    targets: [
      {
        element: {
          uid,
          selector: snapshot.structuralPath,
          tag: element.tagName.toLowerCase(),
          text: snapshot.textContent,
          prefixContext: snapshot.prefixContext,
          suffixContext: snapshot.suffixContext,
        },
        anchor,
      },
    ],
    depth: action === 'deeper' ? latestEntry.depth + 1 : latestEntry.depth,
    parent_dispatch: latestEntry.dispatchId,
    learnerNote: action === 'self-explain' ? learnerNote : null,
  });
}
