import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { ensureDaemonRunning, portInUseDiagnostic } from '../../src/daemon/orchestrate.ts';
import { readLock } from '../../src/daemon/lock.ts';
import { lockPathFor } from '../../src/daemon/state-dir.ts';
import { DEFAULT_PORT, PORT_PROBE_RANGE } from '../../src/daemon/bind.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

const HOST = '127.0.0.1';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-foreign-port-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

async function occupyPort(port: number): Promise<Server> {
  const server = createServer((_, res) => res.end('not illuminate'));
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

/**
 * Port-choice note (per this plan's own guidance to document whichever
 * choice is made): daemon-entry.ts's real bind always starts its probe at
 * the hardcoded DEFAULT_PORT -- there is no override mechanism for the
 * *start* port (only ILLUMINATE_IDLE_TIMEOUT_MS is env-overridable, added
 * in this same plan's Task 2). So this test cannot redirect
 * ensureDaemonRunning to try a different base port; it must occupy the
 * real DEFAULT_PORT..DEFAULT_PORT+PORT_PROBE_RANGE-1 range for its
 * duration, identically to the precedent already established by
 * orchestrate.test.ts's "entire port range is held by a foreign process"
 * test. What makes this safe and deterministic rather than a source of
 * cross-file flakiness is Task 1's package.json change
 * (--test-concurrency=1): no other real daemon bind can be attempted by a
 * sibling test file while this one holds the whole range.
 */
test('a foreign process holding the entire probe range surfaces a clear diagnostic, and is never touched', async () => {
  await withTempDir(async (dir) => {
    const occupiers: Server[] = [];
    try {
      for (let offset = 0; offset < PORT_PROBE_RANGE; offset++) {
        occupiers.push(await occupyPort(DEFAULT_PORT + offset));
      }

      await assert.rejects(
        () => ensureDaemonRunning(dir),
        (err: Error) => {
          assert.match(err.message, /Port \d[\d-]* is in use by a process illuminate cannot identify/);
          assert.strictEqual(err.message, portInUseDiagnostic(DEFAULT_PORT, PORT_PROBE_RANGE));
          return true;
        },
      );

      // Never wrote a lockfile for this attempt.
      const record = await readLock(lockPathFor(dir));
      assert.strictEqual(record, null, 'a foreign occupant must never be treated as something illuminate "reclaimed"');

      // The core claim this file adds beyond orchestrate.test.ts's existing
      // coverage: every foreign listener is still up, genuinely untouched
      // -- illuminate never attempts to inspect or kill it.
      for (const server of occupiers) {
        assert.strictEqual(server.listening, true, 'a foreign occupant must never be touched, let alone killed');
      }
    } finally {
      for (const server of occupiers) {
        await closeServer(server);
      }
    }
  });
});
