import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextFollowAction, FOLLOW_BACKOFF_MS } from '../../src/cli/follow.ts';

test('a dispatch response continues immediately', () => {
  assert.deepStrictEqual(nextFollowAction('dispatch', 0), { kind: 'continue' });
});

test('a waiting response (only possible with --timeout-ms) continues immediately', () => {
  assert.deepStrictEqual(nextFollowAction('waiting', 3), { kind: 'continue' });
});

test('an ended session exits 0 with a one-line message', () => {
  const action = nextFollowAction('ended', 0);
  assert.strictEqual(action.kind, 'exit');
  if (action.kind !== 'exit') return;
  assert.strictEqual(action.code, 0);
  assert.match(action.message, /session has ended/);
});

test('the first disconnected response sleeps for the smallest back-off and says so once', () => {
  const action = nextFollowAction('browser_disconnected', 0);
  assert.strictEqual(action.kind, 'sleep');
  if (action.kind !== 'sleep') return;
  assert.strictEqual(action.ms, FOLLOW_BACKOFF_MS[0]);
  assert.match(action.notice ?? '', /not connected/);
});

test('back-off doubles per consecutive disconnected response and is capped at the last step, silently', () => {
  const second = nextFollowAction('browser_disconnected', 1);
  const capped = nextFollowAction('browser_disconnected', 40);
  assert.strictEqual(second.kind, 'sleep');
  assert.strictEqual(capped.kind, 'sleep');
  if (second.kind !== 'sleep' || capped.kind !== 'sleep') return;
  assert.strictEqual(second.ms, FOLLOW_BACKOFF_MS[1]);
  assert.strictEqual(capped.ms, FOLLOW_BACKOFF_MS[FOLLOW_BACKOFF_MS.length - 1]);
  assert.strictEqual(second.notice, null);
  assert.strictEqual(capped.notice, null);
});

test('the back-off ladder is 1s, 2s, 4s, 8s', () => {
  assert.deepStrictEqual([...FOLLOW_BACKOFF_MS], [1000, 2000, 4000, 8000]);
});
