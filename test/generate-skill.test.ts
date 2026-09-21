// GUID-02: proves both that the generator is deterministic and that
// scripts/build.mjs's drift check genuinely fails the build on a stale
// stub and genuinely passes on a correctly generated one -- via real
// subprocesses, not just the pure functions in isolation. Every corruption
// scenario below uses a mkdtemp'd throwaway path via
// ILLUMINATE_SKILL_STUB_PATH (Task 1/2's override), so a failing assertion
// can never leave the repository's own committed skills/illuminate/SKILL.md
// corrupted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSkillMarkdown, checkSkillStub, writeSkillStub, SKILL_STUB_PATH } from '../scripts/generate-skill.mjs';
import { COMMANDS, PLAYBOOKS } from '../src/cli/registry.ts';
import { forceRemove } from './fixtures/cleanup.ts';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-generate-skill-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

test('renderSkillMarkdown is deterministic -- same inputs produce byte-identical output', () => {
  const first = renderSkillMarkdown(COMMANDS, PLAYBOOKS);
  const second = renderSkillMarkdown(COMMANDS, PLAYBOOKS);
  assert.strictEqual(first, second);
});

test('renderSkillMarkdown lists exactly the real playbook ids, sourced from PLAYBOOKS', () => {
  const rendered = renderSkillMarkdown(COMMANDS, PLAYBOOKS);
  const ids = PLAYBOOKS.map((p) => p.id).join(', ');
  assert.match(rendered, new RegExp(`ids: ${ids}\\)`));
  assert.strictEqual(ids, 'anchors, intents, stop, dispatches');
});

test('checkSkillStub against the real, committed skill stub reports in sync', () => {
  const result = checkSkillStub(SKILL_STUB_PATH, COMMANDS, PLAYBOOKS);
  assert.deepStrictEqual(result, { ok: true, message: `${SKILL_STUB_PATH} is in sync` });
});

test('checkSkillStub against a file holding arbitrary garbage text reports drift', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'SKILL.md');
    await writeFile(path, 'this is not generated content\n', 'utf8');
    const result = checkSkillStub(path, COMMANDS, PLAYBOOKS);
    assert.strictEqual(result.ok, false);
  });
});

test('checkSkillStub against a path that was never written reports missing', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'never-written-SKILL.md');
    const result = checkSkillStub(path, COMMANDS, PLAYBOOKS);
    assert.strictEqual(result.ok, false);
  });
});

test('checkSkillStub against a file written via writeSkillStub reports in sync (round trip)', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'SKILL.md');
    writeSkillStub(path, COMMANDS, PLAYBOOKS);
    const result = checkSkillStub(path, COMMANDS, PLAYBOOKS);
    assert.strictEqual(result.ok, true);
  });
});

test('npm run build genuinely fails when ILLUMINATE_SKILL_STUB_PATH points at a stale stub', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'SKILL.md');
    await writeFile(path, 'stale garbage, not what the generator produces\n', 'utf8');

    const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, ILLUMINATE_SKILL_STUB_PATH: path },
    });

    assert.notStrictEqual(result.status, 0, `expected non-zero exit, got ${result.status}. stderr: ${result.stderr}`);
    assert.match(result.stderr, /is stale/);
  });
});

test('npm run build genuinely passes when ILLUMINATE_SKILL_STUB_PATH points at a freshly generated stub', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'SKILL.md');
    writeSkillStub(path, COMMANDS, PLAYBOOKS);

    const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, ILLUMINATE_SKILL_STUB_PATH: path },
    });

    assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  });
});
