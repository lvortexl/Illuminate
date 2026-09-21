import type { Server } from 'node:http';

/**
 * Fixed default port, chosen (RESEARCH.md §3.3, decision A5) to avoid
 * collision with common dev-server ports (3000, 5173, 8080, 4200) and with
 * the reference implementation's own default (4387) that a machine with
 * both tools installed might also be running.
 */
export const DEFAULT_PORT = 4319;

/** Width of the fixed fallback range probed from DEFAULT_PORT (or a caller-supplied start). */
export const PORT_PROBE_RANGE = 10;

/**
 * Attempts to bind `server` to `port`/`host`. Resolves `'ok'` on success,
 * `'in-use'` when the OS says the port is unavailable, and rejects for any
 * other bind error. On `'in-use'` the server is left unbound (not listening)
 * and is safe for the caller to retry on a different port — see `bindWithProbe`.
 *
 * Two OS codes mean "unavailable, try the next one":
 *   - `EADDRINUSE` — another process holds it.
 *   - `EACCES`     — Windows refuses the bind outright. This is NOT only a
 *     privileged-port case: Windows maintains TCP *exclusion ranges* (see
 *     `netsh interface ipv4 show excludedportrange protocol=tcp`, populated by
 *     Hyper-V/WSL among others) and binding inside one fails with EACCES even
 *     though nothing is listening. Treating that as fatal would abort the probe
 *     on a machine where the very next port is free.
 */
export async function tryListen(server: Server, port: number, host = '127.0.0.1'): Promise<'ok' | 'in-use'> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') return resolve('in-use');
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve('ok');
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Probes `startPort..startPort+range-1` in order and binds `server` to the
 * first free port found, returning that port. Bounded by `range` — never
 * falls through to an ephemeral `listen(0, ...)` and never loops forever
 * (RESEARCH.md §3.3, decision A5: fixed default + bounded probe, not
 * ephemeral). Rejects with a clear error if the entire range is occupied.
 */
export async function bindWithProbe(
  server: Server,
  startPort: number = DEFAULT_PORT,
  host = '127.0.0.1',
  range: number = PORT_PROBE_RANGE,
): Promise<number> {
  for (let offset = 0; offset < range; offset++) {
    const port = startPort + offset;
    const result = await tryListen(server, port, host);
    if (result === 'ok') return port;
  }
  throw new Error(`No free port in range ${startPort}-${startPort + range - 1}`);
}
