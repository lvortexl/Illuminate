import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertSession } from '../../src/store/session-store.ts';
import type { IlluminateState, SessionRecord } from '../../src/store/session-store.ts';
import { openChromeSession, beginArtifactLoad, verifyArtifactLoad } from '../../src/daemon/load-token.ts';

const KEY = 'session-key-1';
const FILE = 'artifact.html';

/** A state with exactly one freshly upserted session under KEY. */
function stateWithSession(): IlluminateState {
  const { next } = upsertSession({ sessions: {} }, KEY, FILE);
  return next;
}

test('openChromeSession on a state with the session mints a fresh, non-empty token and stores it', () => {
  const state = stateWithSession();
  const { next, result } = openChromeSession(state, KEY);

  assert.strictEqual(result.status, 'ok');
  if (result.status !== 'ok') throw new Error('unreachable');
  assert.ok(typeof result.chromeLoadToken === 'string' && result.chromeLoadToken.length > 0);
  assert.strictEqual(next.sessions[KEY]?.chromeLoadToken, result.chromeLoadToken);
});

test('openChromeSession on an unknown key returns not-found and performs no mutation', () => {
  const state = stateWithSession();
  const { next, result } = openChromeSession(state, 'no-such-key');

  assert.deepStrictEqual(result, { status: 'not-found' });
  assert.strictEqual(next, state, 'no mutation on a miss');
});

test('supersession: a second openChromeSession invalidates the first chromeLoadToken for beginArtifactLoad', () => {
  const state0 = stateWithSession();

  const open1 = openChromeSession(state0, KEY);
  assert.strictEqual(open1.result.status, 'ok');
  const firstToken = open1.result.status === 'ok' ? open1.result.chromeLoadToken : '';

  const open2 = openChromeSession(open1.next, KEY);
  assert.strictEqual(open2.result.status, 'ok');
  const secondToken = open2.result.status === 'ok' ? open2.result.chromeLoadToken : '';

  assert.notStrictEqual(firstToken, secondToken, 'two opens mint two different tokens');
  assert.strictEqual(open2.next.sessions[KEY]?.chromeLoadToken, secondToken, 'only the second token is stored');
  assert.notStrictEqual(open2.next.sessions[KEY]?.chromeLoadToken, firstToken);

  const stateAfterBothOpens = open2.next;

  const beginWithFirst = beginArtifactLoad(stateAfterBothOpens, KEY, firstToken);
  assert.deepStrictEqual(beginWithFirst.result, { status: 'superseded' });

  const beginWithSecond = beginArtifactLoad(stateAfterBothOpens, KEY, secondToken);
  assert.strictEqual(beginWithSecond.result.status, 'ok');
  if (beginWithSecond.result.status !== 'ok') throw new Error('unreachable');
  assert.strictEqual(beginWithSecond.result.artifactRevision, 1);
  assert.ok(typeof beginWithSecond.result.artifactLoadToken === 'string' && beginWithSecond.result.artifactLoadToken.length > 0);
});

test('beginArtifactLoad on an unknown key returns not-found', () => {
  const state = stateWithSession();
  const { next, result } = beginArtifactLoad(state, 'no-such-key', 'irrelevant-token');

  assert.deepStrictEqual(result, { status: 'not-found' });
  assert.strictEqual(next, state);
});

test('two sequential beginArtifactLoad calls using the CURRENT chromeLoadToken (tab reload) each increment artifactRevision and mint a different artifactLoadToken', () => {
  const state0 = stateWithSession();
  const open = openChromeSession(state0, KEY);
  assert.strictEqual(open.result.status, 'ok');
  const chromeLoadToken = open.result.status === 'ok' ? open.result.chromeLoadToken : '';

  const begin1 = beginArtifactLoad(open.next, KEY, chromeLoadToken);
  assert.strictEqual(begin1.result.status, 'ok');
  if (begin1.result.status !== 'ok') throw new Error('unreachable');
  assert.strictEqual(begin1.result.artifactRevision, 1);

  const begin2 = beginArtifactLoad(begin1.next, KEY, chromeLoadToken);
  assert.strictEqual(begin2.result.status, 'ok');
  if (begin2.result.status !== 'ok') throw new Error('unreachable');
  assert.strictEqual(begin2.result.artifactRevision, 2);

  assert.notStrictEqual(
    begin1.result.artifactLoadToken,
    begin2.result.artifactLoadToken,
    'each begin mints a fresh artifactLoadToken even on the same tab',
  );
});

test('take-over path: a superseded tab can re-open the session itself and supersede the tab that superseded it -- never a dead end', () => {
  const state0 = stateWithSession();

  // Tab A opens.
  const openA = openChromeSession(state0, KEY);
  assert.strictEqual(openA.result.status, 'ok');
  const tokenA = openA.result.status === 'ok' ? openA.result.chromeLoadToken : '';

  // Tab B opens, superseding A.
  const openB = openChromeSession(openA.next, KEY);
  assert.strictEqual(openB.result.status, 'ok');
  const tokenB = openB.result.status === 'ok' ? openB.result.chromeLoadToken : '';

  // A is now superseded.
  const beginA_superseded = beginArtifactLoad(openB.next, KEY, tokenA);
  assert.deepStrictEqual(beginA_superseded.result, { status: 'superseded' });

  // A takes over by opening the session again -- this is the take-over path.
  const openA_again = openChromeSession(openB.next, KEY);
  assert.strictEqual(openA_again.result.status, 'ok');
  const tokenA2 = openA_again.result.status === 'ok' ? openA_again.result.chromeLoadToken : '';
  assert.notStrictEqual(tokenA2, tokenA, 'take-over mints a THIRD, fresh token');
  assert.notStrictEqual(tokenA2, tokenB);

  // B is now superseded in turn -- supersession is symmetric.
  const beginB_superseded_now = beginArtifactLoad(openA_again.next, KEY, tokenB);
  assert.deepStrictEqual(beginB_superseded_now.result, { status: 'superseded' });

  // A's subsequent beginArtifactLoad with the new token succeeds.
  const beginA_succeeds = beginArtifactLoad(openA_again.next, KEY, tokenA2);
  assert.strictEqual(beginA_succeeds.result.status, 'ok');
});

test('verifyArtifactLoad returns true only when BOTH the token and the revision match the record', () => {
  const record: SessionRecord = {
    key: KEY,
    file: FILE,
    createdAt: new Date().toISOString(),
    artifactRevision: 5,
    chromeLoadToken: 'chrome-tok',
    artifactLoadToken: 'artifact-tok',
    queue: [],
    dispatches: {},
    browserLastSeenAt: null,
    sessionEndedAt: null,
  };

  assert.strictEqual(verifyArtifactLoad(record, 'artifact-tok', 5), true);
});

test('verifyArtifactLoad returns false when the token is right but the revision is wrong', () => {
  const record: SessionRecord = {
    key: KEY,
    file: FILE,
    createdAt: new Date().toISOString(),
    artifactRevision: 5,
    chromeLoadToken: 'chrome-tok',
    artifactLoadToken: 'artifact-tok',
    queue: [],
    dispatches: {},
    browserLastSeenAt: null,
    sessionEndedAt: null,
  };

  assert.strictEqual(verifyArtifactLoad(record, 'artifact-tok', 6), false);
});

test('verifyArtifactLoad returns false when the revision is right but the token is wrong', () => {
  const record: SessionRecord = {
    key: KEY,
    file: FILE,
    createdAt: new Date().toISOString(),
    artifactRevision: 5,
    chromeLoadToken: 'chrome-tok',
    artifactLoadToken: 'artifact-tok',
    queue: [],
    dispatches: {},
    browserLastSeenAt: null,
    sessionEndedAt: null,
  };

  assert.strictEqual(verifyArtifactLoad(record, 'wrong-tok', 5), false);
});

test('verifyArtifactLoad returns false when the record is undefined -- callers never need a separate not-found check', () => {
  assert.strictEqual(verifyArtifactLoad(undefined, 'any-token', 1), false);
});

test('double-read guard: verifyArtifactLoad(tokenX, revisionX) flips from true to false once a second beginArtifactLoad lands mid-read', () => {
  const state0 = stateWithSession();
  const open = openChromeSession(state0, KEY);
  assert.strictEqual(open.result.status, 'ok');
  const chromeLoadToken = open.result.status === 'ok' ? open.result.chromeLoadToken : '';

  const begin1 = beginArtifactLoad(open.next, KEY, chromeLoadToken);
  assert.strictEqual(begin1.result.status, 'ok');
  if (begin1.result.status !== 'ok') throw new Error('unreachable');
  const { artifactLoadToken: tokenX, artifactRevision: revisionX } = begin1.result;

  // Verified once, right after the load -- true.
  const currentRecord = begin1.next.sessions[KEY];
  assert.strictEqual(verifyArtifactLoad(currentRecord, tokenX, revisionX), true);

  // A second window loads mid-read (same chrome tab token still authorizes it).
  const begin2 = beginArtifactLoad(begin1.next, KEY, chromeLoadToken);
  assert.strictEqual(begin2.result.status, 'ok');

  // Re-verifying the ORIGINAL (tokenX, revisionX) pair against the NEW current
  // record must now detect the change -- this is the exact double-read guard
  // Plan 03-03's route handler depends on.
  const newCurrentRecord = begin2.next.sessions[KEY];
  assert.strictEqual(verifyArtifactLoad(newCurrentRecord, tokenX, revisionX), false);
});
