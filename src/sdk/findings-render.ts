/// <reference lib="dom" />
// See addressing.ts's own top-of-file comment for why this directive is
// needed: this file is bundled under tsconfig.browser.json (lib: DOM) AND
// imported transitively by test/sdk/findings-render.test.ts under the root
// (no-DOM) tsconfig -- the pure functions below need no DOM type at all,
// but createFindingsController does, so this whole file carries the same
// directive cards.ts/snapshot.ts already establish for exactly this split.

import type { WireFinding, WireFindingsSync } from './protocol-in.ts';

/**
 * Plan 08-05's own quiet-default rendering logic (STAL-02): `unchanged`/
 * `moved` targets produce no marker at all (there is no third/fourth
 * variant of this union -- the Phase 5 spike's own caveat is exactly why
 * this codebase never renders those two states as anything). `touched` and
 * `lost` are the only two states a reader ever sees, and they are always
 * visually distinct (shadow-style.ts's own `::after` corner-dot colors).
 */
export type FindingMarkerState = 'touched' | 'lost' | null;

export interface FindingLookupTarget {
  readonly path: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

function targetsEqual(a: FindingLookupTarget, b: FindingLookupTarget): boolean {
  return a.path === b.path && a.startLine === b.startLine && a.endLine === b.endLine;
}

/** Pure. Looks up every OPEN finding whose `target` exactly matches
 * `target` (path + both range endpoints, including the whole-file
 * null/null case), across BOTH rules. `recordAbsence`'s own discipline
 * (findings-store.ts) keeps the two rules mutually exclusive-when-open for
 * a given target across an ordinary scan sequence, but this function
 * defensively prefers `'lost'` over `'touched'` if both were somehow open
 * at once -- the stronger signal wins, never a silent arbitrary pick.
 * Non-'open' findings (resolved/dismissed) never produce a marker. */
export function findingStateForTarget(
  findings: readonly WireFinding[],
  target: FindingLookupTarget,
): FindingMarkerState {
  let touchedFound = false;
  let lostFound = false;
  for (const finding of findings) {
    if (finding.status !== 'open') continue;
    if (!targetsEqual(target, finding.target)) continue;
    if (finding.rule === 'drift-lost') lostFound = true;
    else if (finding.rule === 'drift-touched') touchedFound = true;
  }
  if (lostFound) return 'lost';
  if (touchedFound) return 'touched';
  return null;
}

/** Every finding with `status === 'open'`, preserving the wire payload's
 * own order -- exactly what the drawer lists. */
export function openFindings(findings: readonly WireFinding[]): readonly WireFinding[] {
  return findings.filter((finding) => finding.status === 'open');
}

interface RegisteredTrigger {
  readonly button: HTMLElement;
  readonly target: FindingLookupTarget;
  /** The trigger's own aria-label as index.ts first set it (`Review: ...`),
   * captured once at registration time -- every later `sync()` recomputes
   * the label AS `baseAriaLabel` plus (at most) one suffix, rather than
   * repeatedly appending onto whatever the label already carries. */
  readonly baseAriaLabel: string;
}

export interface FindingsController {
  /** Called once per anchored trigger at boot (index.ts's existing
   * `triggers` construction loop), before the first `sync`. */
  registerTrigger(button: HTMLElement, target: FindingLookupTarget): void;
  /** Called on every heartbeat-cadence illuminate:syncFindings message.
   * Updates every registered trigger's marker class (`illum-trigger--touched`
   * / `illum-trigger--lost` / neither), rebuilds the drawer's finding list
   * from `openFindings(payload.findings)`, and reflects
   * `payload.meta.watcherHealthy` on the drawer toggle
   * (`illum-findings-toggle--degraded` class + updated aria-label when
   * `false`). Idempotent. */
  sync(payload: WireFindingsSync): void;
}

/** Toggle button + collapsible panel, appended once to `shadowRoot` at
 * controller-creation time -- always present in the DOM (even when empty),
 * mirroring cards.ts's own `buildDrawer` (T-07-15's own disposition: the
 * panel's presence/absence must never itself leak finding-count
 * information). Positioned bottom-LEFT (shadow-style.ts) so it never
 * overlaps the existing unattached-notes drawer at bottom-right. */
function buildFindingsDrawer(shadowRoot: ShadowRoot): { readonly toggle: HTMLElement; readonly panel: HTMLElement } {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'illum-findings-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'illum-findings-panel');
  toggle.textContent = 'Findings';

  const panel = document.createElement('div');
  panel.id = 'illum-findings-panel';
  panel.className = 'illum-findings-panel';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Staleness findings');
  panel.hidden = true;

  toggle.addEventListener('click', () => {
    const willShow = panel.hidden;
    panel.hidden = !willShow;
    toggle.setAttribute('aria-expanded', String(willShow));
  });

  shadowRoot.appendChild(toggle);
  shadowRoot.appendChild(panel);
  return { toggle, panel };
}

/** One `.illum-finding-entry` per open finding -- `target.path`(+range if
 * present) rendered via `.textContent` only (T-08-13), never HTML-parsed,
 * plus a `.illum-finding-dismiss` button wired directly to `postDismiss`. */
function buildFindingEntry(finding: WireFinding, postDismiss: (fingerprint: string) => void): HTMLElement {
  const entryEl = document.createElement('div');
  entryEl.className = 'illum-finding-entry';

  const label = document.createElement('div');
  const range =
    finding.target.startLine !== null && finding.target.endLine !== null
      ? `:L${finding.target.startLine}-L${finding.target.endLine}`
      : '';
  label.textContent = `${finding.target.path}${range}`;
  entryEl.appendChild(label);

  const dismissButton = document.createElement('button');
  dismissButton.type = 'button';
  dismissButton.className = 'illum-finding-dismiss';
  dismissButton.textContent = 'Dismiss';
  dismissButton.addEventListener('click', () => postDismiss(finding.fingerprint));
  entryEl.appendChild(dismissButton);

  return entryEl;
}

/** `postDismiss` is `postDismissFinding` (src/sdk/post.ts) pre-bound to
 * this page's own `loadToken`, mirroring `createCardsController`'s own
 * `postIntent` pre-binding convention. Builds and appends the drawer
 * toggle+panel to `shadowRoot` at construction time -- ALWAYS present
 * (mirroring cards.ts's own unattached-notes drawer: its presence/absence
 * must never itself leak finding-count information). The drawer never
 * auto-opens; the toggle button is the only way it becomes visible. */
export function createFindingsController(
  shadowRoot: ShadowRoot,
  postDismiss: (fingerprint: string) => void,
): FindingsController {
  const triggers: RegisteredTrigger[] = [];
  const { toggle, panel } = buildFindingsDrawer(shadowRoot);
  const panelEntries = new Map<string, HTMLElement>();

  function registerTrigger(button: HTMLElement, target: FindingLookupTarget): void {
    triggers.push({ button, target, baseAriaLabel: button.getAttribute('aria-label') ?? '' });
  }

  /** NEVER language implying the claim itself is wrong -- "code behind this
   * may have changed" / "cited code could not be found", never "wrong" or
   * "broken" (this plan's own objective). */
  function applyTriggerState(trigger: RegisteredTrigger, findings: readonly WireFinding[]): void {
    const state = findingStateForTarget(findings, trigger.target);
    trigger.button.classList.remove('illum-trigger--touched', 'illum-trigger--lost');
    if (state === 'touched') {
      trigger.button.classList.add('illum-trigger--touched');
      trigger.button.setAttribute('aria-label', `${trigger.baseAriaLabel} (code behind this may have changed)`);
    } else if (state === 'lost') {
      trigger.button.classList.add('illum-trigger--lost');
      trigger.button.setAttribute('aria-label', `${trigger.baseAriaLabel} (cited code could not be found)`);
    } else {
      trigger.button.setAttribute('aria-label', trigger.baseAriaLabel);
    }
  }

  function syncPanel(open: readonly WireFinding[]): void {
    const seen = new Set<string>();
    for (const finding of open) {
      seen.add(finding.fingerprint);
      const built = buildFindingEntry(finding, postDismiss);
      const existing = panelEntries.get(finding.fingerprint);
      if (existing) {
        existing.replaceWith(built);
      } else {
        panel.appendChild(built);
      }
      panelEntries.set(finding.fingerprint, built);
    }
    for (const [fingerprint, el] of panelEntries) {
      if (!seen.has(fingerprint)) {
        el.remove();
        panelEntries.delete(fingerprint);
      }
    }
  }

  function syncDegraded(watcherHealthy: boolean): void {
    toggle.classList.toggle('illum-findings-toggle--degraded', !watcherHealthy);
    toggle.textContent = watcherHealthy ? 'Findings' : 'Findings (degraded)';
    toggle.setAttribute(
      'aria-label',
      watcherHealthy ? 'Findings' : 'Findings (staleness watcher degraded -- detection may be delayed)',
    );
  }

  function sync(payload: WireFindingsSync): void {
    for (const trigger of triggers) applyTriggerState(trigger, payload.findings);
    syncPanel(openFindings(payload.findings));
    syncDegraded(payload.meta.watcherHealthy);
  }

  return { registerTrigger, sync };
}
