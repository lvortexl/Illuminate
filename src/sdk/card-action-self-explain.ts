/// <reference lib="dom" />
// See addressing.ts's own top-of-file comment for why this directive is
// needed: this file lives under tsconfig.browser.json (lib: DOM), mirroring
// card-action-deeper.ts's own header comment exactly.

import type { CardActionRenderer } from './cards.ts';
import { buildFollowUpPayload } from './follow-up.ts';

/**
 * EDU-06: learner-INITIATED "explain it in your own words," reachable ONLY
 * from an already-rendered card's action row -- never a bare-element picker
 * item, never offered on page load, never suggested. This is the one action
 * this whole phase adds that requires the reader to TYPE something before
 * anything is posted: the toggle button alone opens a free-text box; a
 * second, deliberate act (typing non-whitespace text, then clicking submit)
 * is what actually dispatches. Both layers together are what makes this the
 * evidence-based feature (Chi 1994's learner-initiated self-explanation),
 * never the anti-feature (an unsolicited quiz) FEATURES.md's research
 * explicitly distinguishes.
 *
 * Satisfies cards.ts's `CardActionRenderer` contract: the toggle BUTTON is
 * what gets returned (appended to the action row); the free-text box itself
 * is appended separately into `ctx.threadRoot` (NOT the action row), per
 * this plan's own `<interfaces>` block.
 *
 * `depth` is passed through UNCHANGED from `ctx.latestEntry.depth` -- this
 * is a parallel, learner-initiated branch off the same card, not a step
 * deeper on the explain -> deeper -> show-code ladder (contrast with
 * card-action-deeper.ts's `depth + 1`).
 */
export const selfExplainCardAction: CardActionRenderer = (ctx) => {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'illum-card-action-self-explain';
  toggle.textContent = 'Check my understanding';
  toggle.setAttribute('aria-expanded', 'false');

  const boxId = `illum-self-explain-box-${ctx.cardId}`;
  const textareaId = `illum-self-explain-textarea-${ctx.cardId}`;
  toggle.setAttribute('aria-controls', boxId);

  let box: HTMLElement | null = null;

  function closeBox(): void {
    box?.remove();
    box = null;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = 'Check my understanding';
  }

  function openBox(): void {
    box = document.createElement('div');
    box.id = boxId;
    box.className = 'illum-self-explain-box';

    const label = document.createElement('label');
    label.className = 'illum-self-explain-label';
    label.htmlFor = textareaId;
    label.textContent = 'What do you think this does, in your own words?';
    box.appendChild(label);

    const textarea = document.createElement('textarea');
    textarea.id = textareaId;
    textarea.className = 'illum-self-explain-textarea';
    textarea.placeholder = 'What do you think this does, in your own words?';
    box.appendChild(textarea);

    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'illum-self-explain-submit';
    submit.textContent = 'Grade my understanding';
    // Disabled until real (non-whitespace) text exists -- never posted from
    // opening the box alone.
    submit.disabled = true;
    box.appendChild(submit);

    textarea.addEventListener('input', () => {
      submit.disabled = textarea.value.trim().length === 0;
    });

    submit.addEventListener('click', () => {
      const learnerNote = textarea.value.trim();
      if (learnerNote.length === 0) return; // defensive -- submit stays disabled anyway

      // Deliberately re-reads the card's own live element at submit time
      // (not any cached data from when the card was first created) --
      // same discipline as card-action-deeper.ts's own click handler.
      // Construction (including the UNCHANGED depth that makes this a
      // parallel branch rather than a rung on the ladder) lives in
      // follow-up.ts, shared with the chrome rail's own copy of this action.
      ctx.postIntent(buildFollowUpPayload(ctx.element, ctx.latestEntry, 'self-explain', learnerNote));

      // Replace the box with a brief "Grading..." placeholder -- removed on
      // the next real sync() once the card re-renders (either because the
      // graded entry landed, or any other heartbeat sync rebuilds this
      // card's whole container fresh -- exactly like every other locally-
      // toggled card sub-tree in this file: cards.ts's own show/hide
      // toggles reset the same way on every sync()).
      const grading = document.createElement('div');
      grading.className = 'illum-self-explain-grading';
      grading.setAttribute('role', 'status');
      grading.textContent = 'Grading…';
      box?.replaceWith(grading);
      box = null;
      toggle.setAttribute('aria-expanded', 'false');
    });

    toggle.setAttribute('aria-expanded', 'true');
    ctx.threadRoot.appendChild(box);
    textarea.focus();
  }

  toggle.addEventListener('click', () => {
    if (box) {
      closeBox();
    } else {
      openBox();
    }
  });

  return toggle;
};
