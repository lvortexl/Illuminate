import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postTypedIntent, postDismissFinding } from '../../src/sdk/post.ts';
import { buildDismissFindingPayload, DISMISS_PROTOCOL_VERSION } from '../../src/shared/dismiss.ts';
import { buildTypedIntentPayload } from '../../src/shared/intent.ts';

/**
 * Plan 08-04's own regression-proof suite for `src/sdk/post.ts`'s refactor:
 * `postTypedIntent`'s existing signature/behavior stays byte-for-byte
 * unchanged, `postDismissFinding` is new, and BOTH funnel through the one
 * private `send()` -- the one literal `parent.postMessage(` call site left
 * in this file, and in all of `src/` (the last test below, whole-tree
 * scope). `post.ts` runs under `tsconfig.browser.json`'s DOM lib, where
 * `parent` is a real global -- under `node --test` there is no such global,
 * so this file installs a minimal fake before each call and restores
 * whatever was there afterward.
 */

interface FakePostMessageCall {
  readonly message: unknown;
  readonly targetOrigin: string;
}

interface FakeParent {
  postMessage(message: unknown, targetOrigin: string): void;
}

function installFakeParent(): { calls: FakePostMessageCall[]; restore: () => void } {
  const calls: FakePostMessageCall[] = [];
  const fake: FakeParent = {
    postMessage(message, targetOrigin) {
      calls.push({ message, targetOrigin });
    },
  };
  const globalRecord = globalThis as unknown as { parent?: FakeParent };
  const original = globalRecord.parent;
  globalRecord.parent = fake;
  return {
    calls,
    restore: () => {
      globalRecord.parent = original;
    },
  };
}

const ELEMENT = {
  uid: 'u1',
  selector: '#u1',
  tag: 'p',
  text: 'hi',
  prefixContext: null,
  suffixContext: null,
};

// ---------------------------------------------------------------------------
// buildDismissFindingPayload -- pure, zero-dependency (src/shared/dismiss.ts)
// ---------------------------------------------------------------------------

test("buildDismissFindingPayload('abc123') returns {protocol: DISMISS_PROTOCOL_VERSION, fingerprint: 'abc123'}", () => {
  assert.deepStrictEqual(buildDismissFindingPayload('abc123'), {
    protocol: DISMISS_PROTOCOL_VERSION,
    fingerprint: 'abc123',
  });
});

// ---------------------------------------------------------------------------
// postTypedIntent -- existing signature/behavior UNCHANGED by this refactor.
// ---------------------------------------------------------------------------

test('postTypedIntent posts an illuminate:queuePrompt message carrying the typed intent payload verbatim, to the wildcard target origin', () => {
  const fake = installFakeParent();
  try {
    const payload = buildTypedIntentPayload({ intent: 'explain', targets: [{ element: ELEMENT, anchor: null }] });
    postTypedIntent('load-token-1', payload);

    assert.strictEqual(fake.calls.length, 1);
    assert.deepStrictEqual(fake.calls[0]?.message, {
      type: 'illuminate:queuePrompt',
      artifact_load_token: 'load-token-1',
      payload,
    });
    assert.strictEqual(fake.calls[0]?.targetOrigin, '*');
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// postDismissFinding -- new. Reuses the SAME illuminate:queuePrompt message
// type, discriminated on the wire by payload.protocol === DISMISS_PROTOCOL_VERSION
// (never a new ArtifactToChromeType) -- no new call site.
// ---------------------------------------------------------------------------

test('postDismissFinding posts an illuminate:queuePrompt message whose payload is a DismissFindingPayload, to the wildcard target origin', () => {
  const fake = installFakeParent();
  try {
    postDismissFinding('load-token-2', 'abc123def4567890');

    assert.strictEqual(fake.calls.length, 1);
    assert.deepStrictEqual(fake.calls[0]?.message, {
      type: 'illuminate:queuePrompt',
      artifact_load_token: 'load-token-2',
      payload: buildDismissFindingPayload('abc123def4567890'),
    });
    assert.strictEqual(fake.calls[0]?.targetOrigin, '*');
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// Regression, source-text, whole-src/ scope: exactly ONE occurrence of the
// literal substring `parent.postMessage(` exists anywhere under src/ -- the
// hard constraint this plan's refactor must not regress.
// ---------------------------------------------------------------------------

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

test('regression: exactly one literal `parent.postMessage(` call site exists anywhere under src/', () => {
  const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url));
  const files = collectTsFiles(srcRoot);

  let total = 0;
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const matches = text.match(/parent\.postMessage\(/g);
    if (matches) {
      total += matches.length;
      hits.push(`${file} (${String(matches.length)})`);
    }
  }

  assert.strictEqual(
    total,
    1,
    `expected exactly one "parent.postMessage(" call site under src/, found ${String(total)}: ${hits.join(', ')}`,
  );
});
