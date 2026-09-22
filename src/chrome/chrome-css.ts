/**
 * The chrome shell's own stylesheet, inlined into `GET /session/:key`'s
 * shell HTML by server.ts's `handleOpenSession`.
 *
 * Kept as a plain exported string constant rather than a `.css` file for
 * the same reason `src/sdk/shadow-style.ts` is -- this file stays
 * importable and testable under plain `node --test` with zero bundler
 * involvement (see 04-01-PLAN.md Task 2 on why esbuild's `.css` text
 * loader is deliberately not used).
 *
 * This is the SHELL's stylesheet, not the artifact's. It never reaches the
 * sandboxed iframe and never travels with `illuminate export` -- the
 * exported standalone artifact carries only `shadow-style.ts`'s SHADOW_CSS.
 * Nothing here may reference a remote URL (no @import, no url(https://),
 * no webfont): SERVE-10's zero-outbound-request proof covers this document
 * too, and a source-wide test asserts no un-warned remote reference
 * survives an export.
 *
 * ## Design direction
 *
 * The chrome is an instrument, not a destination. The artifact is the
 * content; this stylesheet's whole job is to stay quieter than whatever it
 * frames while still being legible. Three rules follow from that:
 *
 * 1. **Recede by default, assert on state.** Surfaces sit within one or
 *    two steps of the page ink. Colour is spent only where it carries
 *    meaning -- a verdict, a stale anchor, an unsent note. Chrome that is
 *    merely present is never coloured.
 * 2. **Density without squinting.** The previous chrome ran 11px system-ui
 *    throughout, which is below comfortable reading size for prose and was
 *    a real part of "graphically it is bad". Body text is 13px/1.55.
 *    10px is reserved for uppercase tracked labels, where it reads as a
 *    typographic register rather than as small text.
 * 3. **One accent.** Amber carries illuminate's identity and marks the one
 *    thing the human is meant to act on next. Blue is retained only for
 *    focus rings, where a distinct non-semantic colour is an accessibility
 *    asset rather than a second brand voice.
 */

/** The token layer. Split from the rules below so a future theme swap is a
 * single-block edit and so the scale is reviewable on its own terms -- the
 * old stylesheet's problem was never that it was hand-written, it was that
 * it had no scale to be consistent with. */
const TOKENS = `
:root {
  /* Surfaces, darkest to lightest. The stage (artifact backdrop) is the
     darkest so the artifact itself reads as the lit object. */
  --il-stage: #06080b;
  --il-bg: #0b0d10;
  --il-surface: #12151a;
  --il-surface-raised: #181c23;
  --il-hairline: #1f242c;
  --il-hairline-strong: #2b323c;

  /* Ink. Four steps is enough; a fifth always ends up used arbitrarily. */
  --il-ink: #e8eaed;
  --il-ink-muted: #a6adb8;
  --il-ink-faint: #6d7684;
  --il-ink-ghost: #4a515c;

  /* One accent. */
  --il-accent: #d9a441;
  --il-accent-soft: rgba(217, 164, 65, 0.14);
  --il-accent-line: rgba(217, 164, 65, 0.42);

  /* Semantic state. Reused verbatim by verdicts, findings and markers so
     "amber" means the same thing everywhere it appears. */
  --il-ok: #5dd39e;
  --il-ok-soft: rgba(93, 211, 158, 0.14);
  --il-warn: #d9a441;
  --il-warn-soft: rgba(217, 164, 65, 0.14);
  --il-bad: #e5695f;
  --il-bad-soft: rgba(229, 105, 95, 0.14);

  /* Focus only. Deliberately not a brand colour. */
  --il-focus: #4da3ff;

  /* Space scale: 4px base, no arbitrary in-between values. */
  --il-s1: 4px;
  --il-s2: 8px;
  --il-s3: 12px;
  --il-s4: 16px;
  --il-s5: 24px;
  --il-s6: 32px;

  --il-r1: 4px;
  --il-r2: 6px;
  --il-r3: 10px;

  --il-font: system-ui, -apple-system, "Segoe UI", sans-serif;
  --il-mono: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, monospace;

  --il-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);

  --il-rail-w: 380px;
  --il-bar-h: 44px;

  /* Motion. Two durations: state, and anything that moves geometry. */
  --il-t-state: 120ms;
  --il-t-move: 200ms;
  --il-ease: cubic-bezier(0.2, 0, 0.2, 1);
}

@media (prefers-reduced-motion: reduce) {
  :root { --il-t-state: 0ms; --il-t-move: 0ms; }
}
`;

export const CHROME_CSS = `${TOKENS}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--il-bg);
  color: var(--il-ink);
  font: 13px/1.55 var(--il-font);
  overflow: hidden;
}
:focus-visible { outline: 2px solid var(--il-focus); outline-offset: 2px; }

/* ---- Layout -------------------------------------------------------- */
/* The structural change this whole redesign rests on: the artifact iframe
   no longer fills the viewport (position:fixed;inset:0). It is a grid
   cell, which is what makes a persistent rail able to exist at all. The
   iframe still needs explicit sizing -- an unstyled <iframe> falls back to
   the HTML spec's 300x150 replaced-element size regardless of its grid
   cell, the exact symptom 07-06 and 04-03 both hit. */
.il-app {
  display: grid;
  grid-template-columns: 1fr var(--il-rail-w);
  grid-template-rows: var(--il-bar-h) 1fr;
  grid-template-areas: "bar bar" "stage rail";
  height: 100vh;
  width: 100vw;
}
.il-app[data-rail="collapsed"] { grid-template-columns: 1fr 0; }
.il-app[data-rail="collapsed"] .il-rail { display: none; }

.il-bar {
  grid-area: bar;
  display: flex;
  align-items: center;
  gap: var(--il-s3);
  padding: 0 var(--il-s3);
  background: var(--il-bg);
  border-bottom: 1px solid var(--il-hairline);
}
.il-stage {
  grid-area: stage;
  position: relative;
  background: var(--il-stage);
  min-width: 0;
  min-height: 0;
}
#illuminate-artifact-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: none;
  background: var(--il-stage);
}
.il-rail {
  grid-area: rail;
  display: grid;
  grid-template-rows: auto 1fr auto;
  min-height: 0;
  background: var(--il-surface);
  border-left: 1px solid var(--il-hairline);
}

/* ---- Top bar ------------------------------------------------------- */
.il-brand {
  display: flex;
  align-items: baseline;
  gap: var(--il-s2);
  font-weight: 600;
  letter-spacing: -0.01em;
}
.il-brand-mark { color: var(--il-accent); }
.il-brand-file {
  font: 11px/1 var(--il-mono);
  color: var(--il-ink-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40ch;
}
.il-bar-spacer { flex: 1; }

/* Connection state. Reads as a fact, not an alarm -- the only loud
   variant is the one the human must act on. */
.il-conn {
  display: inline-flex;
  align-items: center;
  gap: var(--il-s2);
  font: 10px/1 var(--il-font);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--il-ink-faint);
}
.il-conn::before {
  content: "";
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--il-ink-ghost);
  transition: background var(--il-t-state) var(--il-ease);
}
.il-conn[data-state="live"]::before { background: var(--il-ok); }
.il-conn[data-state="waiting"]::before { background: var(--il-warn); }
.il-conn[data-state="lost"]::before { background: var(--il-bad); }
.il-conn[data-state="lost"] { color: var(--il-bad); }

/* ---- Buttons ------------------------------------------------------- */
.il-btn {
  appearance: none;
  border: 1px solid var(--il-hairline-strong);
  background: var(--il-surface-raised);
  color: var(--il-ink);
  font: 12px/1 var(--il-font);
  padding: 7px 11px;
  border-radius: var(--il-r1);
  cursor: pointer;
  transition: background var(--il-t-state) var(--il-ease),
              border-color var(--il-t-state) var(--il-ease),
              color var(--il-t-state) var(--il-ease);
}
.il-btn:hover { background: #1e232b; border-color: #39414d; }
.il-btn:disabled { opacity: 0.4; cursor: default; }
.il-btn:disabled:hover { background: var(--il-surface-raised); border-color: var(--il-hairline-strong); }
.il-btn--primary {
  background: var(--il-accent);
  border-color: var(--il-accent);
  color: #1a1204;
  font-weight: 600;
}
.il-btn--primary:hover { background: #e6b357; border-color: #e6b357; }
.il-btn--primary:disabled:hover { background: var(--il-accent); border-color: var(--il-accent); }
.il-btn--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--il-ink-muted);
}
.il-btn--ghost:hover { background: var(--il-surface-raised); border-color: var(--il-hairline); color: var(--il-ink); }
.il-btn--sm { padding: 4px 8px; font-size: 11px; }

/* ---- Rail: tabs ---------------------------------------------------- */
.il-tabs {
  display: flex;
  gap: 2px;
  padding: var(--il-s2) var(--il-s3) 0;
  border-bottom: 1px solid var(--il-hairline);
}
.il-tab {
  appearance: none;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--il-ink-faint);
  font: 11px/1 var(--il-font);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: var(--il-s2) var(--il-s3) 10px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: color var(--il-t-state) var(--il-ease),
              border-color var(--il-t-state) var(--il-ease);
}
.il-tab:hover { color: var(--il-ink-muted); }
.il-tab[aria-selected="true"] { color: var(--il-ink); border-bottom-color: var(--il-accent); }
.il-count {
  min-width: 17px;
  padding: 0 5px;
  height: 16px;
  border-radius: 8px;
  background: var(--il-hairline-strong);
  color: var(--il-ink-muted);
  font: 10px/16px var(--il-mono);
  text-align: center;
}
.il-tab[aria-selected="true"] .il-count { background: var(--il-accent-soft); color: var(--il-accent); }
.il-count[data-zero="true"] { display: none; }

/* ---- Rail: scrolling body ------------------------------------------ */
.il-rail-body {
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--il-s3);
  display: flex;
  flex-direction: column;
  gap: var(--il-s2);
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: var(--il-hairline-strong) transparent;
}
.il-rail-body::-webkit-scrollbar { width: 10px; }
.il-rail-body::-webkit-scrollbar-thumb {
  background: var(--il-hairline-strong);
  border-radius: 5px;
  border: 3px solid var(--il-surface);
}
.il-panel[hidden] { display: none; }

/* Empty states carry the instruction. The old chrome opened an empty
   bordered box and said nothing, which is how a working feature reads as
   broken. */
.il-empty {
  margin: var(--il-s5) 0;
  text-align: center;
  color: var(--il-ink-faint);
}
.il-empty-title { color: var(--il-ink-muted); margin-bottom: var(--il-s2); }
.il-empty-hint { font-size: 12px; line-height: 1.6; }
.il-kbd {
  display: inline-block;
  padding: 1px 5px;
  border: 1px solid var(--il-hairline-strong);
  border-bottom-width: 2px;
  border-radius: var(--il-r1);
  background: var(--il-surface-raised);
  font: 10px/1.5 var(--il-mono);
  color: var(--il-ink-muted);
}

/* ---- Cards --------------------------------------------------------- */
.il-card {
  border: 1px solid var(--il-hairline);
  border-radius: var(--il-r2);
  background: var(--il-bg);
  overflow: hidden;
  transition: border-color var(--il-t-state) var(--il-ease);
}
.il-card:hover { border-color: var(--il-hairline-strong); }
.il-card[data-focus="true"] {
  border-color: var(--il-accent-line);
  box-shadow: 0 0 0 1px var(--il-accent-line);
}
.il-card-head {
  display: flex;
  align-items: center;
  gap: var(--il-s2);
  padding: var(--il-s2) var(--il-s3);
  border-bottom: 1px solid var(--il-hairline);
  background: var(--il-surface);
}
.il-card-intent {
  font: 10px/1 var(--il-font);
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--il-accent);
}
.il-card-src {
  flex: 1;
  min-width: 0;
  font: 11px/1.4 var(--il-mono);
  color: var(--il-ink-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.il-card-locate {
  appearance: none;
  background: transparent;
  border: none;
  padding: 2px 4px;
  border-radius: var(--il-r1);
  color: var(--il-ink-ghost);
  cursor: pointer;
  font: 11px/1 var(--il-mono);
  transition: color var(--il-t-state) var(--il-ease), background var(--il-t-state) var(--il-ease);
}
.il-card-locate:hover { color: var(--il-accent); background: var(--il-accent-soft); }
.il-card-body { padding: var(--il-s3); }
/* One block per thread entry. The rule is the separator, so a single-entry
   card looks like a plain card and a three-turn thread looks like a thread
   without either needing its own variant. */
.il-card-entry + .il-card-entry {
  margin-top: var(--il-s3);
  padding-top: var(--il-s3);
  border-top: 1px solid var(--il-hairline);
}
.il-card-entry-head {
  display: flex;
  align-items: center;
  gap: var(--il-s2);
  flex-wrap: wrap;
  margin-bottom: var(--il-s2);
}
.il-depth {
  font: 10px/1.6 var(--il-mono);
  color: var(--il-ink-faint);
}
.il-card-note {
  margin: 0 0 var(--il-s2);
  padding-left: var(--il-s2);
  border-left: 2px solid var(--il-accent-line);
  color: var(--il-ink-muted);
  font-style: italic;
}
.il-card-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.il-orphan {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: var(--il-r1);
  background: var(--il-warn-soft);
  color: var(--il-warn);
  font: 10px/1.6 var(--il-font);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.il-card[data-orphan="true"] { border-left: 2px solid var(--il-warn); }

.il-deciding { margin-top: var(--il-s3); }
.il-deciding-label {
  font: 10px/1.5 var(--il-font);
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--il-ink-faint);
  margin-bottom: var(--il-s1);
}
.il-code--open { display: block; }

.il-card-meta {
  margin-top: var(--il-s2);
  font: 10px/1.5 var(--il-mono);
  letter-spacing: 0.04em;
  color: var(--il-ink-ghost);
}
.il-card-foot {
  display: flex;
  align-items: center;
  gap: var(--il-s2);
  flex-wrap: wrap;
  padding: 0 var(--il-s3) var(--il-s3);
}

.il-verdict {
  display: inline-block;
  padding: 2px 7px;
  border-radius: var(--il-r1);
  font: 10px/1.5 var(--il-font);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.il-verdict[data-v="supported"] { background: var(--il-ok-soft); color: var(--il-ok); }
.il-verdict[data-v="contradicted"] { background: var(--il-bad-soft); color: var(--il-bad); }
.il-verdict[data-v="not-determinable"] { background: var(--il-warn-soft); color: var(--il-warn); }

.il-disclosure {
  appearance: none;
  background: transparent;
  border: none;
  padding: 0;
  color: var(--il-ink-faint);
  font: 11px/1 var(--il-font);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.il-disclosure:hover { color: var(--il-accent); }
.il-code {
  margin: var(--il-s2) 0 0;
  padding: var(--il-s2);
  border-radius: var(--il-r1);
  background: #040507;
  border: 1px solid var(--il-hairline);
  color: var(--il-ink-muted);
  font: 11px/1.6 var(--il-mono);
  white-space: pre-wrap;
  overflow-x: auto;
}
.il-code[hidden] { display: none; }

/* Pending. The shimmer is the only ambient motion in the chrome -- it
   exists because "thinking…" with no movement is indistinguishable from
   "stuck", which is precisely the failure mode the dispatch-dedup bug
   produced. */
.il-card[data-state="pending"] { border-style: dashed; }
.il-pending {
  display: inline-flex;
  align-items: center;
  gap: var(--il-s2);
  color: var(--il-ink-faint);
  font-size: 12px;
}
.il-pending::before {
  content: "";
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--il-accent);
  animation: il-pulse 1.4s var(--il-ease) infinite;
}
@keyframes il-pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .il-pending::before { animation: none; opacity: 0.7; }
}

.il-self-explain {
  display: flex;
  flex-direction: column;
  gap: var(--il-s2);
  padding: 0 var(--il-s3) var(--il-s3);
}
.il-self-explain[hidden] { display: none; }
.il-self-explain textarea {
  width: 100%;
  min-height: 56px;
  resize: vertical;
  padding: var(--il-s2);
  border: 1px solid var(--il-hairline-strong);
  border-radius: var(--il-r1);
  background: var(--il-bg);
  color: var(--il-ink);
  font: 13px/1.5 var(--il-font);
}
.il-self-explain textarea:focus { border-color: var(--il-accent-line); }
.il-self-explain textarea::placeholder { color: var(--il-ink-ghost); }
.il-self-explain button { align-self: flex-start; }

/* ---- Findings ------------------------------------------------------ */
.il-finding {
  border: 1px solid var(--il-hairline);
  border-left-width: 2px;
  border-radius: var(--il-r2);
  background: var(--il-bg);
  padding: var(--il-s3);
}
.il-finding[data-kind="touched"] { border-left-color: var(--il-warn); }
.il-finding[data-kind="lost"] { border-left-color: var(--il-bad); }
.il-finding-kind {
  font: 10px/1 var(--il-font);
  letter-spacing: 0.07em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.il-finding[data-kind="touched"] .il-finding-kind { color: var(--il-warn); }
.il-finding[data-kind="lost"] .il-finding-kind { color: var(--il-bad); }
.il-finding-src {
  font: 11px/1.5 var(--il-mono);
  color: var(--il-ink-muted);
  overflow-wrap: anywhere;
}
.il-finding-foot { margin-top: var(--il-s2); display: flex; gap: var(--il-s2); }

.il-degraded {
  margin-bottom: var(--il-s2);
  padding: var(--il-s2) var(--il-s3);
  border: 1px solid var(--il-warn-soft);
  border-left: 2px solid var(--il-warn);
  border-radius: var(--il-r2);
  background: var(--il-warn-soft);
  color: var(--il-warn);
  font-size: 12px;
}
.il-degraded[hidden] { display: none; }

/* ---- Queue --------------------------------------------------------- */
.il-queued {
  border: 1px solid var(--il-accent-line);
  border-radius: var(--il-r2);
  background: var(--il-accent-soft);
  padding: var(--il-s3);
}
.il-queued-head {
  display: flex;
  align-items: center;
  gap: var(--il-s2);
  margin-bottom: 6px;
}
.il-queued-intent {
  font: 10px/1 var(--il-font);
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--il-accent);
}
.il-queued-src {
  flex: 1;
  min-width: 0;
  font: 11px/1.4 var(--il-mono);
  color: var(--il-ink-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.il-queued-note { margin: 0; color: var(--il-ink); overflow-wrap: anywhere; }
.il-queued-note:empty::before { content: "no note"; color: var(--il-ink-ghost); font-style: italic; }

.il-queued-attach {
  margin-top: var(--il-s2);
  font: 10px/1.5 var(--il-mono);
  letter-spacing: 0.04em;
  color: var(--il-accent);
}
.il-queue-summary {
  font: 11px/1.5 var(--il-mono);
  color: var(--il-ink-faint);
}

/* ---- Composer ------------------------------------------------------ */
.il-compose {
  border-top: 1px solid var(--il-hairline);
  padding: var(--il-s3);
  background: var(--il-surface);
  display: flex;
  flex-direction: column;
  gap: var(--il-s2);
}
.il-compose-target {
  display: flex;
  align-items: center;
  gap: var(--il-s2);
  font: 11px/1.4 var(--il-mono);
  color: var(--il-ink-faint);
  min-height: 18px;
}
.il-compose-target[data-has-target="true"] { color: var(--il-accent); }
/* The label truncates, so the clear control needs its own inviolable space
   -- without this the x sits flush against the last clipped character. */
.il-compose-target > span:first-child {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.il-compose-clear {
  appearance: none;
  background: transparent;
  border: none;
  color: var(--il-ink-ghost);
  cursor: pointer;
  padding: 0 2px;
  font: 12px/1 var(--il-mono);
}
.il-compose-clear:hover { color: var(--il-bad); }
.il-compose textarea {
  width: 100%;
  min-height: 62px;
  max-height: 180px;
  resize: vertical;
  padding: var(--il-s2);
  border: 1px solid var(--il-hairline-strong);
  border-radius: var(--il-r1);
  background: var(--il-bg);
  color: var(--il-ink);
  font: 13px/1.5 var(--il-font);
  transition: border-color var(--il-t-state) var(--il-ease);
}
.il-compose textarea:focus { border-color: var(--il-accent-line); }
.il-compose textarea::placeholder { color: var(--il-ink-ghost); }
.il-compose-row { display: flex; align-items: center; gap: var(--il-s2); }
.il-compose-row select {
  appearance: none;
  padding: 6px 9px;
  border: 1px solid var(--il-hairline-strong);
  border-radius: var(--il-r1);
  background: var(--il-surface-raised);
  color: var(--il-ink);
  font: 12px/1 var(--il-font);
  cursor: pointer;
}
.il-compose-hint {
  font-size: 11px;
  color: var(--il-ink-ghost);
}

/* ---- Conversation -------------------------------------------------- */
.il-msg {
  border-radius: var(--il-r2);
  padding: var(--il-s3);
  overflow-wrap: anywhere;
}
.il-msg[data-from="agent"] {
  background: var(--il-bg);
  border: 1px solid var(--il-hairline);
}
.il-msg[data-from="you"] {
  background: var(--il-accent-soft);
  border: 1px solid var(--il-accent-line);
}
.il-msg-who {
  font: 10px/1 var(--il-font);
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--il-ink-faint);
  margin-bottom: 6px;
}
.il-msg[data-from="you"] .il-msg-who { color: var(--il-accent); }
/* illuminate's own voice -- transport failures and the like. Visually
   distinct from both participants so a tool message is never mistaken for
   something the agent said. */
.il-msg[data-from="system"] {
  background: transparent;
  border: 1px dashed var(--il-hairline-strong);
  color: var(--il-ink-muted);
}
.il-msg[data-from="system"] .il-msg-who { color: var(--il-ink-faint); }
.il-msg-text { margin: 0; white-space: pre-wrap; }

/* ---- Notice (supersession / fatal) --------------------------------- */
.il-notice {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--il-s3);
  padding: var(--il-s6);
  text-align: center;
  background: var(--il-stage);
  color: var(--il-ink-muted);
}
.il-notice-title { color: var(--il-ink); font-size: 15px; }

/* ---- Rail notice (rejected dispatch / transport failure, ADR-111) -- */
.il-rail-notices { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px 0; }
.il-rail-notices:empty { display: none; }
.il-rail-notice { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--il-hairline); border-left: 3px solid var(--il-accent); background: var(--il-surface-raised); color: var(--il-ink); font-size: 13px; line-height: 1.4; }
.il-rail-notice-text { flex: 1; }

/* ---- Narrow windows ------------------------------------------------ */
/* Below this the rail would starve the artifact, so it becomes an overlay
   the human opens deliberately rather than a permanent column. */
@media (max-width: 900px) {
  .il-app { grid-template-columns: 1fr 0; }
  .il-rail {
    position: fixed;
    top: var(--il-bar-h);
    right: 0;
    bottom: 0;
    width: min(var(--il-rail-w), 100vw);
    box-shadow: var(--il-shadow);
    z-index: 10;
  }
  .il-app[data-rail="collapsed"] .il-rail { display: none; }
}
`;
