import { writeFileSync } from 'node:fs';

// Fixture for test/daemon/spawn.test.ts: a real subprocess that stays
// alive until SIGTERM, used to prove spawnDaemon's parent-exit survival
// semantics with a genuine grandchild process, not an assumption.
//
// Guarded against bare `node --test` auto-discovery — any file living
// under a directory named `test` (this one included, via test/fixtures/)
// is a candidate test file by Node's default discovery glob, the same way
// test/fixtures/git-repo.ts already is. With no pid-file argument, this
// exits immediately as a harmless no-op instead of hanging the suite.
const pidFilePath = process.argv[2];
if (!pidFilePath) {
  process.exit(0);
}

writeFileSync(pidFilePath, String(process.pid), 'utf8');

// Deliberately NOT unref'd — the child itself must stay alive for the test
// to observe it, until SIGTERM tells it to stop.
const interval = setInterval(() => {}, 1000);

process.on('SIGTERM', () => {
  clearInterval(interval);
  process.exit(0);
});
