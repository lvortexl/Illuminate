// NOTE: this test spawns the BUILT cli (`dist/cli.mjs`), so `npm run build`
// must run before `npm test` -- same ordering requirement as smoke.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isAsciiOnly } from '../src/cli/output.ts';

test('illuminate --help exits 0, is ASCII-only, fits <=20 lines, and points to design and playbook', () => {
  const result = spawnSync(process.execPath, ['dist/cli.mjs', '--help'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0);
  assert.ok(isAsciiOnly(result.stdout), 'stdout is not ASCII-only');
  const lines = result.stdout.split('\n').filter((l) => l.length > 0);
  assert.ok(lines.length <= 20, `stdout has ${lines.length} lines, expected <=20`);
  assert.match(result.stdout, /design/);
  assert.match(result.stdout, /playbook/);
});

test('illuminate -h behaves identically to --help', () => {
  const result = spawnSync(process.execPath, ['dist/cli.mjs', '-h'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0);
  assert.ok(isAsciiOnly(result.stdout), 'stdout is not ASCII-only');
  const lines = result.stdout.split('\n').filter((l) => l.length > 0);
  assert.ok(lines.length <= 20, `stdout has ${lines.length} lines, expected <=20`);
  assert.match(result.stdout, /design/);
  assert.match(result.stdout, /playbook/);
});
