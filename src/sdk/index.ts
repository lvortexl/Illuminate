import { boot } from './boot.ts';
import { buildSelector, buildUid, truncateText, walkChain } from './addressing.ts';
import { readAnchorAttributes } from './anchor-read.ts';
import { computeElementSnapshot, parseAnchorRangeFromSrc } from './snapshot.ts';
import { renderElementComposer, type ElementComposerHandle } from './element-composer.ts';
import { postTypedIntent, postDismissFinding, postComposerSubmission } from './post.ts';
import { createCardsController } from './cards.ts';
import { createFindingsController } from './findings-render.ts';
import { deeperCardAction } from './card-action-deeper.ts';
import { selfExplainCardAction } from './card-action-self-explain.ts';
import { parseSyncAnnotations, parseDispatchCreated, parseSyncFindings } from './protocol-in.ts';

/** Shared shape check for the two inbound messages below that are small
 * enough not to warrant their own parser in protocol-in.ts. */
function isRecordWithType(data: unknown, type: string): boolean {
  return typeof data === 'object' && data !== null && (data as Record<string, unknown>).type === type;
}

/** `illuminate:revealElement`'s payload is a single uid string. Never
 * throws on malformed input, matching protocol-in.ts's own discipline for
 * every other inbound message. */
function parseRevealElement(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.type !== 'illuminate:revealElement') return null;
  const payload = d.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const uid = (payload as Record<string, unknown>).uid;
  return typeof uid === 'string' && uid.length > 0 ? uid : null;
}

/**
 * The nearest element at or above `el` that actually carries a citation.
 *
 * Anchored blocks in a real artifact are containers -- a `<div data-src>`
 * wrapping a `<span class="cite">` and one or more `<p>`s. The reader clicks
 * the PROSE, so `e.target` is the `<p>`, which carries no `data-src` of its
 * own. `readAnchorAttributes` only ever looked at the clicked element, so
 * clicking the visible text of an anchored claim produced an UNANCHORED
 * dispatch: the agent got no source and answered from the claim alone, while
 * the block it came from was sitting there properly cited. The whole promise
 * of the tool -- an explanation grounded in real code -- quietly did not
 * happen, and nothing reported it.
 *
 * `closest()` is the right primitive and is available on every element in a
 * sandboxed iframe. Returns `null` when nothing above the click is anchored,
 * which is a real case (page margins, unanchored prose) and keeps the
 * existing graceful-degradation path intact.
 */
function nearestAnchored(el: Element): Element | null {
  return el.closest('[data-src]');
}

const result = boot();
if (result) {
  // Destructured (not `result.loadToken` inline below) because TS's
  // narrowing of `result` from this `if (result)` guard does not persist
  // into the nested onSelect closure passed to renderIntentPicker -- a
  // plain `const loadToken: string` has no such boundary.
  const { shadowRoot, loadToken, revision } = result;

  function isOwnUi(target: EventTarget | null): boolean {
    return target instanceof Node && shadowRoot.host.contains(target);
  }

  let activePicker: ElementComposerHandle | null = null;

  // Recorded by onElementSelected, BEFORE postTypedIntent, so a later
  // illuminate:dispatchCreated echo (carrying this same element's uid) can
  // look the live element back up to render an immediate pending card.
  const elementsByUid = new Map<string, Element>();

  /** Builds the addressing/anchor data for `el`, opens the intent picker at
   * `rect`, and posts a single TypedIntentPayload message on selection.
   * `returnFocusTo` is whatever should regain focus once the picker closes
   * (by selection or Escape) -- the trigger button for the keyboard path,
   * or whatever had focus before the click for the mouse path (often
   * nothing focusable, i.e. effectively document.body). Opening a second
   * picker destroys any picker already open -- at most one is ever live. */
  function onElementSelected(clicked: Element, rect: DOMRect, returnFocusTo: HTMLElement | null): void {
    activePicker?.destroy();
    // Retarget to the anchored block the reader clicked INSIDE of. The
    // citation, the hover affordance and the trigger dot all belong to that
    // block, so it is what "point at this" means to them -- see
    // `nearestAnchored`. Falls back to the clicked element when nothing above
    // it is anchored.
    const el = nearestAnchored(clicked) ?? clicked;
    const chain = walkChain(el);
    const selector = buildSelector(chain);
    const text = truncateText((el.textContent ?? '').trim());
    const uid = buildUid(selector, text);
    const anchor = readAnchorAttributes(el.getAttribute.bind(el));
    const snapshot = computeElementSnapshot(el);
    elementsByUid.set(uid, el);

    activePicker = renderElementComposer(shadowRoot, rect, {
      tag: el.tagName.toLowerCase(),
      label: anchor ? anchor.src : null,
      onSubmit: (submission) => {
        postComposerSubmission(loadToken, {
          element: {
            uid,
            selector,
            tag: el.tagName.toLowerCase(),
            text,
            // Sourced from the same helper reattachment uses, so the context
            // strings compared in identity.ts's disambiguation tier are
            // computed identically on both sides.
            prefixContext: snapshot.prefixContext,
            suffixContext: snapshot.suffixContext,
          },
          anchor,
          label: anchor ? anchor.src : `<${el.tagName.toLowerCase()}> ${truncateText(text, 48)}`,
          intent: submission.intent,
          note: submission.note,
          attachments: submission.attachments,
          mode: submission.mode,
        });
        activePicker = null;
        returnFocusTo?.focus();
      },
      onClose: () => {
        activePicker = null;
        returnFocusTo?.focus();
      },
    });
  }

  // --- Mouse hover: ephemeral highlight over whatever element is under the
  // cursor, excluding the SDK's own overlay. No trigger button needed for
  // mouse users -- they can click the element directly. ---
  const highlight = document.createElement('div');
  highlight.className = 'illum-highlight';
  highlight.style.display = 'none';
  shadowRoot.appendChild(highlight);

  document.addEventListener(
    'mouseover',
    (e) => {
      if (isOwnUi(e.target)) return;
      const el = e.target as Element;
      const rect = el.getBoundingClientRect();
      highlight.style.display = 'block';
      highlight.style.left = `${rect.left}px`;
      highlight.style.top = `${rect.top}px`;
      highlight.style.width = `${rect.width}px`;
      highlight.style.height = `${rect.height}px`;
    },
    true,
  );
  document.addEventListener(
    'mouseout',
    (e) => {
      if (isOwnUi(e.target)) return;
      highlight.style.display = 'none';
    },
    true,
  );

  document.addEventListener(
    'click',
    (e) => {
      if (isOwnUi(e.target)) return;
      const el = e.target as Element;
      // The picker opens at the POINTER, not at the element's own box.
      //
      // Clicking the page margin selects whatever full-width container is
      // under it -- a `<body>` or a wrapper `<div>` -- whose rect starts at
      // x=0 and runs far past the bottom of the viewport. Opening below that
      // rect flips the menu above it, clamps to zero, and parks it in the
      // top-left corner of the page, nowhere near the click. A zero-size rect
      // at the cursor gives `renderIntentPicker`'s existing placement and
      // clamping logic the one position that is always meaningful: where the
      // reader actually pointed.
      const at = new DOMRect(e.clientX, e.clientY, 0, 0);
      onElementSelected(el, at, document.activeElement instanceof HTMLElement ? document.activeElement : null);
    },
    true,
  );

  // --- Keyboard: one focusable trigger per data-src element, in document
  // order. Deliberately NOT extended to every element in the artifact --
  // adding tabindex to arbitrary artifact nodes would mutate the
  // artifact's own accessibility tree, a change this phase has no warrant
  // to make. Anchored elements already carry an agent-authored data-src
  // attribute -- i.e. they are already marked "about something," which is
  // what makes them the right bounded set (FEATURES.md's cheap-
  // differentiator framing). ---
  const anchoredElements = Array.from(document.querySelectorAll('[data-src]'));
  const triggers = anchoredElements.map((el) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'illum-trigger';
    const tag = el.tagName.toLowerCase();
    const snippet = truncateText((el.textContent ?? '').trim(), 40);
    button.setAttribute('aria-label', `Review: ${tag} -- ${snippet}`);
    button.textContent = '⌘'; // compact glyph; label carries the meaning
    // The TRIGGER's own rect, not the element's: the keyboard path has no
    // pointer, and the dot is both small and always on screen, so the menu
    // opens directly under the control that opened it.
    button.addEventListener('click', () => onElementSelected(el, button.getBoundingClientRect(), button));
    shadowRoot.appendChild(button);
    return { el, button };
  });

  // Plan 07-05's own wiring block: THIS plan's own action-row content is
  // the empty array literal below -- Plans 07-06/07-07 each change ONLY
  // this one array literal, in order, never anything else in this block.
  // Created HERE (after the anchored-element triggers above, not before
  // them) so the drawer toggle button -- the one new focusable element
  // this controller appends to the shadow root -- lands AFTER every
  // trigger in tab order, never displacing the existing keyboard-
  // reachability contract those triggers already have (shadow-root.spec.ts's
  // own "first Tab reaches the first anchored trigger" proof).
  // Plan 07-06 added deeperCardAction (the array's first element). Plan
  // 07-07 adds selfExplainCardAction as the second -- EDU-06's learner-
  // initiated "explain it in your own words," reachable only from this
  // same already-rendered card's action row.
  const cardsController = createCardsController(shadowRoot, [deeperCardAction, selfExplainCardAction], (payload) =>
    postTypedIntent(loadToken, payload),
  );

  // Plan 08-05 (STAL-02/STAL-05) -- passive per-trigger touched/lost
  // markers plus the findings drawer (dismiss + degraded-watcher
  // indicator). One more postIntent-shaped pre-binding, mirroring
  // cardsController's own convention immediately above: findings-render.ts
  // never imports post.ts/loadToken itself.
  const findingsController = createFindingsController(shadowRoot, (fingerprint) =>
    postDismissFinding(loadToken, fingerprint),
  );
  for (const { el, button } of triggers) {
    const anchor = readAnchorAttributes(el.getAttribute.bind(el));
    if (anchor) {
      findingsController.registerTrigger(button, parseAnchorRangeFromSrc(anchor.src));
    }
  }

  function positionTriggers(): void {
    for (const { el, button } of triggers) {
      const rect = el.getBoundingClientRect();
      button.style.left = `${rect.right - 20}px`;
      button.style.top = `${rect.top}px`;
    }
  }
  positionTriggers();
  function positionEverything(): void {
    positionTriggers();
    cardsController.reposition();
  }
  window.addEventListener('scroll', positionEverything, true);
  window.addEventListener('resize', positionEverything);

  // This document's OWN top-level message listener -- distinct from
  // post.ts's one parent.postMessage call site (the opposite direction).
  // This is the ARTIFACT document's own `window`, receiving messages the
  // chrome shell posts INTO this iframe's contentWindow (illuminate:
  // syncAnnotations on the heartbeat cadence, illuminate:dispatchCreated
  // right after a dispatch POST resolves) -- src/chrome/client.ts's
  // `postToArtifact`.
  window.addEventListener('message', (e: MessageEvent) => {
    const syncPayload = parseSyncAnnotations(e.data);
    if (syncPayload) {
      cardsController.sync(syncPayload, document, shadowRoot.host, revision);
      return;
    }
    const created = parseDispatchCreated(e.data);
    if (created) {
      const el = elementsByUid.get(created.elementUid);
      // Silently does nothing if the element reference was never recorded
      // (e.g. this SDK instance did not itself originate that dispatch) --
      // the NEXT sync() still picks it up once answered.
      if (el) cardsController.renderPendingCard(created.dispatchId, el);
      return;
    }
    // Plan 08-05's own branch -- mutually exclusive with the two checks
    // above by `type`/`payload.protocol`, so checking order is not
    // correctness-relevant here either.
    const findingsPayload = parseSyncFindings(e.data);
    if (findingsPayload) {
      findingsController.sync(findingsPayload);
      return;
    }
    // The rail's "show me where this is" control. Scrolls the artifact to
    // the element a card belongs to and flashes it -- the affordance that
    // replaces positioning the card itself against a possibly-scrolled-away
    // anchor. Shape-checked inline rather than via a protocol-in.ts parser
    // because the whole payload is one string; a malformed one simply finds
    // no element and does nothing.
    // The rail asking this document to run a card follow-up. The rail has
    // the card's stored snapshot; only the artifact has the LIVE element a
    // follow-up must be grounded in (T-07-17), so the action is performed
    // here and the payload is built by the same `buildFollowUpPayload` the
    // in-artifact action buttons use.
    if (isRecordWithType(e.data, 'illuminate:cardAction')) {
      const payload = (e.data as { payload?: Record<string, unknown> }).payload;
      const cardId = payload?.cardId;
      const action = payload?.action;
      const learnerNote = payload?.learnerNote;
      if (typeof cardId === 'string' && (action === 'deeper' || action === 'self-explain')) {
        cardsController.runAction(cardId, action, typeof learnerNote === 'string' ? learnerNote : null);
      }
      return;
    }
    // Sent by the chrome shell once its rail is mounted. Checked before
    // reveal purely for locality -- the branches are mutually exclusive by
    // `type`.
    if (isRecordWithType(e.data, 'illuminate:setCardPresentation')) {
      const mode = (e.data as { payload?: { mode?: unknown } }).payload?.mode;
      if (mode === 'rail' || mode === 'inline') cardsController.setPresentation(mode);
      return;
    }
    const reveal = parseRevealElement(e.data);
    if (reveal) {
      const target = elementsByUid.get(reveal);
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const flash = document.createElement('div');
        flash.className = 'illum-reveal';
        shadowRoot.appendChild(flash);
        const place = (): void => {
          const r = target.getBoundingClientRect();
          flash.style.left = `${String(r.left)}px`;
          flash.style.top = `${String(r.top)}px`;
          flash.style.width = `${String(r.width)}px`;
          flash.style.height = `${String(r.height)}px`;
        };
        place();
        setTimeout(place, 220);
        setTimeout(() => {
          flash.remove();
        }, 1400);
      }
    }
  });
}
