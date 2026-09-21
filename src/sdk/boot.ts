import { SHADOW_CSS } from './shadow-style.ts';

export interface SdkBootResult {
  readonly shadowRoot: ShadowRoot;
  readonly loadToken: string;
  readonly revision: string; // NEW -- raw artifact_revision query param, read once here alongside artifact_load_token
}

/**
 * Per JOIN-CONTRACT.md §1: the artifact document's OWN URL carries
 * `artifact_load_token` (03-03-PLAN.md's real /artifact/:key/ route shape)
 * -- NOT document.currentScript.src, which only carries `?key=...`. A
 * missing/empty token means this document was not loaded through a real
 * (or fixture) illuminate session; the SDK refuses to attach any UI rather
 * than running unauthenticated against an unknown parent frame.
 *
 * `artifact_revision` rides the same URL (SERVE-08's freshness guard always
 * sets both together) -- read here, once, alongside the token, rather than
 * adding a second URL-parsing pass in Plan 07-05's card renderer. Kept as a
 * raw string (no `Number()` parsing): reattachCards()/identity.ts's
 * `reattach()` only ever compare it for string equality/inequality across
 * calls, never arithmetic.
 */
export function boot(): SdkBootResult | null {
  const params = new URLSearchParams(window.location.search);
  const loadToken = params.get('artifact_load_token');
  const revision = params.get('artifact_revision');
  if (!loadToken || !revision) {
    console.error('illuminate SDK: no artifact_load_token in the document URL -- refusing to boot');
    return null;
  }

  const host = document.createElement('div');
  host.setAttribute('data-illuminate-ui', 'overlay');
  document.documentElement.appendChild(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(SHADOW_CSS);
  shadowRoot.adoptedStyleSheets = [sheet]; // shadow root only -- NEVER document.adoptedStyleSheets (SERVE-07)

  // Non-configurable, non-writable: an artifact (agent-generated, untrusted)
  // must not be able to clobber this mid-review. STACK.md's explicit
  // anti-clobber recommendation.
  if (!('illuminate' in window)) {
    Object.defineProperty(window, 'illuminate', {
      value: Object.freeze({ ready: true }),
      configurable: false,
      writable: false,
    });
  }

  return { shadowRoot, loadToken, revision };
}
