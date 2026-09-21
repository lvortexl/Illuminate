import { findBodyCloseOffset, detectBaseHref, detectAuthorCsp } from './detect.ts';

export type InjectWarning = 'base-href' | 'csp-meta';

export interface InjectResult {
  html: string;
  warnings: InjectWarning[];
}

// Only ever accept an absolute http(s) URL. Refusing anything else here --
// not just by caller convention -- structurally closes the <base>-rewrite
// exfiltration path (T-03-02): a root-relative script src is exactly what a
// malicious <base href> could redirect elsewhere.
const ABSOLUTE_HTTP_URL = /^https?:\/\//;

/**
 * Byte-exact HTML injection: given the artifact's raw HTML text and an
 * absolute script URL, returns that same text with exactly one `<script>`
 * tag spliced in immediately before the real `</body>` -- never a decoy
 * `</body>` occurring inside a `<script>`, `<pre><code>`, comment, `srcdoc`
 * attribute, or `<style>` block.
 *
 * This is a parse-only, offset-splice operation. The splice point itself is
 * computed by `findBodyCloseOffset` (./detect.ts) -- the one shared,
 * already-proven implementation of this offset math, reused verbatim by
 * every caller that needs it (09-04's export appendix is the second). That
 * function's own parse5 tree is used exclusively to locate the byte offset
 * of the real closing tag via `sourceCodeLocationInfo`; the HTML text
 * itself is never rebuilt from that tree by any tree-to-string step, which
 * is proven (STACK.md) to mutate ordinary HTML in ways that break the
 * served-equals-saved guarantee. No such tree-to-string export is imported
 * anywhere in this module.
 */
export function injectScriptTag(html: string, scriptUrl: string): InjectResult {
  if (!ABSOLUTE_HTTP_URL.test(scriptUrl)) {
    throw new Error(`injectScriptTag: scriptUrl must be absolute (http:// or https://), got: ${scriptUrl}`);
  }

  const tag = `<script src="${scriptUrl}"></script>`;
  const offset = findBodyCloseOffset(html);
  const splicedHtml = html.slice(0, offset) + tag + html.slice(offset);

  const warnings: InjectWarning[] = [];
  if (detectBaseHref(html)) warnings.push('base-href');
  if (detectAuthorCsp(html)) warnings.push('csp-meta');

  return { html: splicedHtml, warnings };
}
