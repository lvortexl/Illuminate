import type { WireAnnotationStore, WireCard, WireCardThreadEntry, WireFinding } from '../sdk/protocol-in.ts';
import type { Intent } from '../shared/intent.ts';
import { verdictLabel } from '../shared/verdict.ts';

/**
 * The chrome shell's review rail -- the persistent right-hand column that
 * `GET /session/:key`'s shell HTML lays out beside the artifact iframe.
 *
 * ## Why this module exists
 *
 * `src/chrome/client.ts` carries the same comment in six places: *"no
 * chrome-shell UI exists yet to surface this to"*. A failed dispatch POST,
 * a failed annotation sync, a superseded artifact load, a degraded
 * staleness watcher and a dismissed finding were all best-effort and all
 * silent. The artifact-side SDK compensated by drawing its own chrome
 * INSIDE the sandboxed iframe -- corner-pinned toggles opening 260x300
 * boxes, and cards absolutely positioned against their anchor element's
 * live `getBoundingClientRect()`.
 *
 * That placement is why a card could render at `top: -482px`, wholly above
 * the viewport, whenever its anchor had been scrolled past: `positionAt`
 * clamped bottom overflow but never top. The clamp is fixed separately,
 * but the deeper problem is that a floating box positioned against a
 * scrolling anchor has no correct answer when the anchor is off-screen.
 * A rail does: the card is in a list, always reachable, and the ELEMENT
 * gets the marker instead.
 *
 * ## Contract
 *
 * `createRail` builds DOM and returns setters. It owns no network and no
 * postMessage: every side effect leaves through the callbacks in
 * `RailOptions`, so client.ts keeps its position as the single place any
 * HTTP call is made (the trust-boundary discipline message-handling.ts's
 * header describes).
 *
 * ## Safety
 *
 * Card markdown, notes, deciding lines and source content are model output
 * and arrive over the wire from a sandboxed artifact. This module assigns
 * them via `textContent` ONLY -- never `innerHTML`, `insertAdjacentHTML`
 * or a `<template>` parse -- mirroring the invariant `src/sdk/cards.ts`
 * already holds and a source-text test already enforces there. Every
 * element here is built with `document.createElement`.
 */

/** A note the human has written but not yet sent. Queued entries live only
 * in this browser tab until `onSend` flushes them -- they are deliberately
 * NOT persisted server-side, because an unsent draft is not a fact about
 * the artifact and must never be visible to an agent polling the session. */
export interface QueuedNote {
  readonly id: string;
  readonly intent: Intent;
  readonly note: string;
  readonly target: RailTarget;
}

/** The artifact element the composer is currently pointed at, as forwarded
 * by the SDK. Structurally the `element`/`anchor` halves of a
 * `TypedIntentPayload`, kept as an opaque record here so this module never
 * needs to know how a dispatch is assembled. */
export interface RailTarget {
  readonly uid: string;
  readonly label: string;
  /** ADR-102: the whole selection this queued note is about, not just the
   * section the row is named after. */
  readonly targets: readonly Readonly<Record<string, unknown>>[];
  /** Already uploaded: ids, never bytes. The rail holds these only to pass
   * them back on send and to show a count on the queued row. */
  readonly attachments: readonly { readonly id: string; readonly mediaType: string }[];
}

export type ConnectionState = 'connecting' | 'live' | 'waiting' | 'lost';

export interface RailOptions {
  /** Flush the queue. Resolves when every entry has been POSTed; the rail
   * clears the queue only on resolve, so a failed send keeps the human's
   * text rather than silently discarding it. */
  readonly onSend: (notes: readonly QueuedNote[]) => Promise<void>;
  readonly onDismissFinding: (fingerprint: string) => void;
  /** Scroll the artifact iframe to an element and flash it. */
  readonly onLocate: (uid: string) => void;
  /** Ask the ARTIFACT to dispatch a follow-up for a card. Not a direct POST:
   * the payload has to be built from the card's live element, which lives on
   * the other side of the iframe boundary. */
  readonly onCardAction: (cardId: string, action: 'deeper' | 'self-explain', learnerNote: string | null) => void;
  readonly onEndSession: () => void;
}

export interface Rail {
  readonly root: HTMLElement;
  setCards(store: WireAnnotationStore): void;
  setFindings(findings: readonly WireFinding[], watcherHealthy: boolean): void;
  /** Adds a note the element composer assembled, unsent. */
  addQueued(note: Omit<QueuedNote, 'id'>): void;
  setConnection(state: ConnectionState): void;
  setArtifactName(name: string): void;
  /** A dispatch was accepted by the daemon but has no answer yet. Renders a
   * pending row immediately, ahead of the next heartbeat-cadence sync.
   *
   * Keyed on `dispatchId`, NOT on the element uid: a stored card's
   * `snapshot.elementUid` is nullable (identity.ts can match an element
   * purely structurally), so a uid-keyed pending row could never be cleared
   * for exactly those cards -- it would sit on "waiting for the agent..."
   * forever next to the answer it was waiting for. A dispatch id appears
   * verbatim in the answered card's own thread, so the match is exact. */
  addPending(dispatchId: string, uid: string, label: string, intent: Intent): void;
  addMessage(from: 'agent' | 'you' | 'system', text: string): void;
  focusCard(uid: string): void;
  /** A one-line statement from illuminate itself (never the agent): a
   * request the daemon rejected, a transport failure. Dismissible. */
  showNotice(text: string): void;
}

type TabId = 'review' | 'findings' | 'conversation';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `src/foo/bar.ts:12-40` from a card's own source record, or the bare path
 * when the range is unresolved. Pure string assembly -- never parsed back. */
function sourceLabel(path: string, startLine: number | null, endLine: number | null): string {
  if (startLine === null || endLine === null) return path;
  return `${path}:${String(startLine)}-${String(endLine)}`;
}

/** The newest thread entry is the one worth showing collapsed; the rest are
 * reachable by expanding. A card with an empty thread is a pending card. */
function latestEntry(card: WireCard): WireCardThreadEntry | null {
  if (card.thread.length === 0) return null;
  return card.thread[card.thread.length - 1] ?? null;
}

function intentLabel(intent: string): string {
  switch (intent) {
    case 'explain':
      return 'Explain';
    case 'verify':
      return 'Verify';
    case 'deeper':
      return 'Go deeper';
    case 'fix-artifact':
      return 'Fix artifact';
    case 'fix-code':
      return 'Fix code';
    default:
      // Never narrowed to a `never` exhaustiveness check: `intent` is
      // untrusted wire data typed as a bare `string` (protocol-in.ts's own
      // documented convention), so an unknown value is a real runtime case
      // and must render rather than throw.
      return intent;
  }
}

export function createRail(options: RailOptions): Rail {
  const root = el('aside', 'il-rail');
  root.setAttribute('aria-label', 'Review');

  // ---- Tabs --------------------------------------------------------
  const tabs = el('div', 'il-tabs');
  tabs.setAttribute('role', 'tablist');

  const tabButtons = new Map<TabId, HTMLButtonElement>();
  const tabCounts = new Map<TabId, HTMLSpanElement>();
  const panels = new Map<TabId, HTMLDivElement>();
  let activeTab: TabId = 'review';

  function makeTab(id: TabId, label: string): void {
    const button = el('button', 'il-tab');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.id = `il-tab-${id}`;
    button.appendChild(document.createTextNode(label));
    const count = el('span', 'il-count', '0');
    count.dataset.zero = 'true';
    button.appendChild(count);
    button.addEventListener('click', () => {
      selectTab(id);
    });
    tabButtons.set(id, button);
    tabCounts.set(id, count);
    tabs.appendChild(button);

    const panel = el('div', 'il-panel');
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    panels.set(id, panel);
  }

  function selectTab(id: TabId): void {
    activeTab = id;
    for (const [tabId, button] of tabButtons) {
      button.setAttribute('aria-selected', tabId === id ? 'true' : 'false');
    }
    for (const [panelId, panel] of panels) {
      panel.hidden = panelId !== id;
    }
  }

  function setCount(id: TabId, n: number): void {
    const count = tabCounts.get(id);
    if (!count) return;
    count.textContent = String(n);
    count.dataset.zero = n === 0 ? 'true' : 'false';
  }

  makeTab('review', 'Review');
  makeTab('findings', 'Findings');
  makeTab('conversation', 'Agent');

  // Sits directly before the panels container (`body`, below) so a
  // dismissible notice from illuminate itself survives `renderReview()`'s
  // `panel.replaceChildren()` -- that rebuild only ever touches `body`'s
  // own descendants, never a root-level sibling.
  const notices = el('div', 'il-rail-notices');

  const body = el('div', 'il-rail-body');
  for (const panel of panels.values()) body.appendChild(panel);

  // ---- Composer ----------------------------------------------------
  // The rail's footer is an action bar, not a composer.
  //
  // It used to hold a textarea, an intent select and a target line, fed by an
  // `illuminate:selectElement` message. The element composer replaced all of
  // it: notes are now written ON the element, where the reader is already
  // looking, with the intent chosen in the same popover. Keeping a second
  // place to type would mean two controls that do the same thing and
  // disagree about which element they mean.
  //
  // What stays here is the thing that is genuinely rail-shaped: the queue is
  // a list, and flushing it is one action over the whole list.
  const compose = el('div', 'il-compose');
  const queueSummary = el('span', 'il-queue-summary');
  const clearButton = el('button', 'il-btn il-btn--sm', 'Clear');
  clearButton.type = 'button';
  const sendButton = el('button', 'il-btn il-btn--primary', 'Send to Agent');
  sendButton.type = 'button';
  const spacer = el('span', 'il-bar-spacer');
  const row = el('div', 'il-compose-row');
  row.append(queueSummary, spacer, clearButton, sendButton);

  const hint = el('div', 'il-compose-hint', 'Click any element in the artifact to write a note about it.');
  compose.append(row, hint);
  root.append(tabs, notices, body, compose);

  // ---- State -------------------------------------------------------
  const queue: QueuedNote[] = [];
  /** Pending dispatches keyed by dispatch id -- see `Rail.addPending` for
   * why not by element uid. `uid` is carried along only so the row can still
   * offer "show me where this is". */
  const pending = new Map<string, { uid: string; label: string; intent: Intent }>();
  let cardStore: WireAnnotationStore = { protocol: '', cards: [] };
  let queueSeq = 0;
  let sending = false;

  function updateSendState(): void {
    const n = queue.length;
    queueSummary.textContent = n === 0 ? 'Nothing queued' : `${String(n)} queued`;
    clearButton.disabled = n === 0 || sending;
    sendButton.disabled = n === 0 || sending;
    sendButton.textContent = sending ? 'Sending…' : n > 0 ? `Send ${String(n)} to Agent` : 'Send to Agent';
  }

  /** Adds a note the element composer already assembled. The rail never
   * builds one itself any more -- it holds them. */
  function addQueued(note: Omit<QueuedNote, 'id'>): void {
    queueSeq += 1;
    queue.push({ ...note, id: `q${String(queueSeq)}` });
    selectTab('review');
    renderReview();
    updateSendState();
  }

  async function flush(): Promise<void> {
    if (queue.length === 0 || sending) return;
    const batch = queue.slice();
    sending = true;
    updateSendState();
    try {
      await options.onSend(batch);
      // Only on success: a rejected send keeps every note in the queue so
      // the human never loses typed text to a transient failure.
      queue.length = 0;
      for (const note of batch) {
        addMessage('you', `${intentLabel(note.intent)} — ${note.target.label}
${note.note}`);
      }
    } catch {
      addMessage('system', 'Could not reach the daemon — your notes are still queued. Try Send again.');
      selectTab('conversation');
    } finally {
      sending = false;
      renderReview();
      updateSendState();
    }
  }

  clearButton.addEventListener('click', () => {
    queue.length = 0;
    renderReview();
    updateSendState();
  });
  sendButton.addEventListener('click', () => {
    void flush();
  });

  // ---- Rendering: Review -------------------------------------------
  /** One thread entry -- an answer, or a graded self-explanation. A card
   * renders EVERY entry, not just the newest: `explain -> deeper -> graded`
   * is one conversation about one element, and reading only the last turn
   * loses the chain that makes the last turn mean anything. This mirrors
   * the in-artifact renderer's own `.illum-card-entry` structure. */
  function buildEntryNode(entry: WireCardThreadEntry): HTMLElement {
    const node = el('div', 'il-card-entry');

    const header = el('div', 'il-card-entry-head');
    header.appendChild(el('span', 'il-card-intent', intentLabel(entry.intent)));
    if (entry.depth > 1) header.appendChild(el('span', 'il-depth', `depth ${String(entry.depth)}`));
    if (entry.verdict !== null) {
      const verdict = el('span', 'il-verdict', verdictLabel(entry.verdict));
      verdict.dataset.v = entry.verdict;
      header.appendChild(verdict);
    }
    node.appendChild(header);

    if (entry.learnerNote !== null) {
      node.appendChild(el('p', 'il-card-note', entry.learnerNote));
    }
    node.appendChild(el('p', 'il-card-text', entry.markdown));

    if (entry.decidingLines !== null && entry.decidingLines.length > 0) {
      // The exact lines the answer turned on. This is the most load-bearing
      // provenance illuminate produces -- a verdict without its deciding
      // lines is an assertion, not a citation -- so it is shown expanded
      // rather than hidden behind a disclosure.
      const deciding = el('div', 'il-deciding');
      deciding.appendChild(el('div', 'il-deciding-label', 'Deciding lines'));
      deciding.appendChild(el('pre', 'il-code il-code--open', entry.decidingLines));
      node.appendChild(deciding);
    }

    if (entry.source?.content != null && entry.source.content.length > 0) {
      const code = el('pre', 'il-code', entry.source.content);
      code.hidden = true;
      const toggle = el('button', 'il-disclosure', 'Show the code');
      toggle.type = 'button';
      toggle.addEventListener('click', () => {
        code.hidden = !code.hidden;
        toggle.textContent = code.hidden ? 'Show the code' : 'Hide the code';
      });
      node.append(toggle, code);
    }

    // Which model, at which tier, answered this -- and at which revision the
    // cited source was read. illuminate's whole claim is that an explanation
    // is checkable, and an unattributed answer is not.
    const provenance = [entry.model, entry.tier];
    if (entry.source?.rev != null && entry.source.rev.length > 0) {
      provenance.push(`@ ${entry.source.rev.slice(0, 7)}`);
    }
    node.appendChild(el('div', 'il-card-meta', provenance.join(' · ')));

    return node;
  }

  function buildCardNode(card: WireCard): HTMLElement {
    const entry = latestEntry(card);
    const node = el('div', 'il-card');
    // `elementUid` is null for a card whose element was identified purely
    // structurally (identity.ts's reattach path) -- `cardId` is the stable
    // fallback key, and the rail only ever uses this to scroll to a row.
    node.dataset.uid = card.snapshot.elementUid ?? card.cardId;
    node.dataset.cardId = card.cardId;

    const head = el('div', 'il-card-head');
    const src = el('span', 'il-card-src');
    src.textContent = card.snapshot.anchor
      ? sourceLabel(card.snapshot.anchor.path, card.snapshot.anchor.startLine, card.snapshot.anchor.endLine)
      : card.snapshot.structuralPath;
    head.appendChild(src);
    // A card whose element is no longer in the artifact. Previously this
    // moved to a separate corner drawer; in the rail it stays in the list and
    // says so, because a card that vanishes from where you last saw it reads
    // as data loss even when nothing was lost.
    if (card.orphan?.confirmedOrphan === true) {
      node.dataset.orphan = 'true';
      const badge = el('span', 'il-orphan', 'unattached');
      badge.title = 'The element this card was about is no longer in the artifact.';
      head.appendChild(badge);
    }
    const locate = el('button', 'il-card-locate', '↗');
    locate.type = 'button';
    locate.title = 'Show me where this is';
    locate.addEventListener('click', () => {
      options.onLocate(card.snapshot.elementUid ?? card.cardId);
    });
    head.appendChild(locate);
    node.appendChild(head);

    const cardBody = el('div', 'il-card-body');
    if (entry === null) {
      node.dataset.state = 'pending';
      cardBody.appendChild(el('span', 'il-pending', 'waiting for the agent…'));
      node.appendChild(cardBody);
      return node;
    }
    for (const threadEntry of card.thread) cardBody.appendChild(buildEntryNode(threadEntry));
    node.appendChild(cardBody);

    // The actions act on the card's NEWEST entry -- "go deeper" means one
    // rung past wherever the thread currently ends, never past its start.
    const foot = el('div', 'il-card-foot');
    const deeper = el('button', 'il-btn il-btn--sm', 'Go deeper');
    deeper.type = 'button';
    deeper.addEventListener('click', () => {
      options.onCardAction(card.cardId, 'deeper', null);
      deeper.disabled = true;
      deeper.textContent = 'Going deeper…';
    });
    foot.appendChild(deeper);

    // Labels are the in-artifact action's own, verbatim: "Check my
    // understanding" opens the box and "Grade my understanding" submits it.
    // The rail replaced the surface, not the product's language.
    const explainBack = el('button', 'il-btn il-btn--sm', 'Check my understanding');
    explainBack.type = 'button';
    foot.appendChild(explainBack);

    const selfExplain = el('div', 'il-self-explain');
    selfExplain.hidden = true;
    const area = el('textarea', 'il-self-explain-textarea');
    area.placeholder = 'Explain this in your own words…';
    area.setAttribute('aria-label', 'Your explanation');
    const submit = el('button', 'il-btn il-btn--sm il-btn--primary', 'Grade my understanding');
    submit.type = 'button';
    submit.disabled = true;
    area.addEventListener('input', () => {
      submit.disabled = area.value.trim().length === 0;
    });
    submit.addEventListener('click', () => {
      options.onCardAction(card.cardId, 'self-explain', area.value.trim());
      selfExplain.replaceChildren(el('span', 'il-pending', 'grading…'));
    });
    selfExplain.append(area, submit);
    explainBack.addEventListener('click', () => {
      selfExplain.hidden = !selfExplain.hidden;
      if (!selfExplain.hidden) area.focus();
    });

    node.append(foot, selfExplain);
    return node;
  }

  function buildQueuedNode(note: QueuedNote): HTMLElement {
    const node = el('div', 'il-queued');
    const head = el('div', 'il-queued-head');
    head.appendChild(el('span', 'il-queued-intent', intentLabel(note.intent)));
    head.appendChild(el('span', 'il-queued-src', note.target.label));
    const remove = el('button', 'il-compose-clear', '×');
    remove.type = 'button';
    remove.title = 'Remove from queue';
    remove.addEventListener('click', () => {
      const index = queue.findIndex((q) => q.id === note.id);
      if (index >= 0) queue.splice(index, 1);
      renderReview();
      updateSendState();
    });
    head.appendChild(remove);
    node.appendChild(head);
    node.appendChild(el('p', 'il-queued-note', note.note));
    if (note.target.attachments.length > 0) {
      const n = note.target.attachments.length;
      node.appendChild(el('div', 'il-queued-attach', `${String(n)} image${n === 1 ? '' : 's'} attached`));
    }
    return node;
  }

  function renderReview(): void {
    const panel = panels.get('review');
    if (!panel) return;
    panel.replaceChildren();

    for (const note of queue) panel.appendChild(buildQueuedNode(note));

    for (const [dispatchId, info] of pending) {
      const node = el('div', 'il-card');
      node.dataset.state = 'pending';
      node.dataset.uid = info.uid;
      node.dataset.dispatchId = dispatchId;
      const head = el('div', 'il-card-head');
      head.appendChild(el('span', 'il-card-intent', intentLabel(info.intent)));
      head.appendChild(el('span', 'il-card-src', info.label));
      node.appendChild(head);
      const cardBody = el('div', 'il-card-body');
      cardBody.appendChild(el('span', 'il-pending', 'waiting for the agent…'));
      node.appendChild(cardBody);
      panel.appendChild(node);
    }

    for (const card of cardStore.cards) panel.appendChild(buildCardNode(card));

    if (panel.childElementCount === 0) {
      const empty = el('div', 'il-empty');
      empty.appendChild(el('div', 'il-empty-title', 'Nothing under review yet'));
      const hintText = el('div', 'il-empty-hint');
      hintText.appendChild(document.createTextNode('Click any element in the artifact, write what you want, then '));
      hintText.appendChild(el('span', 'il-kbd', 'Ctrl+Enter'));
      hintText.appendChild(document.createTextNode('.'));
      empty.appendChild(hintText);
      panel.appendChild(empty);
    }

    setCount('review', queue.length + cardStore.cards.length + pending.size);
  }

  // ---- Rendering: Findings -----------------------------------------
  const degraded = el('div', 'il-degraded', 'Staleness watching is degraded — findings may be out of date.');
  degraded.hidden = true;

  function renderFindings(findings: readonly WireFinding[]): void {
    const panel = panels.get('findings');
    if (!panel) return;
    panel.replaceChildren(degraded);

    for (const finding of findings) {
      const node = el('div', 'il-finding');
      node.dataset.kind = finding.rule;
      node.appendChild(
        el(
          'div',
          'il-finding-kind',
          finding.rule === 'lost' ? 'Cited code is gone' : 'Cited code changed',
        ),
      );
      node.appendChild(
        el('div', 'il-finding-src', sourceLabel(finding.target.path, finding.target.startLine, finding.target.endLine)),
      );
      const foot = el('div', 'il-finding-foot');
      const dismiss = el('button', 'il-btn il-btn--sm', 'Dismiss');
      dismiss.type = 'button';
      dismiss.addEventListener('click', () => {
        options.onDismissFinding(finding.fingerprint);
        node.remove();
      });
      foot.appendChild(dismiss);
      node.appendChild(foot);
      panel.appendChild(node);
    }

    if (findings.length === 0) {
      const empty = el('div', 'il-empty');
      empty.appendChild(el('div', 'il-empty-title', 'Everything still matches'));
      empty.appendChild(
        el('div', 'il-empty-hint', 'Each claim in this artifact still points at code that exists and has not changed.'),
      );
      panel.appendChild(empty);
    }
    setCount('findings', findings.length);
  }

  // ---- Rendering: Conversation -------------------------------------
  let messageCount = 0;

  function addMessage(from: 'agent' | 'you' | 'system', text: string): void {
    const panel = panels.get('conversation');
    if (!panel) return;
    const emptyState = panel.querySelector('.il-empty');
    if (emptyState) emptyState.remove();
    const node = el('div', 'il-msg');
    node.dataset.from = from;
    node.appendChild(el('div', 'il-msg-who', from === 'agent' ? 'Agent' : from === 'you' ? 'You' : 'illuminate'));
    node.appendChild(el('p', 'il-msg-text', text));
    panel.appendChild(node);
    messageCount += 1;
    setCount('conversation', messageCount);
    if (activeTab === 'conversation') node.scrollIntoView({ block: 'nearest' });
  }

  function renderConversationEmpty(): void {
    const panel = panels.get('conversation');
    if (!panel || panel.childElementCount > 0) return;
    const empty = el('div', 'il-empty');
    empty.appendChild(el('div', 'il-empty-title', 'No word from the agent yet'));
    empty.appendChild(
      el('div', 'il-empty-hint', 'Anything you send lands here, alongside whatever the agent sends back.'),
    );
    panel.appendChild(empty);
  }

  // ---- Public surface ----------------------------------------------
  selectTab('review');
  renderReview();
  renderFindings([]);
  renderConversationEmpty();
  updateSendState();

  return {
    root,
    setCards(store: WireAnnotationStore): void {
      cardStore = store;
      // A pending row clears when its dispatch id turns up in a real card's
      // thread -- the answer has landed, so the placeholder has been replaced
      // rather than merely joined.
      for (const card of store.cards) {
        for (const entry of card.thread) pending.delete(entry.dispatchId);
      }
      renderReview();
    },
    setFindings(findings: readonly WireFinding[], watcherHealthy: boolean): void {
      degraded.hidden = watcherHealthy;
      renderFindings(findings);
    },
    addQueued,
    setConnection(): void {
      // Owned by the top bar, not the rail -- see client.ts's own
      // `setConnection`. Kept on this interface so callers have one object
      // to talk to; deliberately inert here.
    },
    setArtifactName(): void {
      // Same as setConnection -- the bar owns it.
    },
    addPending(dispatchId: string, uid: string, label: string, intent: Intent): void {
      pending.set(dispatchId, { uid, label, intent });
      renderReview();
    },
    addMessage,
    focusCard(uid: string): void {
      selectTab('review');
      const node = panels.get('review')?.querySelector(`[data-uid="${CSS.escape(uid)}"]`);
      if (!(node instanceof HTMLElement)) return;
      node.dataset.focus = 'true';
      node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      setTimeout(() => {
        delete node.dataset.focus;
      }, 1600);
    },
    showNotice(text: string): void {
      const notice = el('div', 'il-rail-notice');
      notice.setAttribute('role', 'status');
      notice.appendChild(el('span', 'il-rail-notice-text', text));
      const dismiss = el('button', 'il-btn il-btn--sm', 'Dismiss');
      dismiss.type = 'button';
      dismiss.addEventListener('click', () => {
        notice.remove();
      });
      notice.appendChild(dismiss);
      notices.appendChild(notice);
    },
  };
}
