import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnDaemon } from '../../src/daemon/spawn.ts';

// Fixture for test/daemon/spawn.test.ts's load-bearing parent-exit-
// survival test. Acts as the "parent" from spawnDaemon's perspective:
// launches long-running-child.mjs as a detached grandchild, then exits
// immediately — the test awaits this process's real 'exit' event before
// asserting the grandchild is still alive.
//
// Guarded against bare `node --test` auto-discovery the same way as
// long-running-child.mjs — see that file's comment. With no pid-file
// argument, exits immediately as a no-op.
const pidFilePath = process.argv[2];
if (!pidFilePath) {
  process.exit(0);
}

const childEntry = fileURLToPath(new URL('./long-running-child.mjs', import.meta.url));

// spawnDaemon returns the pid synchronously — write it here rather than
// relying on the grandchild to self-report, so there is no race between
// this wrapper exiting and the grandchild finishing its own startup. The
// grandchild also writes its own pid to the same path once it starts, as
// a same-value consistency check (see long-running-child.mjs).
const pid = spawnDaemon(childEntry, [pidFilePath]);
writeFileSync(pidFilePath, String(pid), 'utf8');

process.exit(0);
