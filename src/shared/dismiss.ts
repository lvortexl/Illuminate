/**
 * The dismiss-finding contract emitted at the artifact/browser boundary,
 * mirroring shared/intent.ts's own zero-dependency, importable-from-both-
 * Node-and-browser isolation discipline exactly.
 *
 * Deliberately NOT a new `ArtifactToChromeType` (shared/protocol.ts): a
 * `DismissFindingPayload` rides as the `payload` of the SAME existing
 * `illuminate:queuePrompt` message `TypedIntentPayload` already uses --
 * protocol.ts's own envelope deliberately types `payload` as an opaque
 * `Record<string, unknown>` bag, and this file's own `DISMISS_PROTOCOL_VERSION`
 * (distinct from `INTENT_PROTOCOL_VERSION`) is what lets a chrome-side
 * listener tell the two shapes apart without a second postMessage call site
 * anywhere in `src/` -- see src/sdk/post.ts's own `send()` refactor.
 */

export const DISMISS_PROTOCOL_VERSION = 'illuminate.dismiss/1' as const;

export interface DismissFindingPayload {
  readonly protocol: typeof DISMISS_PROTOCOL_VERSION;
  readonly fingerprint: string;
}

export function buildDismissFindingPayload(fingerprint: string): DismissFindingPayload {
  return { protocol: DISMISS_PROTOCOL_VERSION, fingerprint };
}
