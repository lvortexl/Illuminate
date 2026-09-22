/**
 * ROUT-03's actual mechanism: given a `TypedIntentPayload` (the browser's
 * typed intent, via the chrome shell) and the artifact's own directory,
 * resolve its anchor to real content at a real revision (Phase 2's
 * `resolve()`, already shipped) and package a fully-provisioned
 * `DispatchEnvelope` (06-01's types) that a harness can act on without ever
 * re-reading the file itself.
 *
 * ROUT-02's full pipeline proof lives here structurally, not just by
 * comment: `resolvePolicy(payload.intent)` runs FIRST, before anything
 * anchor-related is even looked at (step 1, below) -- so it is visible in
 * the code, not just provable by test, that policy never consults
 * `payload.anchor` or anything `resolve()` returns. test/router/envelope.test.ts's
 * injected-directive fixture is the empirical proof this ordering makes
 * possible.
 *
 * This module never calls a model API -- `resolve()` is git plumbing only
 * (Phase 2), and everything below it is a pure packaging step.
 */

import { randomBytes } from 'node:crypto';
import { attachmentPathFor } from '../store/attachment-store.ts';
import { resolvePolicy, toolsForRole } from './policy.ts';
import { getRepoContext as getRepoContextReal } from './pool-registry.ts';
import { resolve as resolveAnchor } from '../provenance/resolve.ts';
import type { RepoContext } from './pool-registry.ts';
import type { ResolveResult } from '../provenance/types.ts';
import type { GitBatchPool } from '../provenance/git-batch-pool.ts';
import type { DispatchElement, DispatchEnvelope, DispatchSource, DispatchTarget, Tier } from './types.ts';
import type { TypedIntentPayload } from '../shared/intent.ts';

/**
 * Fixed per-tier answer deadline (ROUT-03's harness-facing contract): opus
 * calls (the `implementer` role) plausibly run longer than a haiku/sonnet
 * explanation or verification, so it alone gets a longer budget. The ONE
 * place this is defined -- never invented ad hoc per call site.
 */
const DEADLINE_MS_BY_TIER: Record<Tier, number> = {
  haiku: 120_000,
  sonnet: 120_000,
  opus: 300_000,
};

/**
 * EDU-03's return contract, verbatim on every envelope: instructs the
 * harness to write its full answer via the `return_to` command's stdin and
 * report back ONLY the short receipt that command prints -- never the
 * answer text itself, which travels outbound-only to the browser (see
 * `src/router/types.ts`'s own `AnswerRecord`/`PollResponse` doc comments).
 */
const RETURN_CONTRACT =
  'Write your complete answer by running the return_to command exactly as given, piping your full markdown ' +
  'answer to its stdin. Print and return ONLY the single-line receipt that command prints -- never print or ' +
  'return the answer text itself.';

/**
 * EDU-06's grading-framed return contract -- used INSTEAD of `RETURN_CONTRACT`
 * (never alongside it) whenever `payload.learnerNote !== null`. Distinct
 * text, not a suffix appended to the ordinary contract, so a subagent reads
 * one unambiguous instruction: grade the learner's OWN words
 * (`element.text`'s sibling field, carried on the envelope as
 * `learnerNote`) against `source.content` -- the SAME anchored, already-
 * resolved provenance the tutor role is seeded with -- rather than writing a
 * fresh explanation from scratch. The `return_to`/stdin-only delivery
 * mechanism is identical to the ordinary contract; only what the subagent is
 * asked to DO differs.
 */
const SELF_EXPLANATION_RETURN_CONTRACT =
  "The reader has typed their own explanation of this element, carried as learnerNote on this dispatch -- grade " +
  "learnerNote against source.content (the same resolved anchor content you were seeded with), not against your " +
  'own independent explanation. Write specific, concrete feedback: what the reader got right, what they got ' +
  'wrong or missed, referencing source.content directly. Then write your complete graded feedback by running the ' +
  'return_to command exactly as given, piping your full markdown feedback to its stdin. Print and return ONLY ' +
  'the single-line receipt that command prints -- never print or return the feedback text itself.';

/**
 * Splits an `IntentAnchor.src` wire value ("path#Lx-Ly" or a bare path) into
 * the `{path, range}` shape `AnchorInput` (src/provenance/anchor.ts)
 * actually consumes. `anchor.ts`'s own `RANGE_PATTERN` is the sole authority
 * for validating the range grammar -- this function only performs the
 * split, on the first `#`, matching how the browser SDK writes this field
 * (src/sdk/anchor-read.ts). A malformed range (or none at all) is passed
 * through unchanged and left to `resolve()`'s own `parseAnchor` to accept or
 * refuse -- this function never validates the grammar itself.
 */
function splitAnchorSrc(src: string): { readonly path: string; readonly range?: string } {
  const hashIndex = src.indexOf('#');
  if (hashIndex === -1) return { path: src };
  return { path: src.slice(0, hashIndex), range: src.slice(hashIndex + 1) };
}

/** Overridable seams for `buildDispatchEnvelope`'s two collaborators --
 * partial, matching this codebase's `(arg, opts?)` additive-injection
 * convention (`resolve()`'s own `deps`/`batchContext` parameters). Neither
 * field is required; omitting the object entirely uses the real
 * `getRepoContext`/`resolve` implementations. */
export type BuildDispatchEnvelopeDeps = {
  readonly getRepoContext?: (artifactDir: string) => RepoContext;
  readonly resolve?: (
    repoRoot: string,
    input: { readonly path: string; readonly range?: string; readonly rev?: string; readonly anchorHash: string } | null,
    pool: GitBatchPool,
  ) => Promise<ResolveResult>;
};

/**
 * Builds a fully-provisioned `DispatchEnvelope` from a browser-origin
 * `TypedIntentPayload`. Never throws: every anchor failure mode `resolve()`
 * itself can report (refusal, no-git, cannot-determine) surfaces as data on
 * `envelope.source`, exactly as `resolve()` already guarantees for itself.
 *
 * Step order is the actual proof, not just documentation: (1) `resolvePolicy`
 * runs on `payload.intent` ALONE, before `payload.anchor` is even inspected;
 * (2)/(3) anchor handling happens strictly afterward and can only ever
 * affect `envelope.source`, never `envelope.role`/`envelope.model_tier`.
 */
export async function buildDispatchEnvelope(
  payload: TypedIntentPayload,
  artifactDir: string,
  port: number,
  deps?: BuildDispatchEnvelopeDeps,
): Promise<DispatchEnvelope> {
  // Step 1 -- FIRST, before anything anchor-related is even looked at:
  // policy is a pure function of payload.intent alone.
  const { role, tier } = resolvePolicy(payload.intent);
  // Wire-visible EDU-01 proof: tools is a pure function of the already-
  // resolved role, a SEPARATE lookup from resolvePolicy (see policy.ts's
  // own doc comment) -- never itself capable of influencing role/tier.
  const tools = toolsForRole(role);

  const dispatch_id = randomBytes(24).toString('base64url');

  // Step 2/3 -- anchor handling, strictly after policy is already decided.
  //
  // ADR-102: resolved per selected section, in selection order. The repo
  // context is fetched ONCE for the whole dispatch rather than per target:
  // every target in one dispatch belongs to the same artifact, so they share
  // a repo root and a git batch pool, and re-probing per target would spawn
  // a fresh set of git processes for each selected section.
  const getRepoContext = deps?.getRepoContext ?? getRepoContextReal;
  const resolve = deps?.resolve ?? resolveAnchor;
  const targets: DispatchTarget[] = [];
  let repoContext: RepoContext | null = null;
  for (const target of payload.targets) {
    const element: DispatchElement = { ...target.element };
    let source: DispatchSource | null = null;
    if (target.anchor !== null) {
      const { path, range } = splitAnchorSrc(target.anchor.src);
      repoContext ??= getRepoContext(artifactDir);
      const { repoRoot, pool } = repoContext;
      const result = await resolve(
        repoRoot,
        { path, range, rev: target.anchor.rev ?? undefined, anchorHash: target.anchor.anchorHash ?? '' },
        pool,
      );
      source = {
        path,
        rev: result.resolvedRev,
        range: result.resolvedRange,
        status: result.status,
        content: result.content,
      };
    }
    targets.push({ element, source });
  }

  return {
    protocol: 'illuminate.dispatch/2',
    dispatch_id,
    intent: payload.intent,
    role,
    model_tier: tier,
    deadline_ms: DEADLINE_MS_BY_TIER[tier],
    targets,
    return_to: `illuminate answer --dispatch ${dispatch_id} --port ${String(port)} --model <model-you-ran> --tier <haiku|sonnet|opus> --stdin`,
    return_contract: payload.learnerNote !== null ? SELF_EXPLANATION_RETURN_CONTRACT : RETURN_CONTRACT,
    tools,
    depth: payload.depth,
    parent_dispatch: payload.parent_dispatch,
    learnerNote: payload.learnerNote,
    note: payload.note,
    // Resolved here, not on the wire: the browser holds ids, an agent needs
    // somewhere it can actually open. An id that fails validation resolves to
    // null and is DROPPED rather than passed through as a broken path -- an
    // envelope naming a file that is not there is worse than one naming none.
    attachments: payload.attachments.flatMap((a) => {
      const path = attachmentPathFor(artifactDir, a.id, a.mediaType);
      return path === null ? [] : [{ id: a.id, mediaType: a.mediaType, path }];
    }),
  };
}
