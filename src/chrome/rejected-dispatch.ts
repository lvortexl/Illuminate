/**
 * The one sentence illuminate says when the daemon refuses a dispatch
 * request (ADR-111). Pure, so the branch that used to throw on a `null`
 * body can be tested without a browser: `res.json()` resolves for the
 * literal JSON `null` and for any non-object, and a missing or non-string
 * `error` field is an ordinary shape, never a crash.
 */
export function rejectedDispatchNotice(status: number, statusText: string, body: unknown): string {
  const error = body !== null && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  const detail = typeof error === 'string' && error.length > 0 ? error : statusText.length > 0 ? statusText : 'no detail';
  return `illuminate could not queue that request (HTTP ${String(status)}): ${detail}`;
}
