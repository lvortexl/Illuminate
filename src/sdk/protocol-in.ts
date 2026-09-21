import { isChromeToArtifactType } from '../shared/protocol.ts';

/**
 * Artifact-side (SDK) parsing of the two new chrome->artifact message types
 * this plan (07-04) adds to protocol.ts: `illuminate:syncAnnotations`
 * (carries the full current `AnnotationStore` as `payload`) and
 * `illuminate:dispatchCreated` (carries `{dispatchId, elementUid}`, echoed
 * right after a dispatch POST resolves).
 *
 * Chrome is first-party and privileged here (unlike the artifact->chrome
 * direction message-handling.ts guards against a hostile/buggy artifact
 * iframe) -- this file validates SHAPE (never throws on malformed/
 * unexpected data) without message-handling.ts's full adversarial rigor.
 * The security-relevant control for this data is Plan 07-05's card
 * renderer (never `innerHTML` model-authored or repo-authored prose), not
 * here -- see this plan's own `<threat_model>` (T-07-12).
 *
 * `WireXxx` types are the artifact-side, structurally-validated mirror of
 * src/store/annotation-store.ts's own `AnnotationStore`/`Card`/
 * `CardThreadEntry`/`CardSource` -- declared separately, deliberately: this
 * SDK-side module must stay importable from the browser bundle without
 * dragging in that Node-side module's own type dependencies
 * (src/provenance/identity.ts, src/router/types.ts).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Discriminated result -- mirrors message-handling.ts's own `parseAnchor`
 * convention: `null` is a legitimate value for several of these fields, so
 * "invalid" must never be conflated with "validly absent". */
type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

export interface WireCardSource {
  readonly path: string;
  readonly rev: string | null;
  readonly range: { readonly startLine: number; readonly endLine: number } | null;
  readonly status: string;
  readonly content: string | null;
}

export interface WireCardThreadEntry {
  readonly dispatchId: string;
  readonly intent: string;
  readonly depth: number;
  readonly parentDispatchId: string | null;
  readonly learnerNote: string | null;
  readonly markdown: string;
  readonly verdict: string | null;
  readonly decidingLines: string | null;
  readonly model: string;
  readonly tier: string;
  readonly source: WireCardSource | null;
  readonly answeredAt: string;
}

export interface WireElementSnapshot {
  readonly elementUid: string | null;
  readonly anchor: { readonly path: string; readonly startLine: number | null; readonly endLine: number | null } | null;
  readonly textContent: string;
  readonly prefixContext: string | null;
  readonly suffixContext: string | null;
  readonly structuralPath: string;
}

export interface WireOrphanRecord {
  readonly firstMissRevision: string;
  readonly lastMissRevision: string;
  readonly confirmedOrphan: boolean;
}

export interface WireCard {
  readonly cardId: string;
  readonly snapshot: WireElementSnapshot;
  readonly thread: readonly WireCardThreadEntry[];
  readonly orphan: WireOrphanRecord | null;
}

export interface WireAnnotationStore {
  readonly protocol: string;
  readonly cards: readonly WireCard[];
}

function parseCardSource(value: unknown): ParseResult<WireCardSource | null> {
  if (value === null) return { ok: true, value: null };
  if (!isRecord(value)) return { ok: false };
  const { path, rev, range, status, content } = value;
  if (typeof path !== 'string') return { ok: false };
  if (rev !== null && typeof rev !== 'string') return { ok: false };
  let parsedRange: { readonly startLine: number; readonly endLine: number } | null = null;
  if (range !== null) {
    if (!isRecord(range)) return { ok: false };
    const { startLine, endLine } = range;
    if (typeof startLine !== 'number' || typeof endLine !== 'number') return { ok: false };
    parsedRange = { startLine, endLine };
  }
  if (typeof status !== 'string') return { ok: false };
  if (content !== null && typeof content !== 'string') return { ok: false };
  return { ok: true, value: { path, rev: rev as string | null, range: parsedRange, status, content: content as string | null } };
}

function parseCardThreadEntry(value: unknown): ParseResult<WireCardThreadEntry> {
  if (!isRecord(value)) return { ok: false };
  const { dispatchId, intent, depth, parentDispatchId, learnerNote, markdown, verdict, decidingLines, model, tier, source, answeredAt } =
    value;
  if (typeof dispatchId !== 'string') return { ok: false };
  if (typeof intent !== 'string') return { ok: false };
  if (typeof depth !== 'number') return { ok: false };
  if (parentDispatchId !== null && typeof parentDispatchId !== 'string') return { ok: false };
  if (learnerNote !== null && typeof learnerNote !== 'string') return { ok: false };
  if (typeof markdown !== 'string') return { ok: false };
  if (verdict !== null && typeof verdict !== 'string') return { ok: false };
  if (decidingLines !== null && typeof decidingLines !== 'string') return { ok: false };
  if (typeof model !== 'string') return { ok: false };
  if (typeof tier !== 'string') return { ok: false };
  const sourceResult = parseCardSource(source);
  if (!sourceResult.ok) return { ok: false };
  if (typeof answeredAt !== 'string') return { ok: false };
  return {
    ok: true,
    value: {
      dispatchId,
      intent,
      depth,
      parentDispatchId: parentDispatchId as string | null,
      learnerNote: learnerNote as string | null,
      markdown,
      verdict: verdict as string | null,
      decidingLines: decidingLines as string | null,
      model,
      tier,
      source: sourceResult.value,
      answeredAt,
    },
  };
}

function parseElementSnapshot(value: unknown): ParseResult<WireElementSnapshot> {
  if (!isRecord(value)) return { ok: false };
  const { elementUid, anchor, textContent, prefixContext, suffixContext, structuralPath } = value;
  if (elementUid !== null && typeof elementUid !== 'string') return { ok: false };
  let parsedAnchor: { readonly path: string; readonly startLine: number | null; readonly endLine: number | null } | null = null;
  if (anchor !== null) {
    if (!isRecord(anchor)) return { ok: false };
    const { path, startLine, endLine } = anchor;
    if (typeof path !== 'string') return { ok: false };
    if (startLine !== null && typeof startLine !== 'number') return { ok: false };
    if (endLine !== null && typeof endLine !== 'number') return { ok: false };
    parsedAnchor = { path, startLine: startLine as number | null, endLine: endLine as number | null };
  }
  if (typeof textContent !== 'string') return { ok: false };
  if (prefixContext !== null && typeof prefixContext !== 'string') return { ok: false };
  if (suffixContext !== null && typeof suffixContext !== 'string') return { ok: false };
  if (typeof structuralPath !== 'string') return { ok: false };
  return {
    ok: true,
    value: {
      elementUid: elementUid as string | null,
      anchor: parsedAnchor,
      textContent,
      prefixContext: prefixContext as string | null,
      suffixContext: suffixContext as string | null,
      structuralPath,
    },
  };
}

function parseOrphanRecord(value: unknown): ParseResult<WireOrphanRecord | null> {
  if (value === null) return { ok: true, value: null };
  if (!isRecord(value)) return { ok: false };
  const { firstMissRevision, lastMissRevision, confirmedOrphan } = value;
  if (typeof firstMissRevision !== 'string') return { ok: false };
  if (typeof lastMissRevision !== 'string') return { ok: false };
  if (typeof confirmedOrphan !== 'boolean') return { ok: false };
  return { ok: true, value: { firstMissRevision, lastMissRevision, confirmedOrphan } };
}

function parseCard(value: unknown): ParseResult<WireCard> {
  if (!isRecord(value)) return { ok: false };
  const { cardId, snapshot, thread, orphan } = value;
  if (typeof cardId !== 'string') return { ok: false };
  const snapshotResult = parseElementSnapshot(snapshot);
  if (!snapshotResult.ok) return { ok: false };
  if (!Array.isArray(thread)) return { ok: false };
  const parsedThread: WireCardThreadEntry[] = [];
  for (const entry of thread) {
    const entryResult = parseCardThreadEntry(entry);
    if (!entryResult.ok) return { ok: false };
    parsedThread.push(entryResult.value);
  }
  const orphanResult = parseOrphanRecord(orphan);
  if (!orphanResult.ok) return { ok: false };
  return { ok: true, value: { cardId, snapshot: snapshotResult.value, thread: parsedThread, orphan: orphanResult.value } };
}

/** `data` is a raw MessageEvent.data from the top-level `window.addEventListener('message', ...)`
 * boot.ts installs. Returns null on any malformed shape -- never throws.
 * Rejects the WHOLE store when even one card's thread entry is malformed
 * (this codebase's "invalid means the whole extraction fails" convention,
 * from message-handling.ts's own `parseAnchor`). */
export function parseSyncAnnotations(data: unknown): WireAnnotationStore | null {
  if (!isRecord(data)) return null;
  const { type, payload } = data;
  if (typeof type !== 'string' || !isChromeToArtifactType(type)) return null;
  if (type !== 'illuminate:syncAnnotations') return null;
  if (!isRecord(payload)) return null;
  const { protocol, cards } = payload;
  if (typeof protocol !== 'string') return null;
  if (!Array.isArray(cards)) return null;
  const parsedCards: WireCard[] = [];
  for (const card of cards) {
    const result = parseCard(card);
    if (!result.ok) return null;
    parsedCards.push(result.value);
  }
  return { protocol, cards: parsedCards };
}

/** Same shape/never-throw discipline as `parseSyncAnnotations`. */
export function parseDispatchCreated(data: unknown): { readonly dispatchId: string; readonly elementUid: string } | null {
  if (!isRecord(data)) return null;
  const { type, payload } = data;
  if (typeof type !== 'string' || !isChromeToArtifactType(type)) return null;
  if (type !== 'illuminate:dispatchCreated') return null;
  if (!isRecord(payload)) return null;
  const { dispatchId, elementUid } = payload;
  if (typeof dispatchId !== 'string') return null;
  if (typeof elementUid !== 'string') return null;
  return { dispatchId, elementUid };
}

/**
 * Plan 08-04's artifact-side (SDK) mirror of src/store/findings-store.ts's
 * `Finding`/`FindingTarget`/`FindingsStore` -- declared separately,
 * deliberately, mirroring `WireCard`'s own established "this SDK-side module
 * must stay importable from the browser bundle without dragging in that
 * Node-side module's own type dependencies" rationale above. `rule`/`status`
 * stay bare `string` here (never the store's own `FindingRule`/`FindingStatus`
 * unions) -- this is untrusted wire data, narrowed by the SDK renderer (Plan
 * 08-05), not by this parser, exactly like `WireCardThreadEntry.intent`/
 * `.verdict` already do.
 */
export interface WireFindingTarget {
  readonly path: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

export interface WireFinding {
  readonly fingerprint: string;
  readonly rule: string;
  readonly target: WireFindingTarget;
  readonly status: string;
}

export interface WireFindingsSync {
  readonly protocol: string;
  readonly findings: readonly WireFinding[];
  readonly meta: { readonly watcherHealthy: boolean };
}

function parseFindingTarget(value: unknown): ParseResult<WireFindingTarget> {
  if (!isRecord(value)) return { ok: false };
  const { path, startLine, endLine } = value;
  if (typeof path !== 'string') return { ok: false };
  if (startLine !== null && typeof startLine !== 'number') return { ok: false };
  if (endLine !== null && typeof endLine !== 'number') return { ok: false };
  return { ok: true, value: { path, startLine: startLine as number | null, endLine: endLine as number | null } };
}

function parseFinding(value: unknown): ParseResult<WireFinding> {
  if (!isRecord(value)) return { ok: false };
  const { fingerprint, rule, target, status } = value;
  if (typeof fingerprint !== 'string') return { ok: false };
  if (typeof rule !== 'string') return { ok: false };
  const targetResult = parseFindingTarget(target);
  if (!targetResult.ok) return { ok: false };
  if (typeof status !== 'string') return { ok: false };
  return { ok: true, value: { fingerprint, rule, target: targetResult.value, status } };
}

/** `data` is a raw MessageEvent.data from the top-level `window.addEventListener('message', ...)`
 * boot.ts installs. Same never-throw, whole-payload-invalid-means-null
 * discipline as `parseSyncAnnotations` -- rejects the WHOLE payload when even
 * one findings entry is malformed. */
export function parseSyncFindings(data: unknown): WireFindingsSync | null {
  if (!isRecord(data)) return null;
  const { type, payload } = data;
  if (typeof type !== 'string' || !isChromeToArtifactType(type)) return null;
  if (type !== 'illuminate:syncFindings') return null;
  if (!isRecord(payload)) return null;
  const { protocol, findings, meta } = payload;
  if (typeof protocol !== 'string') return null;
  if (!Array.isArray(findings)) return null;
  const parsedFindings: WireFinding[] = [];
  for (const finding of findings) {
    const result = parseFinding(finding);
    if (!result.ok) return null;
    parsedFindings.push(result.value);
  }
  if (!isRecord(meta)) return null;
  const { watcherHealthy } = meta;
  if (typeof watcherHealthy !== 'boolean') return null;
  return { protocol, findings: parsedFindings, meta: { watcherHealthy } };
}
