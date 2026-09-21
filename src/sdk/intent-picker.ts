/// <reference lib="dom" />
// The above triple-slash directive pulls in DOM types for THIS FILE only,
// independent of whichever tsconfig ends up compiling it. Needed because
// this file is imported two ways: tsconfig.browser.json (lib: DOM, the
// SDK's real build target) AND transitively via test/sdk/intent-picker.test.ts
// under the root tsconfig.json (lib: ES2022, no DOM -- Node/CLI target).
// Without this, `tsc --noEmit`'s root pass fails on ShadowRoot/DOMRect/
// document even though only the DOM-free INTENT_MENU_ITEMS/labelFor exports
// are ever imported from a Node context -- TS type-checks the whole file
// regardless of which exports a given importer actually uses.
import { INTENT_TYPES, type Intent } from '../shared/intent.ts';

export interface IntentMenuItem {
  readonly intent: Intent;
  readonly label: string;
}

// Exhaustive by construction -- TypeScript errors if any Intent key is
// missing here (CLAUDE.md's documented `never`-narrowing gotcha; assign
// the object itself instead of relying on switch-default narrowing).
const INTENT_LABELS: Record<Intent, string> = {
  explain: 'Explain',
  verify: 'Verify',
  deeper: 'Go deeper',
  'fix-artifact': 'Fix artifact',
  'fix-code': 'Fix code',
};

export function labelFor(intent: Intent): string {
  return INTENT_LABELS[intent];
}

// Derived from INTENT_TYPES, not hand-duplicated -- see this task's own
// behavior spec on why that matters.
export const INTENT_MENU_ITEMS: readonly IntentMenuItem[] = INTENT_TYPES.map((intent) => ({
  intent,
  label: labelFor(intent),
}));

export interface IntentPickerHandle {
  destroy(): void;
}

/**
 * Renders a role="menu" of role="menuitem" buttons into `shadowRoot`,
 * positioned near `anchorRect`. Arrow keys move focus (wrapping); Enter/
 * Space activates the focused item's own click handler (native button
 * behavior, no extra wiring needed); Escape calls `onClose` and tears the
 * menu down; Tab is trapped while the menu is open (a picker is a modal-ish
 * affordance -- it should not leak focus into the artifact's own tab order
 * mid-selection). The caller (index.ts) is responsible for restoring focus
 * to whatever opened the picker; this function only tears down its own DOM.
 */
export function renderIntentPicker(
  shadowRoot: ShadowRoot,
  anchorRect: DOMRect,
  onSelect: (intent: Intent) => void,
  onClose: () => void,
  /** Optional sixth item: hand this element to the chrome rail's composer
   * instead of dispatching straight away. Optional rather than required so
   * every existing caller and test keeps working unchanged -- when it is
   * absent the menu is exactly the five typed intents it has always been. */
  onNote?: () => void,
): IntentPickerHandle {
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'illuminate actions');
  menu.className = 'illum-picker';
  menu.style.position = 'fixed';

  let focusIndex = 0;
  const buttons: HTMLButtonElement[] = INTENT_MENU_ITEMS.map((item, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.tabIndex = i === 0 ? 0 : -1;
    button.textContent = item.label;
    button.addEventListener('click', () => {
      onSelect(item.intent);
      destroy();
    });
    menu.appendChild(button);
    return button;
  });

  // The note item is appended to the SAME `buttons` array, so arrow-key
  // wrapping, roving tabindex and the focus trap cover it without any
  // special-casing. It is visually separated because it is the one item
  // that does not dispatch anything.
  if (onNote) {
    const noteButton = document.createElement('button');
    noteButton.type = 'button';
    noteButton.setAttribute('role', 'menuitem');
    noteButton.className = 'illum-picker-note';
    noteButton.tabIndex = -1;
    noteButton.textContent = 'Write a note…';
    noteButton.addEventListener('click', () => {
      onNote();
      destroy();
    });
    menu.appendChild(noteButton);
    buttons.push(noteButton);
  }

  function focusItem(i: number): void {
    focusIndex = (i + buttons.length) % buttons.length;
    buttons.forEach((b, idx) => {
      b.tabIndex = idx === focusIndex ? 0 : -1;
    });
    buttons[focusIndex]?.focus();
  }

  menu.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusItem(focusIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusItem(focusIndex - 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      destroy();
    } else if (e.key === 'Tab') {
      e.preventDefault(); // trap focus inside the open menu
    }
  });

  function destroy(): void {
    menu.remove();
  }

  // Append before measuring: the menu's rendered size (5 buttons' worth of
  // layout) is only known once it is actually in the shadow tree and the
  // adopted stylesheet has applied. Positioned off-DOM-order here, then
  // placed, so there is no visible flash at the wrong coordinates.
  shadowRoot.appendChild(menu);

  // Viewport-clamped placement: `anchorRect.bottom + 4` (opening below the
  // clicked element) is the default, but an anchor near the bottom or right
  // edge of the CURRENT viewport -- the artifact's own iframe viewport,
  // which can be arbitrarily small (this is not hypothetical: Plan 04-01's
  // fixture chrome shell embeds its iframe at the browser's unstyled
  // default 300x150) -- would otherwise place the whole menu outside the
  // visible area, making it unreachable to both a real pointer and
  // Playwright's actionability hit-test alike. Flip above the anchor when
  // there isn't room below; clamp horizontally so the menu never extends
  // past the right edge.
  const menuRect = menu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let top = anchorRect.bottom + 4;
  if (top + menuRect.height > viewportHeight) {
    top = Math.max(0, anchorRect.top - menuRect.height - 4);
  }
  let left = anchorRect.left;
  if (left + menuRect.width > viewportWidth) {
    left = Math.max(0, viewportWidth - menuRect.width);
  }
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;

  focusItem(0);
  return { destroy };
}
