import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, sessionStorePathFor, upsertSession } from '../../src/store/session-store.ts';
import { openChromeSession, beginArtifactLoad } from '../../src/daemon/load-token.ts';
import { readArtifactWithFreshnessGuard } from '../../src/daemon/artifact-load.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

async function withStore<T>(fn: (ctx: { store: SessionStore; root: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'illum-artifact-load-'));
  const store = new SessionStore(root);
  try {
    return await fn({ store, root });
  } finally {
    await rm(sessionStorePathFor(root), { force: true });
    await forceRemove(root);
  }
}

const KEY = 'artifact-load-key-1';
const FILE = 'artifact.html';

/** Seeds a fresh session and completes one full open -> begin handshake, returning the live token+revision. */
async function seedBegunSession(store: SessionStore): Promise<{ artifactLoadToken: string; artifactRevision: number }> {
  await store.mutate((state) => upsertSession(state, KEY, FILE));
  const opened = await store.mutate((state) => openChromeSession(state, KEY));
  if (opened.status !== 'ok') throw new Error('unreachable');
  const begun = await store.mutate((state) => beginArtifactLoad(state, KEY, opened.chromeLoadToken));
  if (begun.status !== 'ok') throw new Error('unreachable');
  return { artifactLoadToken: begun.artifactLoadToken, artifactRevision: begun.artifactRevision };
}

test('readArtifactWithFreshnessGuard returns ok with the record and html for a matching token+revision', async () => {
  await withStore(async ({ store }) => {
    const { artifactLoadToken, artifactRevision } = await seedBegunSession(store);
    let readCount = 0;
    const result = await readArtifactWithFreshnessGuard({
      store,
      key: KEY,
      artifactLoadToken,
      artifactRevision,
      readFile: async () => {
        readCount++;
        return '<html>content</html>';
      },
    });
    assert.strictEqual(result.status, 'ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    assert.strictEqual(result.html, '<html>content</html>');
    assert.strictEqual(result.record.key, KEY);
    assert.strictEqual(readCount, 1);
  });
});

test('readArtifactWithFreshnessGuard returns expired BEFORE ever calling readFile when the token/revision do not match', async () => {
  await withStore(async ({ store }) => {
    await seedBegunSession(store);
    let readCount = 0;
    const result = await readArtifactWithFreshnessGuard({
      store,
      key: KEY,
      artifactLoadToken: 'wrong-token',
      artifactRevision: 1,
      readFile: async () => {
        readCount++;
        return 'should never be reached';
      },
    });
    assert.deepStrictEqual(result, { status: 'expired' });
    assert.strictEqual(readCount, 0, 'the guard is a true gate, not just a formality');
  });
});

test('readArtifactWithFreshnessGuard returns expired when a second beginArtifactLoad lands mid-read (deterministic double-read race guard)', async () => {
  await withStore(async ({ store }) => {
    const { artifactLoadToken, artifactRevision } = await seedBegunSession(store);
    const opened = await store.mutate((state) => openChromeSession(state, KEY));
    if (opened.status !== 'ok') throw new Error('unreachable');

    const result = await readArtifactWithFreshnessGuard({
      store,
      key: KEY,
      artifactLoadToken,
      artifactRevision,
      readFile: async () => {
        // Simulate "someone else began a new load while this read was in
        // flight" -- deterministic, not timing-dependent: the mutation
        // happens synchronously as part of the injected readFile itself.
        await store.mutate((state) => beginArtifactLoad(state, KEY, opened.chromeLoadToken));
        return '<html>stale by the time we return</html>';
      },
    });
    assert.deepStrictEqual(result, { status: 'expired' });
  });
});

test('readArtifactWithFreshnessGuard returns not-found for an unknown key', async () => {
  await withStore(async ({ store }) => {
    const result = await readArtifactWithFreshnessGuard({
      store,
      key: 'no-such-key',
      artifactLoadToken: 'irrelevant',
      artifactRevision: 1,
      readFile: async () => 'unreachable',
    });
    assert.deepStrictEqual(result, { status: 'not-found' });
  });
});
