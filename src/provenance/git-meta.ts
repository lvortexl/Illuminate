import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

// The only module in `src/provenance/` allowed to spawn `git` plumbing
// commands directly (`cat-file`, `config`, `hash-object`, `rev-parse`,
// `show`, `diff`, `--version`). Every other module in this phase
// (`relocate.ts`, `drift.ts`, `resolve.ts`) calls through here rather than
// shelling out itself — see this plan's objective and T-02-09 in its threat
// model. Every git invocation below passes an argument array to
// `execFileSync`, never a shell-interpolated string, so a `rev`/`relPath`
// containing shell metacharacters cannot escape into command injection.
//
// This module trusts its caller to have already confined `relPath` to the
// repo root (T-02-07) — it performs no containment check itself.

/**
 * `true` iff `rev` resolves to a commit object that git can currently read
 * in `repoRoot`. Covers both "never committed" (a bogus/unreachable sha) and
 * "committed once but the object is not present here" (a shallow clone whose
 * depth boundary excludes it, or history rewritten out from under a rev by a
 * rebase/force-push) — both surface identically as `cat-file -e` failing to
 * find the object, so one implementation covers both cases in the
 * Four-State Model without a second, separate function.
 */
export function isRevReachable(repoRoot: string, rev: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${rev}^{commit}`], {
      cwd: repoRoot,
    windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The repo's effective `core.autocrlf`. `"unset"` covers both a literal
 * unset key (`git config --get` exits 1) and any value outside the three
 * git recognizes, so a caller never has to separately handle a parse error.
 */
export function getAutocrlf(repoRoot: string): 'true' | 'false' | 'input' | 'unset' {
  let raw: string;
  try {
    raw = execFileSync('git', ['config', '--get', 'core.autocrlf'], {
      cwd: repoRoot,
    windowsHide: true,
      encoding: 'utf8',
    }).trim();
  } catch {
    // `git config --get` exits 1 when the key is unset anywhere in the
    // effective config chain — not an error, just the "unset" case.
    return 'unset';
  }
  if (raw === 'true' || raw === 'false' || raw === 'input') return raw;
  return 'unset';
}

/**
 * `true` iff the working-tree file at `relPath` differs from the committed
 * blob `blobSha`. Sourced exclusively from `git hash-object`, which applies
 * git's own clean filter (CRLF normalization per `core.autocrlf`, plus any
 * `.gitattributes` override) to the raw working-tree bytes before hashing —
 * this is the ANCH-06 mechanism. Never reads the file via `node:fs` and never
 * hashes raw filesystem bytes itself; see `02-RESEARCH.md` Pattern 3 for the
 * empirical verification this depends on.
 */
export function isWorkingTreeDirtyAt(repoRoot: string, relPath: string, blobSha: string): boolean {
  const hash = execFileSync('git', ['hash-object', '--', relPath], {
    cwd: repoRoot,
    windowsHide: true,
    encoding: 'utf8',
  }).trim();
  return hash !== blobSha;
}

/**
 * The batched form of `isWorkingTreeDirtyAt` above (ANCH-03 follow-up):
 * answers the SAME question, for MANY `(relPath, blobSha)` pairs, via ONE
 * `git hash-object --stdin-paths` process instead of one `git hash-object --
 * <path>` spawn per entry. Positionally correlated — `result[i]` answers
 * `entries[i]`, exactly like `GitBatchPool`'s own FIFO convention — so
 * callers never need a keying scheme (and a caller that legitimately repeats
 * the same `relPath` more than once, e.g. several anchors citing the same
 * file, simply gets the same answer at each of its positions, computed
 * once).
 *
 * Two empirically-verified properties this function is built around (git
 * 2.53.0.windows.1, this machine, 2026-09-10 — see this plan's SUMMARY for
 * the full probe transcripts):
 *
 * 1. `--stdin-paths` applies git's OWN clean filter (`core.autocrlf`,
 *    `.gitattributes`) to each path exactly like the single-path form —
 *    verified byte-for-byte identical shas for both a plain file and a
 *    `core.autocrlf=true` CRLF-checked-out file, batched alongside a plain
 *    file in the SAME invocation. The ANCH-06 guarantee this module already
 *    relies on (see `isWorkingTreeDirtyAt` above) is therefore preserved by
 *    batching, not a second, possibly-diverging code path.
 * 2. `--stdin-paths` is NOT independently fault-tolerant per path: the FIRST
 *    path in the fed list that does not exist on disk makes the whole
 *    process print one `fatal:` line to stderr and exit 128 IMMEDIATELY —
 *    every path queued after the missing one in that same input is silently
 *    NEVER hashed at all (verified directly: a 4-path batch with the
 *    missing path in the middle only ever emits stdout for the ONE path
 *    that preceded it). A batching caller that fed every requested path
 *    straight through would therefore lose results for unrelated, perfectly
 *    resolvable siblings whenever even one entry in the same flush raced a
 *    concurrent on-disk deletion — a blast radius `isWorkingTreeDirtyAt`'s
 *    original one-spawn-per-anchor form never had. This function closes
 *    that gap itself, at the source: every entry is checked with
 *    `existsSync` BEFORE it is ever handed to `--stdin-paths`, and a missing
 *    path is resolved `true` (dirty) directly, with NO git spawn at all for
 *    it and WITHOUT ever letting it poison a sibling's result in the same
 *    batch. This is not a workaround for a bug in the single-anchor form
 *    above (that form is never actually reached for a path missing from
 *    disk in `resolve.ts`'s real call chain — `confine.ts`'s
 *    `realpathSync`-based containment check, which runs first,
 *    unconditionally, already requires the path to exist); it exists
 *    because batching multiple anchors' checks into ONE process call
 *    introduces a cross-anchor failure coupling that single-spawn-per-anchor
 *    code structurally could not have, and this function is the one place
 *    that coupling is cut.
 *
 * Only entries that need an actual spawn incur one, and at most ONE spawn
 * total (not one per surviving entry) — `execFileSync`'s `input` option
 * writes every remaining path as one newline-joined blob to `hash-object`'s
 * stdin and captures its stdout synchronously, still a single call, still
 * an argument array (never shell-interpolated), matching this file's own
 * `execFileSync`-only convention (no persistent/streaming subprocess is
 * introduced here — see this plan's SUMMARY for why a persistent
 * `--stdin-paths` process was deliberately rejected: property 2 above means
 * ANY future missing path would kill it mid-batch-pool-lifetime, requiring
 * exactly the same kind of fatal-recovery bookkeeping `GitBatchPool` already
 * carries for a DIFFERENT process, doubled for no benefit over one
 * short-lived call per flush).
 */
export function isWorkingTreeDirtyAtBatch(
  repoRoot: string,
  entries: readonly { readonly relPath: string; readonly blobSha: string }[],
): readonly boolean[] {
  const results = new Array<boolean>(entries.length);
  const toHash: { readonly index: number; readonly relPath: string; readonly blobSha: string }[] = [];

  for (const [index, entry] of entries.entries()) {
    if (!existsSync(join(repoRoot, entry.relPath))) {
      results[index] = true;
      continue;
    }
    toHash.push({ index, relPath: entry.relPath, blobSha: entry.blobSha });
  }

  if (toHash.length === 0) return results;

  const stdin = toHash.map((e) => e.relPath).join('\n') + '\n';
  const out = execFileSync('git', ['hash-object', '--stdin-paths'], {
    cwd: repoRoot,
    windowsHide: true,
    input: stdin,
    encoding: 'utf8',
  });
  // One sha per line, in the SAME order the paths were fed (verified
  // empirically alongside property 1 above) -- never split on anything but
  // the trailing newline `execFileSync`'s captured stdout ends with.
  const hashes = out.split('\n').filter((line) => line.length > 0);
  if (hashes.length !== toHash.length) {
    throw new Error(
      `git hash-object --stdin-paths returned ${String(hashes.length)} hashes for ${String(toHash.length)} requested paths`,
    );
  }
  toHash.forEach((entry, i) => {
    results[entry.index] = hashes[i] !== entry.blobSha;
  });
  return results;
}

/**
 * Walks up from `startPath` to find the enclosing git repo's root, or `null`
 * if `startPath` has no `.git` ancestor. Resolved via `realpath`, not string
 * equality, since a temp directory can have symlinked path components on
 * some systems (matches `confine.ts`'s containment-check convention).
 * Uses `realpathSync.native` (a real OS call) rather than the JS-only
 * `realpathSync`: on Windows, `os.tmpdir()` frequently returns a
 * `%TEMP%`-derived path (e.g. `C:\Windows\TEMP`) whose case doesn't match
 * the true on-disk directory name (e.g. `C:\Windows\Temp`) — plain
 * `fs.realpathSync` preserves the input's case when no symlink needs
 * resolving, while `git`'s own `--show-toplevel` and `realpathSync.native`
 * both resolve to the true on-disk case via the real Win32 API, so only the
 * native variant agrees with what git itself reports.
 */
export function findRepoRoot(startPath: string): string | null {
  let raw: string;
  try {
    raw = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startPath,
      windowsHide: true,
      encoding: 'utf8',
    }).trim();
  } catch {
    // Not inside any git working tree — `rev-parse --show-toplevel` fails
    // with a nonzero exit and no usable stdout.
    return null;
  }
  return realpathSync.native(raw);
}

/**
 * `true` iff a `git` binary is reachable on `PATH`. Deliberately not
 * simulated as `false` by manipulating the in-process `PATH` (fragile,
 * leaks into other tests); this trivial spawn-and-catch-`ENOENT`
 * implementation is integration-tested by construction. Plan 09's resolver
 * suite exercises the "no-git, binary missing" SCENARIO via dependency
 * injection instead of trying to make this function lie about its own
 * environment.
 */
export function isGitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts every configured submodule `path = ...` entry out of raw
 * `.gitmodules` content, normalized to forward slashes. Pure parsing, no I/O
 * — the single source of truth for this format, shared by `isSubmodulePath`
 * below (sourced via `execFileSync git show`) and `resolve.ts`'s pool-routed
 * equivalent (sourced via `pool.contents()`), so the two transports can never
 * drift into two different notions of "is this path a submodule".
 */
export function parseSubmodulePaths(gitmodulesContent: string): readonly string[] {
  const paths: string[] = [];
  const pathLineRe = /^\s*path\s*=\s*(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = pathLineRe.exec(gitmodulesContent)) !== null) {
    paths.push((match[1] ?? '').split('\\').join('/'));
  }
  return paths;
}

/**
 * `true` iff `relPath` names or is nested under one of `submodulePaths`
 * (already parsed via `parseSubmodulePaths`). Pure, no I/O — shared matching
 * logic behind both `isSubmodulePath` and its pool-routed equivalent.
 */
export function pathMatchesSubmodule(relPath: string, submodulePaths: readonly string[]): boolean {
  const normalizedRel = relPath.split('\\').join('/');
  return submodulePaths.some(
    (submodulePath) => normalizedRel === submodulePath || normalizedRel.startsWith(`${submodulePath}/`),
  );
}

/**
 * `true` iff `relPath` names or is nested under a submodule's working-tree
 * path as configured in `.gitmodules` at `rev`. Reads `.gitmodules` via
 * `git show <rev>:.gitmodules` (never `node:fs`, since it must reflect the
 * path's configuration AT `rev`, not whatever `.gitmodules` currently says in
 * the working tree) and tolerates a nonzero exit — no `.gitmodules` at that
 * rev simply means nothing is a submodule there. A5 (locked decision):
 * submodule paths resolve to `cannot-determine` in v1; this function is this
 * plan's contribution to that decision, consumed by Plan 09's `resolve.ts`.
 *
 * This synchronous, `execFileSync`-based form remains the direct-callable
 * contract this module's own tests exercise. `resolve.ts`'s hot path uses a
 * pool-routed equivalent instead (see that module) to avoid a per-anchor OS
 * spawn, built on the exact same `parseSubmodulePaths`/`pathMatchesSubmodule`
 * pair above rather than a second, possibly-diverging implementation.
 */
export function isSubmodulePath(repoRoot: string, rev: string, relPath: string): boolean {
  let content: string;
  try {
    content = execFileSync('git', ['show', `${rev}:.gitmodules`], {
      cwd: repoRoot,
    windowsHide: true,
      encoding: 'utf8',
    });
  } catch {
    return false;
  }
  return pathMatchesSubmodule(relPath, parseSubmodulePaths(content));
}

export type DetectRenameResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'single'; readonly newPath: string }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] };

/**
 * Distinguishes an unambiguous rename of `relPath` (as of `rev`) between
 * `rev` and `headRev` from an ambiguous one, per the locked A3/amended
 * ANCH-07 decision. Implemented via a full-tree `git diff -M --name-status`
 * (not `--follow`, which only walks a single file's own history and answers
 * a different question than "does THIS path have exactly one rename
 * destination between these two specific revs").
 *
 * The `ambiguous` branch groups every `R`-status line by shared destination
 * path defensively — empirically (see this plan's SUMMARY) a two-tree
 * `git diff --name-status` cannot actually produce two `R` lines sharing one
 * destination on git 2.53: a destination path can occupy at most one entry
 * in the ending tree, so diffcore-rename's matching is inherently 1:1
 * (verified with both a near-tie and an exact-tie construction — the loser
 * is always reported as a plain `D`, never a second `R`). The grouping check
 * is kept anyway as a defensive, currently-unreachable-in-practice signal
 * rather than assumed-safe dead code.
 */
export function detectRename(
  repoRoot: string,
  rev: string,
  headRev: string,
  relPath: string,
): DetectRenameResult {
  let out: string;
  try {
    out = execFileSync('git', ['diff', '-M', '--name-status', rev, headRev], {
      cwd: repoRoot,
    windowsHide: true,
      encoding: 'utf8',
    });
  } catch {
    return { kind: 'none' };
  }

  const normalizedRel = relPath.split('\\').join('/');
  const renameLines: { oldPath: string; newPath: string }[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const status = parts[0];
    const oldPath = parts[1];
    const newPath = parts[2];
    if (status === undefined || !status.startsWith('R')) continue;
    if (oldPath === undefined || newPath === undefined) continue;
    renameLines.push({ oldPath, newPath });
  }

  const own = renameLines.filter((r) => r.oldPath === normalizedRel);
  if (own.length === 0) return { kind: 'none' };

  const destPath = own[0]!.newPath;
  const sharing = renameLines.filter((r) => r.newPath === destPath).map((r) => r.oldPath);
  const uniqueSharing = [...new Set(sharing)].sort();
  if (uniqueSharing.length > 1) {
    return { kind: 'ambiguous', candidates: uniqueSharing };
  }
  return { kind: 'single', newPath: destPath };
}

export type DiffHunk = {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
};

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses unified-diff hunk headers (`@@ -oldStart[,oldLines]
 * +newStart[,newLines] @@`) from `git diff -U0 <rev> <headRev> -- <relPath>`
 * for the cheap line-shift relocation stage. When a count is omitted, git's
 * own convention is that it means `1` (a single-line hunk) — handled
 * explicitly here rather than left to parse as `NaN`.
 */
export function parseDiffHunks(
  repoRoot: string,
  rev: string,
  headRev: string,
  relPath: string,
): readonly DiffHunk[] {
  let out: string;
  try {
    out = execFileSync('git', ['diff', '-U0', rev, headRev, '--', relPath], {
      cwd: repoRoot,
    windowsHide: true,
      encoding: 'utf8',
    });
  } catch {
    return [];
  }

  const hunks: DiffHunk[] = [];
  for (const line of out.split('\n')) {
    const match = HUNK_HEADER_RE.exec(line);
    if (!match) continue;
    const oldStart = Number(match[1]);
    const oldLines = match[2] !== undefined ? Number(match[2]) : 1;
    const newStart = Number(match[3]);
    const newLines = match[4] !== undefined ? Number(match[4]) : 1;
    hunks.push({ oldStart, oldLines, newStart, newLines });
  }
  return hunks;
}
