import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockPathFor } from '../../src/daemon/state-dir.ts';
import {
  sessionKey,
  sessionStorePathFor,
  writeAtomic,
  SessionStore,
  upsertSession,
} from '../../src/store/session-store.ts';
import type { RenameFn, SessionRecord, IlluminateState } from '../../src/store/session-store.ts';
import { forceRemove } from '../fixtures/cleanup.ts';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'illuminate-session-store-test-'));
  try {
    return await fn(dir);
  } finally {
    await forceRemove(dir);
  }
}

// SessionStore always resolves its path via the real stateDir() (no
// override point -- that IS the point, per T-01-23's colocation
// requirement). Isolation instead comes from using a uniquely-generated,
// mkdtemp'd artifactRoot per test, so each test gets its own hash key
// under the real state directory, then removing that one state file
// afterward.
async function withStore<T>(fn: (store: SessionStore, artifactRoot: string) => Promise<T>): Promise<T> {
  return withTempDir(async (artifactRoot) => {
    const store = new SessionStore(artifactRoot);
    try {
      return await fn(store, artifactRoot);
    } finally {
      await rm(sessionStorePathFor(artifactRoot), { force: true });
    }
  });
}

test('sessionKey is deterministic for the same input', () => {
  const a = sessionKey('C:\\Projects\\foo');
  const b = sessionKey('C:\\Projects\\foo');
  assert.strictEqual(a, b);
});

test('sessionKey is case-insensitive, mirroring lockPathFor NTFS rationale', () => {
  const a = sessionKey('C:\\Foo\\Bar');
  const b = sessionKey('c:\\foo\\bar');
  assert.strictEqual(a, b);
});

test('sessionKey of two genuinely different paths produces two different keys', () => {
  const a = sessionKey('C:\\Projects\\foo');
  const b = sessionKey('C:\\Projects\\bar');
  assert.notStrictEqual(a, b);
});

test('sessionStorePathFor is colocated with and keyed identically to lockPathFor for the same root', () => {
  const root = 'C:\\Projects\\some-artifact';
  const expected = lockPathFor(root).replace(/\.json$/, '.state.json');
  assert.strictEqual(sessionStorePathFor(root), expected);
});

test('SessionStore.read() against a path with no existing file returns an empty, well-typed state', async () => {
  await withStore(async (store) => {
    const state = await store.read();
    assert.deepStrictEqual(state, { sessions: {} });
  });
});

test('SessionStore.mutate() performs a visible read-modify-write', async () => {
  await withStore(async (store) => {
    await store.mutate((state) => {
      state.sessions['abc'] = {
        key: 'abc',
        file: 'foo.ts',
        createdAt: new Date().toISOString(),
        artifactRevision: 0,
        chromeLoadToken: null,
        artifactLoadToken: null,
        queue: [],
        dispatches: {},
        browserLastSeenAt: null,
        sessionEndedAt: null,
      };
      return { next: state, result: undefined };
    });
    const after = await store.read();
    assert.ok(after.sessions['abc']);
    assert.strictEqual(after.sessions['abc']?.key, 'abc');
  });
});

test('mutate() resolves to exactly the result the callback returns', async () => {
  await withStore(async (store) => {
    const result = await store.mutate((state) => ({ next: state, result: 'ret-value' }));
    assert.strictEqual(result, 'ret-value');
  });
});

test('25 concurrent mutate() calls each adding one uniquely-keyed session all land', async () => {
  await withStore(async (store) => {
    const calls = Array.from({ length: 25 }, (_, i) =>
      store.mutate((state) => {
        const key = `session-${i}`;
        state.sessions[key] = {
          key,
          file: `file-${i}.ts`,
          createdAt: new Date().toISOString(),
          artifactRevision: 0,
          chromeLoadToken: null,
          artifactLoadToken: null,
          queue: [],
          dispatches: {},
          browserLastSeenAt: null,
          sessionEndedAt: null,
        };
        return { next: state, result: undefined };
      }),
    );
    await Promise.all(calls);

    const final = await store.read();
    const keys = Object.keys(final.sessions);
    assert.strictEqual(keys.length, 25, 'no update was lost to a race');
    for (let i = 0; i < 25; i++) {
      assert.ok(final.sessions[`session-${i}`], `session-${i} present`);
    }
  });
});

test('writeAtomic retries the rename on injected EPERM and succeeds on a later attempt', async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, 'state.json');
    let calls = 0;
    // The one deliberately-injected branch in this suite for an OS
    // condition (transient antivirus/indexer lock) not reproducible on
    // demand in CI -- mirrors ownership.test.ts's KillFn pattern.
    const flakyRename: RenameFn = async (oldPath, newPath) => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      const { rename } = await import('node:fs/promises');
      await rename(oldPath, newPath);
    };

    await writeAtomic(target, JSON.stringify({ hello: 'world' }), flakyRename);

    assert.ok(calls >= 2, 'rename was retried after the injected EPERM');
    const contents = JSON.parse(await readFile(target, 'utf8'));
    assert.deepStrictEqual(contents, { hello: 'world' });
  });
});

test('writeAtomic never leaves a torn file -- a reader observes either fully-old or fully-new content', async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, 'state.json');
    await writeAtomic(target, JSON.stringify({ v: 1 }));
    await writeAtomic(target, JSON.stringify({ v: 2 }));
    const contents = JSON.parse(await readFile(target, 'utf8'));
    // Either fully old or fully new -- never a partial parse failure.
    assert.ok(contents.v === 1 || contents.v === 2);
    assert.deepStrictEqual(contents, { v: 2 });
  });
});

test('upsertSession on an empty state creates a new SessionRecord with correct defaults', () => {
  const state: IlluminateState = { sessions: {} };
  const { next, result } = upsertSession(state, 'key1', 'file1.html');

  assert.strictEqual(result.key, 'key1');
  assert.strictEqual(result.file, 'file1.html');
  assert.strictEqual(result.artifactRevision, 0);
  assert.strictEqual(result.chromeLoadToken, null);
  assert.strictEqual(result.artifactLoadToken, null);
  assert.ok(typeof result.createdAt === 'string' && result.createdAt.length > 0, 'createdAt is a fresh timestamp');
  assert.deepStrictEqual(result.queue, [], 'a fresh session starts with an empty dispatch queue');
  assert.deepStrictEqual(result.dispatches, {}, 'a fresh session starts with an empty dispatch ledger');
  assert.strictEqual(result.browserLastSeenAt, null, 'presence is unknown until the first poll/heartbeat');
  assert.strictEqual(result.sessionEndedAt, null, 'a fresh session has not ended');
  assert.strictEqual(next.sessions['key1'], result);
});

test('upsertSession on a state with an existing key returns the EXISTING record unchanged, no mutation', () => {
  const existing: SessionRecord = {
    key: 'key1',
    file: 'file1.html',
    createdAt: '2020-01-01T00:00:00.000Z',
    artifactRevision: 3,
    chromeLoadToken: 'tok-chrome-a',
    artifactLoadToken: 'tok-artifact-b',
    queue: ['d1'],
    dispatches: {},
    browserLastSeenAt: '2020-01-01T00:00:05.000Z',
    sessionEndedAt: null,
  };
  const state: IlluminateState = { sessions: { key1: existing } };
  const { next, result } = upsertSession(state, 'key1', 'file1.html');

  assert.strictEqual(result, existing, 'same object identity -- in-progress tokens/revision are never reset');
  assert.strictEqual(next, state, 'no new state object identity -- idempotent no-op');
  assert.deepStrictEqual(result.queue, ['d1'], 'a second upsertSession call never resets an in-progress queue');
  assert.strictEqual(
    result.browserLastSeenAt,
    '2020-01-01T00:00:05.000Z',
    'a second upsertSession call never resets presence',
  );
});

test('upsertSession called with a DIFFERENT file for an existing key still returns the existing record -- key lookup wins, not file comparison', () => {
  const existing: SessionRecord = {
    key: 'key1',
    file: 'file1.html',
    createdAt: '2020-01-01T00:00:00.000Z',
    artifactRevision: 0,
    chromeLoadToken: null,
    artifactLoadToken: null,
    queue: [],
    dispatches: {},
    browserLastSeenAt: null,
    sessionEndedAt: null,
  };
  const state: IlluminateState = { sessions: { key1: existing } };
  const { next, result } = upsertSession(state, 'key1', 'a-completely-different-file.html');

  assert.strictEqual(result, existing);
  assert.strictEqual(result.file, 'file1.html', 'the stored file is NOT silently overwritten');
  assert.strictEqual(next, state);
});

test('a round-trip through writeAtomic/JSON.parse preserves all four Phase-6 fields unchanged', async () => {
  await withStore(async (store) => {
    const record: SessionRecord = {
      key: 'rt1',
      file: 'roundtrip.html',
      createdAt: '2020-01-01T00:00:00.000Z',
      artifactRevision: 2,
      chromeLoadToken: 'chrome-tok',
      artifactLoadToken: 'artifact-tok',
      queue: ['dispatch-a', 'dispatch-b'],
      dispatches: {
        'dispatch-a': {
          envelope: {
            protocol: 'illuminate.dispatch/1',
            dispatch_id: 'dispatch-a',
            intent: 'explain',
            role: 'tutor',
            model_tier: 'haiku',
            deadline_ms: 30000,
            element: { uid: 'e1', selector: '#main', tag: 'p', text: 'hello', prefixContext: null, suffixContext: null },
            source: null,
            return_to: 'illuminate answer dispatch-a',
            return_contract: 'pipe markdown to stdin',
            tools: [],
            depth: 1,
            parent_dispatch: null,
            learnerNote: null,
            note: null,
            attachments: [],
          },
          status: 'open',
          createdAt: '2020-01-01T00:00:01.000Z',
          deliveredAt: null,
          answer: null,
          tierDeviation: false,
        },
      },
      browserLastSeenAt: '2020-01-01T00:00:02.000Z',
      sessionEndedAt: null,
    };

    await store.mutate((state) => ({
      next: { ...state, sessions: { ...state.sessions, rt1: record } },
      result: undefined,
    }));

    const after = await store.read();
    assert.deepStrictEqual(after.sessions['rt1'], record, 'all four new fields survive an atomic-write round trip unchanged');
  });
});
