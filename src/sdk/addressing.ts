/// <reference lib="dom" />
// The above triple-slash directive pulls in DOM types for THIS FILE only,
// independent of whichever tsconfig ends up compiling it. Needed because
// this file is imported two ways: tsconfig.browser.json (lib: DOM, the
// SDK's real build target) AND transitively via test/sdk/addressing.test.ts
// (and, per 07-03-PLAN.md, test/sdk/snapshot.test.ts) under the root
// tsconfig.json (lib: ES2022, no DOM -- Node/CLI target). Without this,
// `tsc --noEmit`'s root pass fails on Element/document even though only the
// DOM-free buildSelector/buildUid/truncateText exports are ever imported
// from a Node context -- TS type-checks the whole file regardless of which
// exports a given importer actually uses. Same pattern intent-picker.ts
// already uses, for the same reason.

export interface AncestorStep {
  readonly tag: string;
  readonly nthOfType: number;
  readonly id: string | null;
}

/** Root-first: index 0 is the outermost ancestor the caller chose to start
 * from (typically document.documentElement's child), the last entry is the
 * targeted element itself. Pure -- the DOM walk that PRODUCES this chain
 * lives in boot.ts/index.ts, not here.
 *
 * Index 0 never renders `:nth-of-type(...)` (unless it has an id, which
 * still wins via the tag#id branch): it is the walk's starting point --
 * typically document.documentElement's single child (`<body>`) -- unique
 * by construction, so a positional qualifier there is redundant noise a
 * human writing the same selector by hand would drop. Every other step
 * keeps its `:nth-of-type` because siblings of the same tag are common at
 * deeper levels. */
export function buildSelector(chain: readonly AncestorStep[]): string {
  return chain
    .map((step, index) => {
      if (step.id) return `${step.tag}#${step.id}`;
      if (index === 0) return step.tag;
      return `${step.tag}:nth-of-type(${step.nthOfType})`;
    })
    .join(' > ');
}

// Non-cryptographic, deterministic, dependency-free -- this is an
// addressing/dedupe key within one page load, not a security boundary, so
// FNV-1a is the right tool: no Web Crypto async ceremony, works identically
// under node --test and every real browser.
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildUid(selector: string, textSnippet: string): string {
  return `el_${fnv1a(`${selector} ${textSnippet}`)}`;
}

export function truncateText(text: string, maxLength = 240): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

/** Walks up from `el` to document.documentElement, root-first, computing
 * each step's tag/nth-of-type/id -- the DOM-touching half of addressing;
 * buildSelector/buildUid (pure) do the actual string work. Extracted
 * verbatim from index.ts's own private closure (07-03-PLAN.md) so
 * snapshot.ts can reuse it to address ANY element on the page, not just
 * the one under the cursor. */
export function walkChain(el: Element): AncestorStep[] {
  const steps: AncestorStep[] = [];
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    // Explicit annotation: the local `parent` shadows the DOM global
    // `Window.parent`, and without a type annotation tsc mis-resolves
    // this as a circular self-reference (TS7022) instead of inferring
    // `Element | null` from `node.parentElement`.
    const parent: Element | null = node.parentElement;
    const siblingsOfType = parent
      ? Array.from(parent.children).filter((c) => c.tagName === node!.tagName)
      : [node];
    steps.unshift({
      tag: node.tagName.toLowerCase(),
      nthOfType: siblingsOfType.indexOf(node) + 1,
      id: node.id || null,
    });
    node = parent;
  }
  return steps;
}
