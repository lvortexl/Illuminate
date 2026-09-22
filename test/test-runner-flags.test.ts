// The guards that keep a hung test from eating a CI job, asserted from the
// suite they protect.
//
// A Windows job once sat for five hours and fifty-eight minutes and was then
// cancelled at the six-hour default. It was not slow: one test file spawned a
// `poll --follow` child, an assertion failed before the line that killed it,
// and the live child's pipes held the file's process open. The cancellation
// is the expensive part -- every test file after that one was reported as
// failed-by-cancellation, so the run said nothing at all about the code.
//
// Three layers, because each one covers what the others miss:
//
//   1. The suite kills what it spawns. test/cli-poll.test.ts registers every
//      CLI child it starts and reaps them however the test ends. This is the
//      actual fix; the two below are the net for the next one nobody saw.
//   2. --test-timeout fails an individual test that stops making progress.
//   3. timeout-minutes on the CI job bounds the whole run from outside, where
//      nothing inside the suite can defeat it.
//
// Deliberately NOT used: --test-force-exit. It looks like the obvious answer
// and it is measurably wrong here -- on Windows it aborts the runner inside
// libuv ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", exit code
// 0xC0000409) for any file still closing a handle, which failed two
// previously-green test files. Layer 1 is what actually makes force-exit
// unnecessary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PACKAGE_JSON_PATH = fileURLToPath(new URL('../package.json', import.meta.url));
const CI_WORKFLOW_PATH = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));

test('the test script bounds every individual test with --test-timeout', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as { scripts?: Record<string, string> };
  const script = pkg.scripts?.test;
  assert.ok(typeof script === 'string' && script.length > 0, 'package.json must define a "test" script');
  const match = /--test-timeout[= ](\d+)/.exec(script);
  assert.ok(match, `expected --test-timeout in the test script, got: ${script}`);
  const timeoutMs = Number(match[1]);
  // Generous against the slowest test actually observed (about 8 s on
  // Windows CI) while still turning a stall into a failure inside a minute.
  assert.ok(timeoutMs > 0 && timeoutMs <= 120_000, `--test-timeout should be a bound worth having, got ${timeoutMs}ms`);
});

test('the test script does not use --test-force-exit, which aborts the runner on Windows', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as { scripts?: Record<string, string> };
  assert.doesNotMatch(pkg.scripts?.test ?? '', /--test-force-exit\b/, 'see this file\'s header: it crashes libuv on win32');
});

test('the CI job carries a timeout the suite itself cannot defeat', () => {
  const workflow = readFileSync(CI_WORKFLOW_PATH, 'utf8');
  const match = /^\s*timeout-minutes:\s*(\d+)\s*$/m.exec(workflow);
  assert.ok(match, 'expected a timeout-minutes on the CI job so a hang cannot run to the 6h default');
  const minutes = Number(match[1]);
  assert.ok(minutes > 0 && minutes <= 60, `timeout-minutes should bound the job usefully, got ${minutes}`);
});

test('the poll suite reaps every CLI child it spawns, whatever the test does', () => {
  // The layer the other two exist to back up. Asserted against the source
  // because the failure it prevents cannot be reproduced in-process: it needs
  // a test whose assertion fails before its own cleanup line.
  const pollSuite = readFileSync(fileURLToPath(new URL('./cli-poll.test.ts', import.meta.url)), 'utf8');
  assert.match(pollSuite, /function reapLiveChildren\(\)/, 'the poll suite must have a reaper');
  // Exactly one direct spawn() in the file: the one inside spawnCli(), which
  // is what registers the child with the reaper. A second would be a child
  // nothing is tracking.
  const directSpawns = pollSuite.match(/(?<![A-Za-z])spawn\(/g) ?? [];
  assert.strictEqual(
    directSpawns.length,
    1,
    `only spawnCli() may call spawn() directly, found ${directSpawns.length} call sites`,
  );
});
