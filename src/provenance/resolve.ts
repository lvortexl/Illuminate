import { readFileSync } from 'node:fs';
import type { AnchorRef, DriftState, ResolveResult } from './types.ts';
import { parseAnchor, parseFileReference } from './anchor.ts';
import type { AnchorInput } from './anchor.ts';
import { confineToRepoRoot } from './confine.ts';
import { isGitAvailable, findRepoRoot, isWorkingTreeDirtyAt, parseSubmodulePaths, pathMatchesSubmodule } from './git-meta.ts';
import { classifyDrift } from './drift.ts';
import type { GitBatchPool, BatchResult, GitBatchContext } from './git-batch-pool.ts';

// The phase's public entry point (ANCH-01/02/07/08) — the single function
// later phases (the Phase 6 router, the Phase 7 education-mode cards)
// actually call. Every pre-classification outcome from `02-RESEARCH.md`'s
// Four-State Model table that ISN'T a drift state lives here: `refused`
// (security rejection), `no-git` (degraded serving, no git repo or binary
// available), `cannot-determine` (dirty working tree, unreachable data-rev,
// shallow-clone-predates-boundary, submodule path), `unanchored` (no
// `data-src` at all), and the `unpinned` resolution (A4). Only once all of
// these are ruled out does this module delegate to `classifyDrift`
// (drift.ts) — it never reimplements classification logic itself.
//
// The single most important invariant: containment is checked on EVERY
// path, including the no-git degraded path. `parseAnchor` (anchor.ts)
// enforces it first, unconditionally, before any git-availability branching
// even runs — so a malicious `data-src` is refused identically whether or
// not a git repository exists. `serveNoGit` below additionally calls
// `confineToRepoRoot` directly, both to obtain the confined absolute path
// to read and as explicit, provable defense-in-depth rather than relying on
// the upstream guarantee alone.

/**
 * Overridable subset of `git-meta.ts`'s environment probes, defaulting to
 * the real implementations. Exists specifically so the "git binary missing"
 * scenario is testable by injecting a fake `isGitAvailable`, rather than by
 * mutating the real process `PATH` (fragile, leaks into other tests) — see
 * this plan's Task 1 behavior block.
 */
type ResolveDeps = {
  readonly isGitAvailable: () => boolean;
  readonly findRepoRoot: (startPath: string) => string | null;
};

const REAL_DEPS: ResolveDeps = { isGitAvailable, findRepoRoot };

const CORE_DRIFT_STATES = new Set<DriftState>(['unchanged', 'moved', 'touched', 'lost']);

function isCoreDriftState(state: DriftState): boolean {
  return CORE_DRIFT_STATES.has(state);
}

function refused(reason: string): ResolveResult {
  return { status: 'refused', content: null, resolvedRev: null, resolvedRange: null, eligibleForStaleness: false, reason };
}

function cannotDetermine(reason: string): ResolveResult {
  return {
    status: 'cannot-determine',
    content: null,
    resolvedRev: null,
    resolvedRange: null,
    eligibleForStaleness: false,
    reason,
  };
}

/**
 * Splits raw text into 1-indexed lines matching git's own line numbering. A
 * private copy, deliberately not shared with `drift.ts`/`relocate.ts`'s
 * identical helpers (established per-module convention in this phase) — this
 * one serves the no-git degraded read path, which never touches a git blob
 * at all, so it has no business importing a git-blob-oriented module.
 */
function splitLines(text: string): string[] {
  const withoutTrailingNewline = text.replace(/\r\n$|\n$/, '');
  return withoutTrailingNewline.split(/\r\n|\n/);
}

/**
 * ADR-002's content budget. A verifier handed a SILENTLY truncated file will
 * answer confidently from the part it got, which is the exact confabulation
 * EDU-07 exists to prevent — so truncation is always marked in the content
 * itself, never merely implied by a length.
 */
const FILE_LEVEL_MAX_BYTES = 64 * 1024;
const FILE_LEVEL_MAX_LINES = 2000;

function applyBudget(raw: string, path: string): string {
  const lines = splitLines(raw);
  const overLines = lines.length > FILE_LEVEL_MAX_LINES;
  const kept = overLines ? lines.slice(0, FILE_LEVEL_MAX_LINES) : lines;
  let text = kept.join('\n');
  const overBytes = Buffer.byteLength(text, 'utf8') > FILE_LEVEL_MAX_BYTES;
  if (overBytes) {
    text = Buffer.from(text, 'utf8').subarray(0, FILE_LEVEL_MAX_BYTES).toString('utf8');
  }
  if (!overLines && !overBytes) return text;
  const limit = overLines ? `${String(FILE_LEVEL_MAX_LINES)} lines` : `${String(FILE_LEVEL_MAX_BYTES)} bytes`;
  return `${text}\n\n[TRUNCATED: ${path} exceeds the ${limit} file-level budget. Content beyond this point was NOT read. Answer 'not determinable' for any claim that depends on it.]`;
}

/**
 * ADR-001's file-level tier: a `data-src` that names a readable file but
 * carries no `data-anchor-hash`.
 *
 * Before this existed, such a reference was `refused` outright, so `verify`
 * short-circuited to "no resolved source content is available" WITHOUT EVER
 * OPENING THE FILE — even though the file was present, readable and named
 * correctly. Stamping a hash needs a git repo and a clean tree, which no
 * ordinary agent-generated artifact has done.
 *
 * This is deliberately NOT a relaxation of the mandatory-hash rule: pinned
 * anchors keep it, and keep their staleness guarantee with it. This tier is
 * weaker and says so — `eligibleForStaleness` is false, `resolvedRev` is
 * null, and the status itself travels to the answering agent inside
 * `DispatchSource`, so a working-tree read can never be mistaken in the
 * record for a revision-pinned one (ADR-003).
 *
 * Containment is enforced through the SAME `parseFileReference` a pinned
 * anchor uses, so this tier can never accept a path the pinned tier refuses.
 */
function serveFileLevel(repoRoot: string, input: AnchorInput): ResolveResult {
  const parsed = parseFileReference(repoRoot, input);
  if (!parsed.ok) {
    return refused(parsed.reason);
  }
  const ref = parsed.ref;

  const confined = confineToRepoRoot(repoRoot, ref.path);
  if (confined === null) {
    // Unreachable in practice (parseFileReference just checked), kept for the
    // same belt-and-suspenders reason serveNoGit keeps its copy: a raw
    // readFileSync call site must never rely on an upstream guarantee.
    return refused('path escapes repo root');
  }

  let raw: string;
  try {
    raw = readFileSync(confined, 'utf8');
  } catch (err) {
    return {
      status: 'file-level',
      content: null,
      resolvedRev: null,
      resolvedRange: null,
      eligibleForStaleness: false,
      reason: `no data-anchor-hash, and the referenced path could not be read: ${(err as Error).message}`,
    };
  }

  const lines = splitLines(raw);
  const requested =
    ref.startLine !== null && ref.endLine !== null ? { startLine: ref.startLine, endLine: ref.endLine } : null;
  const inBounds =
    requested !== null && requested.startLine >= 1 && requested.endLine >= requested.startLine && requested.endLine <= lines.length;

  return {
    status: 'file-level',
    content: inBounds ? lines.slice(requested.startLine - 1, requested.endLine).join('\n') : applyBudget(raw, ref.path),
    resolvedRev: null,
    resolvedRange: inBounds ? requested : null,
    eligibleForStaleness: false,
    reason:
      'no data-anchor-hash on this reference; serving current working-tree content at file level. ' +
      'This is NOT pinned to a revision and NOT checked for drift — ground any claim in the content shown, ' +
      'and say so when the content cannot settle it.',
  };
}

/**
 * Serves content directly off disk when no git repository is available at
 * all (ANCH-08's "degraded, not broken"; T-02-01/02's `no-git` mitigation).
 * `confineToRepoRoot` is the actual raw-filesystem call site's containment
 * check — `node:fs.readFileSync` is the ONE place in this whole phase
 * allowed to read raw filesystem bytes for content serving, since there is
 * no blob to compare against (Pattern 3's rule is about blob COMPARISON,
 * not about serving current content when no git repo exists at all).
 */
function serveNoGit(repoRoot: string, anchor: AnchorRef): ResolveResult {
  const confined = confineToRepoRoot(repoRoot, anchor.path);
  if (confined === null) {
    // Belt-and-suspenders: `parseAnchor` already refused an escaping path
    // before `resolve()` ever reaches this branch in practice, but this
    // no-git path must never assume that upstream guarantee holds — see
    // this plan's objective and T-02-01/02.
    return refused('path escapes repo root');
  }

  let raw: string;
  try {
    raw = readFileSync(confined, 'utf8');
  } catch (err) {
    return {
      status: 'no-git',
      content: null,
      resolvedRev: null,
      resolvedRange: null,
      eligibleForStaleness: false,
      reason: `no git repository found; unable to read the confined path: ${(err as Error).message}`,
    };
  }

  const lines = splitLines(raw);
  const requestedRange =
    anchor.startLine !== null && anchor.endLine !== null
      ? { startLine: anchor.startLine, endLine: anchor.endLine }
      : null;
  const inBounds =
    requestedRange !== null &&
    requestedRange.startLine >= 1 &&
    requestedRange.endLine >= requestedRange.startLine &&
    requestedRange.endLine <= lines.length;

  return {
    status: 'no-git',
    content: inBounds
      ? lines.slice(requestedRange.startLine - 1, requestedRange.endLine).join('\n')
      : raw,
    resolvedRev: null,
    resolvedRange: inBounds ? requestedRange : null,
    eligibleForStaleness: false,
    reason:
      'no git repository found at or above the confined path; serving current working-tree content, ineligible for drift classification',
  };
}

/**
 * Pool-routed replacement for `git-meta.ts`'s `isRevReachable` (ANCH-02/03):
 * asks the SAME long-lived `cat-file --batch-command` process this module
 * already holds open, rather than spawning a dedicated `git cat-file -e`
 * process per anchor. `<rev>^{commit}` (not bare `<rev>`) is passed through
 * unchanged from the original implementation — the peel-to-commit suffix is
 * what makes an annotated tag or any other rev-ish resolve the same commit
 * object `cat-file -e <rev>^{commit}` checked, and it is also what makes a
 * shallow clone's depth-boundary-excluded rev report as `missing` here just
 * as it reported non-zero there (empirically verified against this
 * machine's git: both a never-committed sha and a pre-shallow-boundary rev
 * come back `missing` through `--batch-command`'s `info` verb, identically
 * to `cat-file -e`'s failure). `found` alone is the full answer — no `type`
 * check needed, since `^{commit}` guarantees the object kind is a commit
 * whenever it resolves at all.
 */
async function isRevReachableViaPool(pool: GitBatchPool, rev: string): Promise<boolean> {
  const info = await pool.info(`${rev}^{commit}`);
  return info.found;
}

/**
 * Pool-routed replacement for `git-meta.ts`'s `isSubmodulePath` (A5): same
 * `path = ...` / prefix-match semantics (via the shared, pure
 * `parseSubmodulePaths`/`pathMatchesSubmodule` pair — a single source of
 * truth for the algorithm, never re-derived here), sourced through the pool
 * instead of a dedicated `execFileSync git show` per anchor.
 *
 * Two-step, cheapest-first: `preFetchedInfo` (when supplied) or a fresh
 * `pool.info(<rev>:<relPath>)` call answers the DIRECT case immediately —
 * `type === 'submodule'` is the sizeless gitlink shape `git-batch-pool.ts`
 * now parses (Plan 10's authorized fix) — with `found === true` at any OTHER
 * type also a definitive "no" (the superproject's own tree does not contain
 * a real blob/tree at a path that is ALSO nested under a submodule, since a
 * submodule's own contents are never tracked as objects in the superproject
 * at all — confirmed empirically on this machine: `cat-file` reports a
 * nested-under-submodule path as `missing`, never as the nesting parent's
 * type). Only the genuinely ambiguous `missing` case falls through to
 * `.gitmodules` (fetched via `pool.contents`, not `execFileSync`), which is
 * the only source of truth for the NESTED case (`vendor/sub/lib.txt` inside
 * submodule `vendor/sub`) — preserving `isSubmodulePath`'s exact contract,
 * including the case `git-meta.test.ts` proves it must catch.
 */
async function isSubmodulePathViaPool(
  pool: GitBatchPool,
  rev: string,
  relPath: string,
  preFetchedInfo?: BatchResult,
): Promise<boolean> {
  const info = preFetchedInfo ?? (await pool.info(`${rev}:${relPath}`));
  if (info.found) return info.type === 'submodule';

  const gitmodules = await pool.contents(`${rev}:.gitmodules`);
  if (!gitmodules.found) return false;
  return pathMatchesSubmodule(relPath, parseSubmodulePaths(gitmodules.content.toString('utf8')));
}

/**
 * The git-present branch: reachability, working-tree cleanliness, and
 * submodule pre-checks (each mapping straight to `cannot-determine` per
 * ANCH-07), followed by delegation to `classifyDrift` (drift.ts) for the
 * four core drift states. Never reimplements classification logic itself.
 *
 * ANCH-03 follow-up (Plan 10's finding, closed here): every pre-check below
 * now goes through `pool`, never `execFileSync` directly — the ~160
 * per-40-anchor OS `git.exe` spawns Plan 10 diagnosed (`isRevReachable`,
 * `isSubmodulePath` TWICE, `isWorkingTreeDirtyAt`) are reduced to ONE
 * unavoidable spawn per anchor (`isWorkingTreeDirtyAt`'s own working-tree
 * file read — see that function's doc comment: there is no git OBJECT to
 * ask the pool about for the CURRENT, possibly-uncommitted, working-tree
 * bytes, only a real file to hash). Every other check below is answered by
 * the SAME long-lived batch process this module already holds open.
 *
 * ANCH-03 second follow-up: when the caller supplies a `batchContext`
 * (`git-batch-pool.ts`'s `GitBatchContext`, optional — see `resolve()`'s own
 * doc comment), the dirty-tree pre-check's `isWorkingTreeDirtyAt` spawn is
 * ALSO batched across every anchor sharing that context instead of firing
 * per anchor. With no `batchContext`, this function's behavior is
 * byte-for-byte unchanged from before this follow-up.
 */
async function resolveGitPresent(
  pool: GitBatchPool,
  repoRoot: string,
  anchor: AnchorRef,
  batchContext: GitBatchContext | undefined,
): Promise<ResolveResult> {
  const reachabilityRev = anchor.rev ?? 'HEAD';
  if (!(await isRevReachableViaPool(pool, reachabilityRev))) {
    // Covers a plain unreachable rev AND a shallow clone whose depth
    // boundary excludes it (locked decision: no separate detection path —
    // this falls out of isRevReachableViaPool naturally, same as the
    // execFileSync form it replaces, already proven in Plan 04).
    return cannotDetermine(
      `data-rev "${reachabilityRev}" is not reachable in this repository (unreachable, rewritten, or predates a shallow-clone boundary)`,
    );
  }

  // HEAD's own commit sha is needed regardless of whether this anchor is
  // pinned: classifyDrift always compares dataRev against headRev, and an
  // unpinned anchor's effective rev IS this sha (A4). Resolved via the pool
  // (a bare object name, no `:path` suffix, resolves the commit itself) so
  // this module never shells out to git directly, per git-meta.ts's own
  // "only module allowed to spawn git plumbing" contract.
  const headInfo = await pool.info('HEAD');
  if (!headInfo.found) {
    return cannotDetermine('unable to resolve HEAD in this repository');
  }
  const currentHeadSha = headInfo.sha;
  const effectiveRev = anchor.rev ?? currentHeadSha;

  // Fetched once, ahead of both the submodule pre-check below AND the
  // dirty-tree pre-check further down — the SAME `<currentHeadSha>:<path>`
  // key answers both questions (submodule type-check first, blob sha for
  // the dirty comparison second), so this single pool round-trip serves two
  // purposes instead of two.
  const blobAtHead = await pool.info(`${currentHeadSha}:${anchor.path}`);

  // Submodule check BEFORE the dirty-tree pre-check (A5, locked decision):
  // checked at BOTH `effectiveRev` and `currentHeadSha`, not just one —
  // `classifyDrift` (and the relocation ladder it delegates to) fetches
  // blobs at both revisions internally, so either one being a submodule at
  // the anchored path must be caught here first. The redundant-double-call
  // fix Plan 10 flagged: when the anchor is unpinned (A4), `effectiveRev`
  // IS `currentHeadSha` — the literal same rev — so the second check would
  // be the exact same pool request repeated; `blobAtHead` (already fetched
  // above) is reused for BOTH in that case instead of firing it twice, and
  // is reused as `preFetchedInfo` for the `currentHeadSha` check even when
  // pinned, since it is either way the same request this module needs for
  // the dirty-tree check regardless.
  const isSubAtHead = await isSubmodulePathViaPool(pool, currentHeadSha, anchor.path, blobAtHead);
  const isSubAtEffective =
    effectiveRev === currentHeadSha ? isSubAtHead : await isSubmodulePathViaPool(pool, effectiveRev, anchor.path);
  if (isSubAtEffective || isSubAtHead) {
    // A5 (locked decision): submodule paths resolve to cannot-determine in v1.
    return cannotDetermine('anchored path is inside a git submodule; not classified in v1');
  }

  // Dirty-tree pre-check: this asks "does the CURRENT working tree match
  // what is actually committed at HEAD", so it is always evaluated against
  // HEAD's blob for this path, never `effectiveRev`'s. A pinned anchor
  // legitimately cites an OLDER rev while HEAD has since moved on through
  // ordinary commits — comparing the working tree against that older blob
  // would flag every such anchor as "dirty" even though nothing is
  // uncommitted at all (caught empirically by this plan's own integration
  // test: a relocated-region anchor pinned to an ancestor commit was being
  // misreported as cannot-determine before this was corrected). `type ===
  // 'blob'` additionally guards the working-tree hash check (`git
  // hash-object`, no defined behavior for a directory) from ever being
  // invoked on anything but a real file. Per Plan 10's own finding, this
  // check is never pool-routed either way (the pool answers questions about
  // git OBJECTS, and the current, possibly-uncommitted working-tree bytes
  // are not one — only the blob-sha half of this comparison,
  // `blobAtHead.sha`, is pool-sourced); what CAN and does change below is
  // whether it fires as its own dedicated spawn per anchor
  // (`isWorkingTreeDirtyAt`, no `batchContext`) or as one shared entry in a
  // whole-batch `git hash-object --stdin-paths` call (`batchContext`
  // supplied — see `GitBatchContext.isWorkingTreeDirtyAt`, git-batch-pool.ts).
  if (blobAtHead.found && blobAtHead.type === 'blob') {
    let dirty: boolean;
    if (batchContext) {
      try {
        dirty = await batchContext.isWorkingTreeDirtyAt(repoRoot, anchor.path, blobAtHead.sha);
      } catch {
        // A batched flush failing for a reason its own missing-path
        // handling doesn't cover (see GitBatchContext's doc comment) must
        // never be silently treated as clean — refuse, same as a genuine
        // dirty result, per this phase's "refuse rather than guess" rule.
        return cannotDetermine('unable to determine whether the working tree has uncommitted changes at the anchored path');
      }
    } else {
      dirty = isWorkingTreeDirtyAt(repoRoot, anchor.path, blobAtHead.sha);
    }
    if (dirty) {
      return cannotDetermine('working tree has uncommitted changes at the anchored path');
    }
  }

  const drift = await classifyDrift(pool, repoRoot, anchor, effectiveRev, currentHeadSha);

  // eligibleForStaleness is true only when BOTH the anchor is pinned AND
  // classification actually succeeded into one of the four core drift
  // states — an unpinned anchor is unconditionally ineligible even when it
  // resolves cleanly (A4), and a cannot-determine outcome (whether from a
  // pre-check above or from classifyDrift's own internal fallback, e.g. a
  // whole-file anchor whose path never existed at dataRev) never claims
  // staleness eligibility, since no drift verdict was actually reached.
  const eligibleForStaleness = !anchor.unpinned && isCoreDriftState(drift.state);

  return {
    status: drift.state,
    content: drift.content,
    resolvedRev: drift.content !== null ? effectiveRev : null,
    resolvedRange: drift.resolvedRange,
    eligibleForStaleness,
    reason: null,
  };
}

/**
 * Resolves a single anchor to real content plus its classification. `input:
 * null` means the element carries no `data-src` at all (`unanchored`,
 * ANCH-08) — checked first, since there is no anchor to parse or path to
 * confine in that case. Deliberate contract choice: an unanchored element
 * has no path context to read from at all, so `content` is `null` rather
 * than attempting to guess a path (documented per this plan's Task 1
 * behavior block, which explicitly asks for this simpler contract).
 *
 * Never throws: every failure mode this module owns (refusal, no-git,
 * cannot-determine, unanchored) is an explicit, well-typed `ResolveResult`,
 * never an exception — see this plan's objective and ANCH-07.
 *
 * `batchContext` (ANCH-03 second follow-up, optional, additive — the
 * `(arg, opts?)` pattern this codebase already establishes via
 * `ensureDaemonRunning(artifactRoot, opts?)`): when supplied, this call's
 * `isGitAvailable`/`findRepoRoot` env probes and its dirty-tree pre-check's
 * working-tree hash are answered through `GitBatchContext`'s per-repository
 * cache/batch (`git-batch-pool.ts`) instead of firing a dedicated spawn
 * every time. Omitted (the default), this function's behavior is
 * byte-for-byte identical to before this follow-up — stateless per call,
 * `deps` (unaffected by `batchContext`) still the sole env-probe override
 * point, exactly as `resolve.test.ts`'s existing deps-injection test
 * exercises.
 */
export async function resolve(
  repoRoot: string,
  input: AnchorInput | null,
  pool: GitBatchPool,
  deps: ResolveDeps = REAL_DEPS,
  batchContext?: GitBatchContext,
): Promise<ResolveResult> {
  if (input === null) {
    return {
      status: 'unanchored',
      content: null,
      resolvedRev: null,
      resolvedRange: null,
      eligibleForStaleness: false,
      reason: 'no data-src anchor present on this element; no path context available to serve content from',
    };
  }

  // ADR-001: a reference with no hash is not a broken pinned anchor, it is a
  // weaker tier. Routed BEFORE parseAnchor, whose mandatory-hash rule would
  // otherwise refuse a file that is present and readable. Deliberately ahead
  // of every git probe too: file-level grounding never needs a repository.
  if (!input.anchorHash) {
    return serveFileLevel(repoRoot, input);
  }

  // parseAnchor enforces containment internally (Plan 01, confine.ts) — a
  // `refused` status here is simply surfacing its failure reason directly,
  // whether that reason is a path escape or a grammar error (e.g. a missing
  // data-anchor-hash). This runs BEFORE any git or filesystem access, on
  // every code path, including the no-git degraded path below.
  const parsed = parseAnchor(repoRoot, input);
  if (!parsed.ok) {
    return refused(parsed.reason);
  }
  const anchor = parsed.anchor;

  const gitAvailable = batchContext ? batchContext.isGitAvailable() : deps.isGitAvailable();
  if (!gitAvailable) {
    return serveNoGit(repoRoot, anchor);
  }
  const resolvedRepoRoot = batchContext ? batchContext.findRepoRoot(repoRoot) : deps.findRepoRoot(repoRoot);
  if (resolvedRepoRoot === null) {
    return serveNoGit(repoRoot, anchor);
  }

  return resolveGitPresent(pool, repoRoot, anchor, batchContext);
}
