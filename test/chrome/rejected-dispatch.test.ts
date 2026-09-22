import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rejectedDispatchNotice } from '../../src/chrome/rejected-dispatch.ts';

test('an object body with a string error field names that error', () => {
  assert.strictEqual(rejectedDispatchNotice(500, 'Internal Server Error', { error: 'synthetic failure' }), 'illuminate could not queue that request (HTTP 500): synthetic failure');
});

test('a JSON null body falls back to the status text instead of throwing', () => {
  assert.strictEqual(rejectedDispatchNotice(500, 'Internal Server Error', null), 'illuminate could not queue that request (HTTP 500): Internal Server Error');
});

test('a non-object body (a bare string) falls back to the status text', () => {
  assert.strictEqual(rejectedDispatchNotice(403, 'Forbidden', 'nope'), 'illuminate could not queue that request (HTTP 403): Forbidden');
});

test('an object body whose error field is not a string falls back to the status text', () => {
  assert.strictEqual(rejectedDispatchNotice(400, 'Bad Request', { error: 42 }), 'illuminate could not queue that request (HTTP 400): Bad Request');
});

test('an empty status text ends in "no detail"', () => {
  assert.strictEqual(rejectedDispatchNotice(500, '', {}), 'illuminate could not queue that request (HTTP 500): no detail');
});
