import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createActivePolls, createClaudeOnPathProbe } from '../../src/daemon/active-polls.ts';
import type { ProbeSpawnFn } from '../../src/daemon/active-polls.ts';

/**
 * A minimal fake child process -- just enough surface for
 * `createClaudeOnPathProbe`'s probe (`.on('error'|'exit', ...)`), never a
 * real `claude` binary. Emitting is deferred to a microtask/macrotask via
 * the caller so tests can choose exactly which event fires.
 */
class FakeProbeChild extends EventEmitter {}

function spawnFnThatExits(code: number | null): ProbeSpawnFn {
  return () => {
    const child = new FakeProbeChild();
    setImmediate(() => child.emit('exit', code));
    return child;
  };
}

function spawnFnThatErrors(): ProbeSpawnFn {
  return () => {
    const child = new FakeProbeChild();
    setImmediate(() => child.emit('error', new Error('ENOENT: claude not found')));
    return child;
  };
}

function spawnFnThatThrowsSynchronously(): ProbeSpawnFn {
  return () => {
    throw new Error('spawn EACCES');
  };
}

// ---------------------------------------------------------------------------
// createActivePolls: count-based enter/exit/isActive
// ---------------------------------------------------------------------------

test('isActive is false before any enter()', () => {
  const activePolls = createActivePolls();
  assert.strictEqual(activePolls.isActive('key-1'), false);
});

test('enter() then isActive() is true; exit() after a matching enter() returns to false', () => {
  const activePolls = createActivePolls();
  activePolls.enter('key-1');
  assert.strictEqual(activePolls.isActive('key-1'), true);
  activePolls.exit('key-1');
  assert.strictEqual(activePolls.isActive('key-1'), false);
});

test('two concurrent enter() calls for the SAME key require two exit() calls before isActive goes false again', () => {
  const activePolls = createActivePolls();
  activePolls.enter('key-1');
  activePolls.enter('key-1');
  assert.strictEqual(activePolls.isActive('key-1'), true, 'still active after only one of two exits');
  activePolls.exit('key-1');
  assert.strictEqual(activePolls.isActive('key-1'), true, 'a single exit must not zero out a count of two');
  activePolls.exit('key-1');
  assert.strictEqual(activePolls.isActive('key-1'), false, 'the second matching exit must clear it');
});

test('exit() is never called more times than enter() -- extra exit() calls do not go negative or throw', () => {
  const activePolls = createActivePolls();
  activePolls.enter('key-1');
  activePolls.exit('key-1');
  activePolls.exit('key-1');
  activePolls.exit('key-1');
  assert.strictEqual(activePolls.isActive('key-1'), false);
});

test('different keys are tracked independently', () => {
  const activePolls = createActivePolls();
  activePolls.enter('key-1');
  assert.strictEqual(activePolls.isActive('key-1'), true);
  assert.strictEqual(activePolls.isActive('key-2'), false);
});

// ---------------------------------------------------------------------------
// createClaudeOnPathProbe: cached, injectable claude --version probe
// ---------------------------------------------------------------------------

test('isClaudeOnPath resolves true when the probe process exits 0', async () => {
  const isClaudeOnPath = createClaudeOnPathProbe();
  const result = await isClaudeOnPath(spawnFnThatExits(0));
  assert.strictEqual(result, true);
});

test('isClaudeOnPath resolves false when the probe process exits non-zero', async () => {
  const isClaudeOnPath = createClaudeOnPathProbe();
  const result = await isClaudeOnPath(spawnFnThatExits(1));
  assert.strictEqual(result, false);
});

test('isClaudeOnPath resolves false on a spawn error event (e.g. ENOENT -- claude not installed)', async () => {
  const isClaudeOnPath = createClaudeOnPathProbe();
  const result = await isClaudeOnPath(spawnFnThatErrors());
  assert.strictEqual(result, false);
});

test('isClaudeOnPath resolves false when spawnFn throws synchronously', async () => {
  const isClaudeOnPath = createClaudeOnPathProbe();
  const result = await isClaudeOnPath(spawnFnThatThrowsSynchronously());
  assert.strictEqual(result, false);
});

test('isClaudeOnPath caches the result after the first call -- a second call with a DIFFERENT spawnFn still returns the cached value', async () => {
  const isClaudeOnPath = createClaudeOnPathProbe();
  const first = await isClaudeOnPath(spawnFnThatExits(0));
  assert.strictEqual(first, true);

  // A spawnFn that would resolve false if actually invoked -- proves the
  // cache short-circuits before ever calling it again.
  let secondSpawnInvoked = false;
  const spawnFnNeverCalled: ProbeSpawnFn = () => {
    secondSpawnInvoked = true;
    return spawnFnThatExits(1)('claude', ['--version'], { stdio: 'ignore' });
  };

  const second = await isClaudeOnPath(spawnFnNeverCalled);
  assert.strictEqual(second, true, 'the cached true result must be returned, not a fresh probe');
  assert.strictEqual(secondSpawnInvoked, false, 'the probe must not run a second time within one process lifetime');
});

test('two independently-created probes each carry their own cache -- no cross-instance leakage', async () => {
  const probeA = createClaudeOnPathProbe();
  const probeB = createClaudeOnPathProbe();

  const resultA = await probeA(spawnFnThatExits(0));
  assert.strictEqual(resultA, true);

  const resultB = await probeB(spawnFnThatExits(1));
  assert.strictEqual(resultB, false, 'a fresh probe instance must not inherit another instance\'s cached result');
});
