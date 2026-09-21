import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IdleController } from '../../src/daemon/idle.ts';

const IDLE_TS_URL = pathToFileURL(fileURLToPath(new URL('../../src/daemon/idle.ts', import.meta.url))).href;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('onIdle fires within a generous window of construction when activeCount starts at 0', async () => {
  let fired = false;
  new IdleController(30, () => {
    fired = true;
  });
  // Real timer, not a mocked clock — allow generous scheduling jitter; the
  // point under test is "does it fire," not "does it fire at exactly 30ms".
  await sleep(150);
  assert.strictEqual(fired, true);
});

test('enter() called before the timer fires prevents onIdle from firing at all', async () => {
  let fired = false;
  const controller = new IdleController(30, () => {
    fired = true;
  });
  controller.enter();
  await sleep(100); // well past idleMs
  assert.strictEqual(fired, false);
});

test('enter() then exit() re-arms a fresh idle window measured from exit(), not from construction', async () => {
  let fired = false;
  const controller = new IdleController(80, () => {
    fired = true;
  });
  await sleep(20);
  controller.enter(); // cancels the original 80ms-from-construction timer
  await sleep(30); // t=50 since construction
  controller.exit(); // re-arms: should fire ~80ms from *this* call, i.e. ~t=130
  await sleep(50); // t=100 since construction, only 50ms since exit() — must not have fired yet
  assert.strictEqual(fired, false, 'must not fire before idleMs has elapsed since exit(), not construction');
  await sleep(80); // t=180 since construction, 130ms since exit() — safely past the re-armed deadline
  assert.strictEqual(fired, true, 'must fire roughly idleMs after the exit() call');
});

test('a connection landing just before fire time cancels onIdle, and a subsequent exit() still re-arms correctly', async () => {
  let fired = false;
  const idleMs = 20;
  const controller = new IdleController(idleMs, () => {
    fired = true;
  });

  // Timed to land just before the timer would fire — proves the recheck
  // is against genuinely-live state, not just "did schedule happen first".
  setTimeout(() => {
    controller.enter();
  }, idleMs - 5);

  await sleep(idleMs + 30); // well past the original fire time
  assert.strictEqual(fired, false, 'the entry landing before fire time must cancel onIdle');

  controller.exit(); // must correctly re-arm a fresh idle window afterward
  await sleep(idleMs + 30);
  assert.strictEqual(fired, true, 'exit() after a cancelled fire must still correctly re-arm');
});

test("the internal timer is unref'd — a very long idleMs does not keep the process alive", () => {
  const script = [
    `import { IdleController } from ${JSON.stringify(IDLE_TS_URL)};`,
    `new IdleController(10 * 60 * 1000, () => {});`,
    `console.log('exited-on-its-own');`,
  ].join('\n');
  // If the internal timer were not unref'd, this subprocess (and thus this
  // test) would hang for 10 minutes; the `timeout` is a safety net so a
  // regression fails fast instead of hanging the whole suite.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /exited-on-its-own/);
});
