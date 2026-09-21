import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkOwnership } from '../../src/daemon/ownership.ts';
import type { KillFn, LockRecord } from '../../src/daemon/lock.ts';

const OWNERSHIP_TS_PATH = fileURLToPath(new URL('../../src/daemon/ownership.ts', import.meta.url));
const HOST = '127.0.0.1';

function makeRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    pid: process.pid,
    port: 0,
    version: '0.1.0',
    startedAt: new Date().toISOString(),
    healthToken: 'test-token',
    ...overrides,
  };
}

/** Real minimal HTTP server answering GET /health with the given JSON body. */
async function serveHealth(body: unknown, status = 200): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve());
    server.listen(0, HOST);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo from an ephemeral listen()');
  }
  return { server, port: address.port };
}

/** Grabs a real free port and immediately releases it — genuinely nothing listens there. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve());
    server.listen(0, HOST);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo from an ephemeral listen()');
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function spawnAndAwaitDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const childPid = child.pid;
  assert.ok(childPid, 'child process must have a pid');
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  return childPid;
}

test('a dead pid resolves stale-pid-dead without ever making an HTTP call', async () => {
  const deadPid = await spawnAndAwaitDeadPid();
  const port = await freePort(); // genuinely nothing listening here
  const record = makeRecord({ pid: deadPid, port });

  const start = Date.now();
  const result = await checkOwnership(record, { timeoutMs: 500 });
  const elapsedMs = Date.now() - start;

  assert.deepStrictEqual(result, { status: 'stale-pid-dead' });
  // The pid-liveness check short-circuits before the fetch/health branch is
  // ever reached, so this resolves almost immediately rather than waiting
  // anywhere near the 500ms timeoutMs a real (or attempted) HTTP round trip
  // would be bounded by.
  assert.ok(elapsedMs < 200, `expected a near-instant resolution, took ${elapsedMs}ms`);
});

test('an alive pid with a matching health response is ours-and-healthy', async () => {
  const record = makeRecord();
  const { server, port } = await serveHealth({ pid: record.pid, healthToken: record.healthToken });
  try {
    const result = await checkOwnership({ ...record, port });
    assert.deepStrictEqual(result, { status: 'ours-and-healthy' });
  } finally {
    await closeServer(server);
  }
});

test('an alive pid whose health response has a mismatched healthToken is foreign-process-on-recorded-pid', async () => {
  const record = makeRecord();
  const { server, port } = await serveHealth({ pid: record.pid, healthToken: 'a-completely-different-token' });
  try {
    const result = await checkOwnership({ ...record, port });
    assert.deepStrictEqual(result, { status: 'foreign-process-on-recorded-pid' });
  } finally {
    await closeServer(server);
  }
});

test('an alive pid with nothing listening on the recorded port (real connection-refused) is foreign-process-on-recorded-pid', async () => {
  const port = await freePort();
  const record = makeRecord({ port });
  const result = await checkOwnership(record);
  assert.deepStrictEqual(result, { status: 'foreign-process-on-recorded-pid' });
});

// The A2 refinement, both halves, in one test. `killFn` is the one
// deliberately-injected branch (mirrors lock.test.ts's own EPERM test) since
// a real different-user-token process isn't reproducible on demand. Every
// other assertion here — the real dead server, the real mismatched
// healthToken response — is unmocked.
test('A2 both halves: an EPERM-alive pid is still subjected to the health-token cross-check and is reclaimable when it fails', async () => {
  const record = makeRecord();
  const { server, port } = await serveHealth({ pid: record.pid, healthToken: 'not-the-real-token' });
  try {
    const eperm: KillFn = () => {
      const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    };
    const result = await checkOwnership({ ...record, port }, { killFn: eperm });
    assert.deepStrictEqual(
      result,
      { status: 'foreign-process-on-recorded-pid' },
      'EPERM-alive must not short-circuit past the health-token cross-check',
    );
  } finally {
    await closeServer(server);
  }
});

test('ownership.ts never shells out to lsof, ps, tasklist, or wmic', () => {
  const source = readFileSync(OWNERSHIP_TS_PATH, 'utf8');
  assert.doesNotMatch(source, /lsof|tasklist|wmic|\bps\b/i);
});
