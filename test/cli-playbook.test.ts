// NOTE: this test spawns the BUILT cli (`dist/cli.mjs`), so `npm run build`
// must run before `npm test` -- same ordering requirement as smoke.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('illuminate playbook with no id exits 0 and lists all 3 real ids', () => {
  const result = spawnSync(process.execPath, ['dist/cli.mjs', 'playbook'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /anchors/);
  assert.match(result.stdout, /intents/);
  assert.match(result.stdout, /stop/);
});

test('illuminate playbook anchors exits 0 and prints only the anchors playbook', () => {
  const result = spawnSync(process.execPath, ['dist/cli.mjs', 'playbook', 'anchors'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /Authoring anchors/);
  assert.match(result.stdout, /data-anchor-hash/);
  // Must not leak the intents playbook's own content.
  assert.ok(!result.stdout.includes('postMessage'), 'anchors playbook leaked intents content');
});

test('illuminate playbook nonsense exits 1, stderr names the unknown id, stdout still lists the valid ids', () => {
  const result = spawnSync(process.execPath, ['dist/cli.mjs', 'playbook', 'nonsense'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /unknown id/);
  assert.match(result.stdout, /anchors/);
  assert.match(result.stdout, /intents/);
  assert.match(result.stdout, /stop/);
});
