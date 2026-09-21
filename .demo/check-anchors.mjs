// Drives every anchor in an artifact through illuminate's REAL resolve()
// pipeline -- the same code path the daemon uses -- and reports each status.
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { getRepoContext } from '../src/router/pool-registry.ts';
import { resolve } from '../src/provenance/resolve.ts';

const file = resolvePath(process.argv[2]);
const html = readFileSync(file, 'utf8');
const { repoRoot, pool } = getRepoContext(dirname(file));

const RE = /data-src="([^"]+)"\s+data-rev="([0-9a-f]+)"\s+data-anchor-hash="([0-9a-f]{16})"/g;
const rows = [...html.matchAll(RE)];
if (rows.length === 0) throw new Error('no anchors found');

let bad = 0;
for (const [, src, rev, anchorHash] of rows) {
  const i = src.indexOf('#L');
  const path = i === -1 ? src : src.slice(0, i);
  const range = i === -1 ? undefined : src.slice(i + 1);
  const r = await resolve(repoRoot, { path, range, rev, anchorHash }, pool);
  const ok = r.status === 'unchanged';
  if (!ok) bad++;
  const where = r.resolvedRange ? `L${r.resolvedRange.startLine}-L${r.resolvedRange.endLine}` : '-';
  console.log(
    `${ok ? 'OK  ' : 'BAD '} ${r.status.padEnd(16)} stale-eligible=${String(r.eligibleForStaleness).padEnd(5)} ${where.padEnd(12)} ${src}${r.reason ? '  <- ' + r.reason : ''}`,
  );
}
pool.close();
console.log(`\n${rows.length - bad}/${rows.length} anchors resolve unchanged`);
process.exit(bad === 0 ? 0 : 1);
