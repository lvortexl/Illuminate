import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { ensureDaemonRunning } from '../../src/daemon/orchestrate.ts';
import { readLock, isPidAlive } from '../../src/daemon/lock.ts';
import { lockPathFor } from '../../src/daemon/state-dir.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

/**
 * 06-11's own deferred-items.md left this exact gap: `test/cli-answer.test.ts`
 * / `test/cli-audit.test.ts` spawn a REAL, separate daemon subprocess via
 * `ensureDaemonRunning` (`src/daemon/orchestrate.ts`), which has no
 * injection seam for `DaemonServerOptions.isClaudeOnPathOverride` -- unlike
 * the in-process `createDaemonServer` tests (`dispatch-routes.test.ts`,
 * `end-session-route.test.ts`), which were fixed by passing that override
 * directly. On any machine with a real `claude` binary on PATH (true on
 * this dev host, since this very session runs inside it), those two
 * suites' dispatch-creation calls silently spawn a real, costly,
 * non-deterministic `claude -p` subprocess -- "harmless today only by
 * accident of how fast the tests' own direct HTTP calls race it"
 * (06-11-SUMMARY.md).
 *
 * This file proves the fix: `ILLUMINATE_DISABLE_SELF_DISPATCH=1`, read once
 * in `daemon-entry.ts` alongside `resolveIdleMs()`'s own precedent, makes a
 * REAL spawned daemon subprocess never even probe for `claude` on PATH, let
 * alone invoke it. Never spawns a real `claude` -- a fake, zero-cost,
 * deterministic stand-in `claude` executable (found via a PATH override
 * scoped to one spawned child, mirroring idle-e2e.test.ts's own
 * `ILLUMINATE_IDLE_TIMEOUT_MS`-via-`opts.env` precedent) records whether it
 * was ever invoked at all, for both the `--version` PATH probe
 * (active-polls.ts) and the real `-p` self-dispatch call (self-dispatch.ts).
 */

const HOST = '127.0.0.1';

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

/** Mirrors this suite's other integration files' shared cleanup helper. */
async function stopDaemon(artifactRoot: string): Promise<void> {
  const record = await readLock(lockPathFor(artifactRoot));
  if (!record) return;
  try {
    await fetch(`http://${HOST}:${record.port}/shutdown?token=${record.healthToken}`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // fall through to a direct signal below
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isPidAlive(record.pid)) {
    await sleep(25);
  }
  if (isPidAlive(record.pid)) {
    try {
      process.kill(record.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

/**
 * A fake `claude` that never runs a real model: it only proves WHETHER it
 * was invoked at all, by appending one line to `markerFile` every time it
 * runs -- for both the `--version` PATH probe (`stdio: 'ignore'`, so its
 * stdout is never read, only its exit code) and the real `-p
 * --output-format json` self-dispatch call (whose stdout IS read, so this
 * also emits a minimal valid JSON body). Zero cost, zero non-determinism,
 * unlike a real `claude` binary -- exactly what this fix exists to make
 * unnecessary for `cli-answer.test.ts`/`cli-audit.test.ts` to ever invoke.
 */
async function writeFakeClaude(binDir: string, markerFile: string): Promise<void> {
  if (process.platform === 'win32') {
    const script = [
      '@echo off',
      `>> "${markerFile}" echo invoked %*`,
      'if "%1"=="--version" (',
      '  echo 1.0.0-fake',
      '  exit /b 0',
      ')',
      'echo {"result":"fake self-dispatch answer","total_cost_usd":0}',
      'exit /b 0',
      '',
    ].join('\r\n');
    await writeFile(join(binDir, 'claude.cmd'), script, 'utf8');
  } else {
    const script = [
      '#!/bin/sh',
      `echo "invoked $*" >> "${markerFile}"`,
      'if [ "$1" = "--version" ]; then',
      '  echo "1.0.0-fake"',
      '  exit 0',
      'fi',
      'echo \'{"result":"fake self-dispatch answer","total_cost_usd":0}\'',
      'exit 0',
      '',
    ].join('\n');
    const scriptPath = join(binDir, 'claude');
    await writeFile(scriptPath, script, 'utf8');
    await chmod(scriptPath, 0o755);
  }
}

async function createSession(port: number, file: string): Promise<string> {
  const res = await fetch(`http://${HOST}:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file }),
  });
  const text = await res.text();
  assert.strictEqual(res.status, 200, `session creation failed: ${text}`);
  const { key } = JSON.parse(text) as { key: string };
  return key;
}

/** Enqueues a fresh dispatch with NO poll ever open for `key` -- the exact
 * `!activePolls.isActive(key)` condition server.ts gates self-dispatch on. */
async function enqueueDispatch(port: number, key: string): Promise<void> {
  const res = await fetch(`http://${HOST}:${port}/api/${key}/dispatches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intent: 'explain',
      targets: [{ element: { uid: 'u1', selector: '#u1', tag: 'p', text: 'task text for self-dispatch-disable-env' }, anchor: null }],
    }),
  });
  assert.strictEqual(res.status, 200, `enqueue failed: ${await res.text()}`);
}

async function markerAppearedWithin(markerFile: string, windowMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (existsSync(markerFile)) return true;
    await sleep(50);
  }
  return existsSync(markerFile);
}

test('control: with a fake claude on PATH and self-dispatch NOT disabled, a fresh dispatch with no active poll really invokes it', async () => {
  await withTempDir('illum-selfdispatch-control-root-', async (dir) => {
    await withTempDir('illum-selfdispatch-control-bin-', async (binDir) => {
      const markerFile = join(binDir, 'marker.txt');
      await writeFakeClaude(binDir, markerFile);
      try {
        const file = join(dir, 'artifact.html');
        await writeFile(file, '<!doctype html><html><body><p>hi</p></body></html>', 'utf8');
        const { port } = await ensureDaemonRunning(dir, {
          env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
        });
        const realFile = await realpath(file);
        const key = await createSession(port, realFile);
        await enqueueDispatch(port, key);

        const appeared = await markerAppearedWithin(markerFile, 5000);
        assert.ok(appeared, 'expected the fake claude to be invoked when self-dispatch is not disabled');
      } finally {
        await stopDaemon(dir);
      }
    });
  });
});

test('ILLUMINATE_DISABLE_SELF_DISPATCH=1 prevents a real spawned daemon subprocess from ever invoking claude for a fresh dispatch', async () => {
  await withTempDir('illum-selfdispatch-disabled-root-', async (dir) => {
    await withTempDir('illum-selfdispatch-disabled-bin-', async (binDir) => {
      const markerFile = join(binDir, 'marker.txt');
      await writeFakeClaude(binDir, markerFile);
      try {
        const file = join(dir, 'artifact.html');
        await writeFile(file, '<!doctype html><html><body><p>hi</p></body></html>', 'utf8');
        const { port } = await ensureDaemonRunning(dir, {
          env: {
            PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
            ILLUMINATE_DISABLE_SELF_DISPATCH: '1',
          },
        });
        const realFile = await realpath(file);
        const key = await createSession(port, realFile);
        await enqueueDispatch(port, key);

        const appeared = await markerAppearedWithin(markerFile, 3000);
        assert.strictEqual(
          appeared,
          false,
          'claude must never be invoked (not even the --version PATH probe) once self-dispatch is disabled',
        );
      } finally {
        await stopDaemon(dir);
      }
    });
  });
});

test('an unset or non-"1" ILLUMINATE_DISABLE_SELF_DISPATCH value leaves self-dispatch enabled -- impossible to disable by accident', async () => {
  await withTempDir('illum-selfdispatch-typo-root-', async (dir) => {
    await withTempDir('illum-selfdispatch-typo-bin-', async (binDir) => {
      const markerFile = join(binDir, 'marker.txt');
      await writeFakeClaude(binDir, markerFile);
      try {
        const file = join(dir, 'artifact.html');
        await writeFile(file, '<!doctype html><html><body><p>hi</p></body></html>', 'utf8');
        const { port } = await ensureDaemonRunning(dir, {
          env: {
            PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
            // A stray truthy-looking value must NOT disable self-dispatch --
            // only the exact string '1' does. This is the "impossible to
            // enable accidentally in production" requirement.
            ILLUMINATE_DISABLE_SELF_DISPATCH: 'true',
          },
        });
        const realFile = await realpath(file);
        const key = await createSession(port, realFile);
        await enqueueDispatch(port, key);

        const appeared = await markerAppearedWithin(markerFile, 5000);
        assert.ok(appeared, 'a non-"1" value must not disable self-dispatch');
      } finally {
        await stopDaemon(dir);
      }
    });
  });
});
