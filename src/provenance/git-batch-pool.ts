import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isGitAvailable, findRepoRoot, isWorkingTreeDirtyAtBatch } from './git-meta.ts';

// The long-lived `git cat-file --batch-command` wire client (ANCH-02/ANCH-03):
// one spawn per repository, requests written eagerly without waiting for
// prior responses, responses parsed strictly by DECLARED BYTE LENGTH (never
// by splitting on newlines — content can legitimately contain embedded
// newlines) and correlated to requests by strict FIFO position (never by
// echoed content — a successful lookup returns the *resolved* SHA, not the
// literal rev string that was sent). Both of these are empirically verified
// against this machine's git (2.53.0.windows.1); see `02-RESEARCH.md`
// Pattern 1/Pitfalls 1-2. Do not "simplify" the byte-counting logic below.
//
// This module trusts its caller to have already confined `revPath` to the
// repo root (T-02-07) — it performs no containment check itself.
//
// `--batch-command` (git >=2.36) is the primary path. On an older git this
// machine will never actually have (2.53 here), the pool falls back to
// plain `--batch` (contents) + a short-lived `--batch-check` invocation per
// `info()` call — a REAL, tested code path (forced via `mode: "batch"` in
// tests), not a described-but-unexercised branch. See `detectBatchMode`.

export type BatchResult =
  | { readonly found: true; readonly sha: string; readonly type: string; readonly size: number; readonly content: Buffer }
  | { readonly found: false };

/**
 * `"auto"` (default) probes this machine's git version on first use and
 * caches the result for the pool's lifetime. `"batch-command"` / `"batch"`
 * force a mode unconditionally, skipping the probe — used by tests to
 * exercise the legacy fallback protocol against this machine's real git
 * binary without needing an actual pre-2.36 install.
 */
export type BatchMode = 'auto' | 'batch-command' | 'batch';

export type GitBatchPoolOptions = {
  /** Overrides the default 60s idle-reap window. Test-only in practice. */
  readonly idleReapMs?: number;
  /** Forces a specific wire protocol, or probes for one ("auto", default). */
  readonly mode?: BatchMode;
  /**
   * Test-only injection point (never read as production API surface): when
   * `mode` is `"auto"`, short-circuits the version probe to always resolve
   * `"batch"`, simulating a pre-2.36 git environment without needing one.
   */
  readonly __testForceProbeFailure?: boolean;
};

type PendingRequest = {
  readonly kind: 'contents' | 'info';
  readonly resolve: (r: BatchResult) => void;
  readonly reject: (err: Error) => void;
};

const DEFAULT_IDLE_REAP_MS = 60_000;
const MIN_BATCH_COMMAND_VERSION = { major: 2, minor: 36 } as const;

/**
 * Pure classification of `git --version` output against the minimum version
 * that supports `--batch-command` (2.36, per `git-cat-file(1)`). Unparseable
 * input fails toward `"batch"` — the more conservative, more widely
 * supported mode — never toward assuming a newer feature is available.
 */
export function detectBatchMode(versionOutput: string): 'batch-command' | 'batch' {
  const match = /git version (\d+)\.(\d+)/.exec(versionOutput);
  if (!match) return 'batch';
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const supportsBatchCommand =
    major > MIN_BATCH_COMMAND_VERSION.major ||
    (major === MIN_BATCH_COMMAND_VERSION.major && minor >= MIN_BATCH_COMMAND_VERSION.minor);
  return supportsBatchCommand ? 'batch-command' : 'batch';
}

/**
 * Synchronous, one-shot `git --version` probe used only for `mode: "auto"`
 * (the default) with no forced result. Deliberately synchronous
 * (`execFileSync`, not spawn+await): mode resolution must never introduce
 * an async gap before the pool's first process spawn, since `contents()`
 * and `info()` (and this class's `pid` getter, added in Plan 03) are relied
 * on to reflect a synchronously-spawned process before the returned
 * promise's first microtask tick. The cost is paid at most once per pool
 * instance, on its very first request.
 */
function detectRuntimeMode(repoRoot: string, forceProbeFailure: boolean): 'batch-command' | 'batch' {
  if (forceProbeFailure) return 'batch';
  try {
    const out = execFileSync('git', ['--version'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
    return detectBatchMode(out);
  } catch {
    return 'batch';
  }
}

type ParsedBatchHeader =
  | { readonly missing: true }
  | { readonly missing: false; readonly sizeless: true; readonly sha: string; readonly type: string }
  | {
      readonly missing: false;
      readonly sizeless: false;
      readonly sha: string;
      readonly type: string;
      readonly size: number;
    };

/**
 * Parses one `<sha> <type> <size>` / `<object> missing` / `<sha> <type>`
 * (sizeless) header line. Shared, unmodified, by every response-framing
 * consumer in this file: the long-lived streaming parser (`#onData`, used
 * by both `--batch-command` and plain `--batch`'s contents responses) and
 * the one-off short-lived `--batch-check` invocation (`#infoViaBatchCheck`,
 * the legacy fallback's `info()` path). All three share this exact wire
 * framing per `git-cat-file(1)` — only spawn args and request-line format
 * differ per mode, never this parsing. `size` is the sole authority for how
 * many content bytes follow a `contents`-style response; never derive it by
 * splitting on newlines (Pitfall 1).
 *
 * A gitlink (submodule) path has no blob content, so its response has no
 * trailing size token at all — just `<sha> submodule` (empirically verified
 * on this machine's git 2.53 across `contents`, `info`, and the legacy
 * `--batch-check`; see 02-09's SUMMARY and this plan's regression tests). A
 * well-formed sized header always has exactly 3 space-separated tokens (sha,
 * type, size — neither a sha nor a type token can itself contain a space),
 * so fewer than 3 tokens is the general, not submodule-specific, signal for
 * "this object kind has no size field" — treated as sizeless-but-found
 * rather than routed into the fatal "unparseable" branch every OTHER
 * consumer below still guards against.
 */
function parseBatchHeader(header: string): ParsedBatchHeader {
  if (header.endsWith(' missing')) return { missing: true };
  const parts = header.split(' ');
  if (parts.length < 3) {
    const [sha, type] = parts;
    return { missing: false, sizeless: true, sha: sha ?? '', type: type ?? '' };
  }
  const sizeToken = parts[parts.length - 1] ?? '';
  const typeToken = parts[parts.length - 2] ?? '';
  const sha = parts.slice(0, parts.length - 2).join(' ');
  return { missing: false, sizeless: false, sha, type: typeToken, size: Number(sizeToken) };
}

export class GitBatchPool {
  #repoRoot: string;
  #idleReapMs: number;
  #mode: BatchMode;
  #testForceProbeFailure: boolean;
  #resolvedMode: 'batch-command' | 'batch' | null = null;
  #proc: ChildProcessWithoutNullStreams | null = null;
  #pending: PendingRequest[] = [];
  #buf: Buffer = Buffer.alloc(0);
  #idleTimer: NodeJS.Timeout | null = null;

  constructor(repoRoot: string, opts?: GitBatchPoolOptions) {
    this.#repoRoot = repoRoot;
    this.#idleReapMs = opts?.idleReapMs ?? DEFAULT_IDLE_REAP_MS;
    this.#mode = opts?.mode ?? 'auto';
    this.#testForceProbeFailure = opts?.__testForceProbeFailure ?? false;
  }

  /** The current subprocess pid, or null when no process is currently running. Introspection/test use. */
  get pid(): number | null {
    return this.#proc?.pid ?? null;
  }

  /**
   * The resolved wire-protocol mode once determined (null before the first
   * request). Introspection/test use, mirroring the `pid` getter added in
   * Plan 03 — proves auto-mode actually settled into the expected mode
   * rather than asserting it by comment.
   */
  get resolvedMode(): 'batch-command' | 'batch' | null {
    return this.#resolvedMode;
  }

  contents(revPath: string): Promise<BatchResult> {
    const mode = this.#resolveMode();
    const line = mode === 'batch-command' ? `contents ${revPath}\n` : `${revPath}\n`;
    return this.#enqueue('contents', line);
  }

  info(revPath: string): Promise<BatchResult> {
    const mode = this.#resolveMode();
    if (mode === 'batch') {
      // Plain `--batch` has no `info`-only verb; a second, short-lived
      // `git cat-file --batch-check` process per call is the fallback
      // strategy (info() is not this phase's hot path — contents() is —
      // so one extra spawn per call is an acceptable cost, per 02-RESEARCH
      // and this plan's own guidance). This keeps the hard "one long-lived
      // batch process per repository" constraint intact in both modes.
      return this.#infoViaBatchCheck(revPath);
    }
    return this.#enqueue('info', `info ${revPath}\n`);
  }

  /**
   * Explicit teardown: clears the idle timer, fails any still-pending
   * requests, and kills the underlying process if one is running. Callers
   * (tests, daemon shutdown) must invoke this rather than relying solely on
   * the idle reaper, so a long-lived `git cat-file` process never outlives
   * its owner.
   */
  close(): void {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    // `#onFatal` itself kills `#proc` before forgetting it — no separate
    // kill needed here.
    this.#onFatal(new Error('GitBatchPool closed'));
  }

  /**
   * Resolves (and caches) which wire protocol this pool uses, for its
   * entire lifetime. Explicit `mode` options ("batch-command"/"batch")
   * skip detection entirely; "auto" (default) probes `git --version` once.
   */
  #resolveMode(): 'batch-command' | 'batch' {
    if (this.#resolvedMode) return this.#resolvedMode;
    const mode: 'batch-command' | 'batch' =
      this.#mode === 'batch-command' || this.#mode === 'batch'
        ? this.#mode
        : detectRuntimeMode(this.#repoRoot, this.#testForceProbeFailure);
    this.#resolvedMode = mode;
    return mode;
  }

  #ensureProc(): ChildProcessWithoutNullStreams {
    if (this.#proc) return this.#proc;
    const mode = this.#resolveMode();
    const args = mode === 'batch-command' ? ['cat-file', '--batch-command'] : ['cat-file', '--batch'];
    const proc = spawn('git', args, {
      cwd: this.#repoRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (chunk: Buffer) => this.#onData(chunk));
    proc.stdin.on('error', (err: Error) => this.#onFatal(err));
    proc.on('error', (err: Error) => this.#onFatal(err));
    proc.on('exit', () => this.#onFatal(new Error(`git cat-file ${args[1]} exited`)));
    this.#proc = proc;
    return proc;
  }

  #enqueue(kind: 'contents' | 'info', line: string): Promise<BatchResult> {
    this.#resetIdleTimer();
    return new Promise((resolve, reject) => {
      this.#pending.push({ kind, resolve, reject });
      this.#ensureProc().stdin.write(line, 'utf8');
    });
  }

  /**
   * The plain-`--batch` fallback's `info()` path: a second, short-lived
   * `git cat-file --batch-check` process, spawned and torn down per call.
   * `--batch-check`'s response framing is `<sha> <type> <size>\n` (found,
   * no content bytes follow) or `<object> missing\n` — the SAME shape as
   * `--batch-command`'s `info` response and as `--batch`'s header line, so
   * the header-parsing logic is shared (not reimplemented) with `#onData`.
   */
  async #infoViaBatchCheck(revPath: string): Promise<BatchResult> {
    const proc = spawn('git', ['cat-file', '--batch-check'], {
      cwd: this.#repoRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    const done = new Promise<void>((resolve, reject) => {
      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      proc.stderr.on('data', () => {
        // Drained, not surfaced: --batch-check writes nothing to stderr for
        // ordinary lookups (including "missing"), so any output here would
        // only ever be a genuine spawn/runtime error already caught below.
      });
      proc.on('error', (err: Error) => reject(err));
      proc.on('close', (code: number | null) => {
        if (code === 0) resolve();
        else reject(new Error(`git cat-file --batch-check exited with code ${String(code)}`));
      });
    });
    proc.stdin.write(`${revPath}\n`, 'utf8');
    proc.stdin.end();
    await done;

    const buf = Buffer.concat(chunks);
    const nl = buf.indexOf(0x0a);
    const header = (nl === -1 ? buf : buf.subarray(0, nl)).toString('utf8');
    const parsed = parseBatchHeader(header);
    if (parsed.missing) return { found: false };
    if (parsed.sizeless) {
      return { found: true, sha: parsed.sha, type: parsed.type, size: 0, content: Buffer.alloc(0) };
    }
    if (!Number.isFinite(parsed.size)) {
      throw new Error(`unparseable cat-file --batch-check header: ${header}`);
    }
    return { found: true, sha: parsed.sha, type: parsed.type, size: parsed.size, content: Buffer.alloc(0) };
  }

  #onData(chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      const nl = this.#buf.indexOf(0x0a);
      if (nl === -1) return;
      const header = this.#buf.subarray(0, nl).toString('utf8');
      const pending = this.#pending[0];
      if (!pending) {
        this.#onFatal(new Error(`unexpected cat-file output, no pending request: ${header}`));
        return;
      }
      // Shared by every branch below that consumes just the header line
      // (nothing after it) — `missing` responses and `info` responses both
      // have no content bytes following the header LF.
      const consumeHeaderOnly = (): void => {
        this.#buf = this.#buf.subarray(nl + 1);
        this.#pending.shift();
      };
      const parsed = parseBatchHeader(header);
      if (parsed.missing) {
        consumeHeaderOnly();
        pending.resolve({ found: false });
        continue;
      }
      if (parsed.sizeless) {
        // A gitlink/submodule (or any other sizeless object kind) carries no
        // content bytes after its header line — same framing as `missing`
        // and as an `info` response — for BOTH `contents` and `info`
        // requests alike, so this is handled once here, ahead of the
        // kind-specific branch below.
        consumeHeaderOnly();
        pending.resolve({ found: true, sha: parsed.sha, type: parsed.type, size: 0, content: Buffer.alloc(0) });
        continue;
      }
      if (!Number.isFinite(parsed.size)) {
        this.#onFatal(new Error(`unparseable cat-file header: ${header}`));
        return;
      }
      if (pending.kind === 'info') {
        consumeHeaderOnly();
        pending.resolve({ found: true, sha: parsed.sha, type: parsed.type, size: parsed.size, content: Buffer.alloc(0) });
        continue;
      }
      const start = nl + 1;
      const end = start + parsed.size;
      if (this.#buf.length < end + 1) return; // wait for more data — declared size not fully buffered yet
      const content = Buffer.from(this.#buf.subarray(start, end));
      this.#buf = this.#buf.subarray(end + 1); // +1 discards the trailing separator LF
      this.#pending.shift();
      pending.resolve({ found: true, sha: parsed.sha, type: parsed.type, size: parsed.size, content });
    }
  }

  /**
   * The ONE place a fatal condition (parse failure, unexpected output,
   * process error/exit) is handled. Kills the underlying OS process before
   * forgetting it — NEVER merely null out `#proc` and let the subprocess
   * keep running. A prior version of this method did exactly that: on any
   * unparseable header (e.g. the `sizeless` shape above, before it had a
   * dedicated branch), the pending requests were rejected but the real
   * `git cat-file` process was simply abandoned, still alive, still holding
   * its cwd open, invisible to this pool's own bookkeeping — observed
   * empirically as a ~13-minute orphaned process during Plan 09's own test
   * run (see that plan's SUMMARY). `proc.kill()` on an already-exited
   * process (e.g. when this fires from the `exit` listener itself) is a
   * safe no-op, so this is called unconditionally, not just from the
   * parse-failure paths.
   */
  #onFatal(err: Error): void {
    const pending = this.#pending;
    this.#pending = [];
    const proc = this.#proc;
    this.#proc = null;
    this.#buf = Buffer.alloc(0);
    proc?.kill();
    for (const p of pending) p.reject(err);
  }

  #resetIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    const t = setTimeout(() => this.#reap(), this.#idleReapMs);
    t.unref?.();
    this.#idleTimer = t;
  }

  #reap(): void {
    if (this.#pending.length > 0) {
      this.#resetIdleTimer();
      return;
    }
    this.#proc?.kill();
    this.#proc = null;
  }
}

/**
 * ANCH-03 follow-up: `resolve.ts`'s OPTIONAL, per-repository, batch-scoped
 * cache -- closes the remaining gap Plan 11 diagnosed and deliberately left
 * open (`resolve()`'s own `isGitAvailable`/`findRepoRoot` calls, plus
 * `isWorkingTreeDirtyAt`'s per-anchor spawn). Colocated in this file, not
 * `resolve.ts` or `git-meta.ts`, because its lifetime is the SAME as
 * `GitBatchPool`'s -- one per repository, spanning one batch of anchor
 * resolutions -- even though, unlike `GitBatchPool`, it never itself spawns
 * or owns an OS process directly (env probes are cheap closures the
 * constructor is handed; the working-tree-hash side effect is a single
 * short-lived `execFileSync` call per flush, delegated to `git-meta.ts`'s
 * `isWorkingTreeDirtyAtBatch` -- git-meta.ts remains the only module that
 * actually spawns git plumbing). A caller (a test, eventually the Phase 6
 * router) constructs one `GitBatchContext` alongside one `GitBatchPool` per
 * repository and passes both together into every `resolve()` call for that
 * batch -- exactly mirroring `useRepoAndPool`'s existing `{ repo, pool }`
 * pairing convention in this phase's own tests.
 *
 * Purely ADDITIVE (the `(arg, opts?)` pattern this codebase already
 * establishes via `ensureDaemonRunning(artifactRoot, opts?)`): `resolve()`
 * takes this as a new, fully optional trailing parameter. Omitting it
 * entirely reproduces `resolve()`'s existing stateless-per-call behavior
 * byte-for-byte -- nothing about `GitBatchPool` or any existing call site
 * changes when no `GitBatchContext` is ever constructed.
 */
export type GitEnvDeps = {
  readonly isGitAvailable: () => boolean;
  readonly findRepoRoot: (startPath: string) => string | null;
};

/**
 * The shape of `git-meta.ts`'s `isWorkingTreeDirtyAtBatch`, injectable for
 * the same reason `GitEnvDeps` is: `git-batch-pool.test.ts` uses a counting
 * wrapper around the real function to prove, directly (not just inferred
 * from wall-clock timing the way `resolve.perf.test.ts`'s benchmark does),
 * that N concurrently-issued `isWorkingTreeDirtyAt` calls collapse into
 * exactly ONE underlying batch invocation covering all N entries.
 */
export type HashObjectBatchFn = (
  repoRoot: string,
  entries: readonly { readonly relPath: string; readonly blobSha: string }[],
) => readonly boolean[];

const REAL_ENV_DEPS: GitEnvDeps = { isGitAvailable, findRepoRoot };

type PendingDirtyCheck = {
  readonly repoRoot: string;
  readonly relPath: string;
  readonly blobSha: string;
  readonly resolve: (dirty: boolean) => void;
  readonly reject: (err: Error) => void;
};

export class GitBatchContext {
  #deps: GitEnvDeps;
  #hashObjectBatch: HashObjectBatchFn;
  #gitAvailable: boolean | undefined;
  #repoRoots = new Map<string, string | null>();
  #pendingDirtyChecks: PendingDirtyCheck[] = [];
  #flushHandle: NodeJS.Immediate | null = null;

  /**
   * `deps` defaults to the real `git-meta.ts` implementations, matching
   * `resolve.ts`'s own `REAL_DEPS` default -- overridable for tests exactly
   * the same way `resolve()`'s existing 4th `deps` parameter already is
   * (e.g. a fake `isGitAvailable: () => false`), so the "git binary
   * missing" scenario is testable through a `GitBatchContext` too, not just
   * through the stateless path. `hashObjectBatch` defaults to the real
   * `isWorkingTreeDirtyAtBatch` and exists purely as a test seam (see
   * `HashObjectBatchFn`'s doc comment) -- production callers never pass it.
   */
  constructor(deps: GitEnvDeps = REAL_ENV_DEPS, hashObjectBatch: HashObjectBatchFn = isWorkingTreeDirtyAtBatch) {
    this.#deps = deps;
    this.#hashObjectBatch = hashObjectBatch;
  }

  /** Computed at most once per context, regardless of how many `resolve()` calls share it -- "is git on PATH" cannot change mid-batch. */
  isGitAvailable(): boolean {
    if (this.#gitAvailable === undefined) this.#gitAvailable = this.#deps.isGitAvailable();
    return this.#gitAvailable;
  }

  /** Cached per distinct `startPath` -- every anchor resolved against the SAME repo passes the SAME `repoRoot` as `startPath`, so this is a one-entry cache in practice, not an unbounded one. */
  findRepoRoot(startPath: string): string | null {
    const cached = this.#repoRoots.get(startPath);
    if (cached !== undefined) return cached;
    const result = this.#deps.findRepoRoot(startPath);
    this.#repoRoots.set(startPath, result);
    return result;
  }

  /**
   * The batched replacement for `git-meta.ts`'s per-anchor
   * `isWorkingTreeDirtyAt`. Every call from a concurrently-resolving anchor
   * is collected into one pending queue; `setImmediate` (reset on EVERY new
   * arrival, classic debounce, not "schedule once") defers the actual flush
   * until a full event-loop turn has passed with no new arrivals -- so as
   * long as sibling anchors' calls keep arriving faster than one loop turn
   * apart (true in practice: they are all driven by the SAME pool's stdout
   * stream, which the diagnostic in `resolve.perf.test.ts` shows completes
   * 40 round trips in single-digit milliseconds), every anchor resolved
   * "together" via one `Promise.all` lands in ONE flush, i.e. one
   * `git hash-object --stdin-paths` call for the whole batch, not one per
   * anchor. A lone caller with no siblings still gets a correct answer,
   * just after one extra event-loop turn's worth of latency (a fraction of
   * a millisecond) instead of zero -- deliberately preferred over a
   * fixed-`setTimeout` guess, since it adapts to how fast responses are
   * actually arriving rather than assuming a magic number of milliseconds.
   *
   * A flush's own failure (e.g. `execFileSync` throwing for a reason
   * `isWorkingTreeDirtyAtBatch`'s own missing-path handling does not cover,
   * such as git itself vanishing mid-run) rejects every pending entry in
   * that flush, never resolves them `false` (clean) -- resolve.ts maps a
   * rejection here to `cannot-determine`, the same refusal a genuine dirty
   * result produces, per this plan's "refuse rather than guess" invariant.
   */
  isWorkingTreeDirtyAt(repoRoot: string, relPath: string, blobSha: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.#pendingDirtyChecks.push({ repoRoot, relPath, blobSha, resolve, reject });
      if (this.#flushHandle) clearImmediate(this.#flushHandle);
      this.#flushHandle = setImmediate(() => {
        this.#flush();
      });
    });
  }

  #flush(): void {
    this.#flushHandle = null;
    const batch = this.#pendingDirtyChecks;
    this.#pendingDirtyChecks = [];

    // Grouped by repoRoot defensively -- one GitBatchContext is expected to
    // serve exactly one repository in practice (paired 1:1 with one
    // GitBatchPool, per this class's own doc comment above), but nothing
    // stops a caller from sharing one context across repos, and doing so
    // must never mix one repo's paths into another's `--stdin-paths` call.
    const byRepo = new Map<string, PendingDirtyCheck[]>();
    for (const item of batch) {
      const existing = byRepo.get(item.repoRoot);
      if (existing) existing.push(item);
      else byRepo.set(item.repoRoot, [item]);
    }

    for (const [repoRoot, items] of byRepo) {
      try {
        const results = this.#hashObjectBatch(
          repoRoot,
          items.map((item) => ({ relPath: item.relPath, blobSha: item.blobSha })),
        );
        items.forEach((item, i) => {
          item.resolve(results[i]!);
        });
      } catch (err) {
        for (const item of items) item.reject(err as Error);
      }
    }
  }
}
