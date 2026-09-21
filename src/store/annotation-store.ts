/**
 * The annotation store: the durable, portable sidecar (`<artifact>.illum.json`,
 * next to the artifact file) that Phase 1's session-store.ts explicitly
 * deferred to this phase -- "The annotation store is explicitly NOT part of
 * this file... Phase 7 is that phase" (session-store.ts's own doc comment).
 * Every completed explanation, verify verdict, and "go deeper" follow-up
 * permanently lives here -- the thing that makes a reopened artifact "already
 * know more than session 1 did" (EDU-04).
 *
 * Deliberately separate from src/store/session-store.ts's machine-local
 * `state.json` (ARCHITECTURE.md's own reasoning): accumulated explanations
 * are large, permanent, and belong to the ARTIFACT, not to the machine that
 * happened to review it. Colocating this file next to the artifact means
 * `git mv`ing the artifact and its sidecar together keeps them paired --
 * portable by construction.
 *
 * This module mirrors SessionStore's own read/mutate API shape exactly
 * (src/store/session-store.ts) so callers do not have to learn a second
 * store idiom, and reuses `writeAtomic` from that same file directly rather
 * than reimplementing tmp+rename+Windows-EPERM-retry a second time here.
 *
 * Path derivation is a plain string suffix (`annotationStorePathFor`), NOT a
 * sha256 hash like session-store.ts's `sessionStorePathFor` -- this sidecar
 * is meant to be human-discoverable sitting right next to the artifact it
 * annotates, not hidden in a machine-local state directory.
 *
 * `Card.snapshot`/`Card.orphan` reuse src/provenance/identity.ts's own
 * `ElementSnapshot`/`OrphanRecord` types verbatim -- this file does not
 * redeclare or reimplement identity.ts's re-attachment logic (tiers 1-4,
 * two-strikes orphan promotion). `applyReattachment` (Task 2) only APPLIES
 * caller-supplied `OrphanRecord` values (produced elsewhere, by identity.ts's
 * `reattach`) onto matching cards by id -- it never decides orphan status
 * itself.
 */

import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { AsyncMutex } from './async-mutex.ts';
import { writeAtomic } from './session-store.ts';
import type { Intent } from '../shared/intent.ts';
import type { DriftState } from '../provenance/types.ts';
import type { ElementSnapshot, OrphanRecord } from '../provenance/identity.ts';
import type { Tier, Verdict, DispatchElement, DispatchSource } from '../router/types.ts';

export const ANNOTATION_PROTOCOL_VERSION = 'illuminate.annotations/1' as const;

/**
 * A card's own copy of the resolved provenance a thread entry was answered
 * against. Field-for-field identical to `DispatchSource` (src/router/types.ts)
 * but declared separately, deliberately: this store must stay importable and
 * meaningful independent of the router's wire contracts, and a sidecar
 * surviving on disk for the artifact's entire lifetime should not be coupled
 * to a transport-layer type that later phases are free to reshape.
 */
export interface CardSource {
  readonly path: string;
  readonly rev: string | null;
  readonly range: { readonly startLine: number; readonly endLine: number } | null;
  readonly status: DriftState;
  readonly content: string | null;
}

/**
 * One completed answer in a card's thread -- the unit `appendCardEntry`
 * (Task 2) appends. A single card accumulates one of these per dispatch
 * answered against it (the first creates the card; every chained "go
 * deeper" or self-explanation follow-up extends the same thread, EDU-05).
 */
export interface CardThreadEntry {
  readonly dispatchId: string;
  readonly intent: Intent;
  readonly depth: number;
  readonly parentDispatchId: string | null;
  readonly learnerNote: string | null;
  readonly markdown: string;
  readonly verdict: Verdict | null;
  readonly decidingLines: string | null;
  readonly model: string;
  readonly tier: Tier;
  readonly source: CardSource | null;
  readonly answeredAt: string;
}

/**
 * One element's durable annotation record: its re-attachment identity
 * (`snapshot`), the full chronological thread of answers pinned to it, and
 * its current orphan status (`null` while it still reattaches cleanly).
 * `orphan` is never cleared by anything in this file once set -- ANCH-05's
 * never-silently-delete invariant, carried over verbatim from identity.ts.
 */
export interface Card {
  readonly cardId: string;
  readonly snapshot: ElementSnapshot;
  readonly thread: readonly CardThreadEntry[];
  readonly orphan: OrphanRecord | null;
}

export interface AnnotationStore {
  readonly protocol: typeof ANNOTATION_PROTOCOL_VERSION;
  readonly cards: readonly Card[];
}

export function emptyAnnotationStore(): AnnotationStore {
  return { protocol: ANNOTATION_PROTOCOL_VERSION, cards: [] };
}

/**
 * `<artifactPath>.illum.json` -- co-located with the artifact, not derived
 * from any hash. Portable by construction: `git mv`ing the artifact and its
 * sidecar together keeps them paired; this function does no I/O and does no
 * validation of `artifactPath` (the caller already holds a validated,
 * realpath'd session record's `file` field).
 */
export function annotationStorePathFor(artifactPath: string): string {
  return `${artifactPath}.illum.json`;
}

export type ReadAnnotationFile = (path: string) => Promise<string>;

/**
 * Reads and parses the sidecar at `path`. A missing sidecar (ENOENT -- the
 * artifact has never been annotated) resolves to `emptyAnnotationStore()`
 * rather than throwing, mirroring `SessionStore.read()`'s own ENOENT-catch
 * idiom exactly. Any other error (permission denial, malformed JSON) is
 * rethrown -- only "no sidecar exists yet" is a legitimate empty state.
 */
export async function readAnnotationStore(
  path: string,
  readFileFn: ReadAnnotationFile = (p) => readFile(p, 'utf8'),
): Promise<AnnotationStore> {
  try {
    return JSON.parse(await readFileFn(path)) as AnnotationStore;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyAnnotationStore();
    throw err;
  }
}

/**
 * Builds the `Card.snapshot` `ElementSnapshot` for a NEW card from the
 * originating dispatch's own already-resolved fields. `elementUid` is
 * ALWAYS `null` -- no `data-illum-id` authoring convention exists yet; this
 * is a disclosed v1 limitation, not a bug: tier 1 of identity.ts's fallback
 * chain is a documented no-op until such a convention exists.
 */
export function snapshotFromDispatchElement(
  element: DispatchElement,
  source: DispatchSource | null,
): ElementSnapshot {
  return {
    elementUid: null,
    anchor:
      source === null
        ? null
        : {
            path: source.path,
            startLine: source.range?.startLine ?? null,
            endLine: source.range?.endLine ?? null,
          },
    textContent: element.text,
    prefixContext: element.prefixContext,
    suffixContext: element.suffixContext,
    structuralPath: element.selector,
  };
}

export interface AppendCardEntryParams {
  readonly parentDispatchId: string | null;
  readonly snapshot: ElementSnapshot; // only consulted when a new card is created
  readonly entry: CardThreadEntry;
}

/**
 * Pure reducer. If `parentDispatchId` is non-null AND a card's thread already
 * contains an entry with that `dispatchId`, appends `entry` to THAT card's
 * thread (EDU-05's "extend the same card chain"). Otherwise (`parentDispatchId`
 * is `null`, OR is non-null but matches nothing -- e.g. the parent dispatch
 * predates this artifact's sidecar) creates a brand-new card from
 * `params.snapshot` with a single-entry thread. Never mutates `store` in
 * place; always returns a new `AnnotationStore`, and every card object not
 * being extended is passed through by reference, unchanged.
 */
export function appendCardEntry(store: AnnotationStore, params: AppendCardEntryParams): AnnotationStore {
  const target =
    params.parentDispatchId !== null
      ? store.cards.find((card) => card.thread.some((entry) => entry.dispatchId === params.parentDispatchId))
      : undefined;

  if (target !== undefined) {
    const extended: Card = { ...target, thread: [...target.thread, params.entry] };
    return { ...store, cards: store.cards.map((card) => (card === target ? extended : card)) };
  }

  const newCard: Card = {
    cardId: randomBytes(12).toString('base64url'),
    snapshot: params.snapshot,
    thread: [params.entry],
    orphan: null,
  };
  return { ...store, cards: [...store.cards, newCard] };
}

/**
 * Pure reducer, ANCH-05's never-silently-delete invariant applied to cards:
 * for every card whose id is a key in `orphanUpdates` (i.e. it failed to
 * reattach this pass), sets its `orphan` to the supplied `OrphanRecord`
 * verbatim -- this function does not re-implement identity.ts's own
 * two-strikes logic, it applies caller-supplied values (produced by
 * identity.ts's `reattach`, called by Plan 07-03's browser-side code, whose
 * results travel back to the daemon). For every card whose id is NOT a key
 * in `orphanUpdates` (it matched again this pass, or was never checked),
 * `orphan` is left exactly as it currently is -- matching again after a miss
 * does NOT clear a recorded orphan, identity.ts's own documented, deliberate
 * choice, carried over verbatim. Never removes a card; `store.cards.length`
 * is invariant across any number of calls.
 */
export function applyReattachment(
  store: AnnotationStore,
  orphanUpdates: ReadonlyMap<string, OrphanRecord>,
): AnnotationStore {
  return {
    ...store,
    cards: store.cards.map((card) => {
      const orphan = orphanUpdates.get(card.cardId);
      return orphan === undefined ? card : { ...card, orphan };
    }),
  };
}

/**
 * Mirrors `SessionStore`'s own read/mutate API shape exactly
 * (src/store/session-store.ts) so callers do not have to learn a second
 * store idiom. Reuses session-store.ts's exported `writeAtomic` directly --
 * tmp+rename+Windows-EPERM-retry is implemented exactly once, there.
 */
export class AnnotationStoreFile {
  #path: string;
  #mutex = new AsyncMutex();

  constructor(artifactPath: string) {
    this.#path = annotationStorePathFor(artifactPath);
  }

  async read(): Promise<AnnotationStore> {
    return readAnnotationStore(this.#path);
  }

  /**
   * Mutex-serialized read-modify-write, byte-for-byte the same shape as
   * `SessionStore.mutate`: `fn` receives the current store (or an empty
   * store on first use) and returns the next store plus whatever `mutate`
   * should resolve to; the result is written atomically before the mutex
   * releases, so concurrent callers (e.g. two subagents answering different
   * dispatches for the same artifact around the same time) never interleave
   * a read with another caller's not-yet-flushed write.
   */
  async mutate<T>(fn: (store: AnnotationStore) => { next: AnnotationStore; result: T }): Promise<T> {
    return this.#mutex.runExclusive(async () => {
      const current = await this.read();
      const { next, result } = fn(current);
      await writeAtomic(this.#path, JSON.stringify(next, null, 2));
      return result;
    });
  }
}
