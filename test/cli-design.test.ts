// NOTE: this test spawns the BUILT cli (`dist/cli.mjs`), so `npm run build`
// must run before `npm test` -- same ordering requirement as smoke.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isAsciiOnly } from '../src/cli/output.ts';

test('illuminate design exits 0, is ASCII-only and non-empty, and points to playbook', () => {
  const result = spawnSync(process.execPath, ['dist/cli.mjs', 'design'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0);
  assert.ok(isAsciiOnly(result.stdout), 'stdout is not ASCII-only');
  assert.ok(result.stdout.length > 0);
  assert.match(result.stdout, /playbook/);
});
