import { AnnotationStoreFile, annotationStorePathFor } from '../store/annotation-store.ts';
import { canonicalPathKey } from './state-dir.ts';

/**
 * One `AnnotationStoreFile` per artifact for the daemon's lifetime (RT-14).
 * `AnnotationStoreFile.mutate` serializes writes through an IN-PROCESS,
 * PER-INSTANCE mutex, so two answers landing concurrently for one artifact
 * through two fresh instances could interleave a read-modify-write and drop
 * a card. The findings store already solves this by holding one instance in
 * the staleness registry; this is the same discipline for cards. Keyed by
 * the sidecar path (two artifact paths that share a sidecar are one store),
 * canonicalized the way every other state key already is.
 */
export interface AnnotationStoreRegistry {
  get(artifactPath: string): AnnotationStoreFile;
}

export function createAnnotationStoreRegistry(): AnnotationStoreRegistry {
  const stores = new Map<string, AnnotationStoreFile>();
  return {
    get(artifactPath: string): AnnotationStoreFile {
      const key = canonicalPathKey(annotationStorePathFor(artifactPath));
      let store = stores.get(key);
      if (store === undefined) {
        store = new AnnotationStoreFile(artifactPath);
        stores.set(key, store);
      }
      return store;
    },
  };
}
