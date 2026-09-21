import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';

/**
 * Recursively locates the FIRST element in the parse5 tree whose tag name
 * matches `tagName`, depth-first, document order. Shared by inject.ts to
 * locate `<body>` for the splice offset, and by this file's own detectors
 * to locate `<base>`.
 *
 * Never mutates the tree. Never rebuilds a string from it -- this file, like
 * inject.ts, must never import or call parse5's tree-to-string export.
 */
export function findFirstByTagName(
  node: DefaultTreeAdapterTypes.Node,
  tagName: string,
): DefaultTreeAdapterTypes.Element | null {
  if ('tagName' in node && node.tagName === tagName) {
    return node;
  }
  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      const found = findFirstByTagName(child, tagName);
      if (found) return found;
    }
  }
  return null;
}

function findAllByTagName(
  node: DefaultTreeAdapterTypes.Node,
  tagName: string,
  out: DefaultTreeAdapterTypes.Element[] = [],
): DefaultTreeAdapterTypes.Element[] {
  if ('tagName' in node && node.tagName === tagName) {
    out.push(node);
  }
  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      findAllByTagName(child, tagName, out);
    }
  }
  return out;
}

/** Generalizes findAllByTagName's existing tree-walk to "every element
 * carrying attribute `attrName`" -- factored out here (not duplicated in
 * anchors.ts) because a second hand-rolled parse5 tree-walk in this
 * codebase is worse than one shared, tested one. Never mutates the tree;
 * never calls parse5's tree-to-string export -- same discipline as this
 * file's existing two exports. */
export function findAllByAttribute(
  node: DefaultTreeAdapterTypes.Node,
  attrName: string,
  out: DefaultTreeAdapterTypes.Element[] = [],
): DefaultTreeAdapterTypes.Element[] {
  if ('tagName' in node && node.attrs.some((attr) => attr.name === attrName)) {
    out.push(node);
  }
  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      findAllByAttribute(child, attrName, out);
    }
  }
  return out;
}

/**
 * The byte offset, in `html`, immediately before the real `</body>` --
 * never a decoy `</body>`-shaped substring occurring inside a `<script>`,
 * `<pre><code>`, comment, `srcdoc` attribute, or `<style>` block. This is
 * the offset half of inject.ts's own splice technique (`injectScriptTag`),
 * extracted here so a second caller (the export appendix, 09-04) can reuse
 * the identical, already-proven math rather than hand-maintaining a second
 * copy of the same 2-branch fallback ladder.
 *
 * Parse-only: parse5's tree is used exclusively to locate the byte offset
 * of the real closing tag via `sourceCodeLocationInfo`; the HTML text
 * itself is never rebuilt from that tree by any tree-to-string step, which
 * is proven (STACK.md) to mutate ordinary HTML in ways that break the
 * served-equals-saved guarantee. No such tree-to-string export is imported
 * anywhere in this module.
 *
 * Fallback ladder, 2 branches:
 *   1. Explicit </body> -- return its start offset.
 *   2. No explicit close tag (implied) -- return the original string's
 *      length. PITFALLS.md confirms this is correct browser behaviour:
 *      "Appends at end of document. Browsers' error recovery places it in
 *      body. Correct, keep."
 */
export function findBodyCloseOffset(html: string): number {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const body = findFirstByTagName(doc, 'body');
  return body?.sourceCodeLocation?.endTag?.startOffset ?? html.length;
}

/**
 * True if the artifact declares a `<base href="...">`. illuminate must never
 * rewrite or strip this -- only detect and warn -- because a `<base>` rewrite
 * is also the exfiltration path T-03-02 closes at injectScriptTag's boundary.
 */
export function detectBaseHref(html: string): boolean {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const base = findFirstByTagName(doc, 'base');
  if (!base) return false;
  return base.attrs.some((attr) => attr.name.toLowerCase() === 'href');
}

/**
 * True if the artifact declares an author `<meta http-equiv="Content-Security-Policy">`.
 * illuminate must never rewrite or strip this -- only detect and warn, since an
 * author-set CSP may legitimately block the injected script or inlined export
 * assets, and silently altering it would violate served-equals-saved.
 */
export function detectAuthorCsp(html: string): boolean {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const metas = findAllByTagName(doc, 'meta');
  return metas.some((meta) => {
    const httpEquiv = meta.attrs.find((attr) => attr.name.toLowerCase() === 'http-equiv');
    return httpEquiv !== undefined && httpEquiv.value.toLowerCase() === 'content-security-policy';
  });
}
