/// <reference lib="dom" />
// See addressing.ts's own top-of-file comment for why this directive is
// needed: this file lives under tsconfig.browser.json (lib: DOM). No
// Node-side test imports it directly yet (unlike addressing.ts/snapshot.ts/
// anchor-read.ts, each pulled in transitively by a test/sdk/*.test.ts under
// the root, no-DOM tsconfig) -- carrying the same directive keeps this file
// safe against that becoming true later without a silent root-tsconfig
// failure, matching every other DOM-touching file in this directory.

import type { CardActionRenderer } from './cards.ts';
import { buildFollowUpPayload } from './follow-up.ts';

/**
 * EDU-05 rung 2: "go deeper," reachable from an already-rendered card's
 * action row. Satisfies cards.ts's `CardActionRenderer` contract -- renders
 * one button; on click, builds and posts a `deeper`-intent
 * `TypedIntentPayload` chained onto `ctx.latestEntry` via
 * `parent_dispatch`/`depth + 1`.
 *
 * Deliberately re-reads `ctx.element` (the card's own currently-matched LIVE
 * element) at click time, via `computeElementSnapshot` -- never any cached
 * data from when the card was first created (see this plan's own threat
 * model, T-07-17): a "go deeper" click always grounds the follow-up in what
 * the artifact currently says.
 */
export const deeperCardAction: CardActionRenderer = (ctx) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'illum-card-action-deeper';
  button.textContent = 'Go deeper';
  button.setAttribute('aria-label', 'Go deeper -- ask a follow-up question, added to this same explanation');

  button.addEventListener('click', () => {
    // Construction lives in follow-up.ts because the chrome rail can trigger
    // this same action without a live element of its own -- two copies would
    // have drifted. The re-read-at-click-time discipline documented above is
    // implemented there.
    ctx.postIntent(buildFollowUpPayload(ctx.element, ctx.latestEntry, 'deeper', null));

    // Purely local UI feedback to discourage a double-click -- the server's
    // own dedupe key (computeDedupeKey, keyed on element uid + intent +
    // resolved content) already makes a genuine double-submit harmless.
    button.disabled = true;
    button.textContent = 'Going deeper…';
  });

  return button;
};
