/**
 * The single source of truth for Phase 6's dispatch/ledger/poll wire
 * contracts. Every later 06-xx plan imports from here rather than
 * redeclaring `DispatchEnvelope`/`PollResponse`/`Role`/`Tier`/etc -- mirrors
 * src/shared/protocol.ts's own "declare the contract once, before the
 * implementation" discipline (this phase's Interface-First / Wave-0
 * ordering: write interface contracts before any of it is implemented).
 *
 * Zero-dependency declarations file. Imports only `type Intent`
 * (src/shared/intent.ts) and `type DriftState` (src/provenance/types.ts) --
 * both type-only, so this file drags in no DOM types and no Node-only APIs,
 * and stays importable from anything that can import shared/intent.ts.
 *
 * No `enum`/`namespace` anywhere below: `node --test` runs TypeScript in
 * strip-only mode, which rejects both outright. `const` objects + `as const`
 * unions throughout, per this codebase's established
 * INTENT_TYPES/ARTIFACT_TO_CHROME_TYPES pattern.
 *
 * EDU-02 (context isolation, enforceable): `PollResponse` and
 * `DispatchEnvelope` are the two schemas an orchestrator (the `claude -p`
 * subprocess adapter, or any future adapter) can ever see the return value
 * of. Neither carries an answer body -- `AnswerRecord.markdown` exists only
 * on `DispatchLedgerEntry`, which travels over the outbound-only WebSocket
 * to the browser, never back through a poll response. test/router/types.test.ts
 * proves this at compile time (`@ts-expect-error`) and by source-text scan.
 */

import type { Intent } from '../shared/intent.ts';
import type { DriftState } from '../provenance/types.ts';

/** The five subagent roles a dispatch can be routed to. ROUT-02's router is
 * a pure lookup table keyed on `{ intent, role }` -> `PolicyEntry`. */
export const ROLES = ['tutor', 'verifier', 'researcher', 'author', 'implementer'] as const;
export type Role = (typeof ROLES)[number];

/** The three model tiers a dispatch can be assigned. Ordered cheapest to
 * most expensive -- see TIER_RANK below for the numeric ordering. */
export const TIERS = ['haiku', 'sonnet', 'opus'] as const;
export type Tier = (typeof TIERS)[number];

/** EDU-07's three-state verdict. The third state -- 'not-determinable' --
 * is load-bearing, not a fallback: a verifier that can only ever say
 * SUPPORTED or CONTRADICTED will confabulate one of those two when the
 * anchor genuinely gives it nothing to check against. `isUngroundable`
 * (src/router/verify.ts) is the deterministic predicate that recognizes
 * this case before any model is even asked. */
export const VERDICTS = ['supported', 'contradicted', 'not-determinable'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The one place tier ordering is defined. ROUT-06's floor comparison (a
 * later 06-xx plan) imports this constant; it must never be redefined
 * elsewhere as a second source of truth for "which tier is higher." */
export const TIER_RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2 };

/** A single row of the router's lookup table: which role and tier a given
 * `{ intent, ... }` combination resolves to. */
export interface PolicyEntry {
  readonly role: Role;
  readonly tier: Tier;
}

/** The dispatch lifecycle. `open` -> `delivered` -> `answered` is the happy
 * path; `refused`/`cancelled`/`expired` are the terminal non-answer states. */
export const DISPATCH_STATUSES = ['open', 'delivered', 'answered', 'refused', 'cancelled', 'expired'] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

/** Resolved provenance for the anchor a dispatch was seeded from, or `null`
 * for an unanchored element (ANCH-08 graceful degradation). `content` is the
 * actual resolved text handed to the subagent -- present only when `status`
 * is a state that yielded readable content. */
export interface DispatchSource {
  readonly path: string;
  readonly rev: string | null;
  readonly range: { readonly startLine: number; readonly endLine: number } | null;
  readonly status: DriftState;
  readonly content: string | null;
}

/** The router's own copy of the targeted element, travelling in the
 * DISPATCH envelope -- a different envelope than the browser-origin
 * `IntentElement` (src/shared/intent.ts). Declared separately, field-for-
 * field identical, rather than imported: keeps src/router/ importable
 * without a hard dependency on shared/intent.ts's browser-facing surface
 * beyond the `Intent` union itself. */
export interface DispatchElement {
  readonly uid: string;
  readonly selector: string;
  readonly tag: string;
  readonly text: string;
  /** Mirrors `IntentElement.prefixContext` (src/shared/intent.ts) --
   * field-for-field identical, declared separately for the same reason the
   * rest of this interface is. */
  readonly prefixContext: string | null;
  /** Mirrors `IntentElement.suffixContext`. */
  readonly suffixContext: string | null;
}

/**
 * The envelope a dispatch travels in, from the router to the subagent
 * orchestrator and (via `PollResponse`) onward to the browser.
 *
 * `return_to`/`return_contract` are EDU-03's structural half: every
 * envelope literally carries its own return contract as DATA, not as prose
 * assembled ad hoc later by a CLI command's print statement. `return_to` is
 * where the subagent's short receipt goes (a command it runs);
 * `return_contract` is the one-line instruction describing what that
 * receipt must look like.
 */
export interface DispatchEnvelope {
  readonly protocol: 'illuminate.dispatch/1';
  readonly dispatch_id: string;
  readonly intent: Intent;
  readonly role: Role;
  readonly model_tier: Tier;
  readonly deadline_ms: number;
  readonly element: DispatchElement;
  readonly source: DispatchSource | null;
  readonly return_to: string;
  readonly return_contract: string;
  /** EDU-01's zero-tool guarantee, made wire-visible: `[]` for the tutor
   * role, so a zero-tool dispatch is data any harness can observe and
   * enforce, not folklore documented only in a prompt template. Populated
   * by `toolsForRole` (src/router/policy.ts), a lookup SEPARATE from
   * role/tier resolution (ROUT-02's purity is a role+tier property; this is
   * new, additive metadata alongside it). */
  readonly tools: readonly string[];
  /** Copied verbatim from `TypedIntentPayload.depth`. */
  readonly depth: number;
  /** Copied verbatim from `TypedIntentPayload.parent_dispatch`. */
  readonly parent_dispatch: string | null;
  /** Copied verbatim from `TypedIntentPayload.learnerNote`. Readable by
   * whatever process consumes this envelope (self-dispatch subprocess, or a
   * real harness) -- see this plan's own threat model (T-07-01). */
  readonly learnerNote: string | null;
  /** Copied verbatim from `TypedIntentPayload.note` -- the human's own
   * free-text instruction for this element. Distinct from `learnerNote`:
   * see that field's own doc comment, and `TypedIntentPayload.note`, for
   * why conflating the two would silently mark every note for grading. */
  readonly note: string | null;
  /** The human's attached images, RESOLVED to absolute paths on this
   * machine. The wire carried ids; an envelope carries somewhere the agent
   * can actually open. An id that does not resolve is dropped rather than
   * passed through as a broken path -- see `buildDispatchEnvelope`. */
  readonly attachments: readonly DispatchAttachment[];
}

export interface DispatchAttachment {
  readonly id: string;
  readonly mediaType: string;
  readonly path: string;
}

/**
 * A completed answer's telemetry and content. `markdown` MUST NEVER be read
 * by anything that builds a `PollResponse` (see test/router/types.test.ts's
 * EDU-02 proof) -- it travels outbound-only, over the WebSocket, straight to
 * the browser. It lives here, on the ledger entry, not on any
 * orchestrator-reachable schema.
 */
export interface AnswerRecord {
  readonly markdown: string;
  readonly model: string;
  readonly tier: Tier;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheReadInputTokens: number;
  readonly costUsd: number;
  readonly wallMs: number;
  readonly answeredAt: string;
  /** EDU-07's verdict -- only meaningful for a `verify`-shaped answer; `null`
   * for every other intent. Never present on `PollResponse`/`DispatchEnvelope`
   * (this field lives here, and on `AnswerSubmission` below, exclusively). */
  readonly verdict: Verdict | null;
  /** The subagent's own quoted excerpt that decided `verdict` -- `null`
   * whenever `verdict` is `null`. */
  readonly decidingLines: string | null;
}

/** The durable, server-side record of one dispatch's full lifecycle --
 * 06-03's ledger/queue/presence store persists these; this file only
 * declares the shape. */
export interface DispatchLedgerEntry {
  readonly envelope: DispatchEnvelope;
  readonly status: DispatchStatus;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly answer: AnswerRecord | null;
  readonly tierDeviation: boolean;
}

/**
 * THE enforceable EDU-02 schema: the one shape an orchestrator ever sees
 * back from a poll. Exactly two fields. Neither is prose. `dispatches`
 * carries `DispatchEnvelope`s (the work to do), never `AnswerRecord`s (the
 * answers already given) -- answers never travel back through poll.
 */
export interface PollResponse {
  readonly status: 'dispatch' | 'waiting' | 'ended' | 'browser_disconnected';
  readonly dispatches: readonly DispatchEnvelope[];
}

/** What a subagent submits once it has produced an answer -- the inbound
 * counterpart to `AnswerRecord`, keyed by `dispatchId` rather than carrying
 * a full envelope back. */
export interface AnswerSubmission {
  readonly dispatchId: string;
  readonly markdown: string;
  readonly model: string;
  readonly tier: Tier;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheReadInputTokens: number;
  readonly costUsd: number;
  readonly wallMs: number;
  /** Mirrors `AnswerRecord.verdict` -- see that field's own doc comment. */
  readonly verdict: Verdict | null;
  /** Mirrors `AnswerRecord.decidingLines`. */
  readonly decidingLines: string | null;
}

/** The result of ingesting an `AnswerSubmission` against the ledger. `entry`/
 * `artifactPath` on the `'ok'` variant are the just-updated ledger entry and
 * its owning session's artifact file -- both already in scope inside
 * `ingestAnswer` at its success point, so callers (Plan 07-04's
 * `handleAnswer`) can append into the annotation store sidecar without a
 * second store read. Neither is answer-shaped: `entry` carries the FULL
 * `DispatchLedgerEntry` (including its `answer.markdown`), which is fine --
 * `IngestResult` is never itself passed to anything that builds a
 * `PollResponse`; see this file's own EDU-02 doc comment above. */
export type IngestResult =
  | { readonly kind: 'ok'; readonly receipt: string; readonly entry: DispatchLedgerEntry; readonly artifactPath: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'already-terminal'; readonly reason: string };
