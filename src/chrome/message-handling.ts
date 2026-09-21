import { isArtifactToChromeType, isFromCurrentArtifactLoad } from '../shared/protocol.ts';
import { isIntent, INTENT_PROTOCOL_VERSION } from '../shared/intent.ts';
import type { TypedIntentPayload, IntentElement, IntentAnchor, IntentTarget, Intent } from '../shared/intent.ts';
import { DISMISS_PROTOCOL_VERSION } from '../shared/dismiss.ts';

/**
 * Pure, DOM-free message validation for the chrome shell -- the FIRST real
 * consumer of protocol.ts's guards on the chrome side (03-03-PLAN.md's
 * /session/:key shell had none, per JOIN-CONTRACT.md §3). This is the
 * chrome shell's only line of defense against a hostile or buggy artifact
 * iframe's arbitrary postMessage data: it must never throw, no matter how
 * malformed `data` is (T-06-20, T-06-21).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `null` is the legitimate ANCH-08 unanchored-element case; anything else
 * malformed fails the WHOLE extraction (a discriminated result, not a bare
 * `IntentAnchor | null` return, so "invalid" is never confused with the
 * valid "no anchor" case). */
function parseAnchor(value: unknown): { ok: true; anchor: IntentAnchor | null } | { ok: false } {
  if (value === null) return { ok: true, anchor: null };
  if (!isRecord(value)) return { ok: false };
  const { src, rev, anchorHash } = value;
  if (typeof src !== 'string') return { ok: false };
  if (rev !== null && typeof rev !== 'string') return { ok: false };
  if (anchorHash !== null && typeof anchorHash !== 'string') return { ok: false };
  return { ok: true, anchor: { src, rev, anchorHash } };
}

function parseElement(value: unknown): IntentElement | null {
  if (!isRecord(value)) return null;
  const { uid, selector, tag, text, prefixContext, suffixContext } = value;
  if (typeof uid !== 'string' || typeof selector !== 'string' || typeof tag !== 'string' || typeof text !== 'string') {
    return null;
  }
  if (prefixContext !== null && typeof prefixContext !== 'string') return null;
  if (suffixContext !== null && typeof suffixContext !== 'string') return null;
  return { uid, selector, tag, text, prefixContext, suffixContext };
}

/**
 * `data` is whatever arrived as a real MessageEvent's `.data` -- untyped
 * `unknown` all the way through. Validates `type`/`artifact_load_token` via
 * protocol.ts's own guards FIRST (never re-implements that check locally),
 * then defensively validates the payload shape field-by-field before ever
 * constructing a `TypedIntentPayload` to return -- no `as TypedIntentPayload`
 * cast without the preceding runtime checks actually justifying it, mirroring
 * this codebase's "zero `as Intent` casts" discipline on the chrome side.
 */
export function extractTypedIntent(data: unknown, currentLoadToken: string): TypedIntentPayload | null {
  if (!isRecord(data)) return null;

  const { type, artifact_load_token: artifactLoadToken, payload } = data;
  if (typeof type !== 'string' || !isArtifactToChromeType(type)) return null;
  // Only illuminate:queuePrompt ever carries a TypedIntentPayload (JOIN-CONTRACT.md
  // §3) -- every other real ArtifactToChromeType is a different message shape
  // this function does not (and must not) attempt to interpret as one.
  if (type !== 'illuminate:queuePrompt') return null;

  if (typeof artifactLoadToken !== 'string') return null;
  if (!isFromCurrentArtifactLoad({ artifact_load_token: artifactLoadToken }, currentLoadToken)) return null;

  if (!isRecord(payload)) return null;
  const {
    protocol,
    intent,
    targets: rawTargets,
    depth,
    parent_dispatch: parentDispatch,
    learnerNote,
    note,
  } = payload;

  if (protocol !== INTENT_PROTOCOL_VERSION) return null;
  if (typeof intent !== 'string' || !isIntent(intent)) return null;

  // ADR-102: a LIST of selected sections. Every entry must parse; one bad
  // target rejects the whole message rather than being dropped, so a caller
  // never silently gets an answer about fewer sections than it asked about.
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) return null;
  const targets: IntentTarget[] = [];
  for (const rawTarget of rawTargets) {
    if (!isRecord(rawTarget)) return null;
    const element = parseElement(rawTarget.element);
    if (element === null) return null;
    const anchorResult = parseAnchor(rawTarget.anchor);
    if (!anchorResult.ok) return null;
    targets.push({ element, anchor: anchorResult.anchor });
  }

  if (typeof depth !== 'number') return null;
  if (parentDispatch !== null && typeof parentDispatch !== 'string') return null;
  // `learnerNote` is deliberately read camelCase, NOT snake_case -- unlike
  // `parent_dispatch` (which is snake_case because TypedIntentPayload itself
  // declares that field snake_case), JSON.stringify emits property names
  // exactly as TypeScript wrote them, and `learnerNote` is the name this
  // plan's own interface declares. Do not "normalize" this to
  // `learner_note` -- that would invent a wire shape this file's own type
  // does not describe.
  if (learnerNote !== null && typeof learnerNote !== 'string') return null;
  // Same shape discipline as `learnerNote` above -- see TypedIntentPayload.note
  // for why these two fields are separate and must stay so.
  if (note !== null && typeof note !== 'string') return null;

  // `protocol`/`parent_dispatch`/`learnerNote` are re-typed from the
  // already-validated `unknown` fields above via a plain cast (not `as
  // Intent` -- that specific cast never appears anywhere in this codebase):
  // `protocol` was just proven `=== INTENT_PROTOCOL_VERSION` and
  // `parent_dispatch`/`learnerNote` were just proven `null | string`,
  // mirroring server.ts's own parseAnswerSubmission convention of casting a
  // field immediately after the runtime check that justifies it.
  return {
    protocol: INTENT_PROTOCOL_VERSION,
    intent,
    targets,
    depth,
    parent_dispatch: parentDispatch as string | null,
    learnerNote: learnerNote as string | null,
    note: note as string | null,
    attachments: [],
  };
}

/**
 * Validates a raw postMessage `data` as a genuine `illuminate:endSession`
 * signal from the CURRENT artifact load -- 06-12 wired `POST /api/:key/end`
 * and protocol.ts already declared `illuminate:endSession` as a real
 * `ArtifactToChromeType`, but left the chrome shell with no code that
 * recognised it (06-12-SUMMARY.md's own documented gap: "the browser itself
 * has no UI affordance that calls this new route yet").
 *
 * Unlike `extractTypedIntent`, `illuminate:endSession` carries no fields
 * this chrome shell needs to interpret -- the whole message IS the signal.
 * This returns a boolean, not a payload, and reuses the exact same
 * `isArtifactToChromeType`/`isFromCurrentArtifactLoad` guards
 * `extractTypedIntent` uses, never re-implementing the token check locally
 * (the same trust-boundary discipline this file's own header doc comment
 * describes).
 */
export function isEndSessionSignal(data: unknown, currentLoadToken: string): boolean {
  if (!isRecord(data)) return false;

  const { type, artifact_load_token: artifactLoadToken } = data;
  if (typeof type !== 'string' || !isArtifactToChromeType(type)) return false;
  if (type !== 'illuminate:endSession') return false;

  if (typeof artifactLoadToken !== 'string') return false;
  return isFromCurrentArtifactLoad({ artifact_load_token: artifactLoadToken }, currentLoadToken);
}

/**
 * Plan 08-04's dismiss-action guard. Mirrors `extractTypedIntent`'s own
 * structure and never-throw discipline exactly -- `type`/`artifact_load_token`
 * are validated via protocol.ts's own guards FIRST (never re-implemented
 * locally), same as every other function in this file. The two payload
 * SHAPES riding the same `illuminate:queuePrompt` message (a typed intent,
 * and this dismiss action) cannot collide: `payload.protocol` is checked
 * before any other payload field, and `DISMISS_PROTOCOL_VERSION` !==
 * `INTENT_PROTOCOL_VERSION` by construction, so a real typed-intent message
 * is never misread as a dismiss (T-08-09).
 */
export function extractDismissFinding(data: unknown, currentLoadToken: string): { readonly fingerprint: string } | null {
  if (!isRecord(data)) return null;

  const { type, artifact_load_token: artifactLoadToken, payload } = data;
  if (typeof type !== 'string' || !isArtifactToChromeType(type)) return null;
  if (type !== 'illuminate:queuePrompt') return null;

  if (typeof artifactLoadToken !== 'string') return null;
  if (!isFromCurrentArtifactLoad({ artifact_load_token: artifactLoadToken }, currentLoadToken)) return null;

  if (!isRecord(payload)) return null;
  const { protocol, fingerprint } = payload;

  if (protocol !== DISMISS_PROTOCOL_VERSION) return null;
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) return null;

  return { fingerprint };
}

/**
 * Validates a raw postMessage `data` as a genuine `illuminate:selectElement`
 * from the CURRENT artifact load -- the human pointed at an element and the
 * chrome rail's composer should now target it.
 *
 * Reuses `parseElement`/`parseAnchor` verbatim rather than re-validating
 * those shapes locally, and applies the SAME
 * `isArtifactToChromeType`/`isFromCurrentArtifactLoad` guards
 * `extractTypedIntent` does -- this is the identical trust boundary, and a
 * stale-token selection must be dropped exactly like a stale-token prompt.
 *
 * Selecting a target deliberately creates NO dispatch and NO queue entry:
 * it moves no work and is observable to no agent. That is what makes it
 * safe for this message to arrive on every click.
 */
export function extractElementSelection(
  data: unknown,
  currentLoadToken: string,
): { element: IntentElement; anchor: IntentAnchor | null; label: string } | null {
  if (!isRecord(data)) return null;

  const { type, artifact_load_token: artifactLoadToken, payload } = data;
  if (typeof type !== 'string' || !isArtifactToChromeType(type)) return null;
  if (type !== 'illuminate:selectElement') return null;

  if (typeof artifactLoadToken !== 'string') return null;
  if (!isFromCurrentArtifactLoad({ artifact_load_token: artifactLoadToken }, currentLoadToken)) return null;

  if (!isRecord(payload)) return null;
  const element = parseElement(payload.element);
  if (element === null) return null;

  const anchorResult = parseAnchor(payload.anchor);
  if (!anchorResult.ok) return null;

  const { label } = payload;
  if (typeof label !== 'string') return null;

  return { element, anchor: anchorResult.anchor, label };
}

/** One image as it crosses from the artifact to the chrome: raw bytes in a
 * data URL, because a sandboxed opaque-origin frame has no other way out.
 * This is the ONLY hop that carries bytes -- the chrome uploads them once
 * and everything downstream refers to the id it gets back. */
export interface ComposerAttachmentInput {
  readonly dataUrl: string;
  readonly name: string;
  readonly mediaType: string;
}

export interface ComposerSubmissionMessage {
  /** ADR-102: every section the reader had selected when they submitted. */
  readonly targets: readonly IntentTarget[];
  readonly label: string;
  readonly intent: Intent;
  readonly note: string | null;
  readonly attachments: readonly ComposerAttachmentInput[];
  readonly mode: 'send' | 'queue';
}

/**
 * Validates a raw postMessage as a genuine `illuminate:queueNote` -- the
 * element composer submitting.
 *
 * Deliberately NOT folded into `extractTypedIntent`. That function returns a
 * `TypedIntentPayload`, which the chrome POSTs to the daemon verbatim, and a
 * TypedIntentPayload's `attachments` are IDS of already-uploaded files. What
 * arrives here still carries bytes and has not been uploaded yet, so it is a
 * different shape with a different destination: the chrome uploads first,
 * then either dispatches or hands the result to the rail. Sharing one
 * validator would mean one of the two callers always holding a field the
 * other must ignore.
 *
 * Same trust boundary as every other artifact->chrome message: never throws,
 * and a stale load token is rejected before any field is read.
 */
export function extractComposerSubmission(data: unknown, currentLoadToken: string): ComposerSubmissionMessage | null {
  if (!isRecord(data)) return null;

  const { type, artifact_load_token: artifactLoadToken, payload } = data;
  if (typeof type !== 'string' || !isArtifactToChromeType(type)) return null;
  if (type !== 'illuminate:queueNote') return null;

  if (typeof artifactLoadToken !== 'string') return null;
  if (!isFromCurrentArtifactLoad({ artifact_load_token: artifactLoadToken }, currentLoadToken)) return null;

  if (!isRecord(payload)) return null;

  // ADR-102: one bad target rejects the whole submission rather than being
  // dropped, so the human never gets an answer about fewer sections than they
  // selected without being told.
  if (!Array.isArray(payload.targets) || payload.targets.length === 0) return null;
  const targets: IntentTarget[] = [];
  for (const rawTarget of payload.targets) {
    if (!isRecord(rawTarget)) return null;
    const element = parseElement(rawTarget.element);
    if (element === null) return null;
    const anchorResult = parseAnchor(rawTarget.anchor);
    if (!anchorResult.ok) return null;
    targets.push({ element, anchor: anchorResult.anchor });
  }

  const { label, intent, note, mode } = payload;
  if (typeof label !== 'string') return null;
  if (typeof intent !== 'string' || !isIntent(intent)) return null;
  if (note !== null && typeof note !== 'string') return null;
  if (mode !== 'send' && mode !== 'queue') return null;

  const rawAttachments = payload.attachments;
  if (!Array.isArray(rawAttachments)) return null;
  const attachments: ComposerAttachmentInput[] = [];
  for (const raw of rawAttachments) {
    if (!isRecord(raw)) return null;
    const { dataUrl, name, mediaType } = raw;
    if (typeof dataUrl !== 'string' || typeof name !== 'string' || typeof mediaType !== 'string') return null;
    attachments.push({ dataUrl, name, mediaType });
  }

  return { targets, label, intent, note: note as string | null, attachments, mode };
}
