import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createAnnotationStoreRegistry } from '../../src/daemon/annotation-store-registry.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_TS = join(HERE, '..', '..', 'src', 'daemon', 'server.ts');

test('the same artifact path yields the same AnnotationStoreFile instance', () => {
  const registry = createAnnotationStoreRegistry();
  const artifact = join(tmpdir(), 'illuminate-registry-test', 'a.html');
  assert.strictEqual(registry.get(artifact), registry.get(artifact));
});

test('a relative spelling and the absolute spelling of one artifact path yield one instance', () => {
  const registry = createAnnotationStoreRegistry();
  const absolute = join(tmpdir(), 'illuminate-registry-test', 'a.html');
  const relativeSpelling = relative(process.cwd(), absolute);
  assert.notStrictEqual(relativeSpelling, absolute, 'the test needs two different strings for one path');
  assert.strictEqual(registry.get(relativeSpelling), registry.get(absolute));
});

test('a spelling with a redundant ".." segment, built without path.join, yields the same instance as the plain path', () => {
  const registry = createAnnotationStoreRegistry();
  const dir = join(tmpdir(), 'illuminate-registry-test');
  const plain = `${dir}${sep}a.html`;
  const detour = `${dir}${sep}sub${sep}..${sep}a.html`;
  assert.notStrictEqual(detour, plain, 'the test needs two different strings for one path');
  assert.strictEqual(registry.get(detour), registry.get(plain));
});

test('different artifacts yield different instances', () => {
  const registry = createAnnotationStoreRegistry();
  const dir = join(tmpdir(), 'illuminate-registry-test');
  assert.notStrictEqual(registry.get(join(dir, 'a.html')), registry.get(join(dir, 'b.html')));
});

test('source-text: server.ts never constructs an AnnotationStoreFile directly -- every access goes through the registry', () => {
  const src = readFileSync(SERVER_TS, 'utf8');
  assert.strictEqual((src.match(/new AnnotationStoreFile\(/g) ?? []).length, 0, 'a direct construction reintroduces the per-instance-mutex race (RT-14)');
  assert.ok(src.includes('annotationStores.get('), 'server.ts should read and write cards through annotationStores.get(...)');
});
