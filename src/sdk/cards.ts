/// <reference lib="dom" />
// See addressing.ts's own top-of-file comment for why this directive is
// needed: this file is bundled under tsconfig.browser.json (lib: DOM), and
// while no Node-side test currently imports it directly (unlike
// addressing.ts/snapshot.ts/reattach-cards.ts/intent-picker.ts, each
// pulled in transitively by a test/sdk/*.test.ts under the root, no-DOM
// tsconfig), carrying the same directive keeps this file safe against that
// becoming true later without a silent root-tsconfig failure.

import { reattachCards } from './reattach-cards.ts';
import type { ReattachableCard } from './reattach-cards.ts';
import type { WireAnnotationStore, WireCard, WireCardThreadEntry } from './protocol-in.ts';
import { buildFollowUpPayload } from './follow-up.ts';
import { isIntent } from '../shared/intent.ts';
import type { TypedIntentPayload } from '../shared/intent.ts';
import { labelFor } from './intent-picker.ts';
import { truncateText } from './addressing.ts';
import { verdictLabel } from '../shared/verdict.ts';

/**
 * The context handed to every `CardActionRenderer` -- action rows are only
 * ever rendered for MATCHED cards (never drawer/pending cards, which have
 * no live element to ground a follow-up dispatch against), so `element` is
 * never null here. `postIntent` is `postTypedIntent` pre-bound to this
 * page's own `loadToken` by `index.ts` -- action renderers never import
 * `post.ts`/`loadToken` themselves, mirroring how `index.ts`'s own
 * `onElementSelected` never passes `loadToken` around either.
 */
export interface CardActionContext {
  readonly cardId: string;
  readonly latestEntry: WireCardThreadEntry;
  readonly element: Element;
  readonly threadRoot: HTMLElement;
  readonly postIntent: (payload: TypedIntentPayload) => void;
}

/**
 * A rendered card's action row is composed from a caller-supplied, explicit
 * list -- NOT a shared mutable registry other files push onto. Plans
 * 07-06/07-07 each add one array element at the ONE call site in index.ts
 * that constructs this controller; cards.ts itself never imports either
 * later plan's module, keeping composition visible and file ownership
 * clean.
 */
export type CardActionRenderer = (ctx: CardActionContext) => HTMLElement;

export interface CardsController {
  /** Reconciles the controller's rendered state against a freshly-synced
   * AnnotationStore -- see this file's own header comment for the full
   * reconciliation contract. Idempotent: calling this repeatedly with an
   * unchanged store produces no visible flicker/duplication. */
  sync(store: WireAnnotationStore, root: ParentNode, excludeRoot: Node, revision: string): void;
  /** Renders an immediate "thinking..." placeholder card next to `element`,
   * tagged with `dispatchId`. A no-op if a card for this dispatchId
   * already renders (real or pending) -- never creates a duplicate. */
  renderPendingCard(dispatchId: string, element: Element): void;
  /** Re-run on window scroll/resize -- repositions every currently-tracked
   * (matched or pending) card next to its live element without re-fetching
   * or re-matching anything. */
  reposition(): void;
  /** Who draws card BODIES.
   *
   * `'inline'` (the default, and what every existing caller and test gets
   * by not calling this at all) is the historical behaviour: a floating
   * `position: fixed` card beside its element.
   *
   * `'rail'` is set by the chrome shell, whose review rail renders the same
   * cards in a column that cannot be scrolled away from. Drawing both is
   * pure duplication, and the floating copy is the one that covers the
   * artifact the human is trying to read.
   *
   * This costs the standalone path nothing: `illuminate export` writes
   * cards as a STATIC HTML appendix (src/export/materialize-cards.ts) and
   * the SDK script is a request-time splice that is never persisted, so a
   * floating card can only ever exist in a served session -- exactly where
   * the rail is. */
  setPresentation(mode: 'rail' | 'inline'): void;
  /** Dispatches a card follow-up on the rail's behalf. Returns false if the
   * card has no currently-matched live element. */
  runAction(cardId: string, action: 'deeper' | 'self-explain', learnerNote: string | null): boolean;
}

// Internal tracking key prefix for a pending (not-yet-answered) card --
// distinguishes a synthetic dispatchId-keyed entry from a real cardId in
// the single `rendered` map both share (this plan's own design: one map,
// not two, so a card's pending->real transition is a single lookup+remove).
const PENDING_KEY_PREFIX = 'illum-pending:';

interface RenderedEntry {
  readonly element: Element | null;
  readonly container: HTMLElement;
  readonly dispatchIds: ReadonlySet<string>;
}


function intentLabel(intent: string): string {
  return isIntent(intent) ? labelFor(intent) : intent;
}

/** Local, self-contained show/hide toggle -- pure DOM show/hide, no
 * dispatch, no network call, no persisted open/closed state (EDU-05 rung
 * 3, entirely free once rendered). Shared by the "show deciding lines" and
 * "show me the code" toggles below -- identical behavior, different
 * label/content. */
function appendToggleAndPre(
  parent: HTMLElement,
  toggleLabel: string,
  toggleLabelOpen: string,
  content: string,
  id: string,
): void {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'illum-card-toggle';
  toggle.textContent = toggleLabel;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', id);

  const pre = document.createElement('pre');
  pre.className = 'illum-card-pre';
  pre.id = id;
  pre.textContent = content; // set via .textContent only -- never HTML-parsed, never markdown-rendered (T-07-14)
  pre.hidden = true;

  toggle.addEventListener('click', () => {
    const willShow = pre.hidden;
    pre.hidden = !willShow;
    toggle.setAttribute('aria-expanded', String(willShow));
    toggle.textContent = willShow ? toggleLabelOpen : toggleLabel;
  });

  parent.appendChild(toggle);
  parent.appendChild(pre);
}

/**
 * Renders one thread entry, in the order this plan's own action spec
 * requires: (1) header (intent/model/tier/source), (2) learner-note
 * callout (above the markdown), (3) markdown body, (4) verdict badge +
 * expandable deciding lines, (5) "show me the code" toggle. Every piece of
 * potentially-adversarial text (markdown/learnerNote/decidingLines/
 * source.content) is rendered via `.textContent` only -- this file must
 * never HTML-parse untrusted text anywhere (grep-verifiable against the
 * DOM property this codebase's threat model names, T-07-14).
 */
function renderThreadEntry(entry: WireCardThreadEntry): HTMLElement {
  const entryEl = document.createElement('div');
  entryEl.className = 'illum-card-entry';

  const header = document.createElement('div');
  header.className = 'illum-card-header';
  const headerParts = [intentLabel(entry.intent), `${entry.model} (${entry.tier})`];
  if (entry.source !== null) {
    const rangePart = entry.source.range ? `:L${entry.source.range.startLine}-L${entry.source.range.endLine}` : '';
    headerParts.push(`${entry.source.path}${rangePart} @ ${entry.source.rev ?? 'unpinned'}`);
  }
  header.textContent = headerParts.join(' · ');
  entryEl.appendChild(header);

  if (entry.learnerNote !== null) {
    const callout = document.createElement('div');
    callout.className = 'illum-card-learner-note';
    callout.textContent = `Your explanation: ${entry.learnerNote}`;
    entryEl.appendChild(callout);
  }

  const body = document.createElement('div');
  body.className = 'illum-card-markdown';
  body.textContent = entry.markdown;
  entryEl.appendChild(body);

  if (entry.verdict !== null) {
    const badge = document.createElement('span');
    badge.className = `illum-card-verdict illum-verdict-${entry.verdict}`;
    badge.textContent = verdictLabel(entry.verdict);
    entryEl.appendChild(badge);

    if (entry.decidingLines !== null) {
      appendToggleAndPre(
        entryEl,
        'Show deciding lines',
        'Hide deciding lines',
        entry.decidingLines,
        `illum-lines-${entry.dispatchId}`,
      );
    }
  }

  if (entry.source !== null && entry.source.content !== null) {
    appendToggleAndPre(entryEl, 'Show me the code', 'Hide code', entry.source.content, `illum-code-${entry.dispatchId}`);
  }

  return entryEl;
}

/**
 * `position: fixed`, computed from the live element's own
 * `getBoundingClientRect()`, defaulting to just right of the anchor --
 * clamped against the CURRENT viewport, same discipline as
 * intent-picker.ts's own `renderIntentPicker` positioning (04-03's own
 * fix for the identical symptom class: an unclamped `rect.right + N`
 * placement pushes clean off-screen, unclickable-by-a-real-pointer, for
 * any anchor whose right edge already sits at or near the viewport's own
 * right edge -- an ordinary case for any full-width block element (a
 * `<h1>`/`<p>`/`<div>`, not merely a viewport-edge corner case), NOT
 * equivalent to index.ts's own `positionTriggers()` convention despite
 * this function's prior doc comment claiming so: that convention insets
 * FROM the anchor's own right edge (`rect.right - 20`, always inside the
 * anchor's own already-on-screen bound), where this one had offset PAST
 * it (`rect.right + 8`, unbounded). `container` must already be attached
 * to the DOM (shadowRoot) before this call -- clamping needs the
 * container's own real rendered size, not a guess. */
function positionAt(container: HTMLElement, element: Element): void {
  const rect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Both axes clamp on BOTH sides. The overflow branches alone were not
  // enough: they only fire when the container extends PAST the far edge,
  // and say nothing about an anchor whose own rect starts before the near
  // edge. A `<p>` scrolled above the fold has a NEGATIVE `rect.top`, so
  // `top = rect.top` passed the `top + height > viewportHeight` test
  // untouched and placed the card off-screen upward -- measured at
  // `top: -482px` for a 313px-tall card, i.e. wholly invisible, on the
  // ordinary path of clicking an element and scrolling away. Same asymmetry
  // existed horizontally for an anchor scrolled off to the left.
  //
  // `Math.min` before `Math.max` is deliberate: when the container is
  // LARGER than the viewport, the max wins and the top-left stays pinned on
  // screen, which is the recoverable end of that degenerate case (the card
  // scrolls internally -- see `.illum-card`'s own max-height/overflow-y).
  const left = Math.max(0, Math.min(rect.right + 8, viewportWidth - containerRect.width));
  const top = Math.max(0, Math.min(rect.top, viewportHeight - containerRect.height));

  container.style.left = `${left}px`;
  container.style.top = `${top}px`;
}

/** Appended to `shadowRoot` (by the caller, `renderPendingCard`) BEFORE
 * `positionAt` runs -- see that function's own doc comment for why. */
function buildPendingContainer(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'illum-card-pending';
  container.setAttribute('role', 'status');
  container.textContent = 'thinking…';
  return container;
}

/** MATCHED cards only -- drawer cards render a lighter-weight summary with
 * no action row at all (buildDrawerEntry, below): there is no live element
 * to ground a follow-up dispatch against. Returned UNPOSITIONED -- the
 * caller (`sync`, below) attaches it to `shadowRoot` first, then calls
 * `positionAt`, per that function's own doc comment. */
function buildMatchedCardContainer(
  card: WireCard,
  element: Element,
  actionRenderers: readonly CardActionRenderer[],
  postIntent: (payload: TypedIntentPayload) => void,
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'illum-card';
  container.setAttribute('role', 'region');
  container.setAttribute('aria-label', `Explanation: ${truncateText(card.snapshot.textContent, 60)}`);
  container.dataset.illumCardId = card.cardId;

  for (const entry of card.thread) {
    container.appendChild(renderThreadEntry(entry));
  }

  const actionRow = document.createElement('div');
  actionRow.className = 'illum-card-actions';
  actionRow.setAttribute('data-illum-card-actions', '');
  const latestEntry = card.thread[card.thread.length - 1];
  if (latestEntry) {
    for (const renderAction of actionRenderers) {
      actionRow.appendChild(
        renderAction({ cardId: card.cardId, latestEntry, element, threadRoot: container, postIntent }),
      );
    }
  }
  container.appendChild(actionRow);

  return container;
}

/** The unattached-notes drawer's own lighter-weight summary: the most
 * recent thread entry's markdown snippet, plus `snapshot.textContent` so
 * the reader can tell what the card WAS about. No action row -- there is
 * no live element to ground a follow-up dispatch against. */
function buildDrawerEntry(card: WireCard): HTMLElement {
  const entryEl = document.createElement('div');
  entryEl.className = 'illum-drawer-entry';
  entryEl.dataset.illumCardId = card.cardId;

  const about = document.createElement('div');
  about.className = 'illum-card-header';
  about.textContent = `About: ${truncateText(card.snapshot.textContent, 80)}`;
  entryEl.appendChild(about);

  const latest = card.thread[card.thread.length - 1];
  const summary = document.createElement('div');
  summary.className = 'illum-card-markdown';
  summary.textContent = latest ? truncateText(latest.markdown, 140) : '';
  entryEl.appendChild(summary);

  return entryEl;
}

/** Toggle button + collapsible panel, appended once to `shadowRoot` at
 * controller-creation time -- always present in the DOM (even when empty),
 * so its presence/absence never itself leaks card-count information
 * (T-07-15's own disposition). */
function buildDrawer(shadowRoot: ShadowRoot): { readonly panel: HTMLElement } {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'illum-drawer-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'illum-drawer-panel');
  toggle.textContent = 'Unattached notes';

  const panel = document.createElement('div');
  panel.id = 'illum-drawer-panel';
  panel.className = 'illum-drawer-panel';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Unattached notes');
  panel.hidden = true;

  toggle.addEventListener('click', () => {
    const willShow = panel.hidden;
    panel.hidden = !willShow;
    toggle.setAttribute('aria-expanded', String(willShow));
  });

  shadowRoot.appendChild(toggle);
  shadowRoot.appendChild(panel);
  return { panel };
}

/**
 * `actionRenderers` is rendered, in order, into every MATCHED card's action
 * row (never into drawer/pending cards). `postIntent` is `postTypedIntent`
 * pre-bound to this page's own `loadToken`.
 */
export function createCardsController(
  shadowRoot: ShadowRoot,
  actionRenderers: readonly CardActionRenderer[],
  postIntent: (payload: TypedIntentPayload) => void,
): CardsController {
  const rendered = new Map<string, RenderedEntry>();
  const drawerEntries = new Map<string, HTMLElement>();
  const { panel: drawerPanel } = buildDrawer(shadowRoot);

  /** Removes any PENDING (not real) tracked entry whose dispatchId overlaps
   * `dispatchIds` -- called right before a real card renders for the same
   * dispatch(es), so a placeholder is replaced, never stacked alongside
   * the real card. */
  function removePendingForDispatchIds(dispatchIds: ReadonlySet<string>): void {
    for (const [key, entry] of rendered) {
      if (!key.startsWith(PENDING_KEY_PREFIX)) continue;
      let overlaps = false;
      for (const id of entry.dispatchIds) {
        if (dispatchIds.has(id)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) {
        entry.container.remove();
        rendered.delete(key);
      }
    }
  }

  function removeDrawerEntry(cardId: string): void {
    const existing = drawerEntries.get(cardId);
    if (existing) {
      existing.remove();
      drawerEntries.delete(cardId);
    }
  }

  function ensureDrawerEntry(card: WireCard): void {
    const built = buildDrawerEntry(card);
    const existing = drawerEntries.get(card.cardId);
    if (existing) {
      existing.replaceWith(built);
    } else {
      drawerPanel.appendChild(built);
    }
    drawerEntries.set(card.cardId, built);
  }

  /** See `CardsController.setPresentation`. Defaults to inline so that not
   * calling it leaves every pre-existing behaviour and test untouched. */
  let presentation: 'rail' | 'inline' = 'inline';

  /** Every currently-matched card, tracked independently of whether a
   * floating card is being DRAWN for it. `rendered` cannot serve this
   * purpose: in rail mode it is deliberately empty. Card follow-ups
   * ("go deeper", "explain it back") are dispatched from the rail but must
   * still be built from the card's LIVE element, so this is what the
   * lookup goes through. */
  const matched = new Map<string, { element: Element; latestEntry: WireCardThreadEntry }>();

  function sync(store: WireAnnotationStore, root: ParentNode, excludeRoot: Node, revision: string): void {
    // WireElementSnapshot/WireOrphanRecord are field-for-field identical to
    // identity.ts's ElementSnapshot/OrphanRecord (minus OrphanRecord's own
    // `element` back-reference, which reattachCards()/identity.ts's own
    // reattach() overwrite with the live `beforeList` reference regardless
    // -- see reattach-cards.ts's own doc comment) -- no conversion function
    // needed, just re-supplying `element` so the object satisfies the type.
    const reattachable: ReattachableCard[] = store.cards.map((card) => ({
      cardId: card.cardId,
      snapshot: card.snapshot,
      orphan: card.orphan
        ? {
            element: card.snapshot,
            firstMissRevision: card.orphan.firstMissRevision,
            lastMissRevision: card.orphan.lastMissRevision,
            confirmedOrphan: card.orphan.confirmedOrphan,
          }
        : null,
    }));
    const { matchedElements } = reattachCards(reattachable, root, excludeRoot, revision);

    for (const card of store.cards) {
      const threadDispatchIds = new Set(card.thread.map((entry) => entry.dispatchId));
      const element = matchedElements.get(card.cardId);

      removePendingForDispatchIds(threadDispatchIds);

      if (element) {
        removeDrawerEntry(card.cardId);
        const newest = card.thread[card.thread.length - 1];
        if (newest) matched.set(card.cardId, { element, latestEntry: newest });
        if (presentation === 'rail') {
          // The rail renders this card's body. Reattachment still ran above
          // (the drawer bookkeeping and the trigger markers both depend on
          // knowing WHICH element a card belongs to) -- only the floating
          // copy is skipped. Any previously-rendered floating card for this
          // id is torn down, so flipping modes mid-session is clean.
          rendered.get(card.cardId)?.container.remove();
          rendered.delete(card.cardId);
          continue;
        }
        const built = buildMatchedCardContainer(card, element, actionRenderers, postIntent);
        const existing = rendered.get(card.cardId);
        if (existing) {
          existing.container.replaceWith(built);
        } else {
          shadowRoot.appendChild(built);
        }
        // Positioned AFTER attaching -- positionAt's own viewport-clamping
        // needs the container's real rendered size, only available once it
        // is actually in the shadow tree.
        positionAt(built, element);
        rendered.set(card.cardId, { element, container: built, dispatchIds: threadDispatchIds });
      } else {
        // Not matched this pass -- if it was rendered as a MATCHED card
        // last sync, that rendering must move into the drawer, never
        // disappear silently in between.
        matched.delete(card.cardId);
        const existing = rendered.get(card.cardId);
        if (existing) {
          existing.container.remove();
          rendered.delete(card.cardId);
        }
        ensureDrawerEntry(card);
      }
    }
  }

  function renderPendingCard(dispatchId: string, element: Element): void {
    // The rail shows its own pending row (Rail.addPending), so a floating
    // "thinking..." chip here would be the same duplication as a matched card.
    if (presentation === 'rail') return;
    for (const entry of rendered.values()) {
      if (entry.dispatchIds.has(dispatchId)) return; // already tracked, real or pending -- never duplicate
    }
    const container = buildPendingContainer();
    shadowRoot.appendChild(container);
    positionAt(container, element);
    rendered.set(`${PENDING_KEY_PREFIX}${dispatchId}`, { element, container, dispatchIds: new Set([dispatchId]) });
  }

  function reposition(): void {
    for (const entry of rendered.values()) {
      if (entry.element) positionAt(entry.container, entry.element);
    }
  }

  function setPresentation(mode: 'rail' | 'inline'): void {
    if (mode === presentation) return;
    presentation = mode;
    // Reflected onto the host so the stylesheet can hide the corner drawers
    // in one rule rather than every drawer-owning module reimplementing the
    // same visibility check.
    if (shadowRoot.host instanceof Element) {
      shadowRoot.host.setAttribute('data-presentation', mode);
    }
    if (mode === 'rail') {
      for (const [id, entry] of rendered) {
        entry.container.remove();
        rendered.delete(id);
      }
    }
  }

  /** Runs a card follow-up requested from the chrome rail.
   *
   * Returns false when the card has no live match -- the rail can then say
   * so instead of appearing to have done something. Deliberately re-reads
   * the element through the SAME `buildFollowUpPayload` the in-artifact
   * action buttons use, so a follow-up is grounded in what the artifact
   * says NOW and not in whatever it said when the card was created
   * (T-07-17). */
  function runAction(cardId: string, action: 'deeper' | 'self-explain', learnerNote: string | null): boolean {
    const entry = matched.get(cardId);
    if (!entry) return false;
    postIntent(buildFollowUpPayload(entry.element, entry.latestEntry, action, learnerNote));
    return true;
  }

  return { sync, renderPendingCard, reposition, setPresentation, runAction };
}
