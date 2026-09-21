// NOTE: this test spawns the BUILT cli (`dist/cli.mjs`), so `npm run build`
// must run before `npm test`. CI enforces that ordering explicitly — do not
// reorder those steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('built CLI runs and exits 0 with no args', () => {
  const result = spawnSync(process.execPath, ['dist/cli.mjs'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /illuminate-axi/);
});

test('built CLI rejects an unrecognized flag with exit 1 and "unknown command"', () => {
  // Plan 03-04: any bare (non-flag) argument is now attempted as a file to
  // open (see test/cli-open.test.ts) -- this fallthrough is reachable only
  // for flag-shaped input that matched no known command above it.
  const result = spawnSync(process.execPath, ['dist/cli.mjs', '--nonsense'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /unknown command/);
});

test('built CLI treats a bare unrecognized argument as an attempted file to open, not an unknown command', () => {
  // Superseded by Plan 03-04's real front door: `illuminate <file.html>`.
  // A bare word that names no real command is no longer a dead end -- it is
  // an attempt to serve that path, and the CLI explains exactly why it
  // can't (here: wrong extension) rather than a generic "unknown command".
  const result = spawnSync(process.execPath, ['dist/cli.mjs', 'nonsense'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /\.html/i);
});
