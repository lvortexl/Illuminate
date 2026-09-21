/**
 * The findings store: the durable record, kept in the OS state directory,
 * that holds every "touched"/"lost" staleness detection as a fingerprinted,
 * updatable entry -- never a duplicate, never silently deleted.
 *
 * Findings are DERIVED (a rescan rebuilds them), which is why they live in
 * the state dir rather than beside the artifact -- see
 * `findingsStorePathFor` for the full rationale and its contrast with the
 * annotation store, which stays co-located because it holds the user's own
 * irreproducible work.
 *
 * STAL-04 requires findings to "land in a passive inbox, fingerprinted by
 * rule plus normalized target so repeat detections update rather than
 * duplicate." The reference implementation (lavish-axi) ships exactly this
 * machine for its own "Layout issues inbox" -- `layoutWarningFingerprint`
 * (`{rule, target, viewportClass}` -> `sha256(...).slice(0,16)`), a
 * `Map<fingerprint, observation>` reconciliation pass, and a
 * dismissed/reopened lifecycle keyed on whether a LATER revision still shows
 * the same issue (`dist/cli.mjs:6803-7230`). This file borrows that exact
 * scheme, scaled to two rules (`drift-touched`/`drift-lost`) and three
 * statuses (`open`/`resolved`/`dismissed`) instead of the reference's full
 * seven-status layout-warning lifecycle.
 *
 * Mirrors `AnnotationStoreFile`'s own read/mutate API shape exactly
 * (src/store/annotation-store.ts) so callers do not have to learn a third
 * store idiom, and reuses `writeAtomic` from session-store.ts directly
 * rather than reimplementing tmp+rename+Windows-EPERM-retry a third time.
 *
 * Path derivation is a sha256 key under the state dir
 * (`findingsStorePathFor`), deliberately unlike `annotationStorePathFor`'s
 * co-located `.illum.json` suffix: two separate stores, two separate
 * lifecycles, two separate locations, never one file serving both.
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AsyncMutex } from './async-mutex.ts';
import { writeAtomic } from './session-store.ts';
import { stateDir, statePathHash } from '../daemon/state-dir.ts';

export const FINDINGS_PROTOCOL_VERSION = 'illuminate.findings/1' as const;

/** Only the two states that ever produce a passive-inbox entry (STAL-02's
 * quiet-default: "unchanged"/"moved" relocate or match silently and never
 * reach this store at all -- that discipline lives in Plan 08-02's scanner,
 * not here, but the RULE type itself only ever names the two loud states,
 * making "unchanged/moved never file a finding" true by construction, not
 * by convention). */
export type FindingRule = 'drift-touched' | 'drift-lost';

export type FindingStatus = 'open' | 'resolved' | 'dismissed';

/** POSIX-relative path + optional range, mirroring AnchorRef's own shape
 * (src/provenance/types.ts) -- declared separately rather than imported,
 * this codebase's established cross-module-boundary convention (DispatchElement
 * vs IntentElement, ReattachableCard vs Card). Deliberately carries NO
 * content field: a Finding must never become a second channel for source
 * text to leave the repo -- the SDK re-derives its own display text (if
 * any) from the LIVE element, never from this store. */
export interface FindingTarget {
  readonly path: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

export interface FindingHistoryEntry {
  readonly at: string; // ISO timestamp
  readonly revision: string; // git HEAD sha at detection/resolution time
  readonly event: 'detected' | 'reopened' | 'resolved' | 'dismissed';
}

export interface Finding {
  readonly fingerprint: string; // findingFingerprint(rule, target) -- 16 hex chars
  readonly rule: FindingRule;
  readonly target: FindingTarget;
  readonly status: FindingStatus;
  readonly firstSeenAt: string;
  readonly firstSeenRevision: string;
  readonly lastSeenAt: string;
  readonly lastSeenRevision: string;
  /** Set only when status becomes 'dismissed'; null otherwise. A LATER
   * detection (revision !== dismissedAtRevision) reopens the finding --
   * see recordDetection's own doc comment. */
  readonly dismissedAtRevision: string | null;
  readonly history: readonly FindingHistoryEntry[];
}

export interface FindingsStore {
  readonly protocol: typeof FINDINGS_PROTOCOL_VERSION;
  readonly findings: readonly Finding[];
}

export function emptyFindingsStore(): FindingsStore {
  return { protocol: FINDINGS_PROTOCOL_VERSION, findings: [] };
}

/**
 * Findings live in the OS state directory, NOT beside the artifact.
 *
 * This is the ratified half of the sidecar split. The two stores hold
 * categorically different things and therefore belong in different places:
 *
 *   - Annotation store (`<artifact>.illum.json`): the user's OWN cards --
 *     answers, self-explanations, verification verdicts. Not reproducible,
 *     so it must travel with the artifact when it is copied or shared.
 *     Stays co-located. See `annotationStorePathFor`.
 *   - Findings store (this one): DERIVED staleness detections. A rescan
 *     rebuilds them from scratch, so they are clutter next to the user's
 *     file and there is nothing to lose by relocating them.
 *
 * Keying goes through `statePathHash` (src/daemon/state-dir.ts) -- the same
 * function `lockPathFor` and `sessionStorePathFor` use, not a local copy of
 * its derivation, so "mirrors lockPathFor exactly" is enforced by there
 * being one implementation rather than by a comment. Keyed on the artifact
 * FILE path, not its directory -- two artifacts in one directory keep
 * separate findings.
 *
 * This also restores `state-dir.ts`'s own stated invariant, which the
 * co-located findings file had quietly falsified: "illuminate never writes
 * state next to the user's artifact."
 */
export function findingsStorePathFor(artifactPath: string): string {
  return join(stateDir(), 'findings', `${statePathHash(artifactPath)}.json`);
}

/** Renders a whole-file target (startLine/endLine both null) as the bare
 * path with no `#L..-L..` suffix, and a ranged target as
 * `path#Lstart-Lend`. Load-bearing, not cosmetic: findingFingerprint must
 * distinguish a whole-file finding from a ranged finding at the same path. */
function normalizeFindingTarget(target: FindingTarget): string {
  if (target.startLine === null && target.endLine === null) return target.path;
  return `${target.path}#L${String(target.startLine)}-L${String(target.endLine)}`;
}

/** sha256(`${rule}|${normalizeFindingTarget(target)}`).slice(0,16) --
 * deterministic, collision-cheap (mirrors hash.ts's own truncation
 * rationale: this is a reconciliation key, not a tamper-evidence
 * boundary). normalizeFindingTarget renders a whole-file target
 * (startLine/endLine both null) as the bare path with no `#L..-L..`
 * suffix, and a ranged target as `path#Lstart-Lend`. */
export function findingFingerprint(rule: FindingRule, target: FindingTarget): string {
  return createHash('sha256')
    .update(`${rule}|${normalizeFindingTarget(target)}`)
    .digest('hex')
    .slice(0, 16);
}

export type ReadFindingsFile = (path: string) => Promise<string>;

/** Missing sidecar (ENOENT) resolves to emptyFindingsStore(), mirroring
 * readAnnotationStore's identical ENOENT-catch idiom. Any other read/parse
 * error is rethrown. */
export async function readFindingsStore(
  path: string,
  readFileFn: ReadFindingsFile = (p) => readFile(p, 'utf8'),
): Promise<FindingsStore> {
  try {
    return JSON.parse(await readFileFn(path)) as FindingsStore;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyFindingsStore();
    throw err;
  }
}

export interface RecordObservation {
  readonly rule: FindingRule;
  readonly target: FindingTarget;
  readonly revision: string;
  readonly at: string;
}

/**
 * Pure reducer. Records a fresh 'detected' observation for (rule, target)
 * at `revision`/`at`. If no Finding exists yet for this fingerprint,
 * creates one with status 'open' and a single 'detected' history entry.
 * If an OPEN Finding already exists at this fingerprint: an observation at
 * the SAME revision as `lastSeenRevision` is idempotent (returns the store
 * UNCHANGED, by reference -- a same-revision re-check, not a new event);
 * an observation at a NEWER revision updates lastSeenAt/lastSeenRevision
 * and appends NO new history entry (staying open is not itself an event
 * worth recording -- only the transitions in the list below are). If a
 * DISMISSED Finding exists at this fingerprint and `revision !==
 * dismissedAtRevision`, flips status back to 'open', clears
 * dismissedAtRevision to null, updates lastSeenAt/lastSeenRevision, and
 * appends a 'reopened' history entry -- STAL-04's fail-open promise cuts
 * both ways: a dismissal is scoped to the revision the reader saw, not a
 * permanent silence. If the SAME dismissed revision is detected again,
 * the store is returned unchanged (still dismissed, no reopen). A
 * RESOLVED Finding re-detected at any revision reopens identically to the
 * dismissed case (a 'reopened' history entry, status back to 'open').
 */
export function recordDetection(store: FindingsStore, observation: RecordObservation): FindingsStore {
  const fingerprint = findingFingerprint(observation.rule, observation.target);
  const existing = store.findings.find((f) => f.fingerprint === fingerprint);

  if (existing === undefined) {
    const newFinding: Finding = {
      fingerprint,
      rule: observation.rule,
      target: observation.target,
      status: 'open',
      firstSeenAt: observation.at,
      firstSeenRevision: observation.revision,
      lastSeenAt: observation.at,
      lastSeenRevision: observation.revision,
      dismissedAtRevision: null,
      history: [{ at: observation.at, revision: observation.revision, event: 'detected' }],
    };
    return { ...store, findings: [...store.findings, newFinding] };
  }

  if (existing.status === 'open') {
    if (observation.revision === existing.lastSeenRevision) return store;
    const updated: Finding = {
      ...existing,
      lastSeenAt: observation.at,
      lastSeenRevision: observation.revision,
    };
    return { ...store, findings: store.findings.map((f) => (f === existing ? updated : f)) };
  }

  if (existing.status === 'dismissed') {
    if (observation.revision === existing.dismissedAtRevision) return store;
    const reopened: Finding = {
      ...existing,
      status: 'open',
      dismissedAtRevision: null,
      lastSeenAt: observation.at,
      lastSeenRevision: observation.revision,
      history: [...existing.history, { at: observation.at, revision: observation.revision, event: 'reopened' }],
    };
    return { ...store, findings: store.findings.map((f) => (f === existing ? reopened : f)) };
  }

  // existing.status === 'resolved' -- reopens at any revision.
  const reopened: Finding = {
    ...existing,
    status: 'open',
    dismissedAtRevision: null,
    lastSeenAt: observation.at,
    lastSeenRevision: observation.revision,
    history: [...existing.history, { at: observation.at, revision: observation.revision, event: 'reopened' }],
  };
  return { ...store, findings: store.findings.map((f) => (f === existing ? reopened : f)) };
}

/**
 * Pure reducer. Records the ABSENCE of a previously-open finding at
 * `revision`/`at` -- called only when a fresh classification came back
 * clean (unchanged/moved) for an anchor that previously had an OPEN
 * finding. No-op (returns the store UNCHANGED, by reference) when no OPEN
 * Finding exists for this fingerprint (nothing to resolve), OR when
 * `revision` is not strictly newer than the Finding's own
 * `lastSeenRevision` (a stale/out-of-order absence check must never
 * regress a finding a NEWER pass already re-detected -- defensive
 * ordering guard, not an expected runtime path given Plan 08-02's own
 * single-scan-pass call pattern). Otherwise sets status 'resolved' and
 * appends a 'resolved' history entry. Never touches a 'dismissed' or
 * already-'resolved' Finding -- only 'open' transitions to 'resolved'.
 */
export function recordAbsence(store: FindingsStore, observation: RecordObservation): FindingsStore {
  const fingerprint = findingFingerprint(observation.rule, observation.target);
  const existing = store.findings.find((f) => f.fingerprint === fingerprint);
  if (existing === undefined) return store;
  if (existing.status !== 'open') return store;
  if (observation.revision === existing.lastSeenRevision) return store;

  const resolved: Finding = {
    ...existing,
    status: 'resolved',
    history: [...existing.history, { at: observation.at, revision: observation.revision, event: 'resolved' }],
  };
  return { ...store, findings: store.findings.map((f) => (f === existing ? resolved : f)) };
}

/**
 * Pure reducer. No-op (store returned UNCHANGED, by reference) if
 * `fingerprint` matches no Finding, or matches a Finding that is already
 * 'dismissed' (idempotent). Otherwise sets status 'dismissed',
 * `dismissedAtRevision` to the Finding's own `lastSeenRevision`, and
 * appends a 'dismissed' history entry. Never removes the Finding.
 */
export function dismissFinding(store: FindingsStore, fingerprint: string): FindingsStore {
  const existing = store.findings.find((f) => f.fingerprint === fingerprint);
  if (existing === undefined) return store;
  if (existing.status === 'dismissed') return store;

  const dismissedAt = new Date().toISOString();
  const dismissed: Finding = {
    ...existing,
    status: 'dismissed',
    dismissedAtRevision: existing.lastSeenRevision,
    history: [...existing.history, { at: dismissedAt, revision: existing.lastSeenRevision, event: 'dismissed' }],
  };
  return { ...store, findings: store.findings.map((f) => (f === existing ? dismissed : f)) };
}

export type ScanOutcome = 'detected' | 'absent';

export interface ScanObservation {
  readonly rule: FindingRule;
  readonly target: FindingTarget;
  readonly outcome: ScanOutcome;
  readonly revision: string;
  readonly at: string;
}

/**
 * Folds an ARRAY of per-anchor scan observations through recordDetection/
 * recordAbsence in order, threading the store through each call -- the
 * batching seam Plan 08-02's scanner uses to turn one whole scan pass into
 * ONE FindingsStoreFile.mutate() call rather than one per anchor. Deliberately
 * takes no anchor that classified to cannot-determine/refused/no-git/
 * unanchored: Plan 08-02's own scanner never constructs a ScanObservation
 * for those outcomes at all -- that omission IS the fail-open contract at
 * the call-site boundary, not something this function enforces internally
 * (there is nothing here to enforce: a fail-open check simply never calls
 * this function with that anchor's data).
 */
export function applyScanObservations(store: FindingsStore, observations: readonly ScanObservation[]): FindingsStore {
  return observations.reduce((acc, observation) => {
    const { rule, target, revision, at } = observation;
    return observation.outcome === 'detected'
      ? recordDetection(acc, { rule, target, revision, at })
      : recordAbsence(acc, { rule, target, revision, at });
  }, store);
}

/** Mirrors AnnotationStoreFile's own shape exactly (src/store/annotation-store.ts)
 * so callers do not learn a third store idiom in this codebase. Reuses
 * session-store.ts's exported writeAtomic directly -- tmp+rename+Windows-
 * EPERM-retry is implemented exactly once, there. */
export class FindingsStoreFile {
  #path: string;
  #mutex = new AsyncMutex();

  constructor(artifactPath: string) {
    this.#path = findingsStorePathFor(artifactPath);
  }

  async read(): Promise<FindingsStore> {
    return readFindingsStore(this.#path);
  }

  /**
   * Mutex-serialized read-modify-write, byte-for-byte the same shape as
   * SessionStore.mutate/AnnotationStoreFile.mutate: `fn` receives the
   * current store (or an empty store on first use) and returns the next
   * store plus whatever `mutate` should resolve to; the result is written
   * atomically before the mutex releases, so concurrent callers never
   * interleave a read with another caller's not-yet-flushed write.
   */
  async mutate<T>(fn: (store: FindingsStore) => { next: FindingsStore; result: T }): Promise<T> {
    return this.#mutex.runExclusive(async () => {
      const current = await this.read();
      const { next, result } = fn(current);
      await writeAtomic(this.#path, JSON.stringify(next, null, 2));
      return result;
    });
  }
}
