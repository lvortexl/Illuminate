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

test('PLAYBOOKS has exactly 5 entries: anchors, intents, stop, dispatches, attach', () => {
  assert.strictEqual(PLAYBOOKS.length, 5);
  const ids = PLAYBOOKS.map((p) => p.id);
  assert.deepStrictEqual(ids, ['anchors', 'intents', 'stop', 'dispatches', 'attach']);
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

test('COMMANDS: the answer usage names every flag answerCommand refuses to run without (CLI-01)', () => {
  const answer = COMMANDS.find((c) => c.name === 'answer');
  assert.ok(answer, 'answer command missing');
  for (const flag of ['--dispatch <id>', '--port <port>', '--model <name>', '--tier <haiku|sonnet|opus>', '--stdin']) {
    assert.ok(answer.usage.includes(flag), `answer usage lacks ${flag}: ${answer.usage}`);
  }
});

test('PLAYBOOKS: the dispatches playbook documents the cost flags illuminate audit sums (CLI-07)', () => {
  const dispatches = PLAYBOOKS.find((p) => p.id === 'dispatches');
  assert.ok(dispatches, 'dispatches playbook missing');
  const body = dispatches.body.join('\n');
  for (const flag of ['--input-tokens', '--output-tokens', '--cache-read-input-tokens', '--cost-usd', '--wall-ms']) {
    assert.ok(body.includes(flag), `dispatches playbook never mentions ${flag}`);
  }
});

test('PLAYBOOKS: the attach playbook describes poll --follow\'s end states (exit 0 on ended, back-off while the browser is gone)', () => {
  const attach = PLAYBOOKS.find((p) => p.id === 'attach');
  assert.ok(attach, 'attach playbook missing');
  const body = attach.body.join('\n');
  assert.ok(body.includes('exits 0'), 'attach playbook never says --follow exits 0 when the session ends');
  assert.ok(body.includes('backs off'), 'attach playbook never says --follow backs off while the browser is gone');
  assert.ok(body.includes('--tier <haiku|sonnet|opus>'), 'attach playbook must enumerate the tiers like every other description');
});
