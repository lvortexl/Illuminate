import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // No webServer / baseURL (06-10-PLAN.md): each spec now manages its own
  // real daemon per-file via test.beforeAll/afterAll (e2e/real-daemon.ts's
  // startRealSession/stopRealSession), rather than one shared fixture server
  // Playwright itself launches and health-checks -- e2e/server.ts is
  // retired, and every spec builds its own absolute http://127.0.0.1:<port>
  // URLs since the real daemon's port varies per run (DEFAULT_PORT + a
  // bounded probe, src/daemon/bind.ts).
  //
  // workers: 1 -- every real daemon binds via the SAME fixed DEFAULT_PORT
  // probe range (src/daemon/bind.ts's bindWithProbe, 4319-4328). This
  // project already made the identical tradeoff for `node --test`
  // (package.json's `test` script runs `--test-concurrency=1`, for exactly
  // this reason). Serializing spec FILES the same way avoids two
  // concurrently-spawning daemons racing the same 10-port range, at the
  // cost of running this suite's 3 files one after another rather than in
  // parallel workers.
  workers: 1,
});
