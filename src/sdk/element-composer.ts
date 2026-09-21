/// <reference lib="dom" />
// See addressing.ts's own top-of-file comment for why this directive is
// needed here: this file is imported both by tsconfig.browser.json (lib:
// DOM) and, transitively, by a Node-side test under the root tsconfig
// (lib: ES2022, no DOM).

import { INTENT_MENU_ITEMS, labelFor } from './intent-picker.ts';
import type { Intent } from '../shared/intent.ts';

/**
 * The composer that opens on a clicked element -- what replaced the flat
 * six-item menu.
 *
 * ## Why it changed shape
 *
 * The old picker was a list: five typed intents, plus a "Write a note..."
 * item that dispatched nothing and handed the element to the rail's own
 * composer at the bottom of the screen. So writing a note meant clicking an
 * element, choosing a menu item, then moving to the far side of the window
 * to type -- and the note and the intent were chosen in two different
 * places, which is why nobody used it.
 *
 * lavish-axi solves the same moment with a composer anchored ON the
 * element: a textarea, an attachment control, and Cancel/Queue. What it has
 * no equivalent for is illuminate's typed intent, which is a security
 * property rather than a convenience (ROUT-01: a closed set the browser
 * emits, so no model output can select a role or tier).
 *
 * This is both: lavish's shape, illuminate's typed intent. The intent is
 * still chosen from a closed menu and still travels as the discriminator;
 * the note is optional payload beside it.
 *
 * ## Queue vs send
 *
 * Two actions, deliberately distinct. **Send** dispatches now -- one model
 * call, immediately. **Queue** puts the note in the rail and costs nothing
 * until the human flushes the whole batch. That difference is real money and
 * real latency, so it is two buttons rather than one with a modifier.
 *
 * ## Safety
 *
 * Every node here is built with `createElement` and every string assigned
 * with `textContent`. The element's own text appears in this popover's
 * header (as a label for what was clicked) and is attacker-influenceable
 * artifact content -- the same `innerHTML`-free discipline `cards.ts` holds
 * applies for the same reason.
 */

export interface ComposerAttachment {
  /** A data URL. The bytes never leave the artifact frame by any other
   * route -- the sandbox has no `fetch` -- so this is what gets posted to
   * the chrome for storage. */
  readonly dataUrl: string;
  readonly name: string;
  readonly mediaType: string;
}

export interface ComposerSubmission {
  readonly intent: Intent;
  /** `null` rather than `''` when the human wrote nothing -- an empty note
   * and no note are the same thing, and the wire field is nullable. */
  readonly note: string | null;
  readonly attachments: readonly ComposerAttachment[];
  /** `send` dispatches immediately; `queue` hands it to the rail unsent. */
  readonly mode: 'send' | 'queue';
}

export interface ElementComposerHandle {
  destroy(): void;
}

/** Only images. A dropped PDF or zip would be silently useless: the tutor
 * role has no tools to open one with, and the envelope carries a path, not
 * content. Rejecting loudly beats attaching something that cannot be read. */
function isImage(file: File): boolean {
  return file.type.startsWith('image/');
}

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

function readAsDataUrl(file: File): Promise<ComposerAttachment | null> {
  return new Promise((resolvePromise) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        resolvePromise(null);
        return;
      }
      resolvePromise({ dataUrl: result, name: file.name || 'pasted-image', mediaType: file.type });
    };
    // Never rejects: a failed read drops the one attachment rather than
    // taking down the composer the human is mid-sentence in.
    reader.onerror = () => {
      resolvePromise(null);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Renders the composer into `shadowRoot`, positioned near `anchorRect`.
 *
 * `label` is the citation to show in the header (a `data-src` value), or
 * `null` for an unanchored element -- which is stated rather than hidden, so
 * the human knows before they write that the answer will be ungrounded.
 */
export function renderElementComposer(
  shadowRoot: ShadowRoot,
  anchorRect: DOMRect,
  options: {
    readonly tag: string;
    readonly label: string | null;
    readonly onSubmit: (submission: ComposerSubmission) => void;
    readonly onClose: () => void;
  },
): ElementComposerHandle {
  const root = el('div', 'illum-composer');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Review this element');
  root.style.position = 'fixed';

  // ---- header ------------------------------------------------------
  const head = el('div', 'illum-composer-head');
  head.appendChild(el('span', 'illum-composer-tag', `<${options.tag}>`));
  const cite = el('span', 'illum-composer-cite');
  if (options.label === null) {
    cite.textContent = 'not anchored';
    cite.dataset.unanchored = 'true';
    cite.title = 'This element cites no source, so any answer will be ungrounded.';
  } else {
    cite.textContent = options.label;
  }
  head.appendChild(cite);
  root.appendChild(head);

  // ---- intents -----------------------------------------------------
  let selected: Intent = 'explain';
  const chipRow = el('div', 'illum-composer-intents');
  chipRow.setAttribute('role', 'radiogroup');
  chipRow.setAttribute('aria-label', 'What to ask for');
  const chips = INTENT_MENU_ITEMS.map((item) => {
    const chip = el('button', 'illum-chip', item.label);
    chip.type = 'button';
    chip.setAttribute('role', 'radio');
    chip.dataset.intent = item.intent;
    chip.setAttribute('aria-checked', item.intent === selected ? 'true' : 'false');
    chip.addEventListener('click', () => {
      selected = item.intent;
      for (const other of chips) other.setAttribute('aria-checked', other === chip ? 'true' : 'false');
      textarea.focus();
    });
    chipRow.appendChild(chip);
    return chip;
  });
  root.appendChild(chipRow);

  // ---- note --------------------------------------------------------
  const textarea = el('textarea', 'illum-composer-note');
  textarea.placeholder = 'Add a note — optional. What do you want to know?';
  textarea.setAttribute('aria-label', 'Note for the agent');
  root.appendChild(textarea);

  // ---- attachments -------------------------------------------------
  const attachments: ComposerAttachment[] = [];
  const attachRow = el('div', 'illum-composer-attach');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.multiple = true;
  fileInput.hidden = true;
  const attachButton = el('button', 'illum-composer-attach-btn', 'Attach image');
  attachButton.type = 'button';
  attachButton.addEventListener('click', () => {
    fileInput.click();
  });
  const attachList = el('div', 'illum-composer-files');

  function addFiles(files: readonly File[]): void {
    for (const file of files) {
      if (!isImage(file)) continue;
      void readAsDataUrl(file).then((attachment) => {
        if (!attachment) return;
        attachments.push(attachment);
        const chip = el('span', 'illum-file');
        chip.appendChild(el('span', undefined, attachment.name));
        const remove = el('button', 'illum-file-remove', '×');
        remove.type = 'button';
        remove.title = `Remove ${attachment.name}`;
        remove.addEventListener('click', () => {
          const index = attachments.indexOf(attachment);
          if (index >= 0) attachments.splice(index, 1);
          chip.remove();
        });
        chip.appendChild(remove);
        attachList.appendChild(chip);
      });
    }
  }

  fileInput.addEventListener('change', () => {
    addFiles(Array.from(fileInput.files ?? []));
    fileInput.value = '';
  });
  attachRow.append(attachButton, fileInput, attachList);
  root.appendChild(attachRow);

  // Paste and drop, because "attach image" mostly means a screenshot that is
  // already on the clipboard and nowhere on disk.
  textarea.addEventListener('paste', (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.some(isImage)) {
      event.preventDefault();
      addFiles(files);
    }
  });
  root.addEventListener('dragover', (event: DragEvent) => {
    event.preventDefault();
    root.dataset.dropping = 'true';
  });
  root.addEventListener('dragleave', () => {
    delete root.dataset.dropping;
  });
  root.addEventListener('drop', (event: DragEvent) => {
    event.preventDefault();
    delete root.dataset.dropping;
    addFiles(Array.from(event.dataTransfer?.files ?? []));
  });

  // ---- hint + actions ----------------------------------------------
  const hint = el('div', 'illum-composer-hint');
  hint.appendChild(el('span', 'illum-kbd', 'Enter'));
  hint.appendChild(document.createTextNode(' queues · '));
  hint.appendChild(el('span', 'illum-kbd', 'Ctrl+Enter'));
  hint.appendChild(document.createTextNode(' sends · paste or drop an image'));
  root.appendChild(hint);

  const actions = el('div', 'illum-composer-actions');
  const cancel = el('button', 'illum-btn', 'Cancel');
  cancel.type = 'button';
  const queue = el('button', 'illum-btn', 'Queue');
  queue.type = 'button';
  const send = el('button', 'illum-btn illum-btn--primary', 'Send');
  send.type = 'button';
  actions.append(cancel, queue, send);
  root.appendChild(actions);

  let destroyed = false;
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    document.removeEventListener('keydown', onDocumentKeydown, true);
    root.remove();
  }

  function submit(mode: 'send' | 'queue'): void {
    const note = textarea.value.trim();
    options.onSubmit({
      intent: selected,
      note: note.length > 0 ? note : null,
      attachments: attachments.slice(),
      mode,
    });
    destroy();
  }

  cancel.addEventListener('click', () => {
    options.onClose();
    destroy();
  });
  queue.addEventListener('click', () => {
    submit('queue');
  });
  send.addEventListener('click', () => {
    submit('send');
  });

  textarea.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      submit('send');
      return;
    }
    if (!event.shiftKey) {
      event.preventDefault();
      submit('queue');
    }
  });

  /** Escape closes from anywhere in the composer, including the file input
   * and the chips. Registered on `document` in the capture phase because the
   * composer lives in a shadow root and a keystroke on a chip does not
   * bubble to it in composed order. */
  function onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    options.onClose();
    destroy();
  }
  document.addEventListener('keydown', onDocumentKeydown, true);

  // Append before measuring: the composer's rendered size is only known once
  // it is in the shadow tree with the adopted stylesheet applied. Same
  // discipline the old picker used, and the same clamping -- an anchor near
  // an edge must not push this off-screen where neither a pointer nor
  // Playwright's hit-test can reach it.
  shadowRoot.appendChild(root);
  const box = root.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  let top = anchorRect.bottom + 6;
  if (top + box.height > viewportHeight) top = anchorRect.top - box.height - 6;
  top = Math.max(8, Math.min(top, viewportHeight - box.height - 8));
  let left = anchorRect.left;
  left = Math.max(8, Math.min(left, viewportWidth - box.width - 8));
  root.style.top = `${String(top)}px`;
  root.style.left = `${String(left)}px`;

  textarea.focus();
  return { destroy };
}

/** Re-exported so callers that only need the label table do not have to know
 * which module the composer lives in. */
export { labelFor };
