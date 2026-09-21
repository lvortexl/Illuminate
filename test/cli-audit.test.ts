// NOTE: this test spawns the BUILT cli (`dist/cli.mjs`), so `npm run build`
// must run before `npm test` -- same ordering requirement as smoke.test.ts.
//
// `illuminate audit <file.html>` renders `summarizeForAudit`'s totals plus
// a per-deviation and per-refusal line each (router/ingest.ts, 06-06) --
// never an answer body (T-06-19's accepted-risk mitigation, reinforced by
// this file's own marker check below).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDaemonRunning } from '../src/daemon/orchestrate.ts';
import { readLock, isPidAlive } from '../src/daemon/lock.ts';
import { lockPathFor } from '../src/daemon/state-dir.ts';
import { sessionKey } from '../src/store/session-store.ts';
import { isAsciiOnly } from '../src/cli/output.ts';
import { anchorHash } from '../src/provenance/hash.ts';
import { forceRemove } from './fixtures/cleanup.ts';

const ARTIFACT_CONTENT = '<!doctype html><html><body><p>hi</p></body></html>';

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-cli-audit-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

async function stopDaemon(artifactRoot: string): Promise<void> {
  const record = await readLock(lockPathFor(artifactRoot));
  if (!record) return;
  try {
    await fetch(`http://127.0.0.1:${record.port}/shutdown?token=${record.healthToken}`, {
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

async function setUpSession(dir: string): Promise<{ port: number; key: string; file: string }> {
  const file = join(dir, 'artifact.html');
  await writeFile(file, ARTIFACT_CONTENT);
  // ensureDaemonRunning spawns a REAL, separate daemon subprocess
  // (dist/daemon-entry.mjs) with no way to pass DaemonServerOptions
  // directly -- ILLUMINATE_DISABLE_SELF_DISPATCH is the env-gated seam
  // daemon-entry.ts reads instead (see its own doc comment), closing the
  // gap 06-11's deferred-items.md documented: on any machine with a real
  // `claude` binary on PATH (true on this dev host), every dispatch this
  // file enqueues would otherwise silently spawn a real, costly,
  // non-deterministic `claude -p` subprocess as a side effect.
  const { port } = await ensureDaemonRunning(dir, { env: { ILLUMINATE_DISABLE_SELF_DISPATCH: '1' } });
  const realFile = await realpath(file);
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: realFile }),
  });
  assert.strictEqual(res.status, 200);
  return { port, key: sessionKey(realFile), file };
}

/** `anchor` defaults to `null` (unanchored) for every existing call site.
 * 07-04's deterministic EDU-07 verify-shortcut now auto-answers an
 * unanchored (or otherwise ungroundable) `verify` dispatch synchronously,
 * at zero cost, before it can ever reach this file's own manual
 * `illuminate answer` CLI path -- so THIS file's one `verify` call site
 * below passes a real, groundable anchor instead, keeping that dispatch's
 * cost/token totals genuinely attributable to the manual answer this test
 * submits. */
async function enqueueDispatch(
  port: number,
  key: string,
  uid: string,
  intent: string,
  anchor: { src: string; rev: string | null; anchorHash: string } | null = null,
): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/${key}/dispatches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intent,
      element: { uid, selector: `#${uid}`, tag: 'p', text: `task text for ${uid}` },
      anchor,
    }),
  });
  const text = await res.text();
  assert.strictEqual(res.status, 200, `enqueue failed: ${text}`);
  const body = JSON.parse(text) as { dispatch_id: string };
  return body.dispatch_id;
}

function runAnswer(dispatchId: string, port: number, tier: string, extraFlags: readonly string[], stdin: string): number | null {
  const result = spawnSync(
    process.execPath,
    ['dist/cli.mjs', 'answer', '--dispatch', dispatchId, '--port', String(port), '--model', 'test-model', '--tier', tier, ...extraFlags, '--stdin'],
    { encoding: 'utf8', input: stdin },
  );
  return result.status;
}

function runAudit(file: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['dist/cli.mjs', 'audit', file], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('illuminate audit: missing <file.html> argument exits 1 with a short stderr message', () => {
  const result = spawnSync(process.execPath, ['dist/cli.mjs', 'audit'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /missing <file\.html>/);
});

test('illuminate audit <missing file> exits 1 and names the missing path', () => {
  const result = spawnSync(process.execPath, ['dist/cli.mjs', 'audit', 'does-not-exist-anywhere.html'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.ok(result.stderr.includes('does-not-exist-anywhere.html'));
});

test('illuminate audit <file.html> with no dispatches yet reports zero totals and "none" for both lists', async () => {
  await withTempDir(async (dir) => {
    try {
      const { file } = await setUpSession(dir);
      const result = runAudit(file);
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(isAsciiOnly(result.stdout), `stdout is not ASCII-only: ${JSON.stringify(result.stdout)}`);
      assert.match(result.stdout, /cost: \$0\.0000/);
      assert.match(result.stdout, /tokens: 0 in \/ 0 out/);
      assert.match(result.stdout, /deviations: none/);
      assert.match(result.stdout, /refusals: none/);
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('illuminate audit <file.html> sums cost/tokens across answered dispatches, lists a tier deviation, and never leaks any answer markdown', async () => {
  await withTempDir(async (dir) => {
    try {
      const { port, key, file } = await setUpSession(dir);

      const secretMarkdown1 = 'MARKER-AUDIT-EXPLAIN-MUST-NOT-LEAK';
      const secretMarkdown2 = 'MARKER-AUDIT-VERIFY-MUST-NOT-LEAK';
      const secretMarkdown3 = 'MARKER-AUDIT-FIXCODE-REJECTED-THEN-ANSWERED-MUST-NOT-LEAK';

      // dispatch 1: explain -> tutor/haiku, answered at a DIFFERENT tier
      // (sonnet) -- a non-implementer tier deviation (advisory, ROUT-05).
      const explainId = await enqueueDispatch(port, key, 'e-audit-1', 'explain');
      const explainStatus = runAnswer(
        explainId,
        port,
        'sonnet',
        ['--input-tokens', '100', '--output-tokens', '50', '--cache-read-input-tokens', '10', '--cost-usd', '0.01'],
        secretMarkdown1,
      );
      assert.strictEqual(explainStatus, 0);

      // dispatch 2: verify -> verifier/sonnet, answered at the SAME tier --
      // no deviation, just cost/tokens. Anchored to the real, on-disk
      // artifact.html (whole file, no git repo needed -- resolve()'s
      // no-git degraded path serves real working-tree content directly) so
      // isUngroundable is false and this dispatch is NOT auto-answered by
      // the EDU-07 shortcut -- this test's own point is the manual answer.
      const verifyId = await enqueueDispatch(port, key, 'e-audit-2', 'verify', {
        src: 'artifact.html',
        rev: null,
        anchorHash: anchorHash(ARTIFACT_CONTENT),
      });
      const verifyStatus = runAnswer(
        verifyId,
        port,
        'sonnet',
        ['--input-tokens', '200', '--output-tokens', '100', '--cache-read-input-tokens', '20', '--cost-usd', '0.02'],
        secretMarkdown2,
      );
      assert.strictEqual(verifyStatus, 0);

      // dispatch 3: fix-code -> implementer/opus, first answered BELOW the
      // opus floor (ROUT-06's hard refusal) -- ingestAnswer's own documented
      // contract leaves the ledger entry BYTE-FOR-BYTE UNCHANGED on a hard
      // refusal (test/router/ingest.test.ts: "a hard-refused fix-code
      // dispatch leaves status, answer, and tierDeviation completely
      // untouched"), so this dispatch is still open, not a terminal
      // 'refused' ledger status -- `summarizeForAudit`'s `refusals` array
      // is therefore correctly empty here; it is proven directly against a
      // synthetic AuditSummary below instead, since no real code path in
      // this system currently produces a `status: 'refused'` ledger entry
      // (mirrors ANCH-07's own documented "implemented to spec, currently
      // unreachable" precedent). What IS proven live here: the rejected
      // dispatch stays genuinely answerable afterward, at a valid tier.
      const fixCodeId = await enqueueDispatch(port, key, 'e-audit-3', 'fix-code');
      const rejectedStatus = runAnswer(fixCodeId, port, 'haiku', [], 'this attempt must be rejected, never recorded');
      assert.strictEqual(rejectedStatus, 1);
      const fixCodeStatus = runAnswer(
        fixCodeId,
        port,
        'opus',
        ['--input-tokens', '10', '--output-tokens', '5', '--cost-usd', '0.03'],
        secretMarkdown3,
      );
      assert.strictEqual(fixCodeStatus, 0, 'the dispatch must still be answerable at a valid tier after a hard refusal');

      const result = runAudit(file);
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(isAsciiOnly(result.stdout), `stdout is not ASCII-only: ${JSON.stringify(result.stdout)}`);

      assert.match(result.stdout, /cost: \$0\.0600/);
      assert.match(result.stdout, /tokens: 310 in \/ 155 out/);
      assert.match(result.stdout, /cache-read: 30/);

      assert.match(result.stdout, /deviations: 1/);
      assert.ok(result.stdout.includes(explainId), 'deviations section should name the explain dispatch id');
      assert.match(result.stdout, /expected haiku, reported sonnet/);
      assert.ok(!result.stdout.includes(verifyId), 'the matching-tier verify dispatch must not appear in deviations');
      assert.ok(!result.stdout.includes(fixCodeId), 'the eventually-valid fix-code dispatch must not appear in deviations (implementer floor met)');

      assert.match(result.stdout, /refusals: none/);

      for (const marker of [secretMarkdown1, secretMarkdown2, secretMarkdown3]) {
        assert.ok(!result.stdout.includes(marker), `audit output leaked an answer marker: ${marker}`);
      }
    } finally {
      await stopDaemon(dir);
    }
  });
});

test('renderAuditResult: lists every deviation and every refusal by dispatch id, reads only summarizeForAudit-documented fields, ASCII-only', async () => {
  const { renderAuditResult } = await import('../src/cli/output.ts');
  const rendered = renderAuditResult({
    totalCostUsd: 0.1234,
    totalTokensIn: 10,
    totalTokensOut: 20,
    totalCacheReadInputTokens: 5,
    deviations: [{ dispatchId: 'dev-1', expectedTier: 'haiku', reportedTier: 'opus' }],
    refusals: [{ dispatchId: 'ref-1', reason: 'implementer dispatch requires tier \'opus\' or higher' }],
  });
  assert.ok(isAsciiOnly(rendered), `rendered output is not ASCII-only: ${JSON.stringify(rendered)}`);
  assert.match(rendered, /cost: \$0\.1234/);
  assert.match(rendered, /deviations: 1/);
  assert.ok(rendered.includes('dev-1'));
  assert.match(rendered, /expected haiku, reported opus/);
  assert.match(rendered, /refusals: 1/);
  assert.ok(rendered.includes('ref-1'));
  assert.match(rendered, /implementer dispatch requires tier 'opus' or higher/);
});
