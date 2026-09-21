import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, PLAYBOOKS } from '../../src/cli/registry.ts';

// Duplicated one-line regex rather than importing forward from output.ts
// (Task 2, not yet owned by this task) -- see 04-04-PLAN.md Task 1's note.
function isAsciiOnly(text: string): boolean {
  return /^[\x00-\x7E]*$/.test(text);
}

test('COMMANDS has exactly 10 entries: open, stop, poll, answer, audit, export, --version, --help, design, playbook', () => {
  assert.strictEqual(COMMANDS.length, 10);
  const names = COMMANDS.map((c) => c.name);
  assert.deepStrictEqual(names, ['open', 'stop', 'poll', 'answer', 'audit', 'export', '--version', '--help', 'design', 'playbook']);
});

test('COMMANDS has no duplicate names', () => {
  const names = COMMANDS.map((c) => c.name);
  assert.strictEqual(new Set(names).size, names.length);
});

test('COMMANDS: every summary is non-empty and ASCII-only', () => {
  for (const command of COMMANDS) {
    assert.ok(command.summary.length > 0, `${command.name} has an empty summary`);
    assert.ok(isAsciiOnly(command.summary), `${command.name}'s summary is not ASCII-only`);
  }
});

test('PLAYBOOKS has exactly 4 entries: anchors, intents, stop, dispatches', () => {
  assert.strictEqual(PLAYBOOKS.length, 4);
  const ids = PLAYBOOKS.map((p) => p.id);
  assert.deepStrictEqual(ids, ['anchors', 'intents', 'stop', 'dispatches']);
});

test('PLAYBOOKS has no duplicate ids', () => {
  const ids = PLAYBOOKS.map((p) => p.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('PLAYBOOKS: every body array is non-empty, every line ASCII-only and free of trailing whitespace', () => {
  for (const playbook of PLAYBOOKS) {
    assert.ok(playbook.body.length > 0, `${playbook.id} has an empty body`);
    for (const line of playbook.body) {
      assert.ok(isAsciiOnly(line), `${playbook.id} has a non-ASCII line: ${JSON.stringify(line)}`);
      assert.strictEqual(line, line.replace(/\s+$/, ''), `${playbook.id} has trailing whitespace: ${JSON.stringify(line)}`);
    }
  }
});

test('PLAYBOOKS: every title is non-empty', () => {
  for (const playbook of PLAYBOOKS) {
    assert.ok(playbook.title.length > 0, `${playbook.id} has an empty title`);
  }
});
