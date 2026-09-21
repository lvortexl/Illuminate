// Original to illuminate -- no lavish-axi equivalent exists (annotations/cards
// are a Phase 7 addition). Not attribution-bearing.

/**
 * Turns a real `AnnotationStore` (src/store/annotation-store.ts, Phase 7's
 * own durable sidecar schema) into a static, read-only HTML appendix --
 * this phase's own answer to "what happens to accumulated cards on
 * export."
 *
 * DESIGN DECISION -- static appendix, not a live floating overlay: the
 * live SDK's card renderer (src/sdk/cards.ts) positions each card with
 * `position: fixed`, computed at runtime from `element.getBoundingClientRect()`,
 * re-run on scroll/resize, and re-anchored against a live DOM via
 * src/provenance/identity.ts's tiered matching whenever the store changes.
 * None of that machinery exists in a standalone exported file with
 * illuminate not running -- reproducing it would mean shipping a chunk of
 * the live SDK (and its own DOM-manipulation surface) into the "one
 * self-contained file" EXP-01 promises, and re-running element-matching
 * against a document that, once exported, never changes again anyway (a
 * frozen file has no "next regeneration" to reconcile against). A plain,
 * always-visible, read-only appendix -- one block per card, labeled by its
 * anchor, each thread entry shown in full, no toggles, no JS at all --
 * satisfies "materialised as real markup" (ROADMAP.md's Phase 9 success
 * criterion #2) with zero added attack surface, zero added script, and
 * zero risk of the appendix ever interfering with or restyling the
 * artifact's own content.
 *
 * The live/orphaned distinction the daemon tracks does not carry the same
 * meaning in a frozen file -- an orphan marker is surfaced as a plain "no
 * longer found as of revision X" label on the same appendix entry here,
 * not a separate drawer (there is no drawer -- there is nothing left to
 * reattach to).
 *
 * Every piece of text that originates from a model, a learner, or resolved
 * source content is untrusted and is passed through `escapeHtml` before
 * interpolation into the returned string -- the string-based-generation
 * equivalent of cards.ts's `.textContent`-only discipline (T-07-14): there
 * is no DOM here to lean on, so the escaping is done explicitly, by this
 * file, for every one of those fields (T-09-03).
 *
 * This module does no DOM manipulation and returns a plain string -- it is
 * safe to import from a Node/CLI context (09-04's export command).
 */

import type { AnnotationStore, Card, CardThreadEntry } from '../store/annotation-store.ts';
import { labelFor } from '../sdk/intent-picker.ts';
import { truncateText } from '../sdk/addressing.ts';
import { verdictLabel } from '../shared/verdict.ts';


// Explicit four-character-class escape -- no dependency, mirrors cards.ts's
// own .textContent-only discipline (T-07-14) for a surface with no DOM to
// enforce it structurally. Applied to every string this module interpolates
// into the returned HTML, not only the 5 fields the threat model names by
// example -- escaping is the default, not an opt-in per field.
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The card's own header label: `path#Lstart-Lend @ rev` when the anchor
 * carries a range AND the card's founding thread entry resolved a source
 * with a rev (`ElementSnapshot.anchor` itself carries no rev field -- it is
 * a re-attachment identity snapshot, not a provenance record; the rev
 * shown here, when available, is read from the founding entry's own
 * `CardSource`, never fabricated), `path` alone when the anchor carries no
 * range, or the literal `(unanchored)` when `card.snapshot.anchor` is
 * `null`.
 */
function formatAnchorLabel(card: Card): string {
  const anchor = card.snapshot.anchor;
  if (anchor === null) return '(unanchored)';
  if (anchor.startLine === null || anchor.endLine === null) return anchor.path;

  const rangePart = `#L${anchor.startLine}-L${anchor.endLine}`;
  const foundingRev = card.thread[0]?.source?.rev ?? null;
  const revPart = foundingRev !== null ? ` @ ${foundingRev}` : '';
  return `${anchor.path}${rangePart}${revPart}`;
}

function renderThreadEntry(entry: CardThreadEntry): string {
  const headerParts = [labelFor(entry.intent), `${entry.model} (${entry.tier})`];
  if (entry.source !== null) {
    const rangePart =
      entry.source.range !== null ? `:L${entry.source.range.startLine}-L${entry.source.range.endLine}` : '';
    headerParts.push(`${entry.source.path}${rangePart} @ ${entry.source.rev ?? 'unpinned'}`);
  }
  const header = `<div class="illum-export-entry-header">${escapeHtml(headerParts.join(' · '))}</div>`;

  const learnerNoteBlock =
    entry.learnerNote !== null
      ? `<div class="illum-export-learner-note">Your explanation: ${escapeHtml(entry.learnerNote)}</div>`
      : '';

  const markdownBlock = `<pre class="illum-export-markdown">${escapeHtml(entry.markdown)}</pre>`;

  let verdictBlock = '';
  if (entry.verdict !== null) {
    verdictBlock = `<div class="illum-export-verdict illum-export-verdict-${escapeHtml(entry.verdict)}">${escapeHtml(verdictLabel(entry.verdict))}</div>`;
    if (entry.decidingLines !== null) {
      verdictBlock += `<pre class="illum-export-deciding-lines">${escapeHtml(entry.decidingLines)}</pre>`;
    }
  }

  const sourceBlock =
    entry.source !== null && entry.source.content !== null
      ? `<pre class="illum-export-source">${escapeHtml(entry.source.content)}</pre>`
      : '';

  return `<div class="illum-export-entry">${header}${learnerNoteBlock}${markdownBlock}${verdictBlock}${sourceBlock}</div>`;
}

function renderCard(card: Card): string {
  const anchorLabel = formatAnchorLabel(card);
  const about = truncateText(card.snapshot.textContent, 80);
  const header = `<header class="illum-export-card-header">${escapeHtml(anchorLabel)} — ${escapeHtml(about)}</header>`;

  const orphanBlock =
    card.orphan !== null
      ? `<div class="illum-export-orphan">No longer found in the artifact as of revision ${escapeHtml(card.orphan.lastMissRevision)}.</div>`
      : '';

  const entries = card.thread.map(renderThreadEntry).join('');

  return `<article class="illum-export-card" data-illum-card-id="${escapeHtml(card.cardId)}">${header}${orphanBlock}${entries}</article>`;
}

/**
 * Builds the complete export appendix for `store`. Never throws, never
 * drops a card -- every card in `store.cards`, matched or orphaned,
 * anchored or not, is represented. An empty store still returns the
 * stable, greppable wrapper (`#illum-export-cards`) with zero card
 * entries -- never an error, never a misleading "ask a question" prompt
 * (there is no daemon here to ask).
 */
export function materializeCards(store: AnnotationStore): string {
  const cards = store.cards.map(renderCard).join('');
  return `<section id="illum-export-cards">${cards}</section>`;
}
