/**
 * The staleness scanner: given a served artifact's file on disk, discovers
 * every anchored element server-side (src/html/anchors.ts) and classifies
 * each one's drift state by calling Phase 2's already-built, already-
 * validated `resolve()` (src/provenance/resolve.ts) -- never reimplementing
 * any part of its ladder. Only the two loud states (`touched`/`lost`) are
 * recorded into Plan 08-01's findings store; every other outcome
 * (`unchanged`, `moved`, `cannot-determine`, `refused`, `no-git`,
 * `unanchored`, unpinned) is a reason to do nothing at all -- STAL-04's
 * fail-open contract, gated on nothing but `resolve()`'s own
 * `eligibleForStaleness` flag.
 */

import { readFile } from 'node:fs/promises';
import type { AnchorInput } from '../provenance/anchor.ts';
import type { ResolveResult } from '../provenance/types.ts';
import type { FindingTarget, ScanObservation } from '../store/findings-store.ts';
import { FindingsStoreFile, applyScanObservations } from '../store/findings-store.ts';
import { getRepoContext } from '../router/pool-registry.ts';
import type { PoolRegistryDeps } from '../router/pool-registry.ts';
import type { GitBatchPool } from '../provenance/git-batch-pool.ts';
import { resolve } from '../provenance/resolve.ts';
import { extractAnchorInputs } from '../html/anchors.ts';

export interface AnchorClassification {
  readonly input: AnchorInput;
  readonly result: ResolveResult;
}

/** The same "Lx-Ly" grammar Task 1's extractAnchorInputs splits data-src at
 * -- independently re-derived here (module-private, never imported from
 * anchor.ts's own private RANGE_PATTERN or from the browser-only
 * snapshot.ts) per this codebase's established Node/browser-boundary
 * duplication convention. A range that fails to match falls back to
 * {startLine: null, endLine: null} -- in practice unreachable for an
 * ELIGIBLE classification, since parseAnchor (anchor.ts) already refuses a
 * malformed range before resolve() could ever mark it eligible. */
const RANGE_PATTERN = /^L(\d+)-L(\d+)$/;

function targetFromInput(input: AnchorInput): FindingTarget {
  if (input.range === undefined) {
    return { path: input.path, startLine: null, endLine: null };
  }
  const match = RANGE_PATTERN.exec(input.range);
  if (!match) {
    return { path: input.path, startLine: null, endLine: null };
  }
  return { path: input.path, startLine: Number(match[1]), endLine: Number(match[2]) };
}

/**
 * PURE decision function -- the one place this whole plan decides what to
 * record, kept separate from all I/O so it is directly unit-testable
 * against hand-built ResolveResult fixtures without git or the filesystem.
 * For each classification: `!result.eligibleForStaleness` (covers
 * cannot-determine/refused/no-git/unanchored/unpinned in ONE check, since
 * resolve.ts's own eligibleForStaleness is already false for all of them)
 * means NO observation is produced at all -- this IS the fail-open
 * contract, expressed as an omission, not a branch that has to remember to
 * "do nothing". `status === 'touched' | 'lost'` produces exactly one
 * `{outcome: 'detected'}` observation at the corresponding rule.
 * `status === 'unchanged' | 'moved'` produces TWO `{outcome: 'absent'}`
 * observations, one per rule (`drift-touched` AND `drift-lost`) -- a given
 * (path, range) target could have been filed under EITHER rule in an
 * earlier pass before the underlying code was fixed; recordAbsence
 * (findings-store.ts) is a documented safe no-op against whichever rule
 * has no open finding, so emitting both is harmless and correct rather
 * than requiring this function to remember which rule was filed before.
 */
export function planScanObservations(
  classifications: readonly AnchorClassification[],
  revision: string,
  at: string,
): readonly ScanObservation[] {
  return classifications.flatMap(({ input, result }): ScanObservation[] => {
    if (!result.eligibleForStaleness) return [];

    const target = targetFromInput(input);

    if (result.status === 'touched') {
      return [{ rule: 'drift-touched', target, outcome: 'detected', revision, at }];
    }
    if (result.status === 'lost') {
      return [{ rule: 'drift-lost', target, outcome: 'detected', revision, at }];
    }
    if (result.status === 'unchanged' || result.status === 'moved') {
      return [
        { rule: 'drift-touched', target, outcome: 'absent', revision, at },
        { rule: 'drift-lost', target, outcome: 'absent', revision, at },
      ];
    }
    // Unreachable in practice: eligibleForStaleness is only ever true for
    // one of the four core drift states (resolve.ts's own isCoreDriftState
    // gate) -- kept as a safe no-op rather than an exhaustiveness assertion,
    // since DriftState is a plain string union, not the object-shaped union
    // `const exhaustive: never = ...` needs to compile against.
    return [];
  });
}

export interface StalenessScanResult {
  readonly scannedAnchorCount: number;
  readonly eligibleCount: number;
  readonly skippedCount: number;
  readonly detectedCount: number;
  readonly headRevision: string | null;
}

export type ReadArtifactFile = (path: string) => Promise<string>;

export interface StalenessScanDeps {
  readonly readFile?: ReadArtifactFile;
  readonly now?: () => string;
  readonly getRepoContext?: (artifactDir: string, deps?: PoolRegistryDeps) => ReturnType<typeof getRepoContext>;
  /** Test seam: the per-anchor resolver. Production callers never set it. */
  readonly resolveAnchor?: typeof resolve;
}

/** Reads the repository's current HEAD commit sha through the SAME shared
 * pool every anchor resolution already uses -- mirrors resolve.ts's own
 * internal `pool.info('HEAD')` call (resolveGitPresent), never a second
 * classification or comparison, just a plain "what commit is HEAD" query.
 * This is what makes the store's revision-scoped reopen logic (STAL-04,
 * findings-store.ts) actually advance across scan passes: an anchor's own
 * PINNED data-rev never changes between scans of the same artifact, so
 * stamping observations with it would freeze every finding at its first
 * revision forever. Failure (no git, repo has no commits yet) resolves to
 * null rather than throwing -- in that case eligibleCount is always 0 too
 * (resolve() needs this exact same HEAD lookup to mark anything eligible),
 * so no observation ever needs this value when it is null. */
async function readHeadRevision(pool: GitBatchPool): Promise<string | null> {
  try {
    const info = await pool.info('HEAD');
    return info.found ? info.sha : null;
  } catch {
    return null;
  }
}

/**
 * The async orchestration: read `artifactPath` off disk, extract every
 * anchor, resolve() each one against `artifactDir`'s repository (via the
 * SAME cached GitBatchPool the dispatch router already shares --
 * getRepoContext, never a second pool per repository), plan the
 * observations (planScanObservations, above), and apply them to
 * `findingsStoreFile` in ONE batched mutate() call for the whole pass --
 * never one write per anchor. Never throws on a per-anchor resolve()
 * failure -- resolve() is documented never to throw (ANCH-07), but this
 * loop no longer merely takes that on faith: each anchor is wrapped in its
 * own try/catch boundary (PV-02), so the no-throw guarantee is the loop's
 * own now, not an assumption borrowed from resolve(); a readFile failure
 * (the artifact itself vanished mid-scan) propagates, since there is
 * nothing to scan and the caller (Plan 08-03's watcher/reconcile) is
 * already designed to treat a rejected scan as "try again next tick",
 * never as a crash.
 */
export async function runStalenessScan(
  artifactPath: string,
  artifactDir: string,
  findingsStoreFile: FindingsStoreFile,
  deps: StalenessScanDeps = {},
): Promise<StalenessScanResult> {
  const readFileFn = deps.readFile ?? ((path: string) => readFile(path, 'utf8'));
  const now = deps.now ?? (() => new Date().toISOString());
  const resolveContext = deps.getRepoContext ?? getRepoContext;

  const html = await readFileFn(artifactPath);
  const inputs = extractAnchorInputs(html);
  const { repoRoot, pool } = resolveContext(artifactDir);

  const resolveAnchor = deps.resolveAnchor ?? resolve;
  // Awaited sequentially, never Promise.all fan-out -- this plan's own
  // anchor counts are small per-artifact, matching ANCH-03's already-
  // established interactive scale (T-08-05). Each anchor gets its own
  // boundary: resolve() is documented never to throw, but one anchor that
  // does must not mute every other anchor in the artifact (PV-02).
  const classifications: AnchorClassification[] = [];
  for (const input of inputs) {
    let result: ResolveResult;
    try {
      result = await resolveAnchor(repoRoot, input, pool);
    } catch (err) {
      result = {
        status: 'cannot-determine',
        content: null,
        resolvedRev: null,
        resolvedRange: null,
        eligibleForStaleness: false,
        reason: `resolver threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    classifications.push({ input, result });
  }

  const eligibleCount = classifications.filter((c) => c.result.eligibleForStaleness).length;
  const skippedCount = classifications.length - eligibleCount;
  const headRevision = await readHeadRevision(pool);

  const observations = planScanObservations(classifications, headRevision ?? '', now());
  const detectedCount = observations.filter((o) => o.outcome === 'detected').length;

  const result: StalenessScanResult = {
    scannedAnchorCount: classifications.length,
    eligibleCount,
    skippedCount,
    detectedCount,
    headRevision,
  };

  // An idle scan pass (nothing to record) must never touch the sidecar file
  // at all -- skip the write entirely rather than mutate() with an empty
  // observation array.
  if (observations.length === 0) return result;

  return findingsStoreFile.mutate((store) => ({
    next: applyScanObservations(store, observations),
    result,
  }));
}
