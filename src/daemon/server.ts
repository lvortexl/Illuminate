import { URL, fileURLToPath } from 'node:url';
import { resolve, relative, sep, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { LockRecord } from './lock.ts';
import { cleanupLock } from './lock.ts';
import { lockPathFor } from './state-dir.ts';
import { IdleController } from './idle.ts';
import { isAllowedHost, isSameOriginRequest, resolveAssetPath } from '../serve/containment.ts';
import { serveAsset } from '../serve/asset.ts';
import { SessionStore, sessionKey, upsertSession } from '../store/session-store.ts';
import { openChromeSession, beginArtifactLoad } from './load-token.ts';
import { readArtifactWithFreshnessGuard } from './artifact-load.ts';
import { injectScriptTag } from '../html/inject.ts';
import { createPollEvents, resolvePoll } from './poll.ts';
import type { PollConnection } from './poll.ts';
import { enqueueDispatch, recordHeartbeat, endSession } from './dispatch-ledger.ts';
import { buildDispatchEnvelope } from '../router/envelope.ts';
import { ingestAnswer, summarizeForAudit } from '../router/ingest.ts';
import { isUngroundable } from '../router/verify.ts';
import { CHROME_CSS } from '../chrome/chrome-css.ts';
import { storeAttachment } from '../store/attachment-store.ts';
import { TIERS, VERDICTS } from '../router/types.ts';
import type { AnswerSubmission, DispatchLedgerEntry, PollResponse, Tier, Verdict } from '../router/types.ts';
import { createActivePolls, createClaudeOnPathProbe } from './active-polls.ts';
import { maybeSelfDispatch } from './self-dispatch.ts';
import type { SelfDispatchSpawnFn } from './self-dispatch.ts';
import { isIntent, buildTypedIntentPayload } from '../shared/intent.ts';
import type { TypedIntentPayload, IntentElement, IntentAnchor, IntentAttachment, IntentTarget } from '../shared/intent.ts';
import { appendCardEntry, snapshotFromDispatchElement } from '../store/annotation-store.ts';
import type { CardThreadEntry } from '../store/annotation-store.ts';
import { FindingsStoreFile, dismissFinding } from '../store/findings-store.ts';
import { appendFileSync } from 'node:fs';

/**
 * The self-dispatch gate, with a reason when it declines.
 *
 * A declined gate used to be completely silent, which is how a user ends up
 * staring at a card stuck on "thinking…" with nothing to read anywhere: the
 * adapter never ran, so it never logged; `illuminate audit` shows nothing,
 * because an unanswered dispatch has no cost to report. Setting
 * `ILLUMINATE_LOG_FILE` now explains which condition stopped it.
 *
 * Both conditions are legitimate, not errors -- an open `illuminate poll`
 * deliberately takes priority, and no `claude` on PATH means there is nothing
 * to shell out to. They just need to be visible.
 */
async function shouldSelfDispatch(
  key: string,
  activePolls: { isActive(key: string): boolean },
  isClaudeOnPath: () => Promise<boolean>,
  dispatchId: string,
): Promise<boolean> {
  if (activePolls.isActive(key)) {
    logDispatchSkipped(dispatchId, 'a harness poll is open for this session, which takes priority');
    return false;
  }
  if (!(await isClaudeOnPath())) {
    logDispatchSkipped(dispatchId, 'no `claude` binary found on PATH');
    return false;
  }
  return true;
}

function logDispatchSkipped(dispatchId: string, reason: string): void {
  const logFile = process.env.ILLUMINATE_LOG_FILE;
  if (!logFile) return;
  try {
    appendFileSync(
      logFile,
      `[${new Date().toISOString()}] illuminate self-dispatch: dispatch ${dispatchId} NOT attempted -- ${reason}
`,
      'utf8',
    );
  } catch {
    // Diagnostics must never break the thing they observe.
  }
}

import { createStalenessRegistry } from './staleness-registry.ts';
import { createAnnotationStoreRegistry } from './annotation-store-registry.ts';

/**
 * Sandbox token string, EXACT (03-03-PLAN.md's <interfaces> block; mirrored
 * verbatim in the Phase 3/4 join contract). Used identically as the chrome
 * shell iframe's `sandbox` attribute AND the `Content-Security-Policy:
 * sandbox <tokens>` header on every response under /artifact/:key/* --
 * deliberately WITHOUT `allow-same-origin`, which is what puts the artifact
 * on an opaque origin (T-03-07).
 */
const SANDBOX_TOKENS = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads';

/**
 * Resolves a built `dist/` file relative to THIS module's own location --
 * mirrors orchestrate.ts's `resolveDaemonEntryPath` dual-mode discipline
 * rather than reimplementing it: esbuild preserves `import.meta.url` as the
 * bundled output's own location, so when this file is inlined into
 * `dist/daemon-entry.mjs` (bundled), `import.meta.url` already points
 * inside `dist/` and the sibling file is right there. Run directly from
 * source -- as this module is under `node --test`'s integration tests,
 * unbundled -- `import.meta.url` is this file's own `src/daemon/server.ts`
 * location, two directories below the project root, so the same file is
 * reached via `../../dist/<name>` instead.
 */
function resolveDistFile(fileName: string): string {
  const here = import.meta.url;
  const built = here.endsWith('.mjs') || here.endsWith('.js');
  const relPath = built ? `./${fileName}` : `../../dist/${fileName}`;
  return fileURLToPath(new URL(relPath, here));
}

/**
 * POLL-03's whitespace-heartbeat cadence for a no-timeout poll -- frequent
 * enough to defeat typical proxy/idle-socket timeouts, negligible bandwidth
 * for a connection that may stay open for minutes. `res.setTimeout(0)`
 * (set on the poll route itself) is what actually disables Node's own
 * default socket timeout; this cadence exists purely to keep intermediate
 * infrastructure (and a human watching the connection) confident it's
 * alive, per STACK.md's long-poll guidance.
 */
const POLL_HEARTBEAT_MS = 15_000;

/**
 * POLL-04's reconnect grace window -- ARCHITECTURE.md's own reference
 * value (`BROWSER_DISCONNECT_GRACE_MS = 10_000`): long enough that an
 * ordinary page reload doesn't get treated as a real disconnect, short
 * enough that a genuinely gone browser is reported promptly.
 */
const BROWSER_DISCONNECT_GRACE_MS = 10_000;

/** Validates a raw JSON `element` field into `IntentElement`'s exact shape.
 * Throws (never returns a partial/undefined shape) so every caller can use
 * one try/catch to turn "malformed body" into a 400, matching this file's
 * existing `handleCreateSession`/`handleBeginArtifactLoad` convention. */
function parseIntentElement(value: unknown): IntentElement {
  if (typeof value !== 'object' || value === null) throw new Error('element is required');
  const e = value as Record<string, unknown>;
  if (
    typeof e.uid !== 'string' ||
    typeof e.selector !== 'string' ||
    typeof e.tag !== 'string' ||
    typeof e.text !== 'string'
  ) {
    throw new Error('element must have string uid/selector/tag/text');
  }
  if (e.prefixContext !== undefined && e.prefixContext !== null && typeof e.prefixContext !== 'string') {
    throw new Error('element.prefixContext must be a string or null');
  }
  if (e.suffixContext !== undefined && e.suffixContext !== null && typeof e.suffixContext !== 'string') {
    throw new Error('element.suffixContext must be a string or null');
  }
  return {
    uid: e.uid,
    selector: e.selector,
    tag: e.tag,
    text: e.text,
    prefixContext: (e.prefixContext as string | null | undefined) ?? null,
    suffixContext: (e.suffixContext as string | null | undefined) ?? null,
  };
}

/** `null` is a legitimate, common case (ANCH-08 unanchored element) -- only
 * a present-but-malformed anchor object throws. */
function parseIntentAnchor(value: unknown): IntentAnchor | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') throw new Error('anchor must be an object or null');
  const a = value as Record<string, unknown>;
  if (typeof a.src !== 'string') throw new Error('anchor.src must be a string');
  if (a.rev !== null && typeof a.rev !== 'string') throw new Error('anchor.rev must be a string or null');
  if (a.anchorHash !== null && typeof a.anchorHash !== 'string') {
    throw new Error('anchor.anchorHash must be a string or null');
  }
  return {
    src: a.src,
    rev: (a.rev as string | null | undefined) ?? null,
    anchorHash: (a.anchorHash as string | null | undefined) ?? null,
  };
}

/**
 * Validates a raw JSON POST body into a real `TypedIntentPayload` --
 * reuses `buildTypedIntentPayload` (shared/intent.ts) verbatim for the
 * final construction (protocol tag, depth, parent_dispatch) rather than
 * re-assembling the shape ad hoc a second time, mirroring
 * `handleCreateSession`'s own "reuse, don't reimplement" discipline.
 *
 * `depth`/`parent_dispatch`/`learnerNote`, WHEN PRESENT on the wire body,
 * are now read and passed through -- found entirely unread (07-06's own
 * real-browser proof: a real "go deeper" click's POST body genuinely
 * carried `depth: 2, parent_dispatch: <id>`, yet the persisted card thread
 * entry always showed `depth: 1, parentDispatchId: null`). This function
 * previously called `buildTypedIntentPayload({intent, element, anchor})`
 * ONLY -- omitting all three fields unconditionally, which silently fell
 * through to that function's own Phase-4-era `depth ?? 1` / `parent_dispatch
 * ?? null` / `learnerNote ?? null` defaults on EVERY request, discarding
 * EDU-05's entire chaining mechanism server-side regardless of what any
 * client -- this plan's `deeperCardAction` included -- ever actually sent.
 * Each field stays OPTIONAL here (mirroring `parseIntentElement`'s own
 * `prefixContext`/`suffixContext` leniency just above): at least one
 * existing caller (test/daemon/self-dispatch-disable-env.test.ts's
 * `enqueueDispatch`) posts a hand-rolled body that omits all three, and
 * that caller's own `explain`, `depth: 1`, `parent_dispatch: null` intent
 * is still exactly correct once defaulted -- only a genuinely PRESENT,
 * wrongly-typed value is now rejected.
 */
function parseTypedIntentPayload(body: unknown): TypedIntentPayload {
  if (typeof body !== 'object' || body === null) throw new Error('body must be an object');
  const b = body as Record<string, unknown>;
  if (typeof b.intent !== 'string' || !isIntent(b.intent)) throw new Error('intent must be a valid Intent');
  // ADR-102: the wire carries a LIST of selected sections. The protocol
  // version moved with the shape rather than accepting both forms -- a
  // parser that silently normalizes a legacy single element is exactly the
  // "two ways to say the same thing" this change exists to remove.
  if (!Array.isArray(b.targets)) throw new Error('targets must be an array');
  if (b.targets.length === 0) throw new Error('targets must not be empty');
  const targets: IntentTarget[] = b.targets.map((raw) => {
    if (typeof raw !== 'object' || raw === null) throw new Error('each target must be an object');
    const t = raw as Record<string, unknown>;
    return { element: parseIntentElement(t.element), anchor: parseIntentAnchor(t.anchor) };
  });
  if (b.depth !== undefined && typeof b.depth !== 'number') throw new Error('depth must be a number');
  if (b.parent_dispatch !== undefined && b.parent_dispatch !== null && typeof b.parent_dispatch !== 'string') {
    throw new Error('parent_dispatch must be a string or null');
  }
  if (b.learnerNote !== undefined && b.learnerNote !== null && typeof b.learnerNote !== 'string') {
    throw new Error('learnerNote must be a string or null');
  }
  // Same optional-but-typed discipline as the three fields above. `note` is
  // the chrome rail composer's free text; it is NOT `learnerNote` (which
  // switches the envelope's return contract to grading) -- see
  // TypedIntentPayload.note.
  if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') {
    throw new Error('note must be a string or null');
  }
  const attachments: IntentAttachment[] = [];
  if (b.attachments !== undefined) {
    if (!Array.isArray(b.attachments)) throw new Error('attachments must be an array');
    for (const raw of b.attachments) {
      if (typeof raw !== 'object' || raw === null) throw new Error('each attachment must be an object');
      const a = raw as Record<string, unknown>;
      if (typeof a.id !== 'string' || typeof a.mediaType !== 'string') {
        throw new Error('each attachment needs a string id and mediaType');
      }
      attachments.push({ id: a.id, mediaType: a.mediaType });
    }
  }
  return buildTypedIntentPayload({
    intent: b.intent,
    targets,
    depth: b.depth as number | undefined,
    parent_dispatch: b.parent_dispatch as string | null | undefined,
    learnerNote: b.learnerNote as string | null | undefined,
    note: b.note as string | null | undefined,
    attachments,
  });
}

/**
 * Validates a raw JSON POST body into an `AnswerSubmission`. `dispatchId`
 * is NEVER read from the body -- it comes exclusively from the URL
 * (`POST /api/dispatches/:id/answer`), so a client cannot mismatch the
 * addressed dispatch from the submitted one.
 */
function parseAnswerSubmission(body: unknown, dispatchId: string): AnswerSubmission {
  if (typeof body !== 'object' || body === null) throw new Error('body must be an object');
  const b = body as Record<string, unknown>;
  if (typeof b.markdown !== 'string') throw new Error('markdown must be a string');
  if (typeof b.model !== 'string') throw new Error('model must be a string');
  if (typeof b.tier !== 'string' || !(TIERS as readonly string[]).includes(b.tier)) {
    throw new Error('tier must be a valid Tier');
  }
  if (typeof b.tokensIn !== 'number') throw new Error('tokensIn must be a number');
  if (typeof b.tokensOut !== 'number') throw new Error('tokensOut must be a number');
  if (typeof b.cacheReadInputTokens !== 'number') throw new Error('cacheReadInputTokens must be a number');
  if (typeof b.costUsd !== 'number') throw new Error('costUsd must be a number');
  if (typeof b.wallMs !== 'number') throw new Error('wallMs must be a number');
  // `verdict`/`decidingLines` are optional on the wire (no caller sends them
  // yet -- self-dispatch.ts always posts `null`, and `illuminate answer`
  // (cli.ts) does not yet expose flags for either) -- absent defaults to
  // `null`, mirroring `parseIntentAnchor`'s own `rev`/`anchorHash` ?? null
  // convention above. Verdict-enum ENFORCEMENT tied to real verify-answer
  // wiring is Plan 07-04's concern, not this plan's; this is only the
  // structural passthrough this plan's wire-shape widening requires.
  if (b.verdict !== undefined && b.verdict !== null && !(VERDICTS as readonly string[]).includes(b.verdict as string)) {
    throw new Error('verdict must be a valid Verdict or null');
  }
  if (b.decidingLines !== undefined && b.decidingLines !== null && typeof b.decidingLines !== 'string') {
    throw new Error('decidingLines must be a string or null');
  }
  return {
    dispatchId,
    markdown: b.markdown,
    model: b.model,
    tier: b.tier as Tier,
    tokensIn: b.tokensIn,
    tokensOut: b.tokensOut,
    cacheReadInputTokens: b.cacheReadInputTokens,
    costUsd: b.costUsd,
    wallMs: b.wallMs,
    verdict: (b.verdict as Verdict | null | undefined) ?? null,
    decidingLines: (b.decidingLines as string | null | undefined) ?? null,
  };
}

export interface DaemonServerOptions {
  /**
   * `null` disables idle self-stop entirely — daemon-entry.ts passes this
   * when `ILLUMINATE_IDLE_TIMEOUT_MS` is `'0'` or `'off'`. No `IdleController`
   * is constructed and `enter()`/`exit()` are never called in that case.
   */
  idleMs: number | null;
  /**
   * Overrides `POLL_HEARTBEAT_MS` for the no-timeout poll route. Additive
   * and optional, mirroring `idleMs`'s own injection shape -- omitting it
   * uses the real production cadence. Exists so POLL-03's real-socket
   * whitespace-heartbeat proof (test/daemon/dispatch-routes.test.ts) does
   * not have to wait out a real 15s production interval to observe one.
   */
  pollHeartbeatMs?: number;
  /**
   * Overrides `BROWSER_DISCONNECT_GRACE_MS` for the poll route. Additive
   * and optional, same rationale as `pollHeartbeatMs` -- exists so
   * POLL-04's real-socket `browser_disconnected` proof does not have to
   * wait out the real 10s production grace window to observe it.
   */
  disconnectGraceMs?: number;
  /**
   * 06-11's standalone self-dispatch adapter -- three additive, optional
   * test-injection points, mirroring `pollHeartbeatMs`/`disconnectGraceMs`'s
   * own convention. Omitting all three reproduces real production
   * behavior exactly: a real, once-per-process-cached `claude --version`
   * PATH probe, real `child_process.spawn`, and a real HTTP POST to this
   * same server's own `/api/dispatches/:id/answer` route -- never a
   * bespoke second ingest path.
   */
  selfDispatchSpawnFn?: SelfDispatchSpawnFn;
  /** Bypasses the real PATH probe entirely -- lets a test force "claude is
   * on PATH" true/false without spawning anything, real or fake. */
  isClaudeOnPathOverride?: () => Promise<boolean>;
  selfDispatchPostAnswer?: (submission: AnswerSubmission) => Promise<void>;
  /**
   * Phase 8's staleness-watch timing knobs -- additive, optional, mirroring
   * `pollHeartbeatMs`/`disconnectGraceMs`/`isClaudeOnPathOverride`'s own
   * injection shape exactly. Omitting all three reproduces real production
   * cadences (staleness-registry.ts's own defaults) exactly; daemon-entry.ts
   * threads `ILLUMINATE_STALENESS_DEBOUNCE_MS`/`ILLUMINATE_STALENESS_RECONCILE_MS`/
   * `ILLUMINATE_FORCE_WATCHER_UNHEALTHY` into these only when actually set,
   * so a real spawned daemon subprocess is fully timing-configurable for
   * Plan 08-05's Playwright suite without ever waiting out real production
   * cadences.
   */
  stalenessWatchDebounceMs?: number;
  stalenessReconcileIntervalMs?: number;
  forceWatcherUnhealthy?: boolean;
}

/**
 * Wires bind → lock → ownership's own record into the daemon's actual HTTP
 * route table. `server` must already be an `http.Server`, bound (see
 * daemon-entry.ts's sequencing note: the bound port has to exist before
 * `record` can be built, so this function attaches a `'request'` listener
 * to a server the caller already created/bound, rather than creating and
 * binding one itself). Returns the same `server` for convenience.
 *
 * Request handling order (do not reorder — RESEARCH.md §3.2 / this plan's
 * threat model T-01-19 depend on the Host check running before any route,
 * including /health):
 *
 *   1. IdleController.enter() / exit() bracket every request.
 *   2. isAllowedHost(req) — 403 before touching routing or the filesystem.
 *   3. GET /health, then POST /shutdown (token-checked), then the
 *      session/artifact routes (Plan 03-03: POST /api/sessions, POST
 *      /api/:key/artifact-loads/begin), then Plan 06-07's dispatch/poll/
 *      answer/audit routes (POST+GET /api/:key/dispatches, POST
 *      /api/:key/heartbeat, POST /api/:key/end — this plan's own route,
 *      wiring dispatch-ledger.ts's endSession so POLL-01's "session ends"
 *      outcome is reachable — GET /api/:key/poll, POST
 *      /api/dispatches/:id/answer — the last is deliberately NOT nested
 *      under /api/:key/...), then GET /session/:key, GET /artifact/:key/*,
 *      GET /sdk.js, GET /chrome-client.js (Plan 06-09: both now read a real
 *      built dist/ file instead of the retired sdk-stub.ts placeholder),
 *      then the Phase 1 asset route (GET only, 405 otherwise) —
 *      resolveAssetPath → serveAsset.
 */
export function createDaemonServer(
  server: Server,
  root: string,
  record: LockRecord,
  opts: DaemonServerOptions,
): Server {
  const lockPath = lockPathFor(root);
  // One SessionStore per createDaemonServer call, reused across every
  // session/artifact route below — Plan 03-03's documented composition.
  const store = new SessionStore(root);
  // One PollEvents instance per createDaemonServer call, shared between the
  // dispatch route (emits on a fresh enqueue) and the poll route (the sole
  // subscriber, via resolvePoll) — never re-instantiated per-request, or a
  // waiting poll would never see a wake from a dispatch that landed on a
  // different instance.
  const pollEvents = createPollEvents();
  // 06-11's standalone-adapter state: one `ActivePolls` tracker and one
  // `claude`-on-PATH probe per `createDaemonServer` call (i.e. per daemon
  // process) -- never re-instantiated per-request, mirroring `pollEvents`'s
  // own one-shared-instance discipline. Neither is ever persisted to disk.
  const activePolls = createActivePolls();
  // The self-dispatch half of "something is working on this". `activePolls`
  // only knows about open long polls; `maybeSelfDispatch` is fired and never
  // awaited, so without this the daemon has no idea a `claude -p` is still
  // running and a retry would re-open the dispatch and spawn a second one.
  // Same discipline as `activePolls`: in-memory presence for one daemon
  // process, never persisted -- a dispatch left in flight by a daemon that
  // died is exactly the abandoned dispatch a retry is meant to re-open.
  const inFlightSelfDispatches = new Set<string>();
  const isClaudeOnPath = opts.isClaudeOnPathOverride ?? createClaudeOnPathProbe();
  // One StalenessRegistry per createDaemonServer call, mirroring pollEvents/
  // activePolls' own one-shared-instance-per-daemon-process discipline --
  // 08-01/08-02/08-03's machinery is only ever reachable through THIS
  // instance, started on a successful begin handshake and stopped on
  // session end/shutdown below.
  const stalenessRegistry = createStalenessRegistry({
    debounceMs: opts.stalenessWatchDebounceMs,
    reconcileIntervalMs: opts.stalenessReconcileIntervalMs,
    forceUnhealthy: opts.forceWatcherUnhealthy,
  });
  // One AnnotationStoreFile per artifact, for the same reason the findings
  // store lives in the staleness registry: the mutex is per instance (RT-14).
  const annotationStores = createAnnotationStoreRegistry();
  let shuttingDown = false;

  /**
   * The one shared shutdown routine — both the token-checked /shutdown
   * route and the idle controller's onIdle callback call this, and only
   * this, so there is exactly one close/cleanup/exit sequence to get right
   * (this plan's success criteria), not two that could drift apart.
   */
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    // Closes every currently-tracked session's watcher (timers + watch
    // handles) before the lock is released -- no leaked handle survives a
    // clean shutdown.
    stalenessRegistry.closeAll();
    await cleanupLock(lockPath);
    server.close(() => process.exit(0));
  }

  /** Buffers a request body and parses it as JSON. No body-parsing library -- this project has none. */
  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  }

  /**
   * POST /api/sessions -- {file: "<absolute path under root>"} -> {key}.
   * Reuses resolveAssetPath's realpath containment check verbatim (T-03-08):
   * `file` is turned into a root-relative request path first (a purely
   * lexical operation, no filesystem access of its own), then handed to the
   * exact same function the asset route already trusts to do the realpath
   * resolution and the traversal/dotfile checks -- no second, possibly
   * weaker, path-safety implementation for this route.
   */
  async function handleCreateSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let file: string;
    try {
      const parsed = (await readJsonBody(req)) as { file?: unknown };
      if (typeof parsed.file !== 'string' || parsed.file.length === 0) {
        throw new Error('file is required');
      }
      file = parsed.file;
    } catch {
      sendJson(res, 400, { error: 'invalid request body: expected {"file": "<absolute path>"}' });
      return;
    }

    const relFromRoot = relative(root, resolve(file)).split(sep).join('/');
    const containment = await resolveAssetPath(root, '/' + relFromRoot);
    if (containment.kind === 'not-found') {
      sendJson(res, 404, { error: 'file not found' });
      return;
    }
    if (containment.kind === 'forbidden') {
      sendJson(res, 403, { error: 'file escapes artifact root' });
      return;
    }

    const key = sessionKey(containment.path);
    const sessionRecord = await store.mutate((state) => upsertSession(state, key, containment.path));
    sendJson(res, 200, { key: sessionRecord.key });
  }

  /**
   * GET /session/:key -- the chrome shell document. Mints a fresh
   * chromeLoadToken on EVERY call via openChromeSession (SERVE-09's
   * supersession mechanism -- last-writer-wins, symmetric, a superseded tab
   * can re-GET this route to take the session back). Embeds the token as
   * inert JSON data for the real chrome-client JS to read, AND now loads
   * that real script alongside it -- this shell previously had no
   * addEventListener('message', ...) logic of its own (JOIN-CONTRACT.md
   * §3); that lands via this <script> tag, this plan.
   *
   * The iframe is rendered with NO navigable `src` of its own (deliberately
   * -- see the threat flag this fixes, 06-10-SUMMARY.md/deferred-items.md):
   * this route's own `chromeLoadToken` is only ever valid for THIS load,
   * and calling `beginArtifactLoad` synchronously here, inside a single
   * `store.mutate`, would immediately race the real multi-window supersede
   * story this file's own route-level tests (`test/daemon/artifact-routes.
   * test.ts`) prove independently -- a second tab's own `GET /session/:key`
   * must still be able to 409 a FIRST tab's begin call as `superseded`, an
   * outcome only reachable when the begin call is made by a caller who
   * might lose that race, not unconditionally paired with the mint that
   * just happened to win it. `chrome-client.js` (src/chrome/client.ts) is
   * that caller: it performs the real `POST /api/:key/artifact-loads/begin`
   * handshake itself, using this exact `chromeLoadToken`, and only then
   * addresses this iframe at the resulting, genuinely fresh
   * `(artifact_load_token, artifact_revision)` pair -- never a bare,
   * tokenless `/artifact/:key/` that would 409 on arrival.
   */
  async function handleOpenSession(res: ServerResponse, key: string): Promise<void> {
    const result = await store.mutate((state) => openChromeSession(state, key));
    if (result.status === 'not-found') {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    const sessionData = JSON.stringify({ chrome_load_token: result.chromeLoadToken }).replace(/<\/script/gi, '<\\/script');
    // The iframe carries explicit CSS sizing (position:fixed;inset:0, filling
    // the real viewport) -- an unstyled <iframe> defaults to the HTML spec's
    // replaced-element size, 300x150, regardless of how large the outer
    // browser window actually is. Found via 07-06's own real-browser proof
    // (a genuine Playwright click landing on the artifact document's own
    // <body> instead of a card action button rendered past that 150px
    // mark) -- the exact same symptom class 04-03-SUMMARY.md already
    // documented once for the now-retired FIXTURE chrome shell's identical
    // gap ("<html> intercepts pointer events... default, unstyled 300x150
    // iframe... equally reachable in a real, normally-sized browser
    // window"). That precedent was never ported to THIS, the real,
    // production chrome shell this route serves -- html/body's own default
    // margin is reset alongside it so the fixed-position iframe has no
    // stray scrollbar-inducing gap around it.
    // The shell is a two-column app (top bar / artifact stage / review
    // rail), NOT a viewport-filling iframe. The rail is why: a persistent
    // column cannot exist beside an `inset:0` iframe, which is the
    // structural reason every piece of review UI previously had to be
    // drawn INSIDE the sandboxed artifact as a corner-pinned overlay.
    //
    // `.il-stage`/`#illuminate-artifact-frame` still carry explicit CSS
    // sizing in chrome-css.ts -- being a grid cell does not save an
    // <iframe> from the HTML spec's 300x150 replaced-element default, the
    // exact symptom 07-06's real-browser proof hit (a genuine Playwright
    // click landing on the artifact <body> instead of a card action past
    // the 150px mark) and 04-03-SUMMARY.md had already documented once for
    // the retired fixture shell.
    //
    // CHROME_CSS is inlined rather than served as a second file so the
    // shell still renders correctly on its very first paint, with no
    // unstyled flash and no second request to fail -- and so this document
    // keeps SERVE-10's zero-outbound-request property trivially: there is
    // nothing here to fetch.
    const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>illuminate</title><style>${CHROME_CSS}</style></head>
<body>
<div class="il-app" id="illuminate-app" data-rail="expanded">
  <header class="il-bar">
    <span class="il-brand"><span class="il-brand-mark">illuminate</span><span class="il-brand-file" id="illuminate-artifact-name"></span></span>
    <span class="il-bar-spacer"></span>
    <span class="il-conn" id="illuminate-connection" data-state="connecting">connecting</span>
    <button type="button" class="il-btn il-btn--ghost il-btn--sm" id="illuminate-rail-toggle" aria-expanded="true">Hide rail</button>
  </header>
  <main class="il-stage" id="illuminate-stage">
    <iframe id="illuminate-artifact-frame" title="Artifact" sandbox="${SANDBOX_TOKENS}"></iframe>
  </main>
</div>
<script id="illuminate-session-data" type="application/json">${sessionData}</script>
<script src="/chrome-client.js"></script>
</body>
</html>
`;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html');
    // Clickjacking protection for the SHELL document -- distinct from the
    // `Content-Security-Policy: sandbox ...` header set on /artifact/:key/*
    // (the artifact's own opaque-origin enforcement); do not conflate the two.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.end(html);
  }

  /**
   * POST /api/:key/artifact-loads/begin -- {chromeLoadToken} -> 200
   * {artifact_load_token, artifact_revision} | 409 superseded (with a named
   * take-over path, never a bare rejection -- T-03-09) | 404.
   */
  async function handleBeginArtifactLoad(req: IncomingMessage, res: ServerResponse, key: string): Promise<void> {
    let chromeLoadToken: string;
    try {
      const parsed = (await readJsonBody(req)) as { chromeLoadToken?: unknown };
      if (typeof parsed.chromeLoadToken !== 'string' || parsed.chromeLoadToken.length === 0) {
        throw new Error('chromeLoadToken is required');
      }
      chromeLoadToken = parsed.chromeLoadToken;
    } catch {
      sendJson(res, 400, { error: 'invalid request body: expected {"chromeLoadToken": "..."}' });
      return;
    }

    const result = await store.mutate((state) => beginArtifactLoad(state, key, chromeLoadToken));
    if (result.status === 'not-found') {
      sendJson(res, 404, { error: 'unknown session' });
      return;
    }
    if (result.status === 'superseded') {
      sendJson(res, 409, {
        status: 'superseded',
        message: 'This artifact is open in another window.',
        take_over: `GET /session/${key} to take over this review`,
      });
      return;
    }

    // Starts (idempotently) this session's staleness watcher on every
    // successful begin -- a repeat begin (a tab reload re-winning the same
    // session) is a documented no-op per staleness-registry.ts's own
    // `startForSession` contract, never a second watcher. Re-reads the
    // session record rather than threading `beginArtifactLoad`'s own return
    // value (which carries only the token/revision pair, not `file`) --
    // `file` is immutable for a session's whole lifetime once created
    // (upsertSession, session-store.ts), so this second read is never
    // racing the mutate() call just above it in any way that matters.
    const stateAfterBegin = await store.read();
    const sessionRecordForWatch = stateAfterBegin.sessions[key];
    if (sessionRecordForWatch) {
      stalenessRegistry.startForSession(key, sessionRecordForWatch.file, dirname(sessionRecordForWatch.file));
    }

    sendJson(res, 200, { artifact_load_token: result.artifactLoadToken, artifact_revision: result.artifactRevision });
  }

  /**
   * GET /artifact/:key/ -- the artifact entry document, inside the
   * sandboxed iframe. `artifact_load_token`/`artifact_revision` are read
   * from THIS document's own URL (window.location.search on the client
   * side), never from the injected script's URL -- JOIN-CONTRACT.md §1
   * pins this exactly so Phase 4's SDK reads its token from the right
   * place. Checked before AND after the read via
   * readArtifactWithFreshnessGuard (SERVE-08); 409 on any mismatch.
   */
  async function handleArtifactEntry(res: ServerResponse, key: string, url: URL): Promise<void> {
    const artifactLoadToken = url.searchParams.get('artifact_load_token');
    const artifactRevisionRaw = url.searchParams.get('artifact_revision');
    const artifactRevision = artifactRevisionRaw !== null ? Number(artifactRevisionRaw) : NaN;

    if (!artifactLoadToken || !Number.isFinite(artifactRevision)) {
      sendJson(res, 409, {
        status: 'expired',
        message: 'Missing or invalid artifact_load_token/artifact_revision.',
      });
      return;
    }

    const result = await readArtifactWithFreshnessGuard({
      store,
      key,
      artifactLoadToken,
      artifactRevision,
      readFile: (p) => readFile(p, 'utf8'),
    });

    if (result.status === 'not-found') {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    if (result.status === 'expired') {
      sendJson(res, 409, { status: 'expired', message: 'This artifact load is no longer current.' });
      return;
    }

    const scriptUrl = `http://127.0.0.1:${record.port}/sdk.js?key=${key}`;
    const injected = injectScriptTag(result.html, scriptUrl);

    if (injected.warnings.length > 0) {
      // PITFALLS.md's "warn loudly" -- there is no chrome UI to show this
      // in yet (that lands with Phase 4/6), so stderr + the response
      // header are this phase's honest discharge of that requirement.
      process.stderr.write(`illuminate: warning: ${result.record.file} -- ${injected.warnings.join(', ')}\n`);
      res.setHeader('X-Illuminate-Warnings', injected.warnings.join(','));
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Security-Policy', `sandbox ${SANDBOX_TOKENS}`);
    res.end(injected.html);
  }

  /**
   * GET /artifact/:key/<subpath> -- sibling assets (images, CSS, etc.)
   * referenced by the artifact document. No load-token check here by
   * design: the load token verifies the DOCUMENT load per SERVE-08's
   * literal wording ("the artifact load is verified"); sibling assets are
   * supporting resources fetched by the browser after the document is
   * already showing, and requiring a fresh token on every image request
   * has no correctness payoff SERVE-08 asks for. Reuses resolveAssetPath's
   * containment check verbatim (T-03-06) -- no second implementation.
   */
  async function handleArtifactSibling(
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    subpath: string,
  ): Promise<void> {
    const state = await store.read();
    if (!state.sessions[key]) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    const containment = await resolveAssetPath(root, '/' + subpath);
    if (containment.kind === 'not-found') {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    if (containment.kind === 'forbidden') {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    // Set BEFORE calling serveAsset (T-03-07): serveAsset only sets its own
    // ETag/Range/MIME headers and does not know about the sandbox
    // requirement -- every response under /artifact/:key/*, entry document
    // and sibling assets alike, must carry this header, or a sibling asset
    // response forgetting it would let an embedded resource escape the
    // sandbox's CSP surface even though the top-level document is sandboxed.
    res.setHeader('Content-Security-Policy', `sandbox ${SANDBOX_TOKENS}`);
    await serveAsset(req, res, containment.path);
  }

  /**
   * The ONE write path every answered dispatch flows through into the
   * annotation store sidecar (07-02's `AnnotationStoreFile`), regardless of
   * HOW it was answered -- a real subagent via `handleAnswer`, or this
   * file's own deterministic EDU-07 verify-shortcut (`handleCreateDispatch`,
   * below). There is no second, divergent write path (this plan's own
   * `must_haves.truths`). Defensive no-op when `entry.answer` is `null`:
   * should be unreachable given this is only ever called right after a
   * successful `ingestAnswer`, but this function must not assume its
   * caller's invariant holds (Rule 2 discipline, applied defensively).
   */
  async function appendAnsweredDispatchToAnnotationStore(entry: DispatchLedgerEntry, artifactPath: string): Promise<void> {
    if (entry.answer === null) return;
    const cardEntry: CardThreadEntry = {
      dispatchId: entry.envelope.dispatch_id,
      intent: entry.envelope.intent,
      depth: entry.envelope.depth,
      parentDispatchId: entry.envelope.parent_dispatch,
      learnerNote: entry.envelope.learnerNote,
      markdown: entry.answer.markdown,
      verdict: entry.answer.verdict,
      decidingLines: entry.answer.decidingLines,
      model: entry.answer.model,
      tier: entry.answer.tier,
      source: entry.envelope.targets[0]?.source ?? null,
      answeredAt: entry.answer.answeredAt,
    };
    const primaryTarget = entry.envelope.targets[0];
    if (primaryTarget === undefined) return;
    await annotationStores.get(artifactPath).mutate((current) => ({
      next: appendCardEntry(current, {
        parentDispatchId: entry.envelope.parent_dispatch,
        // A card is rendered at ONE place in the artifact, so it is anchored
        // to the first selected section; the rest of the selection reached
        // the agent on the envelope and is reflected in the answer text.
        // `targets` is never empty (the parser rejects an empty list), but
        // the index is guarded rather than asserted -- a card is not worth
        // crashing the answer-ingest path over.
        snapshot: snapshotFromDispatchElement(primaryTarget.element, primaryTarget.source),
        entry: cardEntry,
      }),
      result: undefined,
    }));
  }

  /**
   * POST /api/:key/dispatches -- {..TypedIntentPayload} -> 200
   * {dispatch_id}. Same-origin guarded (T-06-13): the FIRST mutating route
   * in this codebase that creates real, billable downstream work.
   * `buildDispatchEnvelope` (router/envelope.ts) is the only place role/tier
   * and anchor resolution happen -- this handler never reimplements either.
   * On a genuinely new enqueue (never a deduped repeat), wakes the shared
   * `pollEvents` so an already-waiting poll sees it immediately instead of
   * waiting out its own heartbeat/timeout cadence.
   *
   * EDU-07's deterministic verify-shortcut lives here: a `verify` dispatch
   * whose anchor is unresolvable or unanchored (`isUngroundable`,
   * src/router/verify.ts) is answered SYNCHRONOUSLY, inside this same
   * request, instead of ever reaching self-dispatch or a real harness --
   * zero model calls, zero cost, for a question that structurally cannot be
   * checked. See T-07-11 (this plan's threat model) for the one disclosed,
   * accepted race this shortcut leaves open.
   */
  async function handleCreateDispatch(req: IncomingMessage, res: ServerResponse, key: string): Promise<void> {
    if (!isSameOriginRequest(req, record.port)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    let payload: TypedIntentPayload;
    try {
      const body = await readJsonBody(req);
      payload = parseTypedIntentPayload(body);
    } catch {
      sendJson(res, 400, { error: 'invalid request body: expected a TypedIntentPayload' });
      return;
    }

    const envelope = await buildDispatchEnvelope(payload, root, record.port);
    // The real `isWorkInFlight` predicate (dispatch-ledger.ts): a retry
    // re-opens an abandoned dispatch, but never one a poll or an unfinished
    // self-dispatch is still working on.
    const result = await store.mutate((state) =>
      enqueueDispatch(state, key, envelope, (dispatchId) => activePolls.isActive(key) || inFlightSelfDispatches.has(dispatchId)),
    );
    if (result.status === 'not-found') {
      sendJson(res, 404, { error: 'unknown session' });
      return;
    }
    // Only a genuinely NEW enqueue wakes a waiting poll -- a deduped repeat
    // performed no mutation at all (enqueueDispatch's own documented
    // no-op), so there is nothing new for a waiting poll to see.
    if (result.status === 'ok') {
      pollEvents.emit(key);
      // The envelope the LEDGER holds, which on a retry that re-opened an
      // abandoned dispatch is the ORIGINAL one, not the one just built. Every
      // line below reads from it rather than from `envelope`: both the
      // shortcut's `ingestAnswer` and self-dispatch's `postAnswer` address a
      // dispatch by id, and an answer posted at an id no session holds is
      // silently dropped as `not-found`.
      const ledgerEnvelope = result.envelope;
      // Two independent deterministic shortcuts, both gated on
      // `isUngroundable(...source)` but distinguished by DIFFERENT
      // conditions -- `payload.intent === 'verify'` (EDU-07) vs.
      // `payload.learnerNote !== null` (EDU-06's self-explanation grading).
      // A payload can only ever satisfy one: `verify` never carries a
      // learnerNote (only a self-explanation flow ever sets that field --
      // see shared/intent.ts's own doc comment), so the two never compete
      // for the same dispatch. Neither reads or is affected by the other.
      const isVerifyShortcut = payload.intent === 'verify' && isUngroundable(ledgerEnvelope.targets);
      const isSelfExplainShortcut = payload.learnerNote !== null && isUngroundable(ledgerEnvelope.targets);
      if (isVerifyShortcut || isSelfExplainShortcut) {
        // The deterministic EDU-06/EDU-07 shortcut -- never self-dispatched,
        // never handed to a real harness. A second, distinct `store.mutate`
        // call (not the `enqueueDispatch` result above): `ingestAnswer` is
        // the router's one write path for a submitted answer, reused here
        // verbatim rather than hand-writing a second ledger-mutation path.
        const markdown = isVerifyShortcut
          ? 'NOT DETERMINABLE FROM THIS ANCHOR -- no resolved source content is available to check this claim against.'
          : "There's no resolved source behind this element to grade your explanation against -- try this on an anchored element instead.";
        // Self-explanation grading is never a Verdict -- that field stays
        // verify-only (EDU-07's own three-state contract). Setting it to
        // 'not-determinable' here would conflate two deliberately separate
        // concepts this codebase keeps apart.
        const verdict = isVerifyShortcut ? 'not-determinable' : null;
        const ingestResult = await store.mutate((state) =>
          ingestAnswer(
            state,
            {
              dispatchId: ledgerEnvelope.dispatch_id,
              markdown,
              model: 'illuminate (no model call)',
              tier: ledgerEnvelope.model_tier,
              tokensIn: 0,
              tokensOut: 0,
              cacheReadInputTokens: 0,
              costUsd: 0,
              wallMs: 0,
              verdict,
              decidingLines: null,
            },
            new Date().toISOString(),
          ),
        );
        if (ingestResult.kind === 'ok') {
          await appendAnsweredDispatchToAnnotationStore(ingestResult.entry, ingestResult.artifactPath);
        }
      } else if (await shouldSelfDispatch(key, activePolls, isClaudeOnPath, ledgerEnvelope.dispatch_id)) {
        // 06-11's standalone adapter: a harness actively polling this key
        // always takes priority (T-06-24's accepted scope) -- self-dispatch
        // fires only when no poll is open for `key` AND a `claude` binary is
        // on PATH. Fire-and-forget (never awaited): the dispatch route's own
        // response to the chrome-client must not wait out however long a
        // real `claude -p` call takes.
        const inFlightId = ledgerEnvelope.dispatch_id;
        inFlightSelfDispatches.add(inFlightId);
        void maybeSelfDispatch(ledgerEnvelope, {
          port: record.port,
          spawnFn: opts.selfDispatchSpawnFn,
          postAnswer: opts.selfDispatchPostAnswer,
        }).finally(() => inFlightSelfDispatches.delete(inFlightId));
      }
    }
    // The caller (the future chrome-client) never needs to distinguish
    // "new" from "deduped" -- either way it gets back a valid id.
    sendJson(res, 200, { dispatch_id: result.dispatchId });
  }

  /**
   * POST /api/:key/heartbeat -- no request body. Same-origin guarded.
   * Records POLL-04's presence signal via `recordHeartbeat`
   * (dispatch-ledger.ts) -- this route never touches `browserLastSeenAt`
   * directly.
   */
  async function handleHeartbeat(req: IncomingMessage, res: ServerResponse, key: string): Promise<void> {
    if (!isSameOriginRequest(req, record.port)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    const result = await store.mutate((state) => recordHeartbeat(state, key, new Date().toISOString()));
    if (result.status === 'not-found') {
      sendJson(res, 404, { error: 'unknown session' });
      return;
    }
    sendJson(res, 200, {});
  }

  /**
   * POST /api/:key/end -- no request body. Same-origin guarded (mutating,
   * mirrors handleHeartbeat's shape). The one HTTP route that calls
   * dispatch-ledger.ts's `endSession` (06-03) -- POLL-01's "the session
   * ends" outcome (poll.ts, 06-05) was structurally coded but genuinely
   * unreachable until this route existed (06-07/06-08 both documented the
   * gap and correctly declined to close POLL-01 without it). Idempotent by
   * construction (endSession's own last-write-wins semantics) -- calling
   * this twice is not an error. Always wakes the shared `pollEvents`: a
   * poll already resolved to `'ended'` is unaffected by a spurious wake,
   * and a poll currently waiting must observe this new terminal state
   * immediately rather than wait out its own heartbeat/timeout cadence,
   * mirroring handleCreateDispatch's own wake discipline.
   */
  async function handleEndSession(req: IncomingMessage, res: ServerResponse, key: string): Promise<void> {
    if (!isSameOriginRequest(req, record.port)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    const result = await store.mutate((state) => endSession(state, key, new Date().toISOString()));
    if (result.status === 'not-found') {
      sendJson(res, 404, { error: 'unknown session' });
      return;
    }
    // Closes this session's staleness watcher cleanly -- no leaked timer or
    // open file handle survives an ordinary session end, mirroring
    // shutdown()'s own closeAll() discipline for the whole-daemon case.
    stalenessRegistry.stopForSession(key);
    pollEvents.emit(key);
    sendJson(res, 200, {});
  }

  /**
   * GET /api/:key/poll?timeoutMs= -- THE context-isolation boundary
   * (T-06-14): adapts the real req/res pair into a `PollConnection` and
   * calls `resolvePoll` (poll.ts), which owns every bit of the actual
   * long-poll state machine. `const body: PollResponse = {...}` below is
   * the literal, load-bearing construction site where the compile-time
   * excess-property check on `PollResponse` genuinely applies -- this
   * function must never add a field to that object literal.
   */
  async function handlePoll(req: IncomingMessage, res: ServerResponse, key: string, url: URL): Promise<void> {
    const timeoutMsRaw = url.searchParams.get('timeoutMs');
    const timeoutMsParsed = timeoutMsRaw !== null ? Number(timeoutMsRaw) : null;
    const timeoutMs = timeoutMsParsed !== null && Number.isFinite(timeoutMsParsed) ? timeoutMsParsed : null;

    // A locally-tracked boolean flipped by res's own 'close' event, exactly
    // mirroring this file's pre-existing generic
    // `res.on('close', () => idle?.exit())` wiring one function up --
    // res.writableEnded/res.destroyed alone can lag a real client abort by
    // a tick, so isClosed() also consults this flag directly.
    let resClosed = false;
    res.on('close', () => {
      resClosed = true;
    });

    const conn: PollConnection = {
      isClosed: () => res.writableEnded || res.destroyed || resClosed,
      onClose: (cb) => {
        req.on('close', cb);
      },
    };

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    // STACK.md's explicit guidance: a genuinely long-lived poll must never
    // be killed by Node's own default socket timeout.
    res.setTimeout(0);

    // 06-11's priority rule: a poll open for `key` must be visible to the
    // dispatch route's self-dispatch check for the entire lifetime of this
    // (potentially long-lived) call -- entered immediately before, exited
    // in a `finally` once resolvePoll settles, regardless of outcome.
    activePolls.enter(key);
    let outcome: Awaited<ReturnType<typeof resolvePoll>>;
    try {
      outcome = await resolvePoll(store, key, conn, pollEvents, {
        timeoutMs,
        heartbeatMs: opts.pollHeartbeatMs ?? POLL_HEARTBEAT_MS,
        disconnectGraceMs: opts.disconnectGraceMs ?? BROWSER_DISCONNECT_GRACE_MS,
        now: Date.now,
        writeHeartbeat: () => {
          res.write(' ');
        },
      });
    } finally {
      activePolls.exit(key);
    }

    if (outcome.status === 'not-found') {
      // Nothing has been written yet on this path (not-found is checked
      // before any heartbeat could ever fire) -- safe to still set status.
      if (!res.writableEnded) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'unknown session' }));
      }
      return;
    }
    if (outcome.status === 'aborted') {
      // The socket is already gone -- this is not an error path, just a
      // defensive no-op if anything is somehow still writable.
      if (!res.writableEnded) res.end();
      return;
    }

    const body: PollResponse = {
      status: outcome.status,
      dispatches: outcome.status === 'dispatch' ? outcome.dispatches : [],
    };
    res.end(JSON.stringify(body));
  }

  /**
   * POST /api/dispatches/:id/answer -- deliberately NOT under
   * `/api/:key/...`: dispatch ids are 192-bit random and globally unique
   * across every session this daemon holds, so `ingestAnswer` (router/
   * ingest.ts) finds the owning session by scanning for the id itself. This
   * is what keeps `buildDispatchEnvelope`'s `return_to` string genuinely
   * self-sufficient -- a harness needs no session key to close the loop.
   * Same-origin guarded. No WS broadcast on success -- there is no WS this
   * phase (T-06-16, a deliberate, disclosed scope boundary); 07-04's own
   * `appendAnsweredDispatchToAnnotationStore` call below writes the answer
   * into the durable annotation-store sidecar, which the chrome shell later
   * reads via the polling `GET /api/:key/annotations` route this plan also
   * adds -- still no WS, per this plan's own design note (polling reuses
   * the existing heartbeat cadence instead).
   */
  async function handleAnswer(req: IncomingMessage, res: ServerResponse, dispatchId: string): Promise<void> {
    if (!isSameOriginRequest(req, record.port)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    let submission: AnswerSubmission;
    try {
      const body = await readJsonBody(req);
      submission = parseAnswerSubmission(body, dispatchId);
    } catch {
      sendJson(res, 400, { error: 'invalid request body: expected an AnswerSubmission' });
      return;
    }

    const result = await store.mutate((state) => ingestAnswer(state, submission, new Date().toISOString()));
    if (result.kind === 'ok') {
      // The SAME write path the EDU-07 verify-shortcut uses (see that
      // function's own doc comment) -- there is no second, divergent path
      // into the annotation store regardless of HOW a dispatch was answered.
      await appendAnsweredDispatchToAnnotationStore(result.entry, result.artifactPath);
      // Plain-text body, matching how `illuminate answer` (06-08) will
      // print it verbatim -- formatReceipt's own design, not reformatted
      // here.
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end(result.receipt);
      return;
    }
    if (result.kind === 'refused') {
      sendJson(res, 403, { error: result.reason });
      return;
    }
    if (result.kind === 'not-found') {
      sendJson(res, 404, { error: 'unknown dispatch' });
      return;
    }
    // 'already-terminal'
    sendJson(res, 409, { error: result.reason });
  }

  /**
   * GET /api/:key/dispatches -- audit summary. Stays session-keyed (unlike
   * the answer route): audit is invoked against a known file/session.
   * Read-only, no same-origin guard required, mirroring every other GET
   * route in this file. `summarizeForAudit`'s own return type (router/
   * ingest.ts) already excludes any answer-prose field -- this route
   * inherits that guarantee by construction and must never add a field
   * beyond what it returns.
   */
  async function handleAudit(res: ServerResponse, key: string): Promise<void> {
    const state = await store.read();
    const sessionRecord = state.sessions[key];
    if (!sessionRecord) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    const summary = summarizeForAudit(Object.values(sessionRecord.dispatches));
    sendJson(res, 200, summary);
  }

  /**
   * GET /api/:key/annotations -> 200 {AnnotationStore} | 404 unknown
   * session. Read-only, no same-origin guard required, mirroring
   * `handleAudit`'s own GET-route posture. This is the ONE legitimate
   * prose-carrying route this plan introduces (T-07-10) -- scoped strictly
   * by `key` -> `state.sessions[key].file`, the same lookup every other
   * session-keyed GET route already uses, so a request for an unknown or a
   * DIFFERENT session's key can only ever read that OTHER session's own
   * artifact's sidecar, never cross-contaminate.
   */
  async function handleAnnotations(res: ServerResponse, key: string): Promise<void> {
    const state = await store.read();
    const sessionRecord = state.sessions[key];
    if (!sessionRecord) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    const annotations = await annotationStores.get(sessionRecord.file).read();
    sendJson(res, 200, annotations);
  }

  /**
   * GET /api/:key/findings -> 200 {protocol, findings, meta: {watcherHealthy}}
   * | 404 unknown session. STAL-04's inbox, reachable at last. Reuses the
   * registry's own tracked `FindingsStoreFile` instance when this session
   * has an active watcher (`getFindingsStoreFile`'s own doc comment --
   * `mutate()`'s per-instance mutex only serializes callers sharing the
   * SAME instance, and this route's own sibling, `handleDismissFinding`,
   * mutates through it), falling back to a fresh instance only for a
   * session with no tracked watcher yet (never began, or a documented test
   * seam that skips the begin handshake) -- a plain, still-correct read in
   * that case. Read-only, no same-origin guard required, mirroring every
   * other GET route in this file. `meta.watcherHealthy` makes STAL-05's
   * degraded state an observable fact over the wire.
   */
  async function handleFindings(res: ServerResponse, key: string): Promise<void> {
    const state = await store.read();
    const sessionRecord = state.sessions[key];
    if (!sessionRecord) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    const findingsStoreFile = stalenessRegistry.getFindingsStoreFile(key) ?? new FindingsStoreFile(sessionRecord.file);
    const findingsStore = await findingsStoreFile.read();
    sendJson(res, 200, { ...findingsStore, meta: { watcherHealthy: stalenessRegistry.isWatcherHealthy(key) } });
  }

  // illuminate:dismiss-route-boundary-start -- STAL-05's structural proof
  // that a dismiss can never reach the dispatch pipeline: this handler's own
  // body, between this marker and its matching end marker below, is
  // source-text regression tested (test/daemon/findings-route.test.ts) to
  // contain no reference to this codebase's dispatch/role/tier machinery.
  // The fingerprint's shape (16 lowercase hex chars) is validated by the
  // ROUTE MATCH itself (see this file's `dismissMatch` regex below) -- a
  // malformed fingerprint segment never reaches this function at all, so
  // there is no second, separate validation here.
  /**
   * POST /api/:key/attachments -- {dataUrl} -> 200 {attachment_id, media_type}
   * | 400 | 403 | 404.
   *
   * Returns an ID, never a path: the path is machine-local detail the browser
   * has no use for and no business knowing. `buildDispatchEnvelope` resolves
   * the id back to a path when it builds work for an agent.
   */
  async function handleCreateAttachment(req: IncomingMessage, res: ServerResponse, key: string): Promise<void> {
    if (!isSameOriginRequest(req, record.port)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    const state = await store.read();
    if (!state.sessions[key]) {
      sendJson(res, 404, { error: 'unknown session' });
      return;
    }
    let dataUrl: string;
    try {
      const body = (await readJsonBody(req)) as { dataUrl?: unknown };
      if (typeof body.dataUrl !== 'string' || body.dataUrl.length === 0) {
        throw new Error('dataUrl is required');
      }
      dataUrl = body.dataUrl;
    } catch {
      sendJson(res, 400, { error: 'invalid request body: expected {"dataUrl": "data:image/...;base64,..."}' });
      return;
    }

    const result = await storeAttachment(root, dataUrl);
    if (!result.ok) {
      // The reason is the human's to see -- an 8MB screenshot and an
      // unsupported format fail for different reasons and need different
      // fixes, so a bare 400 would send them guessing.
      sendJson(res, 400, { error: result.reason });
      return;
    }
    sendJson(res, 200, { attachment_id: result.attachment.id, media_type: result.attachment.mediaType });
  }

  /**
   * POST /api/:key/findings/:fingerprint/dismiss -> 200 {} | 404 unknown
   * session. Same-origin guarded, mirroring handleHeartbeat/handleEndSession's
   * mutating-route posture. Calls Plan 08-01's own pure `dismissFinding`
   * reducer through `FindingsStoreFile.mutate` -- never a second,
   * hand-written mutation of the sidecar. Reuses the registry's own tracked
   * instance (see `handleFindings`'s identical doc comment, just above):
   * without this, a dismiss landing while the watcher's own reconcile-
   * interval rescan is mid-mutate races two UNSYNCHRONIZED per-instance
   * mutexes over the SAME on-disk file, and the loser's write -- often the
   * dismiss itself -- is silently lost.
   */
  async function handleDismissFinding(
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    fingerprint: string,
  ): Promise<void> {
    if (!isSameOriginRequest(req, record.port)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    const state = await store.read();
    const sessionRecord = state.sessions[key];
    if (!sessionRecord) {
      sendJson(res, 404, { error: 'unknown session' });
      return;
    }
    const findingsStoreFile = stalenessRegistry.getFindingsStoreFile(key) ?? new FindingsStoreFile(sessionRecord.file);
    await findingsStoreFile.mutate((current) => ({
      next: dismissFinding(current, fingerprint),
      result: undefined,
    }));
    sendJson(res, 200, {});
  }
  // illuminate:dismiss-route-boundary-end

  function handleUnexpectedError(res: ServerResponse): void {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    } else {
      res.destroy();
    }
  }

  let idle: IdleController | null = null;
  if (opts.idleMs !== null) {
    idle = new IdleController(opts.idleMs, () => {
      // Belt-and-braces recheck (RESEARCH.md §4's onIdle sketch): idle.ts's
      // own timer callback already reverifies activeCount === 0
      // synchronously before ever invoking this callback, so this second
      // check can only ever re-confirm the same fact in practice — kept
      // anyway because RESEARCH.md calls it out as an explicit guard, and
      // it costs nothing to check again immediately before an irreversible
      // process.exit().
      if (idle !== null && idle.activeCount === 0) void shutdown();
    });
  }

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    idle?.enter();
    // 'close' (not 'finish' alone) fires on both normal completion and a
    // client aborting mid-response, so an aborted request still releases
    // its idle-count slot instead of wedging the controller open forever.
    res.on('close', () => idle?.exit());

    if (!isAllowedHost(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/health') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      // Exact contract checkOwnership (ownership.ts) cross-checks against —
      // do not add or rename fields.
      res.end(
        JSON.stringify({
          pid: record.pid,
          port: record.port,
          version: record.version,
          healthToken: record.healthToken,
        }),
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/shutdown') {
      const token = url.searchParams.get('token');
      if (token !== record.healthToken) {
        // Deliberate addition beyond RESEARCH.md's bare sketch (T-01-18):
        // without this, any local process or browser tab that discovers
        // the port could kill the daemon with no proof of being
        // illuminate's own CLI.
        res.statusCode = 403;
        res.end('Forbidden');
        return;
      }
      res.statusCode = 200;
      res.end('ok');
      void shutdown();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      handleCreateSession(req, res).catch(() => handleUnexpectedError(res));
      return;
    }

    const beginMatch = req.method === 'POST' ? url.pathname.match(/^\/api\/([^/]+)\/artifact-loads\/begin$/) : null;
    if (beginMatch) {
      const key = beginMatch[1];
      if (key === undefined) {
        handleUnexpectedError(res);
        return;
      }
      handleBeginArtifactLoad(req, res, key).catch(() => handleUnexpectedError(res));
      return;
    }

    // Phase 6 dispatch/poll/answer/audit routes -- POST creates a dispatch,
    // GET returns the audit summary; same path, gated by method.
    const dispatchesMatch = url.pathname.match(/^\/api\/([^/]+)\/dispatches$/);
    if (dispatchesMatch && (req.method === 'POST' || req.method === 'GET')) {
      const key = dispatchesMatch[1];
      if (key === undefined) {
        handleUnexpectedError(res);
        return;
      }
      if (req.method === 'POST') {
        handleCreateDispatch(req, res, key).catch(() => handleUnexpectedError(res));
      } else {
        handleAudit(res, key).catch(() => handleUnexpectedError(res));
      }
      return;
    }

    // 07-04's GET /api/:key/annotations -- the browser's own read path for
    // its artifact's current set of cards. A distinct literal path suffix
    // from `/dispatches` (no regex-ordering collision, per this plan's own
    // interfaces block), placed here for readability, alongside the other
    // /api/:key/... GET routes above.
    const annotationsMatch = req.method === 'GET' ? url.pathname.match(/^\/api\/([^/]+)\/annotations$/) : null;
    if (annotationsMatch) {
      const key = annotationsMatch[1];
      if (key === undefined) {
        handleUnexpectedError(res);
        return;
      }
      handleAnnotations(res, key).catch(() => handleUnexpectedError(res));
      return;
    }

    // Plan 08-04's GET /api/:key/findings -- the browser's own read path for
    // its artifact's current set of staleness findings (STAL-04's inbox).
    // Checked BEFORE the dismiss route's regex below (a distinct, more
    // specific pattern -- no ordering collision either way).
    const findingsMatch = req.method === 'GET' ? url.pathname.match(/^\/api\/([^/]+)\/findings$/) : null;
    if (findingsMatch) {
      const key = findingsMatch[1];
      if (key === undefined) {
        handleUnexpectedError(res);
        return;
      }
      handleFindings(res, key).catch(() => handleUnexpectedError(res));
      return;
    }

    // Plan 08-04's POST /api/:key/findings/:fingerprint/dismiss -- STAL-05's
    // one deliberate human action. The fingerprint capture group's own
    // [0-9a-f]{16} shape IS the validation (see handleDismissFinding's own
    // doc comment) -- a malformed fingerprint segment simply never matches
    // this regex at all and falls through to the 404 asset route below.
    const dismissMatch =
      req.method === 'POST' ? url.pathname.match(/^\/api\/([^/]+)\/findings\/([0-9a-f]{16})\/dismiss$/) : null;
    if (dismissMatch) {
      const key = dismissMatch[1];
      const fingerprint = dismissMatch[2];
      if (key === undefined || fingerprint === undefined) {
        handleUnexpectedError(res);
        return;
      }
      handleDismissFinding(req, res, key, fingerprint).catch(() => handleUnexpectedError(res));
      return;
    }

    // POST /api/:key/attachments -- the one place image bytes enter the
    // daemon. Same-origin guarded like every other mutating route; the body
    // is a data URL because a sandboxed artifact has no way to send
    // multipart, and the chrome relays what the artifact handed it.
    const attachmentsMatch = req.method === 'POST' ? url.pathname.match(/^\/api\/([^/]+)\/attachments$/) : null;
    if (attachmentsMatch) {
      const key = attachmentsMatch[1];
      if (key === undefined) {
        handleUnexpectedError(res);
        return;
      }
      handleCreateAttachment(req, res, key).catch(() => handleUnexpectedError(res));
      return;
    }

    const heartbeatMatch = req.method === 'POST' ? url.pathname.match(/^\/api\/([^/]+)\/heartbeat$/) : null;
    if (heartbeatMatch) {
      const key = heartbeatMatch[1];
      if (key === undefined) {
        handleUnexpectedError(res);
        return;
      }
      handleHeartbeat(req, res, key).catch(() => handleUnexpectedError(res));
      return;
    }

    const endMatch = req.method === 'POST' ? url.pathname.match(/^\/api\/([^/]+)\/end$/) : null;
    if (endMatch) {
      const key = endMatch[1];
      if (key === undefined) {
        handleUnexpectedError(res);
        return;
      }
      handleEndSession(req, res, key).catch(() => handleUnexpectedError(res));
      return;
    }

    const pollMatch = req.method === 'GET' ? url.pathname.match(/^\/api\/([^/]+)\/poll$/) : null;
    if (pollMatch) {
      const key = pollMatch[1];
      if (key === undefined) {
        handleUnexpectedError(res);
        return;
      }
      handlePoll(req, res, key, url).catch(() => handleUnexpectedError(res));
      return;
    }

    // Deliberately NOT under /api/:key/... -- see handleAnswer's own doc
    // comment for why the dispatch id alone is sufficient addressing.
    const answerMatch = req.method === 'POST' ? url.pathname.match(/^\/api\/dispatches\/([^/]+)\/answer$/) : null;
    if (answerMatch) {
      const dispatchId = answerMatch[1];
      if (dispatchId === undefined) {
        handleUnexpectedError(res);
        return;
      }
      handleAnswer(req, res, dispatchId).catch(() => handleUnexpectedError(res));
      return;
    }

    const sessionMatch = req.method === 'GET' ? url.pathname.match(/^\/session\/([^/]+)$/) : null;
    if (sessionMatch) {
      const key = sessionMatch[1];
      if (key === undefined) {
        handleUnexpectedError(res);
        return;
      }
      handleOpenSession(res, key).catch(() => handleUnexpectedError(res));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/sdk.js') {
      readFile(resolveDistFile('sdk.js'))
        .then((content) => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          res.end(content);
        })
        .catch(() => handleUnexpectedError(res));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/chrome-client.js') {
      readFile(resolveDistFile('chrome-client.js'))
        .then((content) => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          res.end(content);
        })
        .catch(() => handleUnexpectedError(res));
      return;
    }

    const artifactEntryMatch = req.method === 'GET' ? url.pathname.match(/^\/artifact\/([^/]+)\/$/) : null;
    if (artifactEntryMatch) {
      const key = artifactEntryMatch[1];
      if (key === undefined) {
        handleUnexpectedError(res);
        return;
      }
      handleArtifactEntry(res, key, url).catch(() => handleUnexpectedError(res));
      return;
    }

    const artifactSiblingMatch = req.method === 'GET' ? url.pathname.match(/^\/artifact\/([^/]+)\/(.+)$/) : null;
    if (artifactSiblingMatch) {
      const key = artifactSiblingMatch[1];
      const subpath = artifactSiblingMatch[2];
      if (key === undefined || subpath === undefined) {
        handleUnexpectedError(res);
        return;
      }
      handleArtifactSibling(req, res, key, subpath).catch(() => handleUnexpectedError(res));
      return;
    }

    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }

    resolveAssetPath(root, url.pathname)
      .then(async (result) => {
        if (result.kind === 'not-found') {
          res.statusCode = 404;
          res.end('Not Found');
          return;
        }
        if (result.kind === 'forbidden') {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }
        await serveAsset(req, res, result.path);
      })
      .catch(() => {
        // Rule 2 (missing error handling): an uncaught rejection here (e.g.
        // a transient fs error between resolveAssetPath's check and
        // serveAsset's own stat) would otherwise surface as an unhandled
        // promise rejection and crash the whole daemon process, not just
        // this one request.
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('Internal Server Error');
        } else {
          res.destroy();
        }
      });
  });

  return server;
}
