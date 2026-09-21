import { ARTIFACT_POST_TARGET_ORIGIN, type ArtifactToChromeMessage } from '../shared/protocol.ts';
import type { TypedIntentPayload, IntentElement, IntentAnchor } from '../shared/intent.ts';
import { buildDismissFindingPayload } from '../shared/dismiss.ts';

/**
 * The ONE place in this file -- and, per this plan's own whole-`src/`-tree
 * regression test, in all of `src/` -- that calls `parent.postMessage`.
 * `postTypedIntent` and `postDismissFinding` (Plan 08-04) both funnel
 * through this single private `send`, never calling `parent.postMessage`
 * directly themselves.
 */
function send(message: ArtifactToChromeMessage): void {
  parent.postMessage(message, ARTIFACT_POST_TARGET_ORIGIN);
}

/**
 * Wraps the typed intent as the `payload` of an existing illuminate:queuePrompt
 * message (protocol.ts, Phase 1) -- per JOIN-CONTRACT.md §3, this plan does
 * not add a new postMessage type. Signature/behavior UNCHANGED by Plan
 * 08-04's `send()` refactor.
 */
export function postTypedIntent(loadToken: string, payload: TypedIntentPayload): void {
  send({
    type: 'illuminate:queuePrompt',
    artifact_load_token: loadToken,
    // protocol.ts's envelope deliberately types `payload` as an opaque
    // Record<string, unknown> bag -- it does not (and per JOIN-CONTRACT.md
    // §3, should not) know about TypedIntentPayload's concrete shape. A
    // fixed-key interface without an index signature isn't structurally
    // assignable to a Record type, so this cast is the documented seam
    // where "a typed payload" becomes "an opaque envelope field" -- the
    // payload's own value is untouched, only its static type widens here.
    payload: payload as unknown as Readonly<Record<string, unknown>>,
  });
}

/**
 * Plan 08-04's dismiss action. Reuses the SAME existing `illuminate:queuePrompt`
 * message type `postTypedIntent` uses -- no new `ArtifactToChromeType` is
 * added for this. The receiving end (src/chrome/message-handling.ts's
 * `extractDismissFinding`) tells this apart from a real typed intent by
 * `payload.protocol === DISMISS_PROTOCOL_VERSION`, checked before any other
 * field, never by a different message `type`.
 */
export function postDismissFinding(loadToken: string, fingerprint: string): void {
  send({
    type: 'illuminate:queuePrompt',
    artifact_load_token: loadToken,
    payload: buildDismissFindingPayload(fingerprint) as unknown as Readonly<Record<string, unknown>>,
  });
}

/**
 * Tells the chrome rail which element the human just pointed at, so its
 * composer can target it. Funnels through the same private `send` as every
 * other outbound message -- `parent.postMessage` still appears exactly once
 * in all of `src/`, and the whole-tree regression test proving that stays
 * green.
 *
 * Unlike `postTypedIntent` this uses its OWN message type rather than
 * riding `illuminate:queuePrompt`: the two carry opposite consequences.
 * A queuePrompt creates a dispatch and costs a model call; a selection
 * creates nothing and is emitted on every click. Discriminating them by a
 * `payload.protocol` field on a shared type -- the trick `postDismissFinding`
 * uses -- would put a free, high-frequency message one parser bug away from
 * being read as billable work.
 */
export function postElementSelection(
  loadToken: string,
  element: IntentElement,
  anchor: IntentAnchor | null,
  label: string,
): void {
  send({
    type: 'illuminate:selectElement',
    artifact_load_token: loadToken,
    payload: { element, anchor, label } as unknown as Readonly<Record<string, unknown>>,
  });
}

/**
 * Submits the element composer: a typed intent, an optional note, and any
 * images the human attached, with `mode` saying whether to dispatch now or
 * hand it to the rail unsent.
 *
 * Its own message type rather than `illuminate:queuePrompt`, because what
 * travels here is not a `TypedIntentPayload`: the attachments still carry
 * BYTES, and the chrome has to upload them and swap in ids before anything
 * can be dispatched. Riding the dispatch message with a field that is only
 * sometimes bytes would put the upload step one missed branch away from
 * being skipped.
 */
export function postComposerSubmission(
  loadToken: string,
  submission: Readonly<Record<string, unknown>>,
): void {
  send({
    type: 'illuminate:queueNote',
    artifact_load_token: loadToken,
    payload: submission,
  });
}
