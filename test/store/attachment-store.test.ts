import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import {
  MAX_ATTACHMENT_BYTES,
  attachmentDirFor,
  attachmentPathFor,
  parseDataUrl,
  storeAttachment,
} from '../../src/store/attachment-store.ts';

/**
 * The attachment store takes two things that crossed a trust boundary and
 * turns them into a filesystem path: a data URL from a sandboxed artifact,
 * and later an id from the wire. Both are places where "just join it onto a
 * path" reads any file on the machine into an agent's envelope, so most of
 * what follows is about refusal rather than storage.
 */

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const ARTIFACT_DIR = 'C:\\illum-attachment-tests\\artifacts';

// --- parseDataUrl: what it refuses ------------------------------------

test('parses a real base64 image data URL', () => {
  const parsed = parseDataUrl(PNG_1PX);
  assert.ok(!('reason' in parsed), 'a genuine PNG data URL must parse');
  assert.strictEqual(parsed.mediaType, 'image/png');
  assert.ok(parsed.bytes.length > 0);
});

test('refuses anything that is not a base64 data URL', () => {
  for (const input of [
    'https://example.com/cat.png',
    'file:///etc/passwd',
    'data:image/png,not-base64-at-all',
    'data:text/plain;base64,aGVsbG8=',
    '',
    'data:;base64,aGVsbG8=',
  ]) {
    const parsed = parseDataUrl(input);
    assert.ok('reason' in parsed, `should have refused: ${JSON.stringify(input)}`);
  }
});

test('refuses a non-image media type even when the encoding is valid', () => {
  // The extension written to disk comes from a closed table; a media type
  // that is not in it has no filename this module could honestly give it.
  const parsed = parseDataUrl('data:application/x-msdownload;base64,TVqQAAMAAAAEAAAA');
  assert.ok('reason' in parsed);
  assert.match(parsed.reason, /unsupported media type/);
});

test('refuses an empty payload rather than writing a zero-byte file', () => {
  const parsed = parseDataUrl('data:image/png;base64,');
  assert.ok('reason' in parsed);
  assert.match(parsed.reason, /empty/);
});

test('refuses an attachment over the size ceiling, and says the ceiling', () => {
  // Built at the limit + 1 rather than "something big", so this test fails if
  // the constant moves without anyone deciding it should.
  const oversize = 'data:image/png;base64,' + 'A'.repeat(Math.ceil(((MAX_ATTACHMENT_BYTES + 1024) * 4) / 3));
  const parsed = parseDataUrl(oversize);
  assert.ok('reason' in parsed);
  assert.match(parsed.reason, /over the/);
});

// --- attachmentPathFor: the traversal boundary ------------------------

test('refuses an id that is not a bare hex token', () => {
  // The whole point: an id arrives over the wire and is then joined onto a
  // path. Anything that could climb out of the attachment directory has to
  // fail here, before `join` ever sees it.
  for (const id of [
    '../../../../etc/passwd',
    '..\\..\\windows\\system32\\config\\sam',
    'abc/../../secret',
    'abcdef',
    'ABCDEF0123456789ABCDEF01',
    'abcdef0123456789abcdef0',
    'abcdef0123456789abcdef012',
    'abcdef0123456789abcdef0g',
    '',
  ]) {
    assert.strictEqual(attachmentPathFor(ARTIFACT_DIR, id, 'image/png'), null, `should have refused id: ${id}`);
  }
});

test('refuses an unlisted media type, so the extension can never come from the caller', () => {
  assert.strictEqual(attachmentPathFor(ARTIFACT_DIR, 'a'.repeat(24), 'image/x-evil'), null);
  assert.strictEqual(attachmentPathFor(ARTIFACT_DIR, 'a'.repeat(24), '../../etc'), null);
});

test('resolves a well-formed id to a path inside the attachment directory', () => {
  const id = 'a'.repeat(24);
  const path = attachmentPathFor(ARTIFACT_DIR, id, 'image/png');
  assert.ok(path);
  assert.strictEqual(dirname(path), attachmentDirFor(ARTIFACT_DIR));
  assert.strictEqual(basename(path), `${id}.png`);
});

test('media type matching is case-insensitive, as HTTP headers are', () => {
  const id = 'b'.repeat(24);
  assert.ok(attachmentPathFor(ARTIFACT_DIR, id, 'IMAGE/PNG'));
});

// --- storeAttachment: the round trip ----------------------------------

test('stores an image and resolves the same bytes back through its id', async () => {
  const result = await storeAttachment(ARTIFACT_DIR, PNG_1PX);
  assert.ok(result.ok, `store failed: ${result.ok ? '' : result.reason}`);
  const { id, mediaType, path } = result.attachment;

  // The id is what the wire carries, and it must be resolvable on its own --
  // the path in the result is a convenience, not the contract.
  assert.strictEqual(attachmentPathFor(ARTIFACT_DIR, id, mediaType), path);

  const written = await readFile(path);
  const parsed = parseDataUrl(PNG_1PX);
  assert.ok(!('reason' in parsed));
  assert.ok(written.equals(parsed.bytes), 'the stored bytes must be the decoded bytes, unmodified');
});

test('two stores of identical content get distinct ids', async () => {
  // Ids are random, not content-derived. A content hash would let one caller
  // probe whether some exact image already exists, and would collide two
  // sessions onto one file.
  const a = await storeAttachment(ARTIFACT_DIR, PNG_1PX);
  const b = await storeAttachment(ARTIFACT_DIR, PNG_1PX);
  assert.ok(a.ok && b.ok);
  assert.notStrictEqual(a.attachment.id, b.attachment.id);
});

test('a refused data URL writes nothing and reports why', async () => {
  const result = await storeAttachment(ARTIFACT_DIR, 'data:text/html;base64,PHNjcmlwdD4=');
  assert.ok(!result.ok);
  assert.match(result.reason, /unsupported media type/);
});

test('two spellings of one artifact directory share one attachment directory', () => {
  // Same property `canonicalPathKey` gives every other store: a trailing
  // separator or the wrong slash must not split one session's attachments
  // across two folders.
  const a = attachmentDirFor('C:\\illum-attachment-tests\\artifacts');
  const b = attachmentDirFor('C:\\illum-attachment-tests\\artifacts\\');
  const c = attachmentDirFor('C:/illum-attachment-tests/artifacts');
  assert.strictEqual(a, b);
  assert.strictEqual(a, c);
});
