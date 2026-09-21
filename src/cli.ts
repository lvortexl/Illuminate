import { realpath, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname, join, basename } from 'node:path';
import { readLock } from './daemon/lock.ts';
import { checkOwnership } from './daemon/ownership.ts';
import { lockPathFor } from './daemon/state-dir.ts';
import { ensureDaemonRunning } from './daemon/orchestrate.ts';
import { COMMANDS, PLAYBOOKS } from './cli/registry.ts';
import {
  renderHelp,
  renderDesign,
  renderPlaybookIndex,
  renderPlaybook,
  renderPollResult,
  renderAuditResult,
  renderExportResult,
} from './cli/output.ts';
import { TIERS, VERDICTS } from './router/types.ts';
import type { PollResponse } from './router/types.ts';
import type { AuditSummary } from './router/ingest.ts';
import { exportArtifact } from './export/inline-html.ts';
import { materializeCards } from './export/materialize-cards.ts';
import { findBodyCloseOffset, detectBaseHref, detectAuthorCsp } from './html/detect.ts';
import { annotationStorePathFor, readAnnotationStore } from './store/annotation-store.ts';

// Build-time substituted by scripts/build.mjs's esbuild `define`. cli.ts is
// only ever executed via the built dist/cli.mjs (see test/smoke.test.ts and
// package.json's `bin` field) — never run directly from source — so unlike
// daemon-entry.ts this reference does not need a `typeof` guard.
declare const __ILLUMINATE_VERSION__: string;

async function main(argv: readonly string[]): Promise<number> {
  const [command] = argv;

  if (command === undefined || command === '--version' || command === '-v') {
    process.stdout.write(`illuminate-axi ${__ILLUMINATE_VERSION__}\n`);
    return 0;
  }

  if (command === 'stop') {
    return stop(argv.slice(1));
  }

  if (command === 'poll') {
    return pollCommand(argv.slice(1));
  }

  if (command === 'answer') {
    return answerCommand(argv.slice(1));
  }

  if (command === 'audit') {
    return auditCommand(argv.slice(1));
  }

  if (command === 'export') {
    return exportCommand(argv.slice(1));
  }

  if (command === '--help' || command === '-h') {
    process.stdout.write(renderHelp(COMMANDS));
    return 0;
  }

  if (command === 'design') {
    process.stdout.write(renderDesign());
    return 0;
  }

  if (command === 'playbook') {
    const id = argv[1];
    if (id === undefined) {
      process.stdout.write(renderPlaybookIndex(PLAYBOOKS));
      return 0;
    }
    const entry = PLAYBOOKS.find((p) => p.id === id);
    if (!entry) {
      process.stderr.write(`illuminate playbook: unknown id '${id}'\n`);
      process.stdout.write(renderPlaybookIndex(PLAYBOOKS));
      return 1;
    }
    process.stdout.write(renderPlaybook(entry));
    return 0;
  }

  if (!command.startsWith('-')) {
    return openArtifact(command, argv.slice(1));
  }

  process.stderr.write(`illuminate: unknown command '${command}'\n`);
  return 1;
}

interface ResolvedFileSession {
  readonly port: number;
  readonly key: string;
  readonly realFile: string;
}

type ResolveFileSessionResult = { readonly ok: true; readonly value: ResolvedFileSession } | { readonly ok: false; readonly error: string };

/**
 * Shared by `openArtifact`/`pollCommand`/`auditCommand`: validates a
 * `<file.html>` argument, resolves/spawns the daemon for its containing
 * directory, and registers (or re-attaches to) that file's session --
 * exactly `openArtifact`'s own original realpath/ensureDaemonRunning/
 * POST-/api/sessions sequence, extracted so poll/audit reuse it verbatim
 * rather than re-implementing daemon/session bootstrap a second and third
 * time. Never throws -- every failure mode returns a short, user-facing
 * `error` string (this file's own no-stack-trace convention), so every
 * caller can print it via `process.stderr.write` and exit 1.
 */
async function resolveFileSession(file: string): Promise<ResolveFileSessionResult> {
  if (!/\.html?$/i.test(file)) {
    return { ok: false, error: `illuminate: ${file} is not an .html file` };
  }

  let realFile: string;
  try {
    realFile = await realpath(resolve(file));
  } catch {
    return { ok: false, error: `illuminate: ${file} does not exist` };
  }

  const artifactRoot = dirname(realFile);
  const { port } = await ensureDaemonRunning(artifactRoot, { currentVersion: __ILLUMINATE_VERSION__ });
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: realFile }),
  });
  const { key } = (await res.json()) as { key: string };
  return { ok: true, value: { port, key, realFile } };
}

/**
 * `illuminate <file.html> [--no-open]` — the real front door (SERVE-01).
 * Starts or attaches to the daemon for the file's containing directory,
 * registers a session, and prints the session URL. `{currentVersion:
 * __ILLUMINATE_VERSION__}` is passed to `ensureDaemonRunning` here for the
 * first time in the project — Phase 1's version-restart dance (01-11) was
 * built and tested against a synthetic mismatch but had no real call site
 * until now.
 *
 * Named distinctly from the imported `open` package (lazy-imported below,
 * only when actually launching a browser) to avoid shadowing it.
 */
async function openArtifact(file: string, rest: readonly string[]): Promise<number> {
  const resolved = await resolveFileSession(file);
  if (!resolved.ok) {
    process.stderr.write(`${resolved.error}\n`);
    return 1;
  }
  const { port, key } = resolved.value;

  const url = `http://127.0.0.1:${port}/session/${key}`;
  process.stdout.write(`${url}\n`);

  if (!rest.includes('--no-open')) {
    const { default: open } = await import('open');
    void open(url).catch(() => {}); // best-effort per PITFALLS.md -- never fail the command over a launch failure
  }

  return 0;
}

/**
 * Turns whatever the user typed at `illuminate stop` into the SAME artifact
 * root `resolveFileSession` hands `ensureDaemonRunning`, so the two agree on
 * which daemon is being addressed.
 *
 * Two distinct normalizations, and both are needed:
 *
 *  - `realpath`, matching `resolveFileSession`'s own `realpath(resolve(file))`
 *    exactly. `canonicalPathKey` (state-dir.ts) cannot do this for us — it is
 *    deliberately pure, doing no filesystem I/O — so a symlinked or 8.3
 *    short-named path would still key a different daemon without this.
 *  - a FILE argument resolves to its containing directory. `--help` says
 *    `stop <dir>`, but the path a user has in their shell history is the one
 *    they started with (`illuminate .demo/a.html`), and silently printing
 *    "not running" at a live daemon because they passed a file is the exact
 *    failure this whole function exists to end.
 *
 * A path that is not on disk at all falls back to a pure resolve: a daemon
 * whose directory has since been deleted is still running and still stoppable,
 * and the `.html` test keeps the file-means-its-directory rule working there
 * too.
 */
async function resolveStopTarget(target: string): Promise<string> {
  const absolute = resolve(target);
  try {
    const real = await realpath(absolute);
    return (await stat(real)).isDirectory() ? real : dirname(real);
  } catch {
    return /\.html?$/i.test(absolute) ? dirname(absolute) : absolute;
  }
}

/**
 * `illuminate stop <dir|file.html> [--force]` — Phase 1 accepts the artifact
 * root as an explicit argument (the polished `illuminate <file.html>` UX that
 * infers this from a running session is Phase 3's concern).
 *
 * Default path: a token-checked POST /shutdown, falling back to SIGTERM if
 * it doesn't respond in time (wedged event loop). `--force` skips straight
 * to SIGTERM, matching RESEARCH.md §4's documented escalation path. Never
 * SIGKILL by default — that would skip the lockfile cleanup handler.
 */
async function stop(args: readonly string[]): Promise<number> {
  const force = args.includes('--force');
  const target = args.find((arg) => arg !== '--force');

  if (!target) {
    process.stderr.write('illuminate stop: missing artifact directory argument\n');
    return 1;
  }

  const root = await resolveStopTarget(target);
  const lockPath = lockPathFor(root);
  const record = await readLock(lockPath);
  if (!record) {
    process.stdout.write('not running\n');
    return 0;
  }

  const ownership = await checkOwnership(record);
  if (ownership.status !== 'ours-and-healthy') {
    // A stale or foreign lock is not a running daemon to stop.
    process.stdout.write('not running\n');
    return 0;
  }

  if (force) {
    process.kill(record.pid, 'SIGTERM');
    process.stdout.write('stopped\n');
    return 0;
  }

  try {
    const res = await fetch(`http://127.0.0.1:${record.port}/shutdown?token=${record.healthToken}`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`shutdown request failed with status ${res.status}`);
  } catch {
    process.kill(record.pid, 'SIGTERM');
  }
  process.stdout.write('stopped\n');
  return 0;
}

/** Extracts a `--name value` pair's value, or `undefined` if `--name` was
 * never given. This file's own minimal, dependency-free argument handling
 * (no argument-parsing library exists in this project) -- extends `stop`'s
 * existing `--force`/positional style to `--flag value` pairs. */
function extractFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

/** Whether a bare boolean `--name` flag (no value) was given. */
function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(`--${name}`);
}

/** Every argument that is neither a `--name` value-flag nor that flag's own
 * value -- `valueFlagNames` lists which `--name`s consume the NEXT
 * argument as their value (so it is skipped, not treated as positional). */
function positionalArgs(args: readonly string[], valueFlagNames: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith('--')) {
      if (valueFlagNames.includes(arg.slice(2))) i++;
      continue;
    }
    result.push(arg);
  }
  return result;
}

/** Buffers stdin fully (until EOF) and decodes it as UTF-8 -- the client-side
 * mirror of `server.ts`'s own `readJsonBody` stream-consumption pattern,
 * used here to read `illuminate answer --stdin`'s full markdown body. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `illuminate poll <file.html> [--timeout-ms N]` -- POLL-01's agent-facing
 * surface. Resolves the daemon/session exactly like `illuminate
 * <file.html>` (via `resolveFileSession`), prints an immediate stderr
 * banner (STACK.md's "not-hung signal" guidance -- once, not per-tick, so
 * an agent harness capturing stderr sees no chatter), then issues ONE
 * `GET /api/:key/poll` with no `timeoutMs` unless `--timeout-ms` was
 * given explicitly -- the CLI's own default is NO timeout, matching
 * POLL-01's "stays silent until..." contract; `--timeout-ms` exists purely
 * as a test/debug escape hatch. stdout carries ONLY `renderPollResult`'s
 * compact rendering -- never the raw JSON, never a diagnostic.
 *
 * A `SIGINT` (Ctrl-C) aborts the in-flight request via `AbortController`
 * and this function returns 130, matching `lock.ts`'s own documented
 * SIGINT/SIGTERM exit-code convention (130/143) rather than inventing a
 * new one.
 */
async function pollCommand(args: readonly string[]): Promise<number> {
  const [file] = positionalArgs(args, ['timeout-ms']);
  if (file === undefined) {
    process.stderr.write('illuminate poll: missing <file.html> argument\n');
    return 1;
  }
  const follow = args.includes('--follow');

  const resolved = await resolveFileSession(file);
  if (!resolved.ok) {
    process.stderr.write(`${resolved.error}\n`);
    return 1;
  }
  const { port, key, realFile } = resolved.value;

  const timeoutMsRaw = extractFlag(args, 'timeout-ms');
  const timeoutMs = timeoutMsRaw !== undefined ? Number(timeoutMsRaw) : undefined;

  process.stderr.write(`illuminate: listening for feedback on ${realFile}... (Ctrl-C to stop)\n`);

  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  try {
    const url = new URL(`http://127.0.0.1:${port}/api/${key}/poll`);
    if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) {
      url.searchParams.set('timeoutMs', String(timeoutMs));
    }

    // --follow (ADR-104): stay attached. A one-shot poll means a harness has
    // to re-invoke the CLI in a loop and re-resolve the daemon every time,
    // and anything queued between two invocations waits for the next one.
    // Looping here keeps ONE long poll outstanding at all times.
    //
    // stdout is NDJSON -- one whole envelope per line, never the compact
    // human rendering -- because the reader is a harness parsing a pipe, and
    // one-JSON-per-line needs no client library. Each envelope already
    // carries the role, model_tier and tools the agent for it should run
    // with; they are the router policy table's resolved values, surfaced
    // here, never re-derived.
    if (follow) {
      for (;;) {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          process.stderr.write(`illuminate poll: ${body.error ?? `request failed with status ${res.status}`}\n`);
          return 1;
        }
        const pollResponse = (await res.json()) as PollResponse;
        for (const envelope of pollResponse.dispatches) {
          // One line, one envelope, flushed as it arrives -- a harness
          // blocked on readline must not wait for a batch to fill.
          process.stdout.write(`${JSON.stringify(envelope)}\n`);
        }
        // A timeout is not an end condition here: it is the idle case, and
        // staying attached through it is the entire point of --follow.
      }
    }

    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      process.stderr.write(`illuminate poll: ${body.error ?? `request failed with status ${res.status}`}\n`);
      return 1;
    }
    const pollResponse = (await res.json()) as PollResponse;
    process.stdout.write(renderPollResult(pollResponse, port));
    return 0;
  } catch (err) {
    if (controller.signal.aborted) {
      return 130;
    }
    process.stderr.write(`illuminate poll: request failed -- ${(err as Error).message}\n`);
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

/**
 * `illuminate answer --dispatch <id> --port <port> --model <name> --tier
 * <haiku|sonnet|opus> [--input-tokens N] [--output-tokens N]
 * [--cache-read-input-tokens N] [--cost-usd X] [--wall-ms N]
 * [--verdict <supported|contradicted|not-determinable>]
 * [--deciding-lines <text>] --stdin` -- ROUT-04's closing half. Needs ONLY
 * `--dispatch`/`--port` to address the daemon and the dispatch -- no
 * session key anywhere, matching `POST /api/dispatches/:id/answer`'s own
 * key-free design and keeping the envelope's own `return_to` command
 * genuinely self-sufficient.
 *
 * `--wall-ms` is an addition beyond this plan's own listed flag list: every
 * `AnswerSubmission` carries a required `wallMs: number` field (06-01's
 * wire contract), and without a way to set it, every real submission would
 * silently report 0ms of wall time in `formatReceipt`'s printed receipt --
 * a correctness gap in this command's own metadata, not a missing
 * feature (Rule 2). Omitting it defaults to 0, reproducing the plan's
 * documented flag set exactly for anyone who never passes it.
 *
 * `--verdict`/`--deciding-lines` (EDU-07's closing half, Plan 07-08): both
 * OPTIONAL -- unlike `--tier`, which is required -- so every existing,
 * non-verify `illuminate answer` invocation is completely unaffected.
 * `--verdict` is validated against the closed `VERDICTS` union BEFORE any
 * request is sent, exactly mirroring `--tier`'s own validation-before-send
 * pattern above (T-07-19). Omitting `--verdict` sends `verdict: null`;
 * omitting `--deciding-lines` sends `decidingLines: null`.
 *
 * On success (200): prints the response body -- `formatReceipt`'s
 * fixed-shape receipt line, verbatim -- and nothing else, exit 0. On
 * 403/404/409: prints ONLY the server's own short `error` field to
 * stderr, never a stack trace or the submitted markdown, exit 1.
 */
async function answerCommand(args: readonly string[]): Promise<number> {
  const dispatchId = extractFlag(args, 'dispatch');
  const portRaw = extractFlag(args, 'port');
  const model = extractFlag(args, 'model');
  const tier = extractFlag(args, 'tier');

  if (dispatchId === undefined || portRaw === undefined || model === undefined || tier === undefined) {
    process.stderr.write(
      'illuminate answer: usage: illuminate answer --dispatch <id> --port <port> --model <name> --tier <haiku|sonnet|opus> ' +
        '[--verdict <supported|contradicted|not-determinable>] [--deciding-lines <text>] --stdin\n',
    );
    return 1;
  }
  if (!hasFlag(args, 'stdin')) {
    process.stderr.write('illuminate answer: missing --stdin -- the answer markdown must be piped via stdin\n');
    return 1;
  }
  if (!(TIERS as readonly string[]).includes(tier)) {
    process.stderr.write(`illuminate answer: --tier must be one of ${TIERS.join(', ')}\n`);
    return 1;
  }
  const verdictRaw = extractFlag(args, 'verdict');
  if (verdictRaw !== undefined && !(VERDICTS as readonly string[]).includes(verdictRaw)) {
    process.stderr.write(`illuminate answer: --verdict must be one of ${VERDICTS.join(', ')}\n`);
    return 1;
  }
  const port = Number(portRaw);
  if (!Number.isFinite(port)) {
    process.stderr.write('illuminate answer: --port must be a number\n');
    return 1;
  }

  const numberFlag = (name: string): number => {
    const raw = extractFlag(args, name);
    const value = raw !== undefined ? Number(raw) : 0;
    return Number.isFinite(value) ? value : 0;
  };

  const decidingLines = extractFlag(args, 'deciding-lines') ?? null;
  const markdown = await readStdin();

  const submission = {
    markdown,
    model,
    tier,
    tokensIn: numberFlag('input-tokens'),
    tokensOut: numberFlag('output-tokens'),
    cacheReadInputTokens: numberFlag('cache-read-input-tokens'),
    costUsd: numberFlag('cost-usd'),
    wallMs: numberFlag('wall-ms'),
    verdict: verdictRaw ?? null,
    decidingLines,
  };

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${String(port)}/api/dispatches/${dispatchId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(submission),
    });
  } catch (err) {
    process.stderr.write(`illuminate answer: request failed -- ${(err as Error).message}\n`);
    return 1;
  }

  if (res.ok) {
    const receipt = await res.text();
    process.stdout.write(`${receipt}\n`);
    return 0;
  }

  const body = (await res.json().catch(() => ({}))) as { error?: string };
  process.stderr.write(`illuminate answer: ${body.error ?? `request failed with status ${res.status}`}\n`);
  return 1;
}

/**
 * `illuminate audit <file.html>` -- resolves the daemon/session like `poll`
 * does, `GET`s `/api/:key/dispatches` (session-keyed, unlike `answer` --
 * audit is invoked against a known file/session), and renders
 * `summarizeForAudit`'s totals plus a per-deviation and per-refusal line
 * each via `renderAuditResult`. Never prints an answer body -- the audit
 * route itself excludes any answer-prose field (router/ingest.ts).
 */
async function auditCommand(args: readonly string[]): Promise<number> {
  const [file] = positionalArgs(args, []);
  if (file === undefined) {
    process.stderr.write('illuminate audit: missing <file.html> argument\n');
    return 1;
  }

  const resolved = await resolveFileSession(file);
  if (!resolved.ok) {
    process.stderr.write(`${resolved.error}\n`);
    return 1;
  }
  const { port, key } = resolved.value;

  const res = await fetch(`http://127.0.0.1:${port}/api/${key}/dispatches`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    process.stderr.write(`illuminate audit: ${body.error ?? `request failed with status ${res.status}`}\n`);
    return 1;
  }
  const summary = (await res.json()) as AuditSummary;
  process.stdout.write(renderAuditResult(summary));
  return 0;
}

/** `<stem>.export.html` -- mirrors the reference's own `exportFileName`
 * naming convention exactly. A two-line pure function, not worth importing
 * across module boundaries for (09-04's own note). */
function exportFileName(file: string): string {
  const stem = basename(file).replace(/\.html?$/i, '') || 'artifact';
  return `${stem}.export.html`;
}

/**
 * `illuminate export <file.html> [--out <path>]` -- EXP-01's CLI/structural
 * half (09-04). Unlike every other command in this file, this is a pure,
 * synchronous-shaped filesystem transform: no daemon, no session. Reads the
 * artifact's raw bytes and its `.illum.json` sidecar (a missing sidecar
 * resolves to an empty store via `readAnnotationStore`'s own ENOENT
 * convention, never an error), inlines local assets via `exportArtifact`
 * (09-03), then -- ONLY against the TRANSFORMED html, never the original
 * bytes, since inlining changes every downstream byte position -- splices
 * `materializeCards`' appendix (09-02) at `findBodyCloseOffset`, and writes
 * the result to a sibling `<stem>.export.html` file (or `--out <path>`).
 *
 * Deliberately does NOT call `resolveFileSession`: that helper additionally
 * spawns/attaches a daemon and registers a session, neither of which this
 * pure filesystem transform needs or should trigger. The extension and
 * existence checks below intentionally duplicate a few lines of
 * `resolveFileSession`'s own two checks rather than risk touching that
 * function's behavior for its other three callers (poll/answer/audit/open).
 */
async function exportCommand(args: readonly string[]): Promise<number> {
  const [file] = positionalArgs(args, ['out']);
  if (file === undefined) {
    process.stderr.write('illuminate export: missing <file.html> argument\n');
    return 1;
  }
  if (!/\.html?$/i.test(file)) {
    process.stderr.write(`illuminate export: ${file} is not an .html file\n`);
    return 1;
  }

  let realFile: string;
  try {
    realFile = await realpath(resolve(file));
  } catch {
    process.stderr.write(`illuminate export: ${file} does not exist\n`);
    return 1;
  }

  const root = dirname(realFile);
  const raw = await readFile(realFile, 'utf8');
  const store = await readAnnotationStore(annotationStorePathFor(realFile));
  const { html: transformed, warnings } = await exportArtifact(raw, { baseDir: root, confineDir: root });

  const appendix = materializeCards(store);
  let final = transformed;
  if (appendix.length > 0) {
    const offset = findBodyCloseOffset(transformed);
    final = transformed.slice(0, offset) + appendix + transformed.slice(offset);
  }

  const outputPath = extractFlag(args, 'out') ?? join(root, exportFileName(realFile));
  // `--out` may name a not-yet-existing directory (e.g. `--out dist/x.html`);
  // the sibling-file convention's own directory (`root`) always already
  // exists, so this is a no-op there, but a real correctness gap for `--out`
  // without it (Rule 2: writeFile alone throws an uncaught ENOENT).
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, final, 'utf8');

  process.stdout.write(
    renderExportResult({
      outputPath,
      byteLength: Buffer.byteLength(final, 'utf8'),
      warnings,
      baseHref: detectBaseHref(transformed),
      authorCsp: detectAuthorCsp(transformed),
    }),
  );
  return 0;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
