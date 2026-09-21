import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPollResult } from '../../src/cli/output.ts';
import { isAsciiOnly } from '../../src/cli/output.ts';
import type { DispatchElement, DispatchEnvelope, PollResponse } from '../../src/router/types.ts';

/**
 * `illuminate poll`'s stdout is the ONLY thing a CLI-polling agent ever sees
 * of a dispatch. Whatever this renderer omits does not exist as far as that
 * agent is concerned, no matter how faithfully the wire carried it.
 *
 * That is not hypothetical: the chrome rail's composer shipped writing the
 * human's note all the way into the envelope, and this renderer printed only
 * `id / role / tier / intent / source`. An agent polling for work saw
 * "explain  src/foo.ts:1-20", had no idea what had actually been asked, and
 * would have answered a question nobody put. These tests exist so that the
 * next field added to a dispatch cannot be invisible in the same way.
 */

const PORT = 4319;

const element: DispatchElement = {
  uid: 'e1',
  selector: '#main > p:nth-child(2)',
  tag: 'p',
  text: 'some text',
  prefixContext: null,
  suffixContext: null,
};

function envelope(overrides: Partial<DispatchEnvelope> = {}): DispatchEnvelope {
  return {
    protocol: 'illuminate.dispatch/2',
    dispatch_id: 'd1',
    intent: 'explain',
    role: 'tutor',
    model_tier: 'haiku',
    deadline_ms: 30000,
    targets: [{ element, source: null }],
    return_to: 'illuminate answer d1',
    return_contract: 'run the command above, piping your markdown answer to stdin',
    tools: [],
    depth: 1,
    parent_dispatch: null,
    learnerNote: null,
    note: null,
    attachments: [],
    ...overrides,
  };
}

function poll(...dispatches: DispatchEnvelope[]): PollResponse {
  return { status: 'dispatch', dispatches };
}

test('a note reaches the polling agent verbatim', () => {
  const out = renderPollResult(poll(envelope({ note: 'Which line actually proves this?' })), PORT);
  assert.match(out, /note: Which line actually proves this\?/);
});

test('a long note is never truncated -- a half-quoted instruction is worse than none', () => {
  const long =
    'This paragraph claims the router cannot be influenced by model output, but it does not say ' +
    'which test proves it, and I want the exact assertion named rather than a summary of one.';
  const out = renderPollResult(poll(envelope({ note: long })), PORT);
  assert.ok(out.includes(long), 'the full note text must survive rendering');
});

test('a multi-line note stays readable, one indented line per line', () => {
  const out = renderPollResult(poll(envelope({ note: 'first line\nsecond line' })), PORT);
  assert.match(out, /^ {2}note: first line$/m);
  assert.match(out, /^ {2}note: second line$/m);
  // The escape sequence itself must never appear -- that would mean the note
  // was printed as JSON-ish text rather than as lines.
  assert.ok(!out.includes('\\n'), 'a newline must be rendered, not escaped');
});

test('a CRLF note leaves no stray carriage return', () => {
  const out = renderPollResult(poll(envelope({ note: 'first\r\nsecond' })), PORT);
  assert.ok(!out.includes('\r'), `stray CR in output: ${JSON.stringify(out)}`);
});

test('a learner explanation is labelled distinctly from a note', () => {
  // The two carry different instructions -- one is to be answered, the other
  // GRADED against resolved source -- so an agent must be able to tell them
  // apart without inspecting the wire.
  const out = renderPollResult(poll(envelope({ learnerNote: 'I think it returns a string.' })), PORT);
  assert.match(out, /their explanation: I think it returns a string\./);
  assert.ok(!out.includes('note: I think'), 'a learner explanation must not be printed as an ordinary note');
});

test('both can appear on one dispatch without being confused', () => {
  const out = renderPollResult(poll(envelope({ note: 'the ask', learnerNote: 'my attempt' })), PORT);
  assert.match(out, /^ {2}note: the ask$/m);
  assert.match(out, /^ {2}their explanation: my attempt$/m);
});

test('an absent or empty note prints nothing at all', () => {
  for (const value of [null, '']) {
    const out = renderPollResult(poll(envelope({ note: value })), PORT);
    assert.ok(!out.includes('note:'), `an empty note must print no label: ${JSON.stringify(out)}`);
  }
});

test('the answer command still follows the human words, so it stays the last thing read', () => {
  const out = renderPollResult(poll(envelope({ note: 'the ask' })), PORT);
  const noteIndex = out.indexOf('  note: the ask');
  const commandIndex = out.indexOf('  -> illuminate answer');
  assert.ok(noteIndex >= 0 && commandIndex >= 0);
  assert.ok(noteIndex < commandIndex, 'the note must be read before the command that answers it');
});

test('rendering a note keeps the output ASCII-only and free of raw JSON', () => {
  const out = renderPollResult(poll(envelope({ note: 'plain words', learnerNote: 'more words' })), PORT);
  assert.ok(isAsciiOnly(out), `stdout is not ASCII-only: ${JSON.stringify(out)}`);
  // The two existing contracts this renderer already held.
  assert.ok(!out.includes('{'), 'poll output must never print raw JSON');
  assert.ok(!out.includes('"'), 'poll output must never print raw JSON');
});

test('several dispatches each keep their own note', () => {
  const out = renderPollResult(
    poll(
      envelope({ dispatch_id: 'd1', note: 'first ask' }),
      envelope({ dispatch_id: 'd2', note: 'second ask' }),
    ),
    PORT,
  );
  assert.match(out, /^ {2}note: first ask$/m);
  assert.match(out, /^ {2}note: second ask$/m);
});
