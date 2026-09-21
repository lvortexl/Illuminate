import { realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, basename, join } from 'node:path';

/**
 * Resolves `candidate` to a real path, tolerating a leaf (or a whole tail of
 * segments) that does not exist on disk.
 *
 * Every segment that DOES exist is still resolved by `realpathSync`, so a
 * symlink or junction anywhere along the existing prefix is followed before
 * the caller's containment check runs. Only segments that are provably
 * absent are appended verbatim — and a path component that does not exist
 * cannot itself be a symlink, so appending it can never smuggle the result
 * outside the prefix that was just resolved.
 *
 * Returns `null` only when nothing in the chain exists at all (the walk runs
 * out of parents), which is not a reachable state for a path under a real
 * repo root.
 */
function realpathAllowingMissingTail(candidate: string): string | null {
  const missing: string[] = [];
  let current = candidate;
  for (;;) {
    try {
      const realExisting = realpathSync(current);
      return missing.length === 0 ? realExisting : join(realExisting, ...missing);
    } catch {
      const parent = dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return null;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

// The resolver's core security boundary (T-02-01/02/03). `anchorPath` is
// untrusted: authored by an LLM agent regenerating an artifact. Symlinks and
// junctions are resolved BEFORE the containment check runs, so an escaping
// symlink is caught by realpath, not missed by a string-prefix check.
//
// A path that does not currently exist is NOT treated as a security refusal
// (STAL-03). A file that was validly committed and cited at `data-rev` and
// has since been deleted is exactly the case staleness's `lost` state exists
// to name — refusing it here made `lost` structurally unreachable through
// `resolve()`, because `parseAnchor` calls this function unconditionally,
// before `resolve()` has even checked whether git is available. Containment
// is unweakened: see `realpathAllowingMissingTail` for why appending a
// provably-absent segment cannot escape. Callers that need the path to
// actually exist (`serveNoGit`'s `readFileSync`) fail on their own read,
// which is a serving failure, not a security one.
export function confineToRepoRoot(repoRoot: string, anchorPath: string): string | null {
  if (isAbsolute(anchorPath)) return null;
  const candidate = resolve(repoRoot, anchorPath);

  const real = realpathAllowingMissingTail(candidate);
  if (real === null) return null;

  let realRoot: string;
  try {
    realRoot = realpathSync(repoRoot);
  } catch {
    // Containment cannot be proven against a root that does not resolve.
    return null;
  }

  const rel = relative(realRoot, real);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return real;
}
