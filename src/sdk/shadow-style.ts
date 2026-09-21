/**
 * The artifact-isolation reset, adopted into the SDK's own shadow root
 * (never `document`) by boot.ts. `:host{all: initial}` is what makes the
 * chrome's CSS immune to the artifact's own stylesheets and vice versa --
 * ARCHITECTURE.md [V] cli.mjs:6494-6501. Kept as a plain string constant,
 * not a `.css` file import, so this file stays importable and testable
 * under plain `node --test` with zero bundler involvement -- see
 * 04-01-PLAN.md Task 2's note on why esbuild's `.css` text loader is
 * deliberately not used.
 *
 * Plan 07-05 (`.illum-card*`/`.illum-drawer*` rules below) -- card
 * rendering (EDU-01/EDU-04/EDU-05). Every card renders its markdown/
 * learnerNote/decidingLines/source.content via textContent only
 * (src/sdk/cards.ts); this stylesheet only ever controls layout of
 * already-safe text nodes, never markup. Doc comments live here (a real
 * TS comment, stripped by esbuild's minifier) rather than inside the CSS
 * template literal itself -- every byte inside the backtick string ships
 * into every artifact (SERVE-10's dependency-free/self-contained/lean
 * constraint).
 *
 * ## On the token block below
 *
 * The custom properties are declared on `:host` AFTER `all: initial`, and
 * every rule that needs them still carries its own `all: initial` reset.
 * That combination is safe on purpose: the `all` shorthand is defined NOT
 * to reset custom properties, so a token declared on the host inherits
 * into a subtree whose every element has otherwise been reset to initial.
 * Do not "simplify" these back to literals -- they are the only reason
 * this stylesheet and the chrome shell's own (src/chrome/chrome-css.ts)
 * can be kept in visual agreement, and a card that reads as a different
 * product from the rail beside it was a real part of what made the old
 * chrome feel unfinished.
 *
 * Values are duplicated rather than imported because this string ships
 * into the sandboxed artifact and the chrome stylesheet does not; there is
 * no module boundary they can share at runtime. Keep them in step by hand.
 */
export const SHADOW_CSS = `
:host { all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
  --il-surface: #12151a; --il-raised: #181c23; --il-hairline: #2b323c;
  --il-ink: #e8eaed; --il-ink-muted: #a6adb8; --il-ink-faint: #6d7684;
  --il-accent: #d9a441; --il-accent-soft: rgba(217,164,65,0.14); --il-accent-line: rgba(217,164,65,0.5);
  --il-ok: #5dd39e; --il-bad: #e5695f; --il-focus: #4da3ff;
  --il-font: system-ui, -apple-system, "Segoe UI", sans-serif;
  --il-mono: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, monospace;
  --il-shadow: 0 8px 28px rgba(0,0,0,0.55);
}

/* The per-element handle. Was a 12px "command" glyph at 25% opacity, which
   read as a stray character rather than a control. Now a small amber dot
   that grows a ring on hover/focus: present enough to find, quiet enough
   to ignore while reading. */
.illum-trigger { all: initial; position: fixed; pointer-events: auto; box-sizing: border-box;
  width: 12px; height: 12px; padding: 0; border-radius: 50%; cursor: pointer;
  background: var(--il-accent-soft); border: 1px solid var(--il-accent-line);
  font-size: 0; line-height: 0; color: transparent; opacity: 0.45;
  /* NOTE: background is deliberately absent from this transition list.
     Hover and focus are interaction feedback and may ease; the touched/
     lost fill is a FACT arriving -- animating it delays the reader seeing
     it, and left the colour observably mid-interpolation (a measured rgba
     alpha of 0.337 against a declared 0.35) to anything reading computed
     style. Backticks are also forbidden anywhere in this string: it IS a
     template literal, and one ends it mid-stylesheet. */
  transition: opacity 120ms ease, box-shadow 120ms ease; }
.illum-trigger:hover, .illum-trigger:focus-visible {
  opacity: 1; background: var(--il-accent); box-shadow: 0 0 0 3px var(--il-accent-soft); }
.illum-trigger:focus-visible { outline: 2px solid var(--il-focus); outline-offset: 2px; }

.illum-highlight { all: initial; position: fixed; pointer-events: none; border-radius: 3px;
  box-shadow: 0 0 0 1px var(--il-accent-line), 0 0 0 4px var(--il-accent-soft); }

/* The rail's "show me where this is" flash. The only animation in the
   artifact, and it ends -- a persistent marker here would compete with the
   artifact's own content for attention. */
.illum-reveal { all: initial; position: fixed; pointer-events: none; border-radius: 3px;
  box-shadow: 0 0 0 2px var(--il-accent); animation: illum-fade 1.4s ease forwards; }
@keyframes illum-fade { 0% { opacity: 0; } 15% { opacity: 1; } 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .illum-reveal { animation: none; opacity: 0.9; }
}

.illum-picker { all: initial; position: fixed; pointer-events: auto; display: flex; flex-direction: column;
  min-width: 168px; background: var(--il-surface); border: 1px solid var(--il-hairline);
  border-radius: 8px; padding: 5px; font: 13px/1.4 var(--il-font); box-shadow: var(--il-shadow); }
.illum-picker button[role="menuitem"] { all: initial; display: block; box-sizing: border-box; width: 100%;
  color: var(--il-ink); background: transparent; border: none; padding: 7px 10px; text-align: left;
  cursor: pointer; font: 13px/1.4 var(--il-font); border-radius: 5px; }
.illum-picker button[role="menuitem"]:hover, .illum-picker button[role="menuitem"]:focus-visible {
  background: var(--il-raised); color: var(--il-ink); outline: none; box-shadow: inset 0 0 0 1px var(--il-hairline); }
/* The one item that dispatches nothing gets its own register, so the cost
   difference between it and the five above it is visible before clicking. */
.illum-picker button.illum-picker-note { margin-top: 5px; padding-top: 10px;
  border-top: 1px solid var(--il-hairline); border-radius: 0 0 5px 5px; color: var(--il-accent); }

/* The element composer -- lavish's popover shape carrying illuminate's typed
   intent. Replaced a flat six-item menu; see element-composer.ts for why the
   two actions (Queue, Send) are deliberately separate buttons. */
.illum-composer { all: initial; position: fixed; pointer-events: auto; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 10px; width: 380px; max-width: calc(100vw - 16px);
  background: var(--il-surface); border: 1px solid var(--il-hairline); border-radius: 10px;
  padding: 12px; box-shadow: var(--il-shadow); font: 13px/1.5 var(--il-font); color: var(--il-ink);
  z-index: 2147483647; }
.illum-composer[data-dropping="true"] { border-color: var(--il-accent); box-shadow: 0 0 0 3px var(--il-accent-soft), var(--il-shadow); }
.illum-composer * { box-sizing: border-box; }

.illum-composer-head { all: initial; display: flex; align-items: baseline; gap: 8px;
  font: 11px/1.4 var(--il-mono); color: var(--il-ink-faint); }
.illum-composer-tag { all: initial; font: 11px/1.4 var(--il-mono); color: var(--il-accent); }
.illum-composer-cite { all: initial; flex: 1; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; font: 11px/1.4 var(--il-mono); color: var(--il-ink-faint); }
.illum-composer-cite[data-unanchored="true"] { color: var(--il-bad); font-style: italic; }

.illum-composer-intents { all: initial; display: flex; flex-wrap: wrap; gap: 5px; }
.illum-chip { all: initial; box-sizing: border-box; cursor: pointer; padding: 5px 10px;
  border-radius: 999px; border: 1px solid var(--il-hairline); background: transparent;
  color: var(--il-ink-muted); font: 12px/1.3 var(--il-font); transition: all 120ms ease; }
.illum-chip:hover { border-color: var(--il-accent-line); color: var(--il-ink); }
.illum-chip[aria-checked="true"] { background: var(--il-accent-soft); border-color: var(--il-accent-line); color: var(--il-accent); }
.illum-chip:focus-visible { outline: 2px solid var(--il-focus); outline-offset: 2px; }

.illum-composer-note { all: initial; box-sizing: border-box; display: block; width: 100%;
  min-height: 74px; max-height: 220px; resize: vertical; padding: 8px; border-radius: 5px;
  border: 1px solid var(--il-hairline); background: var(--il-raised); color: var(--il-ink);
  font: 13px/1.5 var(--il-font); }
.illum-composer-note:focus { outline: none; border-color: var(--il-accent-line); }

.illum-composer-attach { all: initial; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.illum-composer-attach-btn { all: initial; box-sizing: border-box; cursor: pointer;
  padding: 5px 9px; border-radius: 5px; border: 1px solid var(--il-hairline);
  background: var(--il-raised); color: var(--il-ink-muted); font: 12px/1.3 var(--il-font); }
.illum-composer-attach-btn:hover { color: var(--il-ink); border-color: var(--il-hairline); }
.illum-composer-attach-btn:focus-visible { outline: 2px solid var(--il-focus); outline-offset: 2px; }
.illum-composer-files { all: initial; display: flex; flex-wrap: wrap; gap: 5px; }
.illum-file { all: initial; display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px;
  border-radius: 4px; background: var(--il-accent-soft); color: var(--il-accent);
  font: 11px/1.4 var(--il-mono); }
.illum-file-remove { all: initial; cursor: pointer; color: var(--il-accent);
  font: 12px/1 var(--il-mono); padding: 0 2px; }
.illum-file-remove:hover { color: var(--il-bad); }

.illum-composer-hint { all: initial; display: block; font: 11px/1.5 var(--il-font); color: var(--il-ink-ghost); }
.illum-kbd { all: initial; display: inline-block; padding: 1px 5px; border-radius: 4px;
  border: 1px solid var(--il-hairline); border-bottom-width: 2px; background: var(--il-raised);
  color: var(--il-ink-muted); font: 10px/1.5 var(--il-mono); }

.illum-composer-actions { all: initial; display: flex; justify-content: flex-end; gap: 6px; }
.illum-btn { all: initial; box-sizing: border-box; cursor: pointer; padding: 6px 12px;
  border-radius: 5px; border: 1px solid var(--il-hairline); background: var(--il-raised);
  color: var(--il-ink); font: 12px/1.3 var(--il-font); }
.illum-btn:hover { border-color: var(--il-hairline); background: #222833; }
.illum-btn:focus-visible { outline: 2px solid var(--il-focus); outline-offset: 2px; }
.illum-btn--primary { background: var(--il-accent); border-color: var(--il-accent);
  color: #1a1204; font-weight: 600; }
.illum-btn--primary:hover { background: #e6b357; border-color: #e6b357; }

.illum-card { all: initial; position: fixed; pointer-events: auto; display: block; box-sizing: border-box;
  max-width: 340px; max-height: 60vh; overflow-y: auto; background: var(--il-surface); color: var(--il-ink);
  border: 1px solid var(--il-hairline); border-radius: 8px; padding: 12px; font: 13px/1.55 var(--il-font);
  box-shadow: var(--il-shadow); z-index: 2147483647; }
.illum-card-pending { all: initial; position: fixed; pointer-events: none; display: block;
  background: var(--il-surface); color: var(--il-ink-faint); border: 1px dashed var(--il-hairline);
  border-radius: 6px; padding: 5px 10px; font: 12px/1.4 var(--il-font); z-index: 2147483647; }
.illum-card-entry { all: initial; display: block; padding: 10px 0; border-top: 1px solid var(--il-hairline); }
.illum-card-entry:first-child { border-top: none; padding-top: 0; }
.illum-card-header { all: initial; display: block; font: 10px/1.4 var(--il-font); letter-spacing: 0.07em;
  text-transform: uppercase; color: var(--il-ink-faint); margin-bottom: 6px; }
.illum-card-learner-note { all: initial; display: block; border-left: 2px solid var(--il-accent-line);
  padding: 4px 10px; margin-bottom: 8px; font: italic 13px/1.5 var(--il-font); color: var(--il-ink-muted); }
.illum-card-markdown { all: initial; display: block; white-space: pre-wrap; overflow-wrap: anywhere;
  font: 13px/1.55 var(--il-font); color: var(--il-ink); }
.illum-card-verdict { all: initial; display: inline-block; padding: 2px 7px; margin-top: 8px; border-radius: 4px;
  font: 10px/1.5 var(--il-font); letter-spacing: 0.05em; text-transform: uppercase; }
.illum-verdict-supported { background: rgba(93,211,158,0.14); color: var(--il-ok); }
.illum-verdict-contradicted { background: rgba(229,105,95,0.14); color: var(--il-bad); }
.illum-verdict-not-determinable { background: var(--il-accent-soft); color: var(--il-accent); }
.illum-card-toggle { all: initial; display: block; pointer-events: auto; cursor: pointer; background: transparent;
  border: none; padding: 0; margin-top: 8px; color: var(--il-accent); font: 11px/1.4 var(--il-font);
  text-decoration: underline; text-underline-offset: 2px; }
.illum-card-toggle:focus-visible { outline: 2px solid var(--il-focus); outline-offset: 2px; }
.illum-card-pre { all: initial; display: block; white-space: pre-wrap; margin-top: 8px; padding: 8px;
  border: 1px solid var(--il-hairline); border-radius: 4px;
  background: #040507; color: var(--il-ink-muted); font: 11px/1.6 var(--il-mono); }
.illum-card-pre[hidden] { display: none; }
.illum-card-actions { all: initial; display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
.illum-card-actions button { all: initial; box-sizing: border-box; cursor: pointer;
  background: var(--il-raised); color: var(--il-ink); border: 1px solid var(--il-hairline);
  border-radius: 4px; padding: 5px 9px; font: 12px/1 var(--il-font); }
.illum-card-actions button:hover { border-color: var(--il-accent-line); }
.illum-card-actions button:focus-visible { outline: 2px solid var(--il-focus); outline-offset: 2px; }

/* The two corner drawers predate the chrome rail, which now shows both
   findings and cards in a column that cannot be scrolled away from. They
   are kept as the in-artifact fallback (an exported standalone artifact
   has no rail at all) and restyled to match, rather than left in the old
   11px grey that made them look like debug affordances. */
.illum-drawer-toggle, .illum-findings-toggle { all: initial; position: fixed; bottom: 10px; pointer-events: auto;
  background: var(--il-surface); color: var(--il-ink-muted); border: 1px solid var(--il-hairline);
  border-radius: 6px; padding: 6px 10px; font: 11px/1 var(--il-font); cursor: pointer;
  opacity: 0.75; transition: opacity 120ms ease, color 120ms ease; z-index: 2147483647; }
.illum-drawer-toggle { right: 10px; }
.illum-findings-toggle { left: 10px; }
.illum-drawer-toggle:hover, .illum-findings-toggle:hover { opacity: 1; color: var(--il-ink); }
.illum-drawer-toggle:focus-visible, .illum-findings-toggle:focus-visible {
  opacity: 1; outline: 2px solid var(--il-focus); outline-offset: 2px; }
.illum-findings-toggle--degraded { border-color: var(--il-accent-line); color: var(--il-accent); opacity: 1; }
.illum-drawer-panel, .illum-findings-panel { all: initial; position: fixed; bottom: 44px; width: 288px;
  max-height: 320px; overflow-y: auto; background: var(--il-surface); border: 1px solid var(--il-hairline);
  border-radius: 8px; padding: 10px; box-shadow: var(--il-shadow); z-index: 2147483647;
  font: 13px/1.5 var(--il-font); color: var(--il-ink); }
.illum-drawer-panel { right: 10px; }
.illum-findings-panel { left: 10px; }
.illum-drawer-panel[hidden], .illum-findings-panel[hidden] { display: none; }
/* An empty drawer used to open as a blank bordered box, which reads as
   broken rather than as "nothing here". */
.illum-drawer-panel:empty::after, .illum-findings-panel:empty::after {
  content: "Nothing here yet."; color: var(--il-ink-faint); font: italic 12px/1.5 var(--il-font); }
.illum-drawer-entry, .illum-finding-entry { all: initial; display: block; padding: 8px 0;
  border-top: 1px solid var(--il-hairline); font: 12px/1.5 var(--il-font); color: var(--il-ink-muted); }
.illum-drawer-entry:first-child, .illum-finding-entry:first-child { border-top: none; padding-top: 0; }

/* When the chrome rail owns card presentation (illuminate:setCardPresentation),
   both corner drawers are duplicates of a rail tab that cannot be scrolled
   away from, so they are hidden rather than left as a second, worse copy.
   The rule keys off a host attribute so there is ONE switch for the whole
   mode, set in exactly one place (cards.ts's setPresentation). An exported
   standalone artifact never receives that message, so it keeps both. */
:host([data-presentation="rail"]) .illum-drawer-toggle,
:host([data-presentation="rail"]) .illum-drawer-panel,
:host([data-presentation="rail"]) .illum-findings-toggle,
:host([data-presentation="rail"]) .illum-findings-panel { display: none; }

/* Plan 08-05 (STAL-02/STAL-05) -- passive per-trigger touched/lost markers.
   Quiet by design: unchanged/moved render nothing at all (findings-render.ts's
   own findingStateForTarget never returns a state for either), so these rules
   only ever apply to the two loud states. The trigger is now a dot, so a
   stale one changes ITS OWN colour rather than carrying a second dot in the
   corner -- one mark per element, never two. */
.illum-trigger--touched, .illum-trigger--lost { opacity: 1; }
.illum-trigger--touched { background: rgba(217,164,65,0.35); border-color: var(--il-accent); }
.illum-trigger--lost { background: rgba(229,105,95,0.35); border-color: var(--il-bad); }
.illum-trigger--touched:hover, .illum-trigger--touched:focus-visible { background: var(--il-accent); }
.illum-trigger--lost:hover, .illum-trigger--lost:focus-visible { background: var(--il-bad); }

.illum-finding-dismiss { all: initial; display: inline-block; margin-top: 4px; pointer-events: auto;
  cursor: pointer; color: var(--il-accent); font: 11px/1.4 var(--il-font);
  text-decoration: underline; text-underline-offset: 2px; }
.illum-finding-dismiss:focus-visible { outline: 2px solid var(--il-focus); outline-offset: 2px; }
`;
