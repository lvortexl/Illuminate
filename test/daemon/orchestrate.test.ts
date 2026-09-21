import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, request, type Server } from 'node:http';
import { ensureDaemonRunning, portInUseDiagnostic } from '../../src/daemon/orchestrate.ts';
import { readLock, isPidAlive } from '../../src/daemon/lock.ts';
import { lockPathFor } from '../../src/daemon/state-dir.ts';
import { DEFAULT_PORT, PORT_PROBE_RANGE } from '../../src/daemon/bind.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

const HOST = '127.0.0.1';

const ORCHESTRATE_TS_PATH = fileURLToPath(new URL('../../src/daemon/orchestrate.ts', import.meta.url));
const SERVER_TS_PATH = fileURLToPath(new URL('../../src/daemon/server.ts', import.meta.url));
const DAEMON_ENTRY_TS_PATH = fileURLToPath(new URL('../../src/daemon/daemon-entry.ts', import.meta.url));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-orchestrate-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

/**
 * Stops a real daemon spawned during a test via the same token-checked
 * /shutdown route illuminate's own `stop` command uses, falling back to
 * SIGTERM. Used in `finally` blocks so no test can leak a live daemon
 * process into the rest of the suite.
 */
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

/** A raw (non-fetch) GET so a `Host` header can be forged -- fetch() treats Host as forbidden. */
function rawGetWithHost(port: number, path: string, hostHeader: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port, path, method: 'GET', headers: { Host: hostHeader } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function occupyPort(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve());
    server.listen(port, HOST);
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('ensureDaemonRunning spawns fresh on a directory with no lockfile, then attaches to the same daemon on a second call', async () => {
  await withTempDir(async (dir) => {
    try {
      const first = await ensureDaemonRunning(dir);
      assert.strictEqual(first.attached, false);
      assert.ok(Number.isInteger(first.port) && first.port > 0);

      const second = await ensureDaemonRunning(dir);
      assert.strictEqual(second.attached, true);
      assert.strictEqual(second.port, first.port);
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('the spawned daemon really serves GET /health with the exact contract checkOwnership relies on', async () => {
  await withTempDir(async (dir) => {
    try {
      const { port } = await ensureDaemonRunning(dir);
      const res = await fetch(`http://${HOST}:${port}/health`);
      assert.strictEqual(res.status, 200);
      const body = (await res.json()) as { pid: number; port: number; healthToken: string };
      const record = await readLock(lockPathFor(dir));
      assert.ok(record);
      assert.strictEqual(body.pid, record.pid);
      assert.strictEqual(body.port, record.port);
      assert.strictEqual(body.healthToken, record.healthToken);
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('the spawned daemon serves a real asset file from the artifact root', async () => {
  await withTempDir(async (dir) => {
    try {
      await writeFile(join(dir, 'index.html'), '<h1>hello illuminate</h1>', 'utf8');
      const { port } = await ensureDaemonRunning(dir);
      const res = await fetch(`http://${HOST}:${port}/index.html`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(await res.text(), '<h1>hello illuminate</h1>');
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('a request with a disallowed Host header is rejected 403 before any routing, even for /health', async () => {
  await withTempDir(async (dir) => {
    try {
      const { port } = await ensureDaemonRunning(dir);
      const result = await rawGetWithHost(port, '/health', 'evil.example.com');
      assert.strictEqual(result.status, 403);
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('POST /shutdown with a wrong token is rejected 403 and the daemon keeps running', async () => {
  await withTempDir(async (dir) => {
    try {
      const { port } = await ensureDaemonRunning(dir);
      const res = await fetch(`http://${HOST}:${port}/shutdown?token=not-the-real-token`, { method: 'POST' });
      assert.strictEqual(res.status, 403);

      const health = await fetch(`http://${HOST}:${port}/health`);
      assert.strictEqual(health.status, 200);
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('POST /shutdown with the correct token shuts the daemon down and cleans up the lockfile', async () => {
  await withTempDir(async (dir) => {
    const { port } = await ensureDaemonRunning(dir);
    const record = await readLock(lockPathFor(dir));
    assert.ok(record);

    const res = await fetch(`http://${HOST}:${port}/shutdown?token=${record.healthToken}`, { method: 'POST' });
    assert.strictEqual(res.status, 200);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && isPidAlive(record.pid)) {
      await sleep(25);
    }
    assert.strictEqual(isPidAlive(record.pid), false, 'daemon process must actually exit after /shutdown');

    const afterLock = await readLock(lockPathFor(dir));
    assert.strictEqual(afterLock, null, '/shutdown must clean up the lockfile before exiting');
  });
});

test('ensureDaemonRunning reclaims a stale lockfile (dead pid) and spawns fresh, without treating the dead pid as evidence of anything', async () => {
  await withTempDir(async (dir) => {
    try {
      await ensureDaemonRunning(dir);
      const staleRecord = await readLock(lockPathFor(dir));
      assert.ok(staleRecord);

      // SIGKILL bypasses registerCleanupHandlers entirely, leaving a real
      // stale lockfile behind -- the exact "previous run crashed or was
      // taskkill'd" scenario RESEARCH.md §3.2 step 3 describes.
      process.kill(staleRecord.pid, 'SIGKILL');
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && isPidAlive(staleRecord.pid)) {
        await sleep(25);
      }
      assert.strictEqual(isPidAlive(staleRecord.pid), false);

      const stillThere = await readLock(lockPathFor(dir));
      assert.ok(stillThere, 'SIGKILL must not have cleaned up the lockfile -- this is the point of the test');

      const second = await ensureDaemonRunning(dir);
      assert.strictEqual(second.attached, false, 'a dead-pid lockfile must be reclaimed, not attached to');

      const newRecord = await readLock(lockPathFor(dir));
      assert.ok(newRecord);
      assert.notStrictEqual(newRecord.pid, staleRecord.pid);
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('the daemon self-stops via the idle controller when ILLUMINATE_IDLE_TIMEOUT_MS elapses with no open connections, sharing the same shutdown routine as /shutdown', async () => {
  await withTempDir(async (dir) => {
    const hadEnv = Object.prototype.hasOwnProperty.call(process.env, 'ILLUMINATE_IDLE_TIMEOUT_MS');
    const original = process.env.ILLUMINATE_IDLE_TIMEOUT_MS;
    process.env.ILLUMINATE_IDLE_TIMEOUT_MS = '150';
    try {
      const { port } = await ensureDaemonRunning(dir);
      const record = await readLock(lockPathFor(dir));
      assert.ok(record);

      // Prove it's genuinely up first.
      const health = await fetch(`http://${HOST}:${port}/health`);
      assert.strictEqual(health.status, 200);

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && isPidAlive(record.pid)) {
        await sleep(50);
      }
      assert.strictEqual(
        isPidAlive(record.pid),
        false,
        'daemon must self-stop once genuinely idle past the configured timeout',
      );

      const afterLock = await readLock(lockPathFor(dir));
      assert.strictEqual(
        afterLock,
        null,
        'idle self-stop must clean up the lockfile via the same shutdown routine as /shutdown',
      );
    } finally {
      if (hadEnv) process.env.ILLUMINATE_IDLE_TIMEOUT_MS = original;
      else delete process.env.ILLUMINATE_IDLE_TIMEOUT_MS;
      await stopDaemon(dir); // no-op if already stopped
    }
  });
});

test('ensureDaemonRunning refuses and explains when the entire port range is held by a foreign process, with no lockfile involved', async () => {
  await withTempDir(async (dir) => {
    const occupiers: Server[] = [];
    try {
      for (let offset = 0; offset < PORT_PROBE_RANGE; offset++) {
        occupiers.push(await occupyPort(DEFAULT_PORT + offset));
      }

      await assert.rejects(
        () => ensureDaemonRunning(dir),
        (err: Error) => {
          assert.strictEqual(err.message, portInUseDiagnostic(DEFAULT_PORT, PORT_PROBE_RANGE));
          assert.match(err.message, /Get-NetTCPConnection/);
          assert.match(err.message, /netstat/);
          assert.doesNotMatch(err.message.toLowerCase(), /\b(lsof|tasklist|wmic)\b/);
          return true;
        },
      );

      // Never wrote a lockfile for this attempt -- illuminate must never
      // treat a foreign occupant as something it "reclaimed".
      const record = await readLock(lockPathFor(dir));
      assert.strictEqual(record, null);
    } finally {
      for (const server of occupiers) {
        await closeServer(server);
      }
    }
  });
});

test('orchestrate.ts, server.ts, and daemon-entry.ts never shell out to lsof, ps, tasklist, or wmic', () => {
  for (const path of [ORCHESTRATE_TS_PATH, SERVER_TS_PATH, DAEMON_ENTRY_TS_PATH]) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /lsof|tasklist|wmic|\bps\b/i);
  }
});
