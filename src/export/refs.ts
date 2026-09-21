// Ported from lavish-axi's export-bundle.js (MIT License, Copyright (c) 2026 Kun Chen).
// Source: https://github.com/kunchenguid/lavish-axi, vendored/ported 2026-09-11 from the locally
// cached build at lavish-axi@0.1.67 (dist/cli.mjs lines 877-4177, // src/export-bundle.js).
// This file covers document-base / reference resolution, budgeted local reads, and data-URI
// encoding.
//
// Deliberate architectural deviation from the reference, made throughout this file: the
// reference's own file-reading confinement helper (plus the `isOutside`-gated early exits inside
// its own `resolveRef`) is NOT ported. Every local file read in this file is routed through
// `readLocalAsset` below, which is the ONLY function in this file that calls into illuminate's
// own containment check (src/serve/containment.ts, Phase 1) -- already proven against traversal,
// symlink-escape, and dotfile access for the live-serving path. `resolveRef` returns a bare
// candidate path (`{kind:'file', path}`) for every local-looking ref, however it was resolved;
// the actual containment decision happens exactly once, downstream, inside `readBudgeted`. See
// T-09-01 in this plan's threat model.
//
// See THIRD-PARTY-NOTICES.md.

import { readFile, stat } from 'node:fs/promises';
import { resolve, relative, dirname, extname, sep, posix, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAssetPath } from '../serve/containment.ts';
import type { ExportContext, ExportWarning } from './types.ts';
import {
  readHtmlToken,
  popHtmlParent,
  pushHtmlParent,
  elementNamespaceForTag,
  isEffectiveSelfClosingTag,
  findContentClose,
  isRawTextElementForNamespace,
  INERT_CONTENT_TAGS,
  PLAINTEXT_TAG,
  HTML_VOID_TAGS,
  getAttr,
  getDecisionAttr,
  replaceAttrValue,
  decodeHtmlCharacterReferences,
  decodeNumericCharacterReference,
  type OpenStackEntry,
} from './tokenize.ts';

// ---------------------------------------------------------------------------
// Constants (dist/cli.mjs lines 881-914)
// ---------------------------------------------------------------------------

const EXT_MIME: Record<string, string> = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.vtt': 'text/vtt',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
};

const REDACTED_FILE_REF = 'about:blank';

const HTML_REF_OPTIONS: RefOptions = { decodeHtmlEntities: true };

export const DEFAULT_MAX_ASSET_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
export const MAX_ASSET_BYTES_ENV_VAR = 'ILLUMINATE_EXPORT_MAX_ASSET_BYTES';
export const MAX_BUNDLE_BYTES_ENV_VAR = 'ILLUMINATE_EXPORT_MAX_BUNDLE_BYTES';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RefOptions {
  readonly decodeHtmlEntities?: boolean;
  readonly cssSyntax?: boolean;
}

export type RefBase =
  | { readonly kind: 'local'; readonly dir: string }
  | { readonly kind: 'remote' }
  | { readonly kind: 'root'; readonly path: string };

/**
 * Deliberately narrower than the reference's descriptor union: no `escape` variant exists here
 * (see this file's header) and no `allowOutsideRoot` field (the reference's `resolveAbsolute`
 * customization hook has no equivalent on illuminate's `ExportContext`, so a root-absolute ref
 * always falls through to `unmapped-root`, matching the reference's own default behavior).
 */
export type RefDescriptor =
  | { readonly kind: 'skip' }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'unparseable-file-url' }
  | { readonly kind: 'unmapped-root'; readonly ref: string };

export type LocalAssetResult =
  | { readonly kind: 'ok'; readonly bytes: Buffer }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'too-large' };

export interface LoadedText {
  readonly text: string;
  readonly baseDir: string;
  readonly byteLength: number;
}

// ---------------------------------------------------------------------------
// Document-base resolution (dist/cli.mjs lines 2901-2994)
// ---------------------------------------------------------------------------

export function resolveDocumentRefBase(html: string, ctx: ExportContext): RefBase {
  const href = findFirstDocumentBaseHref(html);
  if (!href) return localRefBase(ctx.baseDir);
  return refBaseFromHref(href, ctx.baseDir);
}

export function findFirstDocumentBaseHref(html: string): string | null {
  let index = 0;
  const openStack: OpenStackEntry[] = [];
  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt === -1) break;
    const token = readHtmlToken(html, lt);
    if (!token) {
      index = lt + 1;
      continue;
    }
    if (token.type === 'close') {
      popHtmlParent(openStack, token.tag.toLowerCase());
      index = token.end;
      continue;
    }
    if (token.type === 'start') {
      const tag = token.tag.toLowerCase();
      const elementNamespace = elementNamespaceForTag(tag, openStack);
      const effectiveSelfClosing = isEffectiveSelfClosingTag(tag, token.selfClosing, openStack, elementNamespace);
      if (elementNamespace === 'html' && tag === 'base') {
        const href = getAttr(token.attrs, 'href');
        if (href) return href;
      }
      if (elementNamespace === 'html' && tag === PLAINTEXT_TAG && !effectiveSelfClosing) break;
      if (elementNamespace === 'html' && INERT_CONTENT_TAGS.has(tag) && !effectiveSelfClosing) {
        const close = findContentClose(html, token.end, tag);
        if (close) {
          index = close.end;
          continue;
        }
        break;
      }
      if (isRawTextElementForNamespace(tag, elementNamespace) && !effectiveSelfClosing) {
        const close = findContentClose(html, token.end, tag);
        if (close) {
          index = close.end;
          continue;
        }
        break;
      }
      if (!effectiveSelfClosing && !HTML_VOID_TAGS.has(tag)) pushHtmlParent(openStack, tag, elementNamespace);
    }
    index = token.end;
  }
  return null;
}

export function refBaseFromHref(href: string, documentDir: string): RefBase {
  const trimmed = decodeHtmlCharacterReferences(String(href || '')).trim();
  const schemeRef = normalizeRefForScheme(trimmed, HTML_REF_OPTIONS);
  if (!trimmed || isInert(schemeRef || trimmed)) return localRefBase(documentDir);
  if (schemeRef.startsWith('//') || /^https?:\/\//i.test(schemeRef)) return { kind: 'remote' };
  if (isFileSchemeRef(trimmed, HTML_REF_OPTIONS)) {
    try {
      const fileHref = stripQueryAndHash(schemeRef);
      return localRefBase(directoryFromBasePath(fileURLToPath(fileHref), fileHref));
    } catch {
      return { kind: 'remote' };
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(schemeRef)) return { kind: 'remote' };
  const { pathPart } = splitRefSuffix(trimmed);
  if (!pathPart) return localRefBase(documentDir);
  if (trimmed.startsWith('/')) return { kind: 'root', path: rootDirectoryFromBasePath(pathPart) };
  return localRefBase(directoryFromBasePath(resolve(documentDir, decodeLocalPath(pathPart)), pathPart));
}

export function directoryFromBasePath(absPath: string, ref: string): string {
  const value = String(ref || '');
  return value.endsWith('/') ? absPath : dirname(absPath);
}

export function rootDirectoryFromBasePath(ref: string): string {
  const decoded = decodeLocalPath(ref);
  if (!decoded || decoded === '/') return '/';
  const normalized = posix.normalize(decoded);
  const directory = decoded.endsWith('/') ? normalized : posix.dirname(normalized);
  return directory.endsWith('/') ? directory : `${directory}/`;
}

export function localRefBase(dir: string): RefBase {
  return { kind: 'local', dir: resolve(dir) };
}

/**
 * Simplified from the reference's own runtime duck-typing check
 * (`typeof base === 'object' && typeof base.kind === 'string'`): with a real `RefBase` type,
 * the only two possibilities are "already a `RefBase`" or "a plain directory string", so a
 * straightforward `typeof` narrows correctly.
 */
export function normalizeRefBase(base: string | RefBase): RefBase {
  if (typeof base === 'string') return localRefBase(base);
  return base;
}

export function rootRelativeRef(basePath: string, ref: string): string {
  const { pathPart, suffix } = splitRefSuffix(ref);
  const joined = posix.normalize(posix.join(basePath, decodeLocalPath(pathPart)));
  return `${joined.startsWith('/') ? joined : `/${joined}`}${suffix}`;
}

// ---------------------------------------------------------------------------
// Reference resolution (dist/cli.mjs lines 2995-3048)
// ---------------------------------------------------------------------------

export function resolveRef(
  ref: string,
  baseDir: string | RefBase,
  ctx: ExportContext,
  options: RefOptions = {},
): RefDescriptor {
  const trimmed = normalizeRefForResolution(ref, options).trim();
  const schemeRef = normalizeRefForScheme(ref, options);
  const base = normalizeRefBase(baseDir);
  if (isInert(schemeRef || trimmed)) return { kind: 'skip' };
  if (schemeRef.startsWith('//') || /^https?:\/\//i.test(schemeRef)) return { kind: 'skip' };
  if (isFileSchemeRef(ref, options)) {
    try {
      const resolvedPath = fileURLToPath(schemeRef.replace(/#.*$/, ''));
      return { kind: 'file', path: resolvedPath };
    } catch {
      return { kind: 'unparseable-file-url' };
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(schemeRef)) return { kind: 'skip' };
  if (base.kind === 'remote') return { kind: 'skip' };
  const effectiveRef = base.kind === 'root' && !trimmed.startsWith('/') ? rootRelativeRef(base.path, trimmed) : trimmed;
  if (effectiveRef.startsWith('/')) {
    // No `resolveAbsolute` customization hook exists on illuminate's ExportContext (unlike the
    // reference's caller-supplied mapper, which defaults to `() => null` anyway) -- a
    // root-absolute ref always has no trusted local mapping, matching the reference's own
    // default behavior exactly.
    return { kind: 'unmapped-root', ref: effectiveRef };
  }
  const localPath = decodeLocalPath(stripQueryAndHash(effectiveRef));
  const resolveBaseDir = base.kind === 'local' ? base.dir : ctx.baseDir;
  const resolvedPath = resolveLocalPathPreservingTrailingSlash(resolveBaseDir, localPath);
  return { kind: 'file', path: resolvedPath };
}

export function resolveLocalPathPreservingTrailingSlash(baseDir: string, localPath: string): string {
  const resolved = resolve(baseDir, localPath);
  return localPath.endsWith('/') && !resolved.endsWith(sep) ? `${resolved}${sep}` : resolved;
}

export function warnUnresolvedDescriptor(descriptor: RefDescriptor, ref: string, ctx: ExportContext): void {
  const warning = unresolvedDescriptorWarning(descriptor, ref);
  if (warning) ctx.warnings.push(warning);
  if (descriptor.kind === 'unparseable-file-url') ctx.warnings.push({ kind: 'file-url-redacted', ref });
}

/**
 * Adapted from the reference: the `escape` descriptor kind it dispatches on here no longer
 * exists in this port's `RefDescriptor` union (see this file's header) -- the equivalent
 * `outside-root` warning is instead pushed directly by `readBudgeted`, once, after
 * `readLocalAsset` reports the candidate path `forbidden`.
 */
export function unresolvedDescriptorWarning(descriptor: RefDescriptor, ref: string): ExportWarning | null {
  if (descriptor.kind === 'unparseable-file-url') {
    return {
      kind: 'file-url-unresolved',
      ref,
      reason: 'file URL could not be resolved to a local file and was redacted',
    };
  }
  if (descriptor.kind === 'unmapped-root') {
    return {
      kind: 'unmapped-root-absolute',
      ref: descriptor.ref,
      reason: 'root-absolute reference has no trusted local mapping and is left unchanged',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Budgeted local reads (dist/cli.mjs lines 3807-3876) -- adapted to route through illuminate's
// own containment check instead of the reference's own (unported) file-reading helper.
// ---------------------------------------------------------------------------

/**
 * The ONLY function in the export subsystem that reads a local file's bytes off disk. Computes
 * the candidate path's shape as an incoming HTTP request path (leading '/', POSIX separators --
 * the containment check below treats `requestPath` as a URL path, not an OS path, so Windows `\`
 * separators must be normalized to `/` here or every Windows export would silently 404) and
 * hands the actual containment decision to illuminate's own confinement check
 * (src/serve/containment.ts). Size is checked via `stat` BEFORE `readFile`, never after.
 */
export async function readLocalAsset(
  confineDir: string,
  absCandidatePath: string,
  maxBytes: number,
): Promise<LocalAssetResult> {
  const relativePath = relative(confineDir, absCandidatePath);
  const requestPath = '/' + relativePath.split(sep).join('/');
  const result = await resolveAssetPath(confineDir, requestPath);
  if (result.kind === 'not-found') return { kind: 'not-found' };
  if (result.kind === 'forbidden') return { kind: 'forbidden' };
  const stats = await stat(result.path);
  if (stats.size > maxBytes) return { kind: 'too-large' };
  const bytes = await readFile(result.path);
  return { kind: 'ok', bytes };
}

export async function readBudgeted(
  descriptor: { readonly path: string },
  ref: string,
  ctx: ExportContext,
  options: { countBytes?: boolean } = {},
): Promise<Buffer | null> {
  const countBytes = options.countBytes !== false;
  const remainingBundleBytes = ctx.maxBundleBytes - ctx.inlinedBytes;
  if (remainingBundleBytes <= 0) {
    ctx.warnings.push({ kind: 'too-large', ref, reason: `would exceed per-bundle cap ${ctx.maxBundleBytes}` });
    return null;
  }
  const maxBytes = Math.min(ctx.maxAssetBytes, remainingBundleBytes);
  const result = await readLocalAsset(ctx.confineDir, descriptor.path, maxBytes);
  if (result.kind === 'not-found') {
    ctx.warnings.push({ kind: 'load-failed', ref, reason: 'file not found' });
    return null;
  }
  if (result.kind === 'forbidden') {
    ctx.warnings.push({ kind: 'outside-root', ref });
    return null;
  }
  if (result.kind === 'too-large') {
    const reason =
      remainingBundleBytes < ctx.maxAssetBytes
        ? `would exceed per-bundle cap ${ctx.maxBundleBytes}`
        : `exceeds per-asset cap ${ctx.maxAssetBytes}`;
    ctx.warnings.push({ kind: 'too-large', ref, reason });
    return null;
  }
  if (countBytes) ctx.inlinedBytes += result.bytes.length;
  return result.bytes;
}

// ---------------------------------------------------------------------------
// Loading text / data URIs (dist/cli.mjs lines 3049-3076)
// ---------------------------------------------------------------------------

export async function loadTextFromDescriptor(
  descriptor: RefDescriptor,
  ref: string,
  ctx: ExportContext,
  options: { countBytes?: boolean } = {},
): Promise<LoadedText | null> {
  if (descriptor.kind !== 'file') {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
    return null;
  }
  const buffer = await readBudgeted(descriptor, ref, ctx, options);
  if (!buffer) return null;
  return { text: buffer.toString('utf8'), baseDir: dirname(descriptor.path), byteLength: buffer.length };
}

export async function loadText(
  ref: string,
  baseDir: string | RefBase,
  ctx: ExportContext,
  options: RefOptions = {},
): Promise<LoadedText | null> {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  return loadTextFromDescriptor(descriptor, ref, ctx);
}

export async function loadDataUri(
  ref: string,
  baseDir: string | RefBase,
  ctx: ExportContext,
  options: RefOptions = {},
): Promise<string | null> {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind !== 'file') {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
    return null;
  }
  const buffer = await readBudgeted(descriptor, ref, ctx);
  if (!buffer) return null;
  const mime = pickMime(descriptor.path);
  if (mime === 'image/svg+xml') {
    // Deviation from the reference: the reference recursively sanitizes nested local refs
    // inside inlined SVG text via `transformInertMarkup` (its own recursive HTML-rewriting
    // orchestration) before encoding it. That recursive transform is 09-03's layer, which does
    // not exist yet here (this plan's objective is explicit: "no HTML-rewriting orchestration
    // yet"). This port encodes the SVG bytes as-is; 09-03 wires the sanitization pass in once
    // the full transform exists. The fragment-suffix preservation below (needed for
    // `<use href="sprite.svg#icon">`-shaped references into inlined SVG sprites) is unaffected
    // and ported unchanged.
    return `${toDataUri(buffer, mime)}${fragmentSuffix(normalizeRefForResolution(ref, options))}`;
  }
  return toDataUri(buffer, mime);
}

// ---------------------------------------------------------------------------
// Ref classification (dist/cli.mjs lines 3877-3910)
// ---------------------------------------------------------------------------

export function isInert(ref: string): boolean {
  return !ref || ref.startsWith('#') || /^%23/i.test(ref) || /^(data|blob|about|javascript|mailto|tel):/i.test(ref);
}

export function isHtmlDocumentRef(ref: string): boolean {
  const locator = normalizeRefForResolution(ref, HTML_REF_OPTIONS).trim();
  const { pathPart } = splitRefSuffix(locator);
  return ['.html', '.htm', '.xhtml'].includes(extname(decodeLocalPath(pathPart)).toLowerCase());
}

export function isHtmlDocumentType(attrs: string): boolean {
  const [rawType] = getDecisionAttr(attrs, 'type').trim().toLowerCase().split(';');
  const type = (rawType ?? '').trim();
  return type === 'text/html' || type === 'application/xhtml+xml';
}

export function shouldRedactUnresolvedRef(ref: string, options: RefOptions = {}): boolean {
  return isFileSchemeRef(ref, options);
}

export function containsFileUrl(ref: string): boolean {
  return /(^|[^a-z0-9+.-])file:/i.test(normalizeHtmlRefForScheme(ref));
}

export function isFileSchemeRef(ref: string, options: RefOptions = {}): boolean {
  return /^file:/i.test(normalizeRefForScheme(ref, options));
}

export function replaceUnresolvedAttrRef(source: string, name: string, ref: string): string {
  return shouldRedactUnresolvedRef(ref) ? replaceAttrValue(source, name, REDACTED_FILE_REF) : source;
}

/**
 * Exported for parity with the reference's own API surface and for potential reuse by later
 * plans for non-containment classification (e.g. CSS `@import` cycle bookkeeping). NOT part of
 * this file's security boundary: no local file read in this file is gated by this function --
 * `readLocalAsset`'s call into illuminate's own confinement check is the sole containment
 * authority (see this file's header).
 */
export function isOutside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// Ref string normalization (dist/cli.mjs lines 3911-3933, 3945-3995)
// ---------------------------------------------------------------------------

export function stripQueryAndHash(ref: string): string {
  return ref.replace(/[?#].*$/, '');
}

export function fragmentSuffix(ref: string): string {
  const value = String(ref).trim();
  const hashIndex = value.indexOf('#');
  return hashIndex === -1 ? '' : value.slice(hashIndex);
}

function splitRefSuffix(ref: string): { pathPart: string; suffix: string } {
  const match = String(ref).match(/^([^?#]*)(.*)$/s);
  return { pathPart: match ? (match[1] ?? '') : ref, suffix: match ? (match[2] ?? '') : '' };
}

export function normalizeRefForResolution(ref: string, options: RefOptions = {}): string {
  let value = String(ref);
  if (options.decodeHtmlEntities) value = decodeHtmlCharacterReferences(value);
  return options.cssSyntax ? decodeCssEscapes(value) : value;
}

export function normalizeRefForScheme(ref: string, options: RefOptions = {}): string {
  return options.cssSyntax ? normalizeCssRefForScheme(ref, options) : normalizeHtmlRefForScheme(ref);
}

export function normalizeHtmlRefForScheme(ref: string): string {
  return decodeHtmlCharacterReferences(String(ref || ''))
    .replace(/[\t\n\r]/g, '')
    .trim();
}

export function normalizeCssRefForScheme(ref: string, options: RefOptions = {}): string {
  const value = options.decodeHtmlEntities ? decodeHtmlCharacterReferences(String(ref || '')) : String(ref || '');
  return decodeCssEscapes(value)
    .replace(/[\t\n\f\r ]/g, '')
    .trim();
}

function decodeCssEscapes(value: string): string {
  const input = String(value);
  let result = '';
  let index = 0;
  while (index < input.length) {
    if (input[index] !== '\\') {
      result += input[index] ?? '';
      index += 1;
      continue;
    }
    if (index + 1 >= input.length) {
      result += '\\';
      break;
    }
    const next = input[index + 1] ?? '';
    if (next === '\r' && input[index + 2] === '\n') {
      index += 3;
      continue;
    }
    if (/[\n\r\f]/.test(next)) {
      index += 2;
      continue;
    }
    if (/[\da-f]/i.test(next)) {
      const escaped = readCssEscape(input, index);
      result += escaped.value;
      index = escaped.end;
      continue;
    }
    result += next;
    index += 2;
  }
  return result;
}

function readCssEscape(input: string, index: number): { value: string; end: number } {
  if (index + 1 >= input.length) return { value: '\\', end: index + 1 };
  const next = input[index + 1] ?? '';
  if (next === '\r' && input[index + 2] === '\n') return { value: '', end: index + 3 };
  if (/[\n\r\f]/.test(next)) return { value: '', end: index + 2 };
  if (/[\da-f]/i.test(next)) {
    let cursor = index + 1;
    let hex = '';
    while (cursor < input.length && hex.length < 6 && /[\da-f]/i.test(input[cursor] ?? '')) {
      hex += input[cursor] ?? '';
      cursor += 1;
    }
    const value = decodeNumericCharacterReference(Number.parseInt(hex, 16), '');
    if (cursor < input.length && /[\t\n\f\r ]/.test(input[cursor] ?? '')) cursor += 1;
    return { value, end: cursor };
  }
  return { value: next, end: index + 2 };
}

export function decodeLocalPath(ref: string): string {
  return String(ref)
    .split('/')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join('/');
}

// ---------------------------------------------------------------------------
// MIME / data URI / buffer helpers (dist/cli.mjs lines 3996-4008)
// ---------------------------------------------------------------------------

export function pickMime(locator: string): string {
  const ext = extname(stripQueryAndHash(locator)).toLowerCase();
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

export function toDataUri(buffer: Buffer, mime: string): string {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

export function toBuffer(value: Buffer | ArrayBuffer | ArrayBufferView | string): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(value);
}

// ---------------------------------------------------------------------------
// Budget resolution (dist/cli.mjs lines 4170-4175) -- same env-var-override pattern, illuminate's
// own env var names.
// ---------------------------------------------------------------------------

export function resolveBytes(optionValue: number | undefined, envValue: string | undefined, fallback: number): number {
  if (typeof optionValue === 'number' && Number.isFinite(optionValue) && optionValue > 0) return optionValue;
  const parsed = Number(envValue);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return fallback;
}
