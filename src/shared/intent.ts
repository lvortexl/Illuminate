/**
 * The typed-intent contract emitted at the artifact/browser boundary.
 * [ROUT-01] "The browser emits typed intent (explain / verify / deeper /
 * fix-artifact / fix-code), not an untyped prompt string." This is the
 * security-relevant boundary ARCHITECTURE.md's Agent Router section names:
 * because intent is typed HERE, at the point furthest from any model
 * output, and the router (Phase 6, ROUT-02) is a pure lookup table keyed
 * on this type, model output can never select a role or tier.
 *
 * Deliberately separate from shared/protocol.ts's 21-message vocabulary --
 * 01-09-PLAN.md's own text: "this file does NOT define illuminate:queueIntent
 * ... those belong to Phase 6's ROUT-0x requirements." A TypedIntentPayload
 * rides as the `payload` of an existing `illuminate:queuePrompt` message
 * (protocol.ts) -- Phase 4 does not add a new postMessage type; it defines
 * what a "prompt" IS, using the envelope Phase 1 already agreed on.
 *
 * Zero dependencies, zero imports, no enum/namespace -- importable by both
 * the Node CLI and the browser SDK (mirrors protocol.ts's own constraint).
 */

export const INTENT_PROTOCOL_VERSION = 'illuminate.intent/1' as const;

/**
 * Exactly the five intents ROUT-01 and ROADMAP.md Phase 4's success
 * criterion name, in this order. "fix-artifact" -- not ARCHITECTURE.md's
 * illustrative "fix-doc" -- REQUIREMENTS.md's locked wording governs.
 */
export const INTENT_TYPES = ['explain', 'verify', 'deeper', 'fix-artifact', 'fix-code'] as const;

export type Intent = (typeof INTENT_TYPES)[number];

export function isIntent(value: string): value is Intent {
  return (INTENT_TYPES as readonly string[]).includes(value);
}

/**
 * A minimal, DOM-free description of the element the intent targets.
 * `uid`/`selector` are computed by src/sdk/addressing.ts (Plan 04-02); this
 * type does not know how they were derived.
 */
export interface IntentElement {
  readonly uid: string;
  readonly selector: string;
  readonly tag: string;
  /** Truncated to <=240 chars by the caller -- ARCHITECTURE.md's cited
   * reference convention for `context()`. Not enforced here (this file has
   * no DOM access to measure against); src/sdk/addressing.ts truncates. */
  readonly text: string;
  /** Text immediately before this element in the artifact, DOM-computed by
   * Plan 07-03's snapshot code -- src/provenance/identity.ts's tier-3
   * disambiguation input. `null` until Plan 07-03 lands (this field is
   * reserved now, not populated by this plan), and remains a fully valid,
   * non-placeholder value for any element with no meaningful preceding
   * text (never omitted -- this file's `IntentAnchor` convention). */
  readonly prefixContext: string | null;
  /** Text immediately after this element. See `prefixContext`. */
  readonly suffixContext: string | null;
}

/**
 * Anchor fields as read directly off the element's data-src/data-rev/
 * data-anchor-hash attributes by src/sdk/anchor-read.ts (Plan 04-02) -- a
 * passthrough of raw strings, NOT a resolved anchor. src/provenance/types.ts's
 * AnchorRef is a Node-side, git-backed concept and must never be imported
 * here: the SDK runs on an opaque origin with no filesystem and no git
 * (ARCHITECTURE.md Part 0's consequence #1). `null` means the element had no
 * `data-src` -- ANCH-08 / FEATURES.md's graceful-degradation finding: an
 * unanchored element still gets a typed intent, just without grounding.
 *
 * `anchorHash` (06-01-PLAN.md): Phase 4 originally shipped this type WITHOUT
 * a hash field -- "ANCH-01 validation is Phase 2/6 resolver territory, not
 * the SDK" (src/sdk/anchor-read.ts's original comment). That was correct for
 * Phase 4's scope, but src/provenance/anchor.ts's AnchorInput/parseAnchor
 * treat anchorHash as MANDATORY (ANCH-01): its absence is a parse failure,
 * not a degraded-but-valid anchor. Without this field, every real anchor a
 * browser ever emitted would resolve to `refused`. `string | null` (not
 * optional) mirrors `rev`'s existing shape: `null` when the element has no
 * `data-anchor-hash`, the same graceful-degrade posture as an unanchored
 * element, never a thrown error.
 */
export interface IntentAnchor {
  readonly src: string;
  readonly rev: string | null;
  readonly anchorHash: string | null;
}

export interface TypedIntentPayload {
  readonly protocol: typeof INTENT_PROTOCOL_VERSION;
  readonly intent: Intent;
  readonly element: IntentElement;
  /** Required (not optional) -- see this task's behavior spec: a caller
   * must choose null explicitly, never omit the field. */
  readonly anchor: IntentAnchor | null;
  /** Reserved for Phase 7's progressive depth ladder (EDU-05). Phase 4
   * always sends 1 -- there is no card chain yet to deepen. */
  readonly depth: number;
  /** Reserved for Phase 7's "go deeper" chaining. Phase 4 always sends
   * null. Typed now (not added later) so Phase 6/7 extend this file's
   * USAGE, never its SHAPE -- protocol.ts's "declare the contract once"
   * discipline, applied here too. */
  readonly parent_dispatch: string | null;
  /** EDU-06's learner-initiated free text -- the reader's own explanation,
   * offered voluntarily, never solicited automatically. `null` for every
   * one of the 5 ordinary intents; only a self-explanation flow (Plan
   * 07-07) ever sets this to a non-null string. Required (not optional) --
   * this file's own `parent_dispatch`/`anchor` convention: a caller must
   * choose null explicitly, never omit the field. */
  readonly learnerNote: string | null;
  /** The human's own free-text instruction for this element, written in the
   * chrome rail's composer and carried verbatim to the agent.
   *
   * Deliberately NOT `learnerNote`, which looks similar and is not: a
   * `learnerNote` is the reader's own *explanation*, and its presence
   * switches the dispatch envelope to SELF_EXPLANATION_RETURN_CONTRACT so
   * the agent GRADES it against resolved source (router/envelope.ts). A
   * `note` is an ordinary request and changes no contract. Reusing
   * `learnerNote` for general notes would silently have every note marked
   * for grading.
   *
   * This does not weaken ROUT-01: the intent is still typed and chosen by
   * the human from a closed set, and the router is still a pure lookup
   * table keyed on that intent. A note is payload carried BY a typed
   * intent; it never selects the role, the tier or the tools.
   *
   * Required (not optional) -- this file's own `parent_dispatch`/`anchor`
   * convention: a caller must choose null explicitly, never omit. */
  readonly note: string | null;
  /** Images the human attached in the element composer.
   *
   * Carries IDENTIFIERS, never bytes. The artifact hands the chrome a data
   * URL (a sandboxed frame has no other way out), the chrome uploads it once
   * and puts the resulting id here. Inlining base64 on this payload would
   * write the image into the session store on every dispatch and replay it
   * on every poll and every annotation sync -- see
   * `src/store/attachment-store.ts` for the full reasoning.
   *
   * Required (not optional), like every other field on this interface: a
   * caller with no attachments passes `[]` explicitly. */
  readonly attachments: readonly IntentAttachment[];
}

/** One attached image, as it travels from the chrome to the daemon. The
 * bytes live on disk under the state directory; `id` is what names them. */
export interface IntentAttachment {
  readonly id: string;
  readonly mediaType: string;
}

export function buildTypedIntentPayload(input: {
  intent: Intent;
  element: IntentElement;
  anchor: IntentAnchor | null;
  /** Defaults to 1 -- existing Phase 4/6 call sites that never pass this
   * keep producing exactly the same payload shape they always have. */
  depth?: number;
  /** Defaults to null -- see `TypedIntentPayload.parent_dispatch`. */
  parent_dispatch?: string | null;
  /** Defaults to null -- see `TypedIntentPayload.learnerNote`. */
  learnerNote?: string | null;
  /** Defaults to null -- see `TypedIntentPayload.note`. */
  note?: string | null;
  /** Defaults to `[]` -- see `TypedIntentPayload.attachments`. */
  attachments?: readonly IntentAttachment[];
}): TypedIntentPayload {
  return {
    protocol: INTENT_PROTOCOL_VERSION,
    intent: input.intent,
    element: input.element,
    anchor: input.anchor,
    depth: input.depth ?? 1,
    parent_dispatch: input.parent_dispatch ?? null,
    learnerNote: input.learnerNote ?? null,
    note: input.note ?? null,
    attachments: input.attachments ?? [],
  };
}
