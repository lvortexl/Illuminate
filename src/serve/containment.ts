import { realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import type { IncomingMessage } from 'node:http';

/**
 * Deviation from RESEARCH.md §6.6's sketch, made deliberately: the research's
 * `resolveAssetPath` returns a bare `null` for three semantically different
 * cases (not-found, forbidden-by-traversal, forbidden-by-dotfile), even
 * though its own comments say these map to *different* HTTP status codes
 * (404 for not-found, 403 for the other two). A bare `null` cannot carry
 * that distinction to the caller — so this is a discriminated result instead.
 */
export type ContainmentResult =
  | { kind: 'ok'; path: string }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

/**
 * Resolves a browser-supplied request path against an artifact root,
 * refusing to leave that root by traversal or symlink escape, and refusing
 * any dot-prefixed path segment unconditionally. `not-found` and `forbidden` are deliberately
 * distinct result kinds so the caller can map them to 404 vs 403 — but see
 * T-01-15 in this plan's threat model: ENOENT still maps to 404 even when
 * the ENOENT is the result of a traversal probe landing outside `root`, so
 * "missing inside root" and "escaping outside root" are not distinguishable
 * from outside. That is the documented, deliberate non-leak behavior.
 */
export async function resolveAssetPath(
  artifactRoot: string,
  requestPath: string,
): Promise<ContainmentResult> {
  const candidate = resolve(artifactRoot, '.' + requestPath);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return { kind: 'not-found' };
  }
  const rootReal = await realpath(artifactRoot);
  const rel = relative(rootReal, real);
  if (rel.startsWith('..') || isAbsolute(rel)) return { kind: 'forbidden' };
  // Every segment, not only the basename: `.git/config` has the basename
  // `config`, and the file it names is exactly the leak T-01-13 lists.
  if (rel.split(sep).some((segment) => segment.startsWith('.'))) return { kind: 'forbidden' };
  return { kind: 'ok', path: real };
}

/**
 * Allowlists the `Host` header to loopback-only values, defending against
 * DNS rebinding against this unauthenticated loopback server (T-01-14):
 * a page loaded from a remote origin could otherwise make the victim's
 * browser issue requests to 127.0.0.1:<port> with an attacker-controlled
 * `Host` header pointed at a real DNS name that resolves to 127.0.0.1.
 */
export function isAllowedHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const hostname = extractHostname(host);
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

/**
 * Same-origin guard for Phase 6's first mutating routes that create real,
 * billable downstream work (T-06-13): a cross-site request can still be
 * ISSUED against this unauthenticated loopback server (the `isAllowedHost`
 * Host-header allowlist above defends the request's destination, not its
 * source) -- only reading the response is blocked by the browser's own
 * same-origin policy. Rejecting a foreign `Origin` here stops the request
 * from ever mutating state in the first place.
 *
 * An ABSENT `Origin` header is treated as trusted, not rejected: a
 * same-process CLI caller (curl, `illuminate answer`, Plan 11's future
 * self-dispatch) never sends one, and neither does this file's own
 * pre-existing `/api/sessions` / `/api/:key/artifact-loads/begin` routes
 * check for one today -- so this function is a strict TIGHTENING for the
 * NEW dispatch/heartbeat/answer routes, not a behavior change retrofitted
 * onto those two pre-existing routes.
 */
export function isSameOriginRequest(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

/**
 * Strips a trailing ":port" from a Host header value, without breaking
 * IPv6 addresses (which contain colons themselves).
 *
 * Bug found and fixed here: the naive `host.split(':')[0]` from
 * RESEARCH.md §6.6's sketch (and this plan's own action code) breaks on
 * bracketed IPv6 notation — `'[::1]'.split(':')[0]` is `'['`, not
 * `'[::1]'`, so `Host: [::1]` would incorrectly fail the allowlist despite
 * being one of the six documented cases this function must accept.
 */
function extractHostname(host: string): string {
  if (host.startsWith('[')) {
    // Bracketed IPv6, e.g. "[::1]" or "[::1]:4319" — keep through the
    // closing bracket; any port suffix comes after it.
    const closeBracket = host.indexOf(']');
    return closeBracket === -1 ? host : host.slice(0, closeBracket + 1);
  }
  // A bare (unbracketed) IPv6 address such as "::1" contains more than one
  // colon — a "hostname:port" pair never does. Only strip a trailing
  // ":port" when there's exactly one colon; otherwise the whole value is
  // the hostname.
  const colonCount = (host.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    return host.split(':')[0] ?? host;
  }
  return host;
}
