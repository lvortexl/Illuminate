import {
  extractTypedIntent,
  isEndSessionSignal,
  extractDismissFinding,
  extractComposerSubmission,
} from './message-handling.ts';
import { createRail } from './rail.ts';
import type { QueuedNote, ConnectionState } from './rail.ts';
import type { ComposerAttachmentInput, ComposerSubmissionMessage } from './message-handling.ts';
import { INTENT_PROTOCOL_VERSION } from '../shared/intent.ts';
import type { WireAnnotationStore, WireFinding } from '../sdk/protocol-in.ts';
import { ARTIFACT_POST_TARGET_ORIGIN } from '../shared/protocol.ts';
import type { ChromeToArtifactMessage } from '../shared/protocol.ts';

/**
 * The real chrome-client browser script, injected via a plain
 * `<script src="/chrome-client.js"></script>` tag on `GET /session/:key`'s
 * shell HTML (server.ts's handleOpenSession). JOIN-CONTRACT.md §3 names
 * this exact file as unclaimed follow-up work until this plan: the chrome
 * shell previously had zero `addEventListener('message', ...)` logic at
 * all.
 *
 * Vanilla, dependency-free, self-contained (SERVE-10) -- no `fetch` ever
 * happens inside the sandboxed artifact iframe; every server call in this
 * whole system is made from HERE, by the chrome shell, after a postMessage
 * has already been validated.
 */

/** Cadence for the presence heartbeat -- matches this plan's own action
 * spec ("every ~5 seconds while the page is open"). POLL-04's
 * BROWSER_DISCONNECT_GRACE_MS (10s, server.ts) is comfortably more than
 * double this, so an ordinary heartbeat jitter never trips a false
 * disconnect. */
const HEARTBEAT_INTERVAL_MS = 5000;

/**
 * Reads `chrome_load_token` from the inert `#illuminate-session-data`
 * script tag server.ts already embeds -- the exact tag id/format, not a
 * new one.
 */
function readChromeLoadToken(): string {
  const el = document.getElementById('illuminate-session-data');
  const raw = el?.textContent;
  if (!raw) throw new Error('illuminate: missing #illuminate-session-data script tag');
  const data = JSON.parse(raw) as { chrome_load_token?: unknown };
  if (typeof data.chrome_load_token !== 'string' || data.chrome_load_token.length === 0) {
    throw new Error('illuminate: #illuminate-session-data did not contain a chrome_load_token string');
  }
  return data.chrome_load_token;
}

/**
 * This document IS `/session/:key` -- the key is already in its own URL,
 * a plain pathname split, no separate extraction endpoint needed.
 */
function readSessionKey(): string {
  const segments = window.location.pathname.split('/').filter((segment) => segment.length > 0);
  const key = segments[segments.length - 1];
  if (!key) throw new Error('illuminate: could not determine session key from window.location.pathname');
  return key;
}

const chromeLoadToken = readChromeLoadToken();
const sessionKey = readSessionKey();

/**
 * The review rail, mounted into the shell's grid (server.ts's
 * `handleOpenSession` renders `.il-app` with a `rail` grid area waiting for
 * it). Built here rather than in the shell HTML because every one of its
 * callbacks needs the session key and the `postToArtifact` bridge -- the
 * rail itself owns no network, so this file keeps its position as the only
 * place an HTTP call is ever made.
 */
const rail = createRail({
  onSend: sendQueuedNotes,
  onDismissFinding: (fingerprint: string) => {
    fetch(`/api/${sessionKey}/findings/${fingerprint}/dismiss`, { method: 'POST' }).catch(() => {
      // Best-effort, matching the artifact-side dismiss path below: the row
      // is already gone from the rail, and the next findings sync is
      // authoritative either way.
    });
  },
  onLocate: (uid: string) => {
    postToArtifact({ type: 'illuminate:revealElement', payload: { uid } });
  },
  onCardAction: (cardId: string, action: 'deeper' | 'self-explain', learnerNote: string | null) => {
    // Relayed rather than POSTed: a follow-up's payload must be built from
    // the card's live element, which only the artifact has. The resulting
    // typed intent comes straight back through this file's own message
    // listener as an ordinary illuminate:queuePrompt, so it crosses exactly
    // the same validation as any other dispatch.
    postToArtifact({ type: 'illuminate:cardAction', payload: { cardId, action, learnerNote } });
  },
  onEndSession: () => {
    fetch(`/api/${sessionKey}/end`, { method: 'POST' }).catch(() => {
      // Best-effort -- see this file's other fetch calls.
    });
  },
});

document.getElementById('illuminate-app')?.appendChild(rail.root);

/**
 * The top bar's connection lamp. This is the first time any transport
 * failure in this file is visible to a human at all -- every `fetch` here
 * was previously best-effort with an explicit "no chrome-shell UI exists
 * yet to surface this to" comment. `waiting` is one missed beat (ordinary
 * jitter); `lost` is sustained, and is the state that actually warrants
 * the human's attention.
 */
const connectionEl = document.getElementById('illuminate-connection');
let missedBeats = 0;

function setConnection(state: ConnectionState): void {
  if (!connectionEl) return;
  connectionEl.dataset.state = state;
  connectionEl.textContent = state;
}

function noteTransport(ok: boolean): void {
  if (ok) {
    missedBeats = 0;
    setConnection('live');
    return;
  }
  missedBeats += 1;
  setConnection(missedBeats >= 2 ? 'lost' : 'waiting');
}

const railToggle = document.getElementById('illuminate-rail-toggle');

/** Keeps the toggle's label and aria state honest about the rail. */
function setRail(expanded: boolean): void {
  const app = document.getElementById('illuminate-app');
  if (!app || !railToggle) return;
  app.dataset.rail = expanded ? 'expanded' : 'collapsed';
  railToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  railToggle.textContent = expanded ? 'Hide rail' : 'Show rail';
}

/** Below this the rail stops being a column beside the artifact and becomes
 * an overlay ON it -- the same breakpoint chrome-css.ts's own media query
 * uses. Keep the two in step. */
const RAIL_OVERLAY_MAX_WIDTH = 900;

// Start collapsed on a narrow window. Expanded, the rail is an opaque
// overlay covering roughly half the artifact, which is the wrong default for
// a surface whose entire job is letting someone READ the artifact. It is one
// click away, and the click is the "deliberately" this layout was designed
// around.
setRail(window.innerWidth > RAIL_OVERLAY_MAX_WIDTH);

railToggle?.addEventListener('click', () => {
  const app = document.getElementById('illuminate-app');
  if (!app) return;
  setRail(app.dataset.rail === 'collapsed');
});

/**
 * Flushes the rail's queue. One POST per note, sequentially -- the daemon's
 * dispatch route is a single-writer mutate and N concurrent POSTs would
 * serialize there anyway, so concurrency buys nothing and makes a partial
 * failure harder to reason about.
 *
 * Rejects on the FIRST failure rather than swallowing it, because the rail
 * clears its queue only on resolve: a rejected send is what keeps the
 * human's typed text from disappearing into a transient network error.
 */
async function sendQueuedNotes(notes: readonly QueuedNote[]): Promise<void> {
  for (const note of notes) {
    const res = await fetch(`/api/${sessionKey}/dispatches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: INTENT_PROTOCOL_VERSION,
        intent: note.intent,
        targets: note.target.targets,
        depth: 1,
        parent_dispatch: null,
        learnerNote: null,
        note: note.note.length > 0 ? note.note : null,
        attachments: note.target.attachments,
      }),
    });
    if (res.status !== 200) throw new Error(`dispatch failed: ${String(res.status)}`);
    const body = (await res.json()) as { dispatch_id?: unknown };
    if (typeof body.dispatch_id === 'string') {
      rail.addPending(body.dispatch_id, note.target.uid, note.target.label, note.intent);
      // The artifact still gets told a dispatch exists for its element. The
      // rail draws the pending row in a served session, but this relay is
      // the protocol's, not the rail's: the SDK tracks it, and an artifact
      // rendering its own cards (presentation 'inline') needs it to show a
      // placeholder at all. Dropping it here when the composer replaced the
      // old path would have silently narrowed the contract to one consumer.
      postToArtifact({
        type: 'illuminate:dispatchCreated',
        payload: { dispatchId: body.dispatch_id, elementUid: note.target.uid },
      });
    }
  }
  noteTransport(true);
}

/**
 * The CURRENT artifact load's own token -- distinct from `chromeLoadToken`
 * (SERVE-09's chrome-SHELL supersession token, minted by `GET /session/:key`
 * and used only to authenticate THIS shell's own begin call below).
 * `artifact_load_token` is a second, independently-random 192-bit value
 * (load-token.ts's `issueChromeLoadToken`, reused for both mint sites) that
 * can never equal `chromeLoadToken` by construction -- every real
 * artifact->chrome postMessage (protocol.ts) carries THIS value, never
 * `chromeLoadToken`, and this is the only place that comparison must
 * happen. `null` until `beginArtifactLoadAndNavigate` below has actually
 * completed; `extractTypedIntent`/`isEndSessionSignal` are passed `''` in
 * that window, which can never equal a real (non-empty) token, so an
 * (impossible, but defensive) early message is safely rejected rather than
 * throwing on `null`.
 */
let artifactLoadToken: string | null = null;

/** Locates the sandboxed artifact iframe `handleOpenSession` (src/daemon/
 * server.ts) renders with no navigable `src` of its own -- this shell, not
 * the artifact (which cannot reach the daemon at all), is responsible for
 * performing the real begin handshake and only then addressing the iframe
 * at a genuinely fresh `(artifact_load_token, artifact_revision)` pair. */
function artifactFrame(): HTMLIFrameElement | null {
  const el = document.getElementById('illuminate-artifact-frame');
  return el instanceof HTMLIFrameElement ? el : null;
}

/**
 * The one chrome->artifact `postMessage` call site this file adds (07-04).
 * Target origin is the forced wildcard (`ARTIFACT_POST_TARGET_ORIGIN`, same
 * constant `src/sdk/post.ts` uses for the opposite direction) -- there is
 * no load token to attach here (protocol.ts's own documented asymmetry:
 * chrome always posts to the CURRENT iframe's `contentWindow` right after
 * updating `iframe.src`, so there is no "stale sender" problem to guard
 * against on this side). A no-op if the iframe is gone or has not loaded a
 * `contentWindow` yet (e.g. a superseded load whose iframe was replaced by
 * `showSupersededNotice`).
 */
function postToArtifact(message: ChromeToArtifactMessage): void {
  artifactFrame()?.contentWindow?.postMessage(message, ARTIFACT_POST_TARGET_ORIGIN);
}


/**
 * Uploads one attachment and returns the id the wire will carry, or `null`
 * if the daemon refused it.
 *
 * A refusal is a real, expected outcome -- an oversized screenshot or an
 * unsupported format -- and the daemon says which in its response, so the
 * reason is surfaced rather than reduced to "something went wrong".
 */
async function uploadAttachment(
  attachment: ComposerAttachmentInput,
): Promise<{ id: string; mediaType: string } | null> {
  try {
    const res = await fetch(`/api/${sessionKey}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataUrl: attachment.dataUrl }),
    });
    const body = (await res.json()) as { attachment_id?: unknown; media_type?: unknown; error?: unknown };
    if (res.status !== 200 || typeof body.attachment_id !== 'string') {
      const reason = typeof body.error === 'string' ? body.error : `upload failed (${String(res.status)})`;
      rail.addMessage('system', `Could not attach ${attachment.name}: ${reason}`);
      return null;
    }
    return {
      id: body.attachment_id,
      mediaType: typeof body.media_type === 'string' ? body.media_type : attachment.mediaType,
    };
  } catch {
    rail.addMessage('system', `Could not attach ${attachment.name}: the daemon did not respond.`);
    return null;
  }
}

/**
 * The element composer's whole round trip: upload any images, then either
 * dispatch immediately or hand the finished note to the rail unsent.
 *
 * Uploads run sequentially rather than concurrently. Three screenshots are
 * three small local writes, and doing them in order means a failure message
 * names the file that failed instead of arriving out of order beside two
 * successes.
 */
async function handleComposerSubmission(submission: ComposerSubmissionMessage): Promise<void> {
  const uploaded: { id: string; mediaType: string }[] = [];
  for (const attachment of submission.attachments) {
    const result = await uploadAttachment(attachment);
    if (result) uploaded.push(result);
  }

  // ADR-102: the queue row is keyed on the FIRST selected section (a row
  // names one place in the artifact), but carries the whole selection so a
  // queued note dispatches about everything the human had selected.
  const first = submission.targets[0];
  if (first === undefined) return;
  const target = {
    uid: first.element.uid,
    label: submission.label,
    targets: submission.targets as unknown as readonly Readonly<Record<string, unknown>>[],
    attachments: uploaded,
  };

  if (submission.mode === 'queue') {
    rail.addQueued({ intent: submission.intent, note: submission.note ?? '', target });
    return;
  }

  try {
    await sendQueuedNotes([{ id: 'immediate', intent: submission.intent, note: submission.note ?? '', target }]);
  } catch {
    noteTransport(false);
    rail.addMessage('system', 'That request never reached the daemon. Check the connection lamp, then try again.');
  }
}

/**
 * Shape-tolerant readers for the two sync bodies this file already fetches.
 *
 * Deliberately NOT `parseSyncAnnotations`/`parseSyncFindings` from
 * `src/sdk/protocol-in.ts`: those parse a postMessage ENVELOPE (they require
 * a `type` field and reject the whole payload if any entry is malformed),
 * which is right for the artifact's untrusted inbound boundary and wrong
 * here. This body came from the daemon's own same-origin HTTP route, and a
 * single odd record should degrade one row rather than blank the rail.
 *
 * Both return `null` rather than throwing, matching every other
 * best-effort path in this file.
 */
function parseAnnotationBody(body: unknown): WireAnnotationStore | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.cards)) return null;
  return b as unknown as WireAnnotationStore;
}

function parseFindingsBody(
  body: unknown,
): { findings: readonly WireFinding[]; watcherHealthy: boolean } | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.findings)) return null;
  const meta = b.meta;
  const watcherHealthy =
    typeof meta === 'object' && meta !== null && typeof (meta as Record<string, unknown>).watcherHealthy === 'boolean'
      ? ((meta as Record<string, unknown>).watcherHealthy as boolean)
      : true;
  return { findings: b.findings as readonly WireFinding[], watcherHealthy };
}

/**
 * Fetches the browser's own read path for its artifact's current set of
 * cards (`GET /api/:key/annotations`, 07-04) and relays the parsed body
 * into the sandboxed iframe as `illuminate:syncAnnotations`. Called both
 * right after the begin handshake lands (a best-effort early sync) and on
 * every heartbeat tick thereafter (see `HEARTBEAT_INTERVAL_MS` below) --
 * this project's deliberate choice to reuse the existing heartbeat cadence
 * for card delivery instead of a WebSocket (this plan's own design note).
 * Best-effort throughout, mirroring this file's other fetch calls: no
 * chrome-shell UI exists yet to surface a failed sync to.
 */
function syncAnnotations(): void {
  fetch(`/api/${sessionKey}/annotations`)
    .then((res) => {
      if (res.status !== 200) {
        noteTransport(false);
        return undefined;
      }
      return res.json().then((body: unknown) => {
        noteTransport(true);
        // The artifact still receives the full store: it owns the per-element
        // markers that show which elements have cards at all. The RAIL is now
        // where the card CONTENT renders -- a list can always be reached, where
        // a box positioned against a scrolled-away anchor cannot.
        postToArtifact({
          type: 'illuminate:syncAnnotations',
          payload: body as unknown as Readonly<Record<string, unknown>>,
        });
        // Re-asserted on every sync rather than once at boot: the SDK may
        // have booted after an earlier attempt, and the call is idempotent
        // (setPresentation returns immediately when the mode is unchanged).
        postToArtifact({ type: 'illuminate:setCardPresentation', payload: { mode: 'rail' } });
        const store = parseAnnotationBody(body);
        if (store) rail.setCards(store);
      });
    })
    .catch(() => {
      noteTransport(false);
    });
}

/**
 * Plan 08-04's own findings-delivery counterpart to `syncAnnotations`,
 * mirroring its exact shape: fetches the browser's own read path for its
 * artifact's current set of staleness findings (`GET /api/:key/findings`,
 * 08-04) and relays the parsed body into the sandboxed iframe as
 * `illuminate:syncFindings`. Called on the SAME heartbeat cadence as
 * `syncAnnotations` below -- this project's own established design note
 * (07-04's precedent, reused rather than a second interval or a WebSocket).
 * Best-effort throughout, mirroring this file's other fetch calls.
 */
function syncFindings(): void {
  fetch(`/api/${sessionKey}/findings`)
    .then((res) => {
      if (res.status !== 200) return undefined;
      return res.json().then((body: unknown) => {
        postToArtifact({
          type: 'illuminate:syncFindings',
          payload: body as unknown as Readonly<Record<string, unknown>>,
        });
        const parsed = parseFindingsBody(body);
        if (parsed) rail.setFindings(parsed.findings, parsed.watcherHealthy);
      });
    })
    .catch(() => {
      // Best-effort -- see this file's other fetch calls.
    });
}

/**
 * Surfaces `POST .../artifact-loads/begin`'s named take-over path
 * (T-03-09) in the browser for the first time: reloading THIS document
 * (this document IS `/session/:key`) re-mints a fresh `chromeLoadToken`
 * and supersedes whoever holds it now -- symmetric with the server's own
 * last-writer-wins semantics (load-token.ts's `openChromeSession` doc
 * comment), never a dead end.
 */
function showSupersededNotice(message: string): void {
  const frame = artifactFrame();
  const notice = document.createElement('div');
  notice.className = 'il-notice';
  notice.id = 'illuminate-superseded-notice';
  const title = document.createElement('div');
  title.className = 'il-notice-title';
  title.textContent = message;
  const takeOverButton = document.createElement('button');
  takeOverButton.type = 'button';
  takeOverButton.className = 'il-btn il-btn--primary';
  takeOverButton.textContent = 'Take over this review';
  takeOverButton.addEventListener('click', () => {
    window.location.reload();
  });
  notice.append(title, takeOverButton);
  setConnection('lost');
  // Fills the stage rather than replacing the iframe outright, so the rail
  // beside it stays mounted and whatever the human already queued is still
  // on screen while they decide whether to take over.
  const stage = document.getElementById('illuminate-stage');
  if (stage) {
    frame?.remove();
    stage.appendChild(notice);
  } else if (frame) {
    frame.replaceWith(notice);
  } else {
    document.body.appendChild(notice);
  }
}

/**
 * The real begin handshake this chrome shell was always missing (the first
 * of the two threat flags 06-10-SUMMARY.md/deferred-items.md documented):
 * `POST /api/:key/artifact-loads/begin` using the `chromeLoadToken` THIS
 * load just minted, then address the sandboxed iframe at the resulting,
 * genuinely fresh `(artifact_load_token, artifact_revision)` pair. A 409
 * `superseded` response (another tab won the mint/begin race) surfaces the
 * named take-over path instead of leaving the iframe permanently blank.
 */
async function beginArtifactLoadAndNavigate(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/${sessionKey}/artifact-loads/begin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chromeLoadToken }),
    });
  } catch {
    // Best-effort, mirrors this file's other fetch calls -- no chrome-shell
    // UI exists yet to retry a network failure from.
    return;
  }

  if (res.status === 200) {
    const body = (await res.json()) as { artifact_load_token: string; artifact_revision: number };
    artifactLoadToken = body.artifact_load_token;
    const frame = artifactFrame();
    if (frame) {
      // Claim card presentation the moment the artifact document is parsed,
      // not on the first heartbeat sync five seconds later. Waiting meant the
      // artifact rendered its own corner drawers and floating cards first and
      // then had them yanked -- a visible flash of superseded UI on every
      // load. The SDK's own default stays `inline`, which is what a
      // standalone exported artifact needs; this is the served session
      // saying otherwise, as early as it can be heard.
      frame.addEventListener(
        'load',
        () => {
          postToArtifact({ type: 'illuminate:setCardPresentation', payload: { mode: 'rail' } });
        },
        { once: true },
      );
      frame.src = `/artifact/${sessionKey}/?artifact_load_token=${encodeURIComponent(body.artifact_load_token)}&artifact_revision=${String(body.artifact_revision)}`;
    }
    // A best-effort early sync -- harmless if the SDK has not finished
    // booting yet and drops this message; the heartbeat-cadence sync below
    // covers that case on its own next tick regardless.
    syncAnnotations();
    return;
  }

  if (res.status === 409) {
    const body = (await res.json()) as { message?: unknown };
    const message = typeof body.message === 'string' ? body.message : 'This artifact is open in another window.';
    showSupersededNotice(message);
  }
  // 404 (unknown session) or any other unexpected status -- no shipped UI
  // to surface this to yet; left silent rather than crashing the shell.
}

/**
 * The one addEventListener('message', ...) this shell has -- JOIN-CONTRACT.md
 * §3's exact unclaimed-until-now logic. `extractTypedIntent`/
 * `isEndSessionSignal` are the whole trust boundary: anything both reject is
 * silently dropped, never forwarded to the daemon for the server to
 * re-validate alone (T-06-21). The artifact iframe is sandboxed with an
 * opaque origin and cannot reach the daemon itself (no `fetch` exists on
 * that side, by design -- see src/sdk/post.ts, the SDK's one
 * `parent.postMessage` call site); this chrome shell is the only place
 * either HTTP call is ever made.
 */
window.addEventListener('message', (event: MessageEvent) => {
  const currentLoadToken = artifactLoadToken ?? '';

  // Pointing at an element is checked FIRST because it is the most frequent
  // message and the cheapest to reject. It creates no dispatch and no queue
  // entry -- it only moves the rail composer's target -- so unlike every
  // other branch below there is nothing here for a replayed or hostile
  // message to actually cause.
  // The element composer submitting. Attachments still carry BYTES at this
  // point -- this is the only place they do -- so they are uploaded first
  // and replaced by ids before anything is dispatched or queued.
  const submission = extractComposerSubmission(event.data, currentLoadToken);
  if (submission) {
    void handleComposerSubmission(submission);
    return;
  }

  // Plan 08-04's dismiss action -- checked BEFORE extractTypedIntent below:
  // the two payload shapes riding the same illuminate:queuePrompt message
  // are mutually exclusive by `payload.protocol`, so checking order does not
  // affect correctness, but checking the smaller/cheaper shape first is more
  // legible. No chrome-shell UI exists yet to surface a failed dismiss to --
  // best-effort, mirroring every other fetch call in this file.
  const dismiss = extractDismissFinding(event.data, currentLoadToken);
  if (dismiss) {
    fetch(`/api/${sessionKey}/findings/${dismiss.fingerprint}/dismiss`, { method: 'POST' }).catch(() => {
      // Best-effort -- see this file's other fetch calls.
    });
    return;
  }

  const payload = extractTypedIntent(event.data, currentLoadToken);
  if (payload) {
    fetch(`/api/${sessionKey}/dispatches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then((res) => {
        if (res.status !== 200) return undefined;
        // Echoes the newly-created dispatch id back into the artifact
        // right after this dispatch POST resolves (07-04) -- the SDK/card
        // renderer can use this to show an immediate "pending" state for
        // the element that was just dispatched, ahead of the next
        // heartbeat-cadence `illuminate:syncAnnotations` sync.
        return res.json().then((body: unknown) => {
          const b = body as { dispatch_id?: unknown };
          if (typeof b.dispatch_id !== 'string') return;
          // The rail's own pending row. Every dispatch that does NOT come
          // from the rail's composer -- the intent picker, "go deeper",
          // "grade my understanding" -- arrives here, so this is the one
          // place that covers all of them. Without it those paths show no
          // pending state at all: the artifact's own placeholder is
          // suppressed while the rail owns card bodies, and only the
          // composer path calls addPending for itself.
          const primary = payload.targets[0];
          if (primary === undefined) return;
          rail.addPending(
            b.dispatch_id,
            primary.element.uid,
            // The rail row names the first selected section, and says how many
            // more rode along -- a row that lists all of them stops being a row.
            (primary.anchor?.src ?? `<${primary.element.tag}> ${primary.element.text.slice(0, 48)}`) +
              (payload.targets.length > 1 ? ` (+${String(payload.targets.length - 1)} more)` : ''),
            payload.intent,
          );
          postToArtifact({
            type: 'illuminate:dispatchCreated',
            payload: { dispatchId: b.dispatch_id, elementUid: primary.element.uid },
          });
        });
      })
      .catch(() => {
        // The "future phase's real chrome UI" this comment used to defer to
        // is the rail, and it exists now -- a dropped dispatch is no longer
        // silent. Still never rethrown: an unhandled rejection would be a
        // worse failure than a visible message.
        noteTransport(false);
        rail.addMessage(
          'system',
          'That request never reached the daemon. Check the connection lamp, then try again.',
        );
      });
    return;
  }

  // 06-12 wired POST /api/:key/end but left it uncalled from the browser
  // (06-12-SUMMARY.md's own documented gap). A stale-token endSession (a
  // superseded artifact load still holding a reference to this window) is
  // rejected by isEndSessionSignal exactly like a stale-token queuePrompt --
  // isFromCurrentArtifactLoad is the one check that makes the forced
  // wildcard postMessage target origin (ARTIFACT_POST_TARGET_ORIGIN) safe.
  if (isEndSessionSignal(event.data, currentLoadToken)) {
    fetch(`/api/${sessionKey}/end`, { method: 'POST' }).catch(() => {
      // Best-effort, mirrors the dispatch POST above and the heartbeat/
      // pagehide calls below -- no chrome-shell UI exists yet to surface a
      // failed request to.
    });
  }
});

/**
 * POLL-04's presence signal -- runs for as long as this page stays open.
 * Same-origin by construction (isSameOriginRequest, containment.ts): this
 * document IS served from the daemon's own origin. Also drives 07-04's
 * card-delivery sync on the SAME cadence (this plan's own design note: no
 * second `setInterval`, reusing this exact heartbeat tick instead of a
 * WebSocket).
 */
setInterval(() => {
  fetch(`/api/${sessionKey}/heartbeat`, { method: 'POST' })
    .then(() => {
      noteTransport(true);
    })
    .catch(() => {
      // A single missed heartbeat is exactly what BROWSER_DISCONNECT_GRACE_MS
      // exists to tolerate, which is why `noteTransport` only escalates to
      // `lost` on the second consecutive miss rather than the first.
      noteTransport(false);
    });
  syncAnnotations();
  // Plan 08-04's own design note: reuse this SAME heartbeat cadence for
  // findings delivery instead of a second interval or a WebSocket, exactly
  // as card delivery already does above.
  syncFindings();
}, HEARTBEAT_INTERVAL_MS);

/**
 * Immediate presence-loss signal on tab close/navigation -- sendBeacon
 * survives page unload where a `fetch` call would be aborted. No custom
 * headers/body needed: the heartbeat route's contract (06-07) already
 * accepts a bodyless POST.
 */
window.addEventListener('pagehide', () => {
  navigator.sendBeacon(`/api/${sessionKey}/heartbeat`);
});

// The real begin handshake this shell was always missing -- runs once, at
// script load. The iframe is inserted before this <script> tag (server.ts's
// handleOpenSession template), so document.getElementById above already
// finds it by the time this runs. Fire-and-forget from the top level: this
// classic script has no surrounding async context to await into.
/** The bar's file label. Read from the document title the daemon already
 * sets; purely cosmetic, and silent if the element is absent. */
const nameEl = document.getElementById('illuminate-artifact-name');
if (nameEl) nameEl.textContent = window.location.pathname;

void beginArtifactLoadAndNavigate();
