import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tryListen, bindWithProbe, DEFAULT_PORT, PORT_PROBE_RANGE } from '../../src/daemon/bind.ts';

const BIND_TS_PATH = fileURLToPath(new URL('../../src/daemon/bind.ts', import.meta.url));
const HOST = '127.0.0.1';

function makeServer(): Server {
  return createServer((_req, res) => {
    res.end('ok');
  });
}

/** Binds a fresh server to an OS-assigned free port and returns both. */
async function occupyEphemeral(host = HOST): Promise<{ server: Server; port: number }> {
  const server = makeServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve());
    server.listen(0, host);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo from an ephemeral listen()');
  }
  return { server, port: address.port };
}

/** Binds a fresh server to an explicit port. Rejects with the real bind error if occupied. */
async function occupyPort(port: number, host = HOST): Promise<Server> {
  const server = makeServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve());
    server.listen(port, host);
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('DEFAULT_PORT and PORT_PROBE_RANGE match the locked A5 defaults', () => {
  assert.strictEqual(DEFAULT_PORT, 4319);
  assert.strictEqual(PORT_PROBE_RANGE, 10);
});

test('tryListen on a fresh unused port resolves ok', async () => {
  const server = makeServer();
  try {
    const result = await tryListen(server, 0, HOST);
    assert.strictEqual(result, 'ok');
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string' && address.port > 0);
  } finally {
    await closeServer(server);
  }
});

test('tryListen detects a real EADDRINUSE from two independent real servers on the same fixed port', async () => {
  const occupier = await occupyEphemeral();
  const contender = makeServer();
  try {
    const result = await tryListen(contender, occupier.port, HOST);
    assert.strictEqual(result, 'in-use');
  } finally {
    await closeServer(occupier.server);
    // contender never successfully bound, so it has nothing to close
  }
});

test('tryListen leaves a failed server instance reusable: attempt 1 EADDRINUSE, attempt 2 on the same object succeeds', async () => {
  const occupier = await occupyEphemeral();
  const server = makeServer();
  try {
    const first = await tryListen(server, occupier.port, HOST);
    assert.strictEqual(first, 'in-use');

    // Same `server` instance, different (free) port — proves tryListen does
    // not close/reset the server object on EADDRINUSE.
    const second = await tryListen(server, occupier.port + 1, HOST);
    assert.strictEqual(second, 'ok');
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string' && address.port === occupier.port + 1);
  } finally {
    await closeServer(occupier.server);
    await closeServer(server);
  }
});

test('bindWithProbe binds the first free port in range when the base port is occupied by a real listener', async () => {
  const occupier = await occupyEphemeral();
  const target = makeServer();
  try {
    const port = await bindWithProbe(target, occupier.port, HOST, PORT_PROBE_RANGE);
    assert.strictEqual(port, occupier.port + 1);
    const address = target.address();
    assert.ok(address !== null && typeof address !== 'string' && address.port === occupier.port + 1);
  } finally {
    await closeServer(occupier.server);
    await closeServer(target);
  }
});

test('bindWithProbe rejects clearly when the entire probe range is occupied by real listeners, without falling back to listen(0)', async () => {
  const base = await occupyEphemeral();
  const startPort = base.port;
  const range = 10;
  const occupiers: Server[] = [base.server];
  try {
    // base.server already holds startPort; occupy startPort+1..startPort+9 explicitly.
    for (let offset = 1; offset < range; offset++) {
      occupiers.push(await occupyPort(startPort + offset, HOST));
    }

    const target = makeServer();
    try {
      await assert.rejects(
        () => bindWithProbe(target, startPort, HOST, range),
        (err: Error) => {
          assert.match(err.message, /no free port in range/i);
          assert.match(err.message, new RegExp(`${startPort}-${startPort + range - 1}`));
          return true;
        },
      );
      // target must never have ended up listening on some port outside the range
      // (i.e. it did not silently fall through to an ephemeral listen(0, ...)).
      assert.strictEqual(target.listening, false);
    } finally {
      await closeServer(target);
    }
  } finally {
    for (const occupier of occupiers) {
      await closeServer(occupier);
    }
  }
});

test('tryListen treats EACCES as unavailable, not fatal -- Windows TCP exclusion ranges', async () => {
  // Windows maintains TCP exclusion ranges (netsh interface ipv4 show
  // excludedportrange protocol=tcp; populated by Hyper-V/WSL among others).
  // Binding inside one fails EACCES even though nothing is listening. If that
  // were fatal, bindWithProbe would abort the probe on a machine where the very
  // next port is free -- a real Windows-only crash. A real exclusion range
  // cannot be created without admin rights, so the OS error is injected here;
  // the EADDRINUSE sibling tests above use two genuinely real servers.
  const server = createServer();
  const originalListen = server.listen.bind(server);
  server.listen = (() => {
    const err: NodeJS.ErrnoException = new Error('listen EACCES: permission denied 127.0.0.1:50689');
    err.code = 'EACCES';
    queueMicrotask(() => server.emit('error', err));
    return server;
  }) as typeof server.listen;

  try {
    assert.strictEqual(await tryListen(server, 50689), 'in-use');
  } finally {
    server.listen = originalListen;
    server.close();
  }
});

test('tryListen still rejects a genuinely fatal bind error', async () => {
  const server = createServer();
  const originalListen = server.listen.bind(server);
  server.listen = (() => {
    const err: NodeJS.ErrnoException = new Error('listen EAFNOSUPPORT');
    err.code = 'EAFNOSUPPORT';
    queueMicrotask(() => server.emit('error', err));
    return server;
  }) as typeof server.listen;

  try {
    await assert.rejects(() => tryListen(server, 50690), /EAFNOSUPPORT/);
  } finally {
    server.listen = originalListen;
    server.close();
  }
});

test('bind.ts never shells out to lsof, ps, tasklist, or wmic', () => {
  const source = readFileSync(BIND_TS_PATH, 'utf8');
  assert.doesNotMatch(source, /lsof|tasklist|wmic|\bps\b/i);
});
