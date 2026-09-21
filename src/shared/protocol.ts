/**
 * The single source of truth for the artifact <-> chrome postMessage
 * vocabulary. [V] ARCHITECTURE.md's "Part 0" table: 21 message types,
 * extracted from the reference's two unrelated bundles (cli.mjs,
 * chrome-client.js), which had NO shared declaration between them --
 * ARCHITECTURE.md line 224 names that as the maintenance hazard this file
 * exists to prevent. Phase 4 (chrome shell + artifact SDK) is the first
 * real consumer; this plan only declares the contract.
 *
 * Zero dependencies, zero imports -- this file must remain importable by
 * both the Node-side daemon/CLI and, later, the serialised browser SDK
 * (ARCHITECTURE.md Pattern 3) without dragging in anything Node-specific.
 */

export const PROTOCOL_VERSION = 1 as const;

/** Wildcard is forced, not a choice: the sandboxed artifact frame has an
 * opaque origin (no `allow-same-origin`) and cannot name the parent's
 * origin. `artifact_load_token` on every message below is the actual
 * authentication that makes a wildcard-origin postMessage safe -- see
 * isFromCurrentArtifactLoad. This is a security-relevant invariant, not an
 * implementation detail (ARCHITECTURE.md line 87). */
export const ARTIFACT_POST_TARGET_ORIGIN = '*' as const;

export const ARTIFACT_TO_CHROME_TYPES = [
  'illuminate:queuePrompt',
  'illuminate:sendQueuedPrompts',
  'illuminate:endSession',
  'illuminate:status',
  'illuminate:snapshot',
  'illuminate:scroll',
  'illuminate:reviewState',
  'illuminate:reviewDraftUnrestorable',
  'illuminate:layoutDiagnostics',
  'illuminate:artifactAssetFailure',
  'illuminate:uploadAttachment',
  'illuminate:queueNote', // NEW -- the element composer's Queue action: a complete
  // {element, anchor, label, intent, note, attachments} the rail holds UNSENT. Distinct
  // from queuePrompt, which dispatches immediately and costs a model call.
  'illuminate:selectElement', // NEW -- carries {element, anchor, label} as `payload`;
  // the artifact telling the chrome rail which element the human just pointed at.
  // Deliberately NOT a dispatch: selecting a target creates no work, so it can
  // never enqueue anything an agent could observe.
  'illuminate:toggleAnnotationMode',
  'illuminate:suspendWhiteboard',
  'illuminate:resumeWhiteboard',
] as const;

export const CHROME_TO_ARTIFACT_TYPES = [
  'illuminate:setAnnotationMode',
  'illuminate:requestSnapshot',
  'illuminate:requestLayoutDiagnostics',
  'illuminate:restoreScroll',
  'illuminate:restoreReviewState',
  'illuminate:revealElement',
  'illuminate:attachmentResult',
  'illuminate:syncAnnotations', // NEW -- carries the full current AnnotationStore as `payload`
  'illuminate:dispatchCreated', // NEW -- carries {dispatchId, elementUid} as `payload`, echoed right after a dispatch POST resolves
  'illuminate:syncFindings', // NEW (Phase 8) -- carries {findings, meta} as payload
  'illuminate:cardAction', // NEW -- {cardId, action: 'deeper' | 'self-explain', learnerNote}; the rail
  // asking the ARTIFACT to run a card follow-up, because the payload must be built from the
  // card's live element at click time (T-07-17), which only the artifact has.
  'illuminate:setCardPresentation', // NEW -- {mode: 'rail' | 'inline'};
  // the chrome telling the artifact who renders card BODIES. Absent means
  // 'inline', so the SDK's standalone behaviour is unchanged by default.
] as const;

export type ArtifactToChromeType = (typeof ARTIFACT_TO_CHROME_TYPES)[number];
export type ChromeToArtifactType = (typeof CHROME_TO_ARTIFACT_TYPES)[number];

interface ArtifactToChromeEnvelope<T extends ArtifactToChromeType = ArtifactToChromeType> {
  readonly type: T;
  /** [V] cli.mjs:5132 -- carried on every artifact->chrome message. The
   * chrome shell MUST discard any message whose token does not match the
   * load it is currently tracking (isFromCurrentArtifactLoad). */
  readonly artifact_load_token: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

interface ChromeToArtifactEnvelope<T extends ChromeToArtifactType = ChromeToArtifactType> {
  readonly type: T;
  // [V] the research found no evidence chrome->artifact messages carry the
  // load token: chrome always posts to the CURRENT iframe's contentWindow
  // after updating iframe.src, so there is no "stale sender" problem
  // symmetric to the artifact->chrome direction. Do not add this field
  // here without a verified citation -- that would be an invented claim.
  readonly payload?: Readonly<Record<string, unknown>>;
}

export type ArtifactToChromeMessage = {
  [T in ArtifactToChromeType]: ArtifactToChromeEnvelope<T>;
}[ArtifactToChromeType];

export type ChromeToArtifactMessage = {
  [T in ChromeToArtifactType]: ChromeToArtifactEnvelope<T>;
}[ChromeToArtifactType];

export type ProtocolMessage = ArtifactToChromeMessage | ChromeToArtifactMessage;

export function isArtifactToChromeType(value: string): value is ArtifactToChromeType {
  return (ARTIFACT_TO_CHROME_TYPES as readonly string[]).includes(value);
}

export function isChromeToArtifactType(value: string): value is ChromeToArtifactType {
  return (CHROME_TO_ARTIFACT_TYPES as readonly string[]).includes(value);
}

/** Runtime guard for the load-token invariant. Phase 4's chrome-side
 * message handler must call this before trusting any artifact->chrome
 * message -- see ARCHITECTURE.md line 87: "the chrome discards messages
 * whose token does not match the current artifact load." */
export function isFromCurrentArtifactLoad(
  message: { readonly artifact_load_token: string },
  currentLoadToken: string,
): boolean {
  return message.artifact_load_token === currentLoadToken;
}
