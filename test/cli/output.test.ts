import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAsciiOnly,
  wrapLine,
  renderHelp,
  renderDesign,
  renderPlaybookIndex,
  renderPlaybook,
} from '../../src/cli/output.ts';
import { COMMANDS, PLAYBOOKS } from '../../src/cli/registry.ts';

test('isAsciiOnly: true for a string containing only bytes 0x00-0x7E', () => {
  assert.strictEqual(isAsciiOnly('hello world 123 !@#$%^&*()_+-=[]{}|;:,.<>?'), true);
  assert.strictEqual(isAsciiOnly(''), true);
});

test('isAsciiOnly: false for an em dash, a box-drawing character, or an emoji', () => {
  assert.strictEqual(isAsciiOnly('em—dash'), false);
  assert.strictEqual(isAsciiOnly('│box'), false);
  assert.strictEqual(isAsciiOnly('emoji\u{1F600}'), false);
});

test('wrapLine: no line in the result exceeds maxWidth, and rejoining with spaces recovers the original content', () => {
  const input = 'a '.repeat(200);
  const wrapped = wrapLine(input, 20);
  for (const line of wrapped) {
    assert.ok(line.length <= 20, `line exceeds 20 chars: ${JSON.stringify(line)}`);
  }
  assert.strictEqual(wrapped.join(' '), input);
});

test('renderHelp: real registry data fits <=20 lines, each <=100 columns, ASCII-only, points to design and playbook', () => {
  const help = renderHelp(COMMANDS);
  assert.ok(isAsciiOnly(help), 'renderHelp output is not ASCII-only');
  const lines = help.split('\n').filter((l) => l.length > 0);
  assert.ok(lines.length <= 20, `renderHelp produced ${lines.length} lines, expected <=20`);
  for (const line of lines) {
    assert.ok(line.length <= 100, `renderHelp line exceeds 100 columns: ${JSON.stringify(line)}`);
  }
  assert.match(help, /design/);
  assert.match(help, /playbook/);
});

test('renderHelp: a usage longer than the 32-column pad is wrapped -- usage on its own line, summary indented beneath it, every line still <=100 columns (ADR-112)', () => {
  const longUsage = 'illuminate answer --dispatch <id> --port <port> --model <name> --tier <haiku|sonnet|opus> --stdin';
  const help = renderHelp([{ name: 'answer', usage: longUsage, summary: 'Submit an answer via stdin; needs no session key.' }]);
  const lines = help.split('\n');
  assert.ok(lines.includes(`  ${longUsage}`), `usage line missing: ${help}`);
  assert.ok(lines.includes(`${' '.repeat(35)}Submit an answer via stdin; needs no session key.`), `summary line missing: ${help}`);
  for (const line of lines) {
    assert.ok(line.length <= 100, `renderHelp line exceeds 100 columns: ${JSON.stringify(line)}`);
  }
});

test('renderHelp: a usage that fits the pad still renders on one line', () => {
  const help = renderHelp([{ name: 'design', usage: 'illuminate design', summary: 'Why illuminate is built this way.' }]);
  assert.ok(help.includes(`  ${'illuminate design'.padEnd(32)} Why illuminate is built this way.`), help);
});

test('renderDesign: ASCII-only, non-empty, points to playbook', () => {
  const design = renderDesign();
  assert.ok(isAsciiOnly(design), 'renderDesign output is not ASCII-only');
  assert.ok(design.length > 0);
  assert.match(design, /playbook/);
});

test('renderPlaybookIndex: lists every real id, ASCII-only, and is not a dump of any single playbook body', () => {
  const index = renderPlaybookIndex(PLAYBOOKS);
  assert.ok(isAsciiOnly(index), 'renderPlaybookIndex output is not ASCII-only');
  for (const playbook of PLAYBOOKS) {
    assert.match(index, new RegExp(playbook.id));
  }
  for (const playbook of PLAYBOOKS) {
    for (const line of playbook.body) {
      // Blank lines are a legitimate formatting device inside a body and
      // carry no content, so they cannot "leak" -- and `includes('')` is
      // vacuously true, which would make this assertion unfalsifiable.
      if (line.length === 0) continue;
      assert.ok(!index.includes(line), `renderPlaybookIndex leaked a body line from '${playbook.id}': ${JSON.stringify(line)}`);
    }
  }
});

test("renderPlaybook('anchors'): contains that entry's title and every body line, and none of the other entries' content", () => {
  const anchorsEntry = PLAYBOOKS.find((p) => p.id === 'anchors');
  const intentsEntry = PLAYBOOKS.find((p) => p.id === 'intents');
  const stopEntry = PLAYBOOKS.find((p) => p.id === 'stop');
  assert.ok(anchorsEntry);
  assert.ok(intentsEntry);
  assert.ok(stopEntry);

  const rendered = renderPlaybook(anchorsEntry);
  assert.match(rendered, /Authoring anchors/);
  for (const line of anchorsEntry.body) {
    assert.ok(rendered.includes(line), `renderPlaybook('anchors') is missing body line: ${JSON.stringify(line)}`);
  }
  for (const line of intentsEntry.body) {
    assert.ok(!rendered.includes(line), `renderPlaybook('anchors') leaked intents content: ${JSON.stringify(line)}`);
  }
  for (const line of stopEntry.body) {
    assert.ok(!rendered.includes(line), `renderPlaybook('anchors') leaked stop content: ${JSON.stringify(line)}`);
  }
});
