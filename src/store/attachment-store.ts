import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDir, statePathHash } from '../daemon/state-dir.ts';

/**
 * Where an attached image actually lands.
 *
 * ## Why the bytes stop here and never travel further
 *
 * An image arrives from the artifact frame as a data URL over postMessage,
 * because a sandboxed opaque-origin document has no `fetch` and no other way
 * out. That is fine for one hop and wrong for anything after it: a base64
 * image inlined into a `TypedIntentPayload` would be written verbatim into
 * the session store on every dispatch, replayed in every poll response, and
 * echoed back through every annotation sync. A few screenshots would turn a
 * small JSON ledger into megabytes that are re-read on every heartbeat.
 *
 * So the chrome uploads first and dispatches second. This module writes the
 * decoded bytes once, under the state directory, and hands back an id. The
 * wire carries the id; the envelope carries a resolved absolute path; the
 * agent opens the file. The bytes are in exactly one place.
 *
 * ## Why the state directory and not next to the artifact
 *
 * Same reasoning as `findings-store.ts`: an attachment is session scratch,
 * not part of the document. It must not appear beside the artifact, must not
 * travel with `illuminate export`, and must not turn up in the human's git
 * status because they pasted a screenshot into a review.
 */

/** A hard ceiling on one decoded attachment. Generous for a screenshot and
 * far below anything that would make the postMessage hop or the state
 * directory a problem. Rejected rather than truncated -- half an image is
 * not a smaller image, it is a corrupt one. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** The image types worth accepting. Deliberately a closed list rather than a
 * `image/*` prefix test: the extension written to disk is derived from this
 * table, so an unlisted type has no filename this module could honestly
 * give it. */
const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

export interface StoredAttachment {
  readonly id: string;
  readonly mediaType: string;
  readonly path: string;
  readonly bytes: number;
}

export type StoreAttachmentResult =
  | { readonly ok: true; readonly attachment: StoredAttachment }
  | { readonly ok: false; readonly reason: string };

/** Per-artifact-directory, through the same `statePathHash` every other
 * store keys off (`lockPathFor`, `sessionStorePathFor`,
 * `findingsStorePathFor`) -- one canonical form of one path, so two
 * spellings of the same directory cannot split one session's attachments
 * across two folders.
 *
 * Keyed by the artifact DIRECTORY rather than the session key for a
 * practical reason as well as a tidy one: `buildDispatchEnvelope` has the
 * directory and has never needed the key, and threading a session secret
 * through the envelope builder just to name a folder would be a worse
 * trade than sharing a directory between the artifacts in one folder. Ids
 * are random, so sharing is harmless. */
export function attachmentDirFor(artifactDir: string): string {
  return join(stateDir(), 'attachments', statePathHash(artifactDir));
}

/**
 * Parses a `data:` URL into its media type and bytes.
 *
 * Only base64 payloads are accepted. A percent-encoded `data:` URL is legal
 * in the spec and is never what a `FileReader` produces, so accepting it
 * would mean maintaining a decoder for a shape this system cannot generate.
 * Never throws -- malformed input is a `reason`, because this parses data
 * that crossed a trust boundary.
 */
export function parseDataUrl(dataUrl: string): { readonly mediaType: string; readonly bytes: Buffer } | { readonly reason: string } {
  const match = /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+);base64,([\s\S]*)$/i.exec(dataUrl);
  if (!match) return { reason: 'not a base64 data URL' };
  const mediaType = match[1]?.toLowerCase() ?? '';
  const payload = match[2] ?? '';
  if (!(mediaType in EXTENSION_BY_MEDIA_TYPE)) return { reason: `unsupported media type: ${mediaType}` };
  // Node's base64 decoder is lenient -- it ignores invalid characters rather
  // than failing -- so a round trip is what actually proves the payload was
  // base64 and not, say, a truncated upload.
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length === 0) return { reason: 'empty payload' };
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    return { reason: `attachment is ${String(bytes.length)} bytes, over the ${String(MAX_ATTACHMENT_BYTES)} limit` };
  }
  return { mediaType, bytes };
}

/**
 * Decodes and writes one attachment, returning the id the wire will carry.
 *
 * The id is random, not derived from the content or the filename. A
 * content hash would let two sessions collide on one file and let a caller
 * probe for whether some exact image already exists; the original filename
 * is attacker-influenced and has no business in a path.
 */
export async function storeAttachment(artifactDir: string, dataUrl: string): Promise<StoreAttachmentResult> {
  const parsed = parseDataUrl(dataUrl);
  if ('reason' in parsed) return { ok: false, reason: parsed.reason };

  const extension = EXTENSION_BY_MEDIA_TYPE[parsed.mediaType];
  if (extension === undefined) return { ok: false, reason: `unsupported media type: ${parsed.mediaType}` };

  const id = randomBytes(12).toString('hex');
  const dir = attachmentDirFor(artifactDir);
  const path = join(dir, `${id}.${extension}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, parsed.bytes);
  } catch (err) {
    return { ok: false, reason: `could not write attachment: ${(err as Error).message}` };
  }
  return { ok: true, attachment: { id, mediaType: parsed.mediaType, path, bytes: parsed.bytes.length } };
}

/**
 * Resolves an id back to its path for envelope construction.
 *
 * `id` crossed the wire, so it is validated as a bare hex token before it is
 * ever joined onto a path -- otherwise `../` in an id would read any file on
 * disk into an envelope. The `extension` likewise comes from the closed
 * table above, never from the caller.
 */
export function attachmentPathFor(artifactDir: string, id: string, mediaType: string): string | null {
  if (!/^[0-9a-f]{24}$/.test(id)) return null;
  const extension = EXTENSION_BY_MEDIA_TYPE[mediaType.toLowerCase()];
  if (extension === undefined) return null;
  return join(attachmentDirFor(artifactDir), `${id}.${extension}`);
}
