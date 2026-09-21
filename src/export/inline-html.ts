// Ported from lavish-axi's export-bundle.js (MIT License, Copyright (c) 2026 Kun Chen).
// Source: https://github.com/kunchenguid/lavish-axi, vendored/ported 2026-09-11 from the locally
// cached build at lavish-axi@0.1.67 (dist/cli.mjs lines 877-4177, // src/export-bundle.js).
//
// This file is the assembled inlining/scrubbing transform itself: the CSS-token-level scanner,
// the JS-token-level import scanner (classic/module script import detection only), the
// transform orchestration (`transform`/`transformMarkup`/...), and the full inline/scrub/warn
// surface for links, scripts, styles, SVG, srcset, media, frames, and module-script/import-map
// content. It is the single largest borrowed chunk of the export subsystem -- most of the
// reference's own ~3,300-line module lives here, once the pure-lexing (09-01, tokenize.ts) and
// ref-resolution/budgeted-read layers (09-01, refs.ts) are factored out.
//
// Three deliberate departures from the reference, all documented at their exact point of change
// below as well as here:
//   1. `warnBaseHref`/`warnCspMeta` are NOT ported. illuminate already has `detectBaseHref`/
//      `detectAuthorCsp` in src/html/detect.ts (built for the live injection path, SERVE-05), and
//      09-04's CLI layer calls those directly against this function's OUTPUT instead. The
//      reference's own `warnBaseHref` is actually narrower than `detectBaseHref` (it only warns
//      when a `<base href>` fails to resolve to a real root; `detectBaseHref` warns on ANY
//      `<base href>` presence) -- reusing illuminate's simpler, more conservative detector is a
//      deliberate choice, not an oversight. `isCspMeta` itself IS still ported (unlike
//      `warnCspMeta`) because it is also used to decide which attribute the generic file://
//      scrubbing pass must skip (a CSP meta's own `content` attribute) -- that skip-name decision
//      has nothing to do with warning about the tag's presence.
//   2. `isInjectedLavishSdkSrc` is NOT ported -- it has no illuminate equivalent. The reference
//      checks this because ITS OWN export command can run against an already-served, already-SDK-
//      injected copy of the page. illuminate's `export` command (09-04) always reads the artifact's
//      RAW bytes directly off disk -- illuminate's own sdk.js injection (src/html/inject.ts) is a
//      request-time splice that is never persisted back to the source file, so no injected script
//      tag can ever appear in this function's input. Omitting the check is a "no illuminate
//      analog" exclusion, the same category as the reference's own `resolveDesignAssetPath`.
//   3. A NEW pass this file adds that the reference has no equivalent of at all: after `transform`
//      completes, `findRemoteReferenceWarnings` scans the transformed document's remaining
//      fetchable-attribute values (the same attribute/tag set `inlineAttr`/`inlineMediaAttrs`/
//      `inlineLink`/`inlineScript` already inspect while the transform runs) for any surviving
//      `http(s)://` reference and classifies each one as a `'remote-reference'` `ExportWarning`.
//      The reference's own `createExportOutput` treats a surviving remote CDN/font reference as an
//      accepted, unremarkable outcome ("it needs network to render those"); illuminate's EXP-01
//      requirement is stricter -- no outbound requests, full stop -- so a surviving live reference
//      is tracked as a classified problem here, never silently left as a working link. 09-04 wires
//      this into the export command's printed output and its own source-wide regression backstop.
//
// Everywhere the reference threaded its own `ctx.readLocalFile`/`ctx.resolveAbsolute` (a pluggable
// per-call option object), this port calls 09-01's `readBudgeted`/`loadText`/`loadDataUri`/
// `loadTextFromDescriptor` directly -- those already route every real file read through
// `readLocalAsset`, the sole caller of `resolveAssetPath` (src/export/refs.ts). No second,
// independently-implemented containment or file-reading path exists anywhere in this file.
//
// See THIRD-PARTY-NOTICES.md.

import { resolve as resolvePath, dirname as pathDirname, relative as pathRelative, isAbsolute as pathIsAbsolute } from 'node:path';
import type { ExportContext, ExportWarning, ExportWarningKind } from './types.ts';
import {
  readHtmlToken,
  popHtmlParent,
  pushHtmlParent,
  currentHtmlParent,
  elementNamespaceForTag,
  isEffectiveSelfClosingTag,
  findContentClose,
  isRawTextElementForNamespace,
  INERT_CONTENT_TAGS,
  PLAINTEXT_TAG,
  HTML_VOID_TAGS,
  MEDIA_TAGS,
  SVG_REF_TAGS,
  parseHtmlAttrs,
  findHtmlAttr,
  getAttr,
  getDecisionAttr,
  getTokenListAttr,
  hasAttr,
  replaceAttrValue,
  replaceAttrValuePreservingEntities,
  replaceAttrTokenValue,
  removeAttrs,
  formatStartTag,
  escapeRawText,
  decodeHtmlCharacterReferences,
  decodeNumericCharacterReference,
  escapeRegExp,
  type OpenStackEntry,
  type HtmlNamespace,
} from './tokenize.ts';
import type { RefBase, RefDescriptor, RefOptions } from './refs.ts';
import {
  resolveDocumentRefBase,
  resolveRef,
  readBudgeted,
  loadText,
  loadTextFromDescriptor,
  loadDataUri,
  toDataUri,
  pickMime,
  fragmentSuffix,
  isInert,
  isHtmlDocumentRef,
  isHtmlDocumentType,
  shouldRedactUnresolvedRef,
  containsFileUrl,
  isFileSchemeRef,
  replaceUnresolvedAttrRef,
  normalizeRefForResolution,
  normalizeRefBase,
  decodeLocalPath,
  warnUnresolvedDescriptor,
  unresolvedDescriptorWarning,
  DEFAULT_MAX_ASSET_BYTES,
  DEFAULT_MAX_BUNDLE_BYTES,
  MAX_ASSET_BYTES_ENV_VAR,
  MAX_BUNDLE_BYTES_ENV_VAR,
  resolveBytes,
} from './refs.ts';

// ---------------------------------------------------------------------------
// Constants (dist/cli.mjs lines 909-914) -- small literals duplicated locally rather than
// exported from refs.ts/tokenize.ts: each is either module-private there (REDACTED_FILE_REF) or
// scoped narrowly enough (HTML_REF_OPTIONS, the two reason strings) that widening either file's
// export surface for a single-file reuse was the wrong trade.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DEPTH = 8;
const REDACTED_FILE_REF = 'about:blank';
const HTML_REF_OPTIONS: RefOptions = { decodeHtmlEntities: true };
const INERT_RESOURCE_REASON = 'resources inside template or noscript content are left unchanged';
const SRCDOC_RESOURCE_REASON = 'iframe srcdoc nested HTML is left unchanged';

// ---------------------------------------------------------------------------
// Shared option shapes -- the reference threads a single, loosely-typed `options` bag through
// dozens of these functions (transform-side "is this inert/svg/srcdoc content" flags AND CSS-scrub
// "which warning kind, which reason, which dedupe set" flags reused across very different call
// sites). Rather than inventing a distinct interface per function (which the reference itself does
// not have, and which would misrepresent how loosely these are actually threaded), this port uses
// one shared, all-optional shape reused everywhere, mirroring the reference's real usage pattern.
// ---------------------------------------------------------------------------

interface ScrubOptions {
  readonly warnLocalRefs?: boolean;
  readonly localWarningKind?: ExportWarningKind | null;
  readonly localWarningReason?: string;
  readonly inSvgNamespace?: boolean;
  readonly decodeHtmlEntities?: boolean;
  seen?: Set<string>;
}

// ---------------------------------------------------------------------------
// Transform orchestration (dist/cli.mjs lines 976-1027, 1156-1343, 1397-1444)
// ---------------------------------------------------------------------------

/**
 * The transform's own entry point: resolves the document's own ref base (honors a `<base href>`
 * for RESOLUTION purposes only -- see this file's header, `<base>` itself is never rewritten) and
 * walks the whole document.
 */
async function transform(html: string, ctx: ExportContext): Promise<string> {
  const documentBase = resolveDocumentRefBase(html, ctx);
  return transformMarkup(html, documentBase, ctx);
}

async function transformMarkup(markup: string, baseDir: RefBase, ctx: ExportContext): Promise<string> {
  let result = '';
  let index = 0;
  const openStack: OpenStackEntry[] = [];
  while (index < markup.length) {
    const lt = markup.indexOf('<', index);
    if (lt === -1) {
      result += markup.slice(index);
      break;
    }
    result += markup.slice(index, lt);
    const token = readHtmlToken(markup, lt);
    if (!token) {
      result += markup[lt] ?? '';
      index = lt + 1;
      continue;
    }
    if (token.type === 'close') {
      popHtmlParent(openStack, token.tag.toLowerCase());
      result += scrubRawTextFileUrls(token.raw, ctx);
      index = token.end;
      continue;
    }
    if (token.type !== 'start') {
      result += token.type === 'comment' ? scrubHtmlComment(token.raw, ctx) : scrubRawTextFileUrls(token.raw, ctx);
      index = token.end;
      continue;
    }
    const tagName = token.tag.toLowerCase();
    const elementNamespace = elementNamespaceForTag(tagName, openStack);
    const effectiveSelfClosing = isEffectiveSelfClosingTag(tagName, token.selfClosing, openStack, elementNamespace);
    if (elementNamespace === 'html' && tagName === PLAINTEXT_TAG && !effectiveSelfClosing) {
      result += await transformPlaintextElement(token.tag, token.attrs, markup.slice(token.end), baseDir, ctx);
      index = markup.length;
      continue;
    }
    if (elementNamespace === 'html' && INERT_CONTENT_TAGS.has(tagName) && !effectiveSelfClosing) {
      const close = findContentClose(markup, token.end, tagName);
      if (close) {
        const body = markup.slice(token.end, close.start);
        result += await transformInertContentElement(token.tag, token.attrs, body, close.raw, baseDir, ctx);
        index = close.end;
        continue;
      }
      warnUnterminatedRawText(tagName, ctx);
      result += await transformInertContentElement(token.tag, token.attrs, markup.slice(token.end), '', baseDir, ctx);
      index = markup.length;
      continue;
    }
    if (isRawTextElementForNamespace(tagName, elementNamespace) && !effectiveSelfClosing) {
      const close = findContentClose(markup, token.end, tagName);
      if (close) {
        const body = markup.slice(token.end, close.start);
        result += await transformRawTextElement(token.tag, token.attrs, body, close.raw, baseDir, ctx, {
          inSvgNamespace: elementNamespace === 'svg',
        });
        index = close.end;
        continue;
      }
      warnUnterminatedRawText(tagName, ctx);
      result += await transformUnterminatedRawTextElement(token.tag, token.attrs, markup.slice(token.end), baseDir, ctx, {
        inSvgNamespace: elementNamespace === 'svg',
      });
      index = markup.length;
      continue;
    }
    result += await transformStartTag(
      token.tag,
      token.attrs,
      token.selfClosing,
      baseDir,
      ctx,
      currentHtmlParent(openStack),
      elementNamespace,
    );
    if (!effectiveSelfClosing && !HTML_VOID_TAGS.has(tagName)) pushHtmlParent(openStack, tagName, elementNamespace);
    index = token.end;
  }
  return result;
}

async function transformInertContentElement(
  tag: string,
  attrs: string,
  body: string,
  closeTag: string,
  baseDir: RefBase,
  ctx: ExportContext,
): Promise<string> {
  const tagName = tag.toLowerCase();
  const startTag = formatStartTag(tag, scrubInertAttrs(tagName, attrs, baseDir, ctx), false);
  return `${startTag}${transformInertMarkup(body, baseDir, ctx)}${scrubRawTextFileUrls(closeTag, ctx)}`;
}

async function transformPlaintextElement(
  tag: string,
  attrs: string,
  body: string,
  baseDir: RefBase,
  ctx: ExportContext,
): Promise<string> {
  const startTag = await transformStartTag(tag, attrs, false, baseDir, ctx);
  return `${startTag}${scrubRawTextBodyWithoutInlining(tag.toLowerCase(), attrs, body, baseDir, ctx)}`;
}

function transformInertMarkup(markup: string, baseDir: RefBase, ctx: ExportContext, options: ScrubOptions = {}): string {
  const warnLocalRefs = options.warnLocalRefs !== false;
  let result = '';
  let index = 0;
  const openStack: OpenStackEntry[] = [];
  while (index < markup.length) {
    const lt = markup.indexOf('<', index);
    if (lt === -1) {
      result += scrubRawTextFileUrls(markup.slice(index), ctx);
      break;
    }
    result += scrubRawTextFileUrls(markup.slice(index, lt), ctx);
    const token = readHtmlToken(markup, lt);
    if (!token) {
      result += markup[lt] ?? '';
      index = lt + 1;
      continue;
    }
    if (token.type !== 'start') {
      if (token.type === 'close') popHtmlParent(openStack, token.tag.toLowerCase());
      result += token.type === 'comment' ? scrubHtmlComment(token.raw, ctx) : scrubRawTextFileUrls(token.raw, ctx);
      index = token.end;
      continue;
    }
    const tagName = token.tag.toLowerCase();
    const elementNamespace = elementNamespaceForTag(tagName, openStack);
    const effectiveSelfClosing = isEffectiveSelfClosingTag(tagName, token.selfClosing, openStack, elementNamespace);
    if (elementNamespace === 'html' && tagName === PLAINTEXT_TAG && !effectiveSelfClosing) {
      if (warnLocalRefs) warnInertStartTagRefs(tagName, token.attrs, baseDir, ctx, options, elementNamespace);
      result += transformInertRawTextElement(token.tag, token.attrs, markup.slice(token.end), '', baseDir, ctx, {
        ...options,
        warnLocalRefs: false,
      });
      index = markup.length;
      continue;
    }
    if (
      ((elementNamespace === 'html' && INERT_CONTENT_TAGS.has(tagName)) ||
        isRawTextElementForNamespace(tagName, elementNamespace)) &&
      !effectiveSelfClosing
    ) {
      const close = findContentClose(markup, token.end, tagName);
      const bodyEnd = close ? close.start : markup.length;
      const body = markup.slice(token.end, bodyEnd);
      if (!close) warnUnterminatedRawText(tagName, ctx);
      if (INERT_CONTENT_TAGS.has(tagName)) {
        const attrs = scrubInertAttrs(tagName, token.attrs, baseDir, ctx, options);
        result += `${formatStartTag(token.tag, attrs, false)}${transformInertMarkup(body, baseDir, ctx, options)}${
          close ? scrubRawTextFileUrls(close.raw, ctx) : ''
        }`;
      } else {
        result += transformInertRawTextElement(token.tag, token.attrs, body, close ? close.raw : '', baseDir, ctx, {
          ...options,
          inSvgNamespace: elementNamespace === 'svg',
        });
      }
      index = close ? close.end : markup.length;
      continue;
    }
    if (warnLocalRefs) warnInertStartTagRefs(tagName, token.attrs, baseDir, ctx, options, elementNamespace);
    result += formatStartTag(
      token.tag,
      scrubInertAttrs(tagName, token.attrs, baseDir, ctx, { ...options, warnLocalRefs: false }),
      token.selfClosing,
    );
    if (!effectiveSelfClosing && !HTML_VOID_TAGS.has(tagName)) pushHtmlParent(openStack, tagName, elementNamespace);
    index = token.end;
  }
  return result;
}

async function transformRawTextElement(
  tag: string,
  attrs: string,
  body: string,
  closeTag: string,
  baseDir: RefBase,
  ctx: ExportContext,
  options: ScrubOptions = {},
): Promise<string> {
  const tagName = tag.toLowerCase();
  const safeCloseTag = scrubRawTextFileUrls(closeTag, ctx);
  const namespace: HtmlNamespace = options.inSvgNamespace ? 'svg' : 'html';
  if (tagName === 'style') {
    const startTag = await transformStartTag(tag, attrs, false, baseDir, ctx, '', namespace);
    if (!isCssStyleElementType(attrs)) {
      return `${startTag}${scrubUnsupportedStyleElementBody(body, baseDir, ctx)}${safeCloseTag}`;
    }
    return `${startTag}${escapeRawText(await inlineCss(body, baseDir, ctx, 0, baseDir), 'style')}${safeCloseTag}`;
  }
  if (tagName === 'script' && options.inSvgNamespace) {
    return inlineSvgScript(tag, attrs, body, safeCloseTag, baseDir, ctx);
  }
  if (tagName === 'script') return inlineScript(tag, attrs, body, safeCloseTag, baseDir, ctx);
  return `${await transformStartTag(tag, attrs, false, baseDir, ctx, '', namespace)}${scrubRawTextBodyWithoutInlining(
    tagName,
    attrs,
    body,
    baseDir,
    ctx,
  )}${safeCloseTag}`;
}

async function transformUnterminatedRawTextElement(
  tag: string,
  attrs: string,
  body: string,
  baseDir: RefBase,
  ctx: ExportContext,
  options: ScrubOptions = {},
): Promise<string> {
  const tagName = tag.toLowerCase();
  const namespace: HtmlNamespace = options.inSvgNamespace ? 'svg' : 'html';
  if (tagName === 'style') {
    const startTag = await transformStartTag(tag, attrs, false, baseDir, ctx, '', namespace);
    if (!isCssStyleElementType(attrs)) return `${startTag}${scrubUnsupportedStyleElementBody(body, baseDir, ctx)}`;
    return `${startTag}${escapeRawText(await inlineCss(body, baseDir, ctx, 0, baseDir), 'style')}`;
  }
  if (tagName === 'script') {
    if (options.inSvgNamespace) return inlineSvgScript(tag, attrs, body, '', baseDir, ctx);
    const src = getAttr(attrs, 'src');
    if (!src) return inlineScript(tag, attrs, body, '', baseDir, ctx);
    warnUnterminatedScriptSrc(src, baseDir, ctx, HTML_REF_OPTIONS);
    const startTag = await transformStartTag(
      tag,
      replaceUnresolvedAttrRef(attrs, 'src', src),
      false,
      baseDir,
      ctx,
      '',
      namespace,
    );
    return `${startTag}${escapeRawText(scrubRawTextFileUrls(body, ctx), 'script')}`;
  }
  const startTag = await transformStartTag(tag, attrs, false, baseDir, ctx, '', namespace);
  return `${startTag}${scrubRawTextBodyWithoutInlining(tagName, attrs, body, baseDir, ctx)}`;
}

function transformInertRawTextElement(
  tag: string,
  attrs: string,
  body: string,
  closeTag: string,
  baseDir: RefBase,
  ctx: ExportContext,
  options: ScrubOptions = {},
): string {
  if (options.warnLocalRefs !== false) {
    warnInertStartTagRefs(tag.toLowerCase(), attrs, baseDir, ctx, options, options.inSvgNamespace ? 'svg' : 'html');
  }
  const startTag = formatStartTag(
    tag,
    scrubInertAttrs(tag.toLowerCase(), attrs, baseDir, ctx, { ...options, warnLocalRefs: false }),
    false,
  );
  return `${startTag}${scrubRawTextBodyWithoutInlining(tag.toLowerCase(), attrs, body, baseDir, ctx, options)}${scrubRawTextFileUrls(
    closeTag,
    ctx,
  )}`;
}

function scrubRawTextBodyWithoutInlining(
  tagName: string,
  attrs: string,
  body: string,
  baseDir: RefBase,
  ctx: ExportContext,
  options: ScrubOptions = {},
): string {
  if (tagName === 'style') {
    const warningKind: ExportWarningKind | null =
      options.warnLocalRefs === false ? null : options.localWarningKind || 'inert-resource';
    return scrubCssRefsWithoutInlining(body, baseDir, ctx, {
      localWarningKind: warningKind,
      localWarningReason: options.localWarningReason || INERT_RESOURCE_REASON,
    });
  }
  if (tagName === 'script') {
    let scrubbed = body;
    const warnActiveScriptDependencies = options.localWarningKind === 'srcdoc-resource';
    if (isModuleScript(attrs)) {
      scrubbed = redactInlineModuleFileRefs(scrubbed, ctx, { warnUnresolved: warnActiveScriptDependencies });
      if (warnActiveScriptDependencies) warnInlineModuleImports(scrubbed, baseDir, ctx);
      scrubbed = scrubClassicScriptFileUrlComments(scrubbed, ctx);
    }
    if (isImportMapScript(attrs)) {
      scrubbed = redactInlineImportMapFileRefs(scrubbed, ctx, { warnUnresolved: warnActiveScriptDependencies });
      if (warnActiveScriptDependencies) warnInlineImportMapLocalRefs(scrubbed, baseDir, ctx);
    }
    if (warnActiveScriptDependencies && isClassicScript(attrs)) warnClassicScriptDynamicImports(scrubbed, baseDir, ctx);
    return escapeRawText(scrubRawTextFileUrls(scrubbed, ctx), 'script');
  }
  return scrubRawTextFileUrls(body, ctx);
}

async function transformStartTag(
  tag: string,
  attrs: string,
  selfClosing: boolean,
  baseDir: RefBase,
  ctx: ExportContext,
  parentTag = '',
  namespace: HtmlNamespace = 'html',
): Promise<string> {
  const tagName = tag.toLowerCase();
  const elementNamespace = namespace || 'html';
  const inHtmlNamespace = elementNamespace === 'html';
  const inSvgNamespace = elementNamespace === 'svg';
  let next = attrs;
  if (inHtmlNamespace && MEDIA_TAGS.has(tagName)) {
    next = await inlineMediaAttrs(tagName, next, baseDir, ctx, parentTag);
  }
  if (SVG_REF_TAGS.has(tagName) && inSvgNamespace) {
    next = await inlineAttr(next, 'href', baseDir, ctx);
    next = await inlineAttr(next, 'xlink:href', baseDir, ctx);
  }
  if (tagName === 'script' && inSvgNamespace) {
    next = await inlineSvgScriptAttrs(next, baseDir, ctx);
  }
  if (inHtmlNamespace) next = await inlineRenderResourceAttrs(tagName, next, baseDir, ctx);
  next = await inlineStyleAttr(next, baseDir, ctx);
  // Neither `warnCspMeta` nor `warnBaseHref` is ported (see this file's header) -- `isCspMetaTag`
  // is still computed because it decides which attribute name the generic file:// scrub below
  // must skip (a CSP meta's own `content`), a decision independent of whether the tag's presence
  // is itself warned about.
  const isCspMetaTag = inHtmlNamespace && tagName === 'meta' && isCspMeta(next);
  if (inHtmlNamespace && tagName === 'link') {
    const linked = await inlineLink(next, baseDir, ctx);
    if (linked.replacement !== undefined) return linked.replacement;
    next = linked.attrs;
  }
  next = scrubFileUrlAttrs(next, ctx, { skipNames: fileUrlScrubSkipNames(tagName, isCspMetaTag) });
  return formatStartTag(tag, next, selfClosing);
}

function fileUrlScrubSkipNames(tagName: string, isCspMetaTag: boolean): string[] {
  const names: string[] = [];
  if (isCspMetaTag) names.push('content');
  if (tagName === 'iframe') names.push('srcdoc');
  return names;
}

function scrubFileUrlAttrs(attrs: string, ctx: ExportContext, options: { skipNames?: readonly string[] } = {}): string {
  let result = attrs;
  const parsed = parseHtmlAttrs(attrs);
  const skipNames = new Set((options.skipNames ?? []).map((name) => name.toLowerCase()));
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const attr = parsed[index];
    if (!attr) continue;
    if (skipNames.has(attr.name.toLowerCase())) continue;
    if (!attr.hasValue || !containsFileUrl(attr.value)) continue;
    ctx.warnings.push({ kind: 'file-url-redacted', ref: attr.value });
    result = replaceAttrTokenValue(result, attr, REDACTED_FILE_REF, { preserveEntities: true });
  }
  return result;
}

function scrubInertAttrs(
  tagName: string,
  attrs: string,
  baseDir: RefBase,
  ctx: ExportContext,
  options: ScrubOptions = {},
): string {
  let result = scrubInertStyleAttr(attrs, baseDir, ctx, options);
  if (tagName === 'iframe') result = scrubFrameSrcdoc(result, baseDir, ctx, options);
  const isCspMetaTag = tagName === 'meta' && isCspMeta(result);
  result = scrubFileUrlAttrs(result, ctx, { skipNames: fileUrlScrubSkipNames(tagName, isCspMetaTag) });
  return result;
}

function scrubInertStyleAttr(attrs: string, baseDir: RefBase, ctx: ExportContext, options: ScrubOptions = {}): string {
  const attr = findHtmlAttr(attrs, 'style');
  if (!attr || !attr.hasValue) return attrs;
  const decoded = decodeHtmlCharacterReferences(attr.value);
  const scrubbed = scrubCssRefsWithoutInlining(decoded, baseDir, ctx, {
    localWarningKind: options.warnLocalRefs === false ? null : options.localWarningKind || 'inert-resource',
    localWarningReason: options.localWarningReason || INERT_RESOURCE_REASON,
  });
  return scrubbed === decoded ? attrs : replaceAttrTokenValue(attrs, attr, scrubbed);
}

async function inlineRenderResourceAttrs(tagName: string, attrs: string, baseDir: RefBase, ctx: ExportContext): Promise<string> {
  if (tagName === 'object') return inlineRenderAttr(attrs, 'data', baseDir, ctx, { nestedHtml: true });
  if (tagName === 'embed') return inlineRenderAttr(attrs, 'src', baseDir, ctx, { nestedHtml: true });
  if (tagName === 'input') {
    if (getDecisionAttr(attrs, 'type').trim().toLowerCase() !== 'image') return attrs;
    return inlineRenderAttr(attrs, 'src', baseDir, ctx);
  }
  if (tagName === 'iframe') {
    return scrubFrameSrcdoc(warnFrameSrc(attrs, baseDir, ctx), baseDir, ctx, {
      localWarningKind: 'srcdoc-resource',
      localWarningReason: SRCDOC_RESOURCE_REASON,
    });
  }
  return attrs;
}

async function inlineRenderAttr(
  attrs: string,
  name: string,
  baseDir: RefBase,
  ctx: ExportContext,
  options: { nestedHtml?: boolean } = {},
): Promise<string> {
  const value = getAttr(attrs, name);
  if (!value) return attrs;
  if (options.nestedHtml && (isHtmlDocumentRef(value) || isHtmlDocumentType(attrs))) {
    warnUnsupportedFrame(value, baseDir, ctx, HTML_REF_OPTIONS);
    return replaceUnresolvedAttrRef(attrs, name, value);
  }
  return inlineAttr(attrs, name, baseDir, ctx);
}

async function inlineStyleAttr(attrs: string, baseDir: RefBase, ctx: ExportContext): Promise<string> {
  const attr = findHtmlAttr(attrs, 'style');
  if (!attr || !attr.hasValue) return attrs;
  const decoded = decodeHtmlCharacterReferences(attr.value);
  const rewritten = await inlineCssUrls(decoded, baseDir, ctx, baseDir, { decodeHtmlEntities: false });
  return rewritten === decoded ? attrs : replaceAttrTokenValue(attrs, attr, rewritten);
}

interface InlineLinkResult {
  readonly attrs: string;
  readonly replacement?: string;
}

async function inlineLink(attrs: string, baseDir: RefBase, ctx: ExportContext): Promise<InlineLinkResult> {
  const rel = getTokenListAttr(attrs, 'rel');
  const href = getAttr(attrs, 'href');
  if (!href) return { attrs };
  if (rel.includes('stylesheet')) {
    if (!isCssStylesheetType(attrs)) {
      warnUnsupportedStylesheetType(href, baseDir, ctx, HTML_REF_OPTIONS);
      return { attrs: replaceUnresolvedAttrRef(attrs, 'href', href) };
    }
    if (isInactiveStylesheet(attrs, rel)) {
      warnInactiveStylesheet(href, baseDir, ctx, HTML_REF_OPTIONS);
      return { attrs: replaceUnresolvedAttrRef(attrs, 'href', href) };
    }
    if (hasStylesheetBehaviorAttrs(attrs)) {
      warnBehavioralStylesheet(href, baseDir, ctx, HTML_REF_OPTIONS);
      return { attrs: replaceUnresolvedAttrRef(attrs, 'href', href) };
    }
    const loaded = await loadText(href, baseDir, ctx, HTML_REF_OPTIONS);
    if (!loaded) return { attrs: replaceUnresolvedAttrRef(attrs, 'href', href) };
    const css = await inlineCss(loaded.text, normalizeRefBase(loaded.baseDir), ctx, 0, baseDir);
    const media = scrubGeneratedHtmlAttrValue(getDecisionAttr(attrs, 'media'), ctx);
    return {
      attrs,
      replacement: `<style${media ? ` media="${escapeAttr(media)}"` : ''}>${escapeRawText(css, 'style')}</style>`,
    };
  }
  if (rel.includes('preload') && getDecisionAttr(attrs, 'as').trim().toLowerCase() === 'style') {
    warnPreloadStylesheet(href, baseDir, ctx, HTML_REF_OPTIONS);
    return { attrs: replaceUnresolvedAttrRef(attrs, 'href', href) };
  }
  if (rel.some((value) => ['icon', 'shortcut', 'apple-touch-icon', 'mask-icon'].includes(value))) {
    const dataUri = await loadDataUri(href, baseDir, ctx, HTML_REF_OPTIONS);
    if (!dataUri) return { attrs: replaceUnresolvedAttrRef(attrs, 'href', href) };
    return { attrs: replaceAttrValue(attrs, 'href', dataUri) };
  }
  if (isFetchableLinkRel(rel)) {
    warnFetchableLink(href, baseDir, ctx, HTML_REF_OPTIONS);
    return { attrs: replaceUnresolvedAttrRef(attrs, 'href', href) };
  }
  return { attrs };
}

function isFetchableLinkRel(rel: readonly string[]): boolean {
  return rel.some((value) => ['preload', 'modulepreload', 'prefetch', 'manifest'].includes(value));
}

function isInactiveStylesheet(attrs: string, rel: readonly string[]): boolean {
  return hasAttr(attrs, 'disabled') || rel.includes('alternate');
}

function hasStylesheetBehaviorAttrs(attrs: string): boolean {
  return parseHtmlAttrs(attrs).some((attr) => attr.name.toLowerCase().startsWith('on'));
}

function scrubGeneratedHtmlAttrValue(value: string, ctx: ExportContext): string {
  const text = String(value || '');
  if (!text || !containsFileUrl(text)) return text;
  ctx.warnings.push({ kind: 'file-url-redacted', ref: text });
  return REDACTED_FILE_REF;
}

function isCssStylesheetType(attrs: string): boolean {
  const type = getDecisionAttr(attrs, 'type').trim().toLowerCase();
  if (!type) return true;
  return (type.split(';')[0] ?? '').trim() === 'text/css';
}

function isCssStyleElementType(attrs: string): boolean {
  return isCssStylesheetType(attrs);
}

function isCspMeta(attrs: string): boolean {
  return getDecisionAttr(attrs, 'http-equiv').trim().toLowerCase() === 'content-security-policy';
}

async function inlineScript(
  tag: string,
  attrs: string,
  body: string,
  closeTag: string,
  baseDir: RefBase,
  ctx: ExportContext,
): Promise<string> {
  const src = getAttr(attrs, 'src');
  if (!src) {
    let inlineBody = body;
    if (isModuleScript(attrs)) {
      inlineBody = redactInlineModuleFileRefs(inlineBody, ctx, { warnUnresolved: true });
      warnInlineModuleImports(inlineBody, baseDir, ctx);
      inlineBody = scrubClassicScriptFileUrlComments(inlineBody, ctx);
    }
    if (isImportMapScript(attrs)) {
      inlineBody = redactInlineImportMapFileRefs(inlineBody, ctx, { warnUnresolved: true });
      warnInlineImportMapLocalRefs(inlineBody, baseDir, ctx);
    }
    if (isClassicScript(attrs)) {
      warnClassicScriptDynamicImports(inlineBody, baseDir, ctx);
      inlineBody = scrubClassicScriptFileUrlComments(inlineBody, ctx);
    }
    if (!isClassicScript(attrs) && !isModuleScript(attrs)) inlineBody = scrubRawTextFileUrls(inlineBody, ctx);
    return `${await transformStartTag(tag, attrs, false, baseDir, ctx)}${escapeRawText(inlineBody, 'script')}${closeTag}`;
  }
  // No `isInjectedLavishSdkSrc`-equivalent check here -- see this file's header, point 2.
  if (isModuleScript(attrs)) {
    warnExternalModuleScript(src, baseDir, ctx, HTML_REF_OPTIONS);
    const startTag = await transformStartTag(tag, replaceUnresolvedAttrRef(attrs, 'src', src), false, baseDir, ctx);
    return `${startTag}${escapeRawText(scrubRawTextFileUrls(body, ctx), 'script')}${closeTag}`;
  }
  if (!isClassicScript(attrs)) {
    warnUnsupportedScriptType(src, baseDir, ctx, HTML_REF_OPTIONS);
    const startTag = await transformStartTag(tag, replaceUnresolvedAttrRef(attrs, 'src', src), false, baseDir, ctx);
    return `${startTag}${escapeRawText(scrubRawTextFileUrls(body, ctx), 'script')}${closeTag}`;
  }
  if (hasAttr(attrs, 'defer') || hasAttr(attrs, 'async')) {
    warnUnsupportedScriptTiming(src, baseDir, ctx, HTML_REF_OPTIONS);
    const startTag = await transformStartTag(tag, replaceUnresolvedAttrRef(attrs, 'src', src), false, baseDir, ctx);
    return `${startTag}${escapeRawText(scrubRawTextFileUrls(body, ctx), 'script')}${closeTag}`;
  }
  const loaded = await loadText(src, baseDir, ctx, HTML_REF_OPTIONS);
  if (!loaded) {
    const startTag = await transformStartTag(tag, replaceUnresolvedAttrRef(attrs, 'src', src), false, baseDir, ctx);
    return `${startTag}${escapeRawText(scrubRawTextFileUrls(body, ctx), 'script')}${closeTag}`;
  }
  const cleanedAttrs = removeAttrs(attrs, ['src', 'integrity', 'crossorigin']);
  const startTag = await transformStartTag(tag, cleanedAttrs, false, baseDir, ctx);
  warnClassicScriptDynamicImports(loaded.text, normalizeRefBase(loaded.baseDir), ctx);
  return `${startTag}${escapeRawText(scrubClassicScriptFileUrlComments(loaded.text, ctx), 'script')}${closeTag}`;
}

async function inlineSvgScript(
  tag: string,
  attrs: string,
  body: string,
  closeTag: string,
  baseDir: RefBase,
  ctx: ExportContext,
): Promise<string> {
  const startTag = await transformStartTag(tag, attrs, false, baseDir, ctx, '', 'svg');
  const executable = isClassicScript(attrs) || isModuleScript(attrs);
  if (isClassicScript(attrs)) warnClassicScriptDynamicImports(body, baseDir, ctx);
  const scrubbed = executable ? scrubClassicScriptFileUrlComments(body, ctx) : scrubRawTextFileUrls(body, ctx);
  return `${startTag}${escapeRawText(scrubbed, 'script')}${closeTag}`;
}

async function inlineSvgScriptAttrs(attrs: string, baseDir: RefBase, ctx: ExportContext): Promise<string> {
  let next = attrs;
  next = await inlineSvgScriptAttr(next, 'href', baseDir, ctx);
  next = await inlineSvgScriptAttr(next, 'xlink:href', baseDir, ctx);
  return next;
}

async function inlineSvgScriptAttr(attrs: string, name: string, baseDir: RefBase, ctx: ExportContext): Promise<string> {
  const value = getAttr(attrs, name);
  if (!value) return attrs;
  const descriptor = resolveRef(value, baseDir, ctx, HTML_REF_OPTIONS);
  if (descriptor.kind !== 'file') {
    warnUnresolvedDescriptor(descriptor, value, ctx);
    return replaceUnresolvedAttrRef(attrs, name, value);
  }
  const buffer = await readBudgeted(descriptor, value, ctx);
  if (!buffer) return replaceUnresolvedAttrRef(attrs, name, value);
  const rawText = buffer.toString('utf8');
  if (isClassicScript(attrs)) warnClassicScriptDynamicImports(rawText, normalizeRefBase(pathDirname(descriptor.path)), ctx);
  const text = scrubClassicScriptFileUrlComments(rawText, ctx);
  const dataUri = `${toDataUri(Buffer.from(text, 'utf8'), pickMime(descriptor.path))}${fragmentSuffix(
    normalizeRefForResolution(value, HTML_REF_OPTIONS),
  )}`;
  return replaceAttrValue(attrs, name, dataUri);
}

async function inlineMediaAttrs(
  tagName: string,
  attrs: string,
  baseDir: RefBase,
  ctx: ExportContext,
  parentTag = '',
): Promise<string> {
  let next = attrs;
  if (tagName === 'track' && parentTag !== 'video' && parentTag !== 'audio') return next;
  if (tagName !== 'source' || parentTag === 'video' || parentTag === 'audio') {
    next = await inlineAttr(next, 'src', baseDir, ctx);
  }
  if (tagName === 'video') next = await inlineAttr(next, 'poster', baseDir, ctx);
  if (tagName === 'img' || (tagName === 'source' && parentTag === 'picture')) {
    next = await inlineSrcset(next, baseDir, ctx);
  }
  return next;
}

async function inlineAttr(attrs: string, name: string, baseDir: RefBase, ctx: ExportContext): Promise<string> {
  const value = getAttr(attrs, name);
  if (!value) return attrs;
  const dataUri = await loadDataUri(value, baseDir, ctx, HTML_REF_OPTIONS);
  if (!dataUri) return replaceUnresolvedAttrRef(attrs, name, value);
  return replaceAttrValue(attrs, name, dataUri);
}

async function inlineSrcset(attrs: string, baseDir: RefBase, ctx: ExportContext): Promise<string> {
  const value = getAttr(attrs, 'srcset');
  if (!value) return attrs;
  const candidates = parseSrcsetCandidates(value);
  let result = '';
  let lastIndex = 0;
  let changed = false;
  for (const candidate of candidates) {
    result += value.slice(lastIndex, candidate.urlStart);
    const ref = value.slice(candidate.urlStart, candidate.urlEnd);
    if (isInert(decodeHtmlCharacterReferences(ref.trim()))) {
      result += ref;
    } else {
      const dataUri = await loadDataUri(ref, baseDir, ctx, HTML_REF_OPTIONS);
      if (dataUri) {
        changed = true;
        result += dataUri;
      } else if (shouldRedactUnresolvedRef(ref)) {
        changed = true;
        result += REDACTED_FILE_REF;
      } else {
        result += ref;
      }
    }
    lastIndex = candidate.urlEnd;
  }
  result += value.slice(lastIndex);
  return changed ? replaceAttrValuePreservingEntities(attrs, 'srcset', result) : attrs;
}

interface SrcsetCandidate {
  readonly urlStart: number;
  readonly urlEnd: number;
}

function parseSrcsetCandidates(value: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && (isHtmlSpaceChar(value[index]) || value[index] === ',')) index += 1;
    if (index >= value.length) break;
    const urlStart = index;
    const dataUrl = value.slice(index, index + 'data:'.length).toLowerCase() === 'data:';
    let sawDataPayloadComma = false;
    while (index < value.length) {
      const char = value[index];
      if (isHtmlSpaceChar(char)) break;
      if (char === ',') {
        if (!dataUrl) break;
        if (!sawDataPayloadComma) {
          sawDataPayloadComma = true;
        } else if (isSrcsetCandidateSeparator(value, index)) {
          break;
        }
      }
      index += 1;
    }
    let urlEnd = index;
    while (urlEnd > urlStart && value[urlEnd - 1] === ',') urlEnd -= 1;
    if (urlEnd > urlStart) candidates.push({ urlStart, urlEnd });
    while (index < value.length && value[index] !== ',') index += 1;
    if (index < value.length && value[index] === ',') index += 1;
  }
  return candidates;
}

function isSrcsetCandidateSeparator(value: string, commaIndex: number): boolean {
  let cursor = commaIndex + 1;
  while (cursor < value.length && isHtmlSpaceChar(value[cursor])) cursor += 1;
  return cursor >= value.length || cursor > commaIndex + 1;
}

/** Local duplicate of tokenize.ts's own module-private `isHtmlSpace` -- that file does not export
 * it, and this port needs the identical classifier for srcset scanning (a genuinely separate call
 * site from the tokenizer core, mirroring the reference's own single, silently-redeclared
 * `isHtmlSpace` at this exact point in export-bundle.js). */
function isHtmlSpaceChar(char: string | undefined): boolean {
  return char !== undefined && /[\t\n\f\r ]/.test(char);
}

// ---------------------------------------------------------------------------
// CSS scanner + inline/scrub (dist/cli.mjs lines 1682-2773, 2984-2263[wrapped])
// ---------------------------------------------------------------------------

interface CssStringToken {
  readonly value: string;
  readonly end: number;
}

interface CssUrlToken {
  readonly raw: string;
  readonly ref: string;
  readonly quote: string;
  readonly end: number;
  readonly refStart: number;
  readonly refEnd: number;
}

interface CssImageSetMatch {
  readonly argsStart: number;
  readonly argsEnd: number;
  readonly end: number;
}

interface CssConditionalBlock {
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly end: number;
}

interface CssImportRuleParsed {
  readonly ref: string;
  readonly media: string;
  readonly refStart: number;
  readonly refEnd: number;
}

interface CssNamespaceRefParsed {
  readonly ref: string;
  readonly refStart: number;
  readonly refEnd: number;
}

interface CssPreludeTextSegment {
  readonly type: 'text';
  readonly text: string;
}

interface CssPreludeNamespaceSegment {
  readonly type: 'namespace';
  readonly text: string;
}

interface CssPreludeImportSegment {
  readonly type: 'import';
  readonly rule: string;
  readonly parsed: CssImportRuleParsed;
}

type CssPreludeSegment = CssPreludeTextSegment | CssPreludeNamespaceSegment | CssPreludeImportSegment;

interface CssPrelude {
  readonly segments: CssPreludeSegment[];
  readonly bodyStart: number;
  readonly hasNamespace: boolean;
}

type CssImportClassification =
  | { readonly kind: 'depth' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'candidate'; readonly descriptor: RefDescriptor }
  | { readonly kind: Exclude<RefDescriptor['kind'], 'file'>; readonly descriptor: RefDescriptor };

async function inlineCss(css: string, baseDir: RefBase, ctx: ExportContext, depth: number, outputBaseDir: RefBase): Promise<string> {
  const withImports = await inlineCssImports(css, baseDir, ctx, depth, outputBaseDir);
  return inlineCssUrls(withImports.css, baseDir, ctx, outputBaseDir);
}

interface InlineCssImportsResult {
  readonly css: string;
  readonly complete: boolean;
  readonly hasNamespace: boolean;
}

async function inlineCssImports(
  css: string,
  baseDir: RefBase,
  ctx: ExportContext,
  depth: number,
  outputBaseDir: RefBase,
): Promise<InlineCssImportsResult> {
  const prelude = collectCssPrelude(css);
  const imports = prelude.segments.filter((segment): segment is CssPreludeImportSegment => segment.type === 'import');
  const startBytes = ctx.inlinedBytes;
  const prepared = new Map<CssPreludeImportSegment, string>();
  const classifications = new Map<CssPreludeImportSegment, CssImportClassification>();
  let complete = true;
  let failureIndex = -1;
  let failureCause = '';
  if (prelude.hasNamespace && imports.length > 0) {
    complete = false;
    failureIndex = 0;
    failureCause = 'namespace';
  } else {
    for (let importIndex = 0; importIndex < imports.length; importIndex += 1) {
      const item = imports[importIndex];
      if (!item) continue;
      const classification = classifyCssImport(item.parsed, baseDir, ctx, depth);
      classifications.set(item, classification);
      if (classification.kind !== 'candidate') {
        complete = false;
        failureIndex = importIndex;
        failureCause = classification.kind;
        break;
      }
      const loaded = await loadTextFromDescriptor(classification.descriptor, item.parsed.ref, ctx);
      if (!loaded) {
        complete = false;
        failureIndex = importIndex;
        failureCause = 'load';
        break;
      }
      const inner = await prepareCssImportInline(loaded.text, normalizeRefBase(loaded.baseDir), ctx, depth + 1, outputBaseDir);
      if (!inner.inlineable) {
        complete = false;
        failureIndex = importIndex;
        failureCause = inner.reason || 'nested';
        break;
      }
      prepared.set(item, item.parsed.media ? `@media ${item.parsed.media}{${inner.css}}` : inner.css);
    }
  }
  if (!complete) ctx.inlinedBytes = startBytes;
  let result = '';
  for (const segment of prelude.segments) {
    if (segment.type !== 'import') {
      result += segment.text;
      continue;
    }
    if (complete) {
      result += prepared.has(segment) ? (prepared.get(segment) ?? '') : segment.rule;
      continue;
    }
    warnExternalizedCssImport(segment, baseDir, ctx, depth, imports.indexOf(segment), failureIndex, failureCause, classifications.get(segment));
    result += rebaseCssImportRule(segment.rule, segment.parsed, baseDir, outputBaseDir);
  }
  const body = rewriteLateCssImports(css.slice(prelude.bodyStart), baseDir, ctx, outputBaseDir);
  return { css: result + body.css, complete: complete && body.complete, hasNamespace: prelude.hasNamespace };
}

interface PrepareCssImportInlineResult {
  readonly inlineable: boolean;
  readonly css: string;
  readonly reason?: string;
}

async function prepareCssImportInline(
  css: string,
  baseDir: RefBase,
  ctx: ExportContext,
  depth: number,
  outputBaseDir: RefBase,
): Promise<PrepareCssImportInlineResult> {
  const withImports = await inlineCssImports(css, baseDir, ctx, depth, outputBaseDir);
  if (!withImports.complete) {
    return { inlineable: false, css: '', reason: withImports.hasNamespace ? 'namespace' : 'nested' };
  }
  if (withImports.hasNamespace) return { inlineable: false, css: '', reason: 'namespace' };
  return { inlineable: true, css: await inlineCssUrls(withImports.css, baseDir, ctx, outputBaseDir) };
}

function collectCssPrelude(css: string): CssPrelude {
  const segments: CssPreludeSegment[] = [];
  let index = 0;
  while (index < css.length) {
    const start = index;
    const commentEnd = css.startsWith('/*', index) ? findCssCommentEnd(css, index) : -1;
    if (commentEnd !== -1) {
      segments.push({ type: 'text', text: css.slice(index, commentEnd) });
      index = commentEnd;
      continue;
    }
    if (/\s/.test(css[index] ?? '')) {
      index += 1;
      while (index < css.length && /\s/.test(css[index] ?? '')) index += 1;
      segments.push({ type: 'text', text: css.slice(start, index) });
      continue;
    }
    if (startsCssKeyword(css, index, '@import')) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) break;
      const rule = css.slice(index, ruleEnd + 1);
      const parsed = parseCssImportRule(rule);
      if (!parsed) break;
      segments.push({ type: 'import', rule, parsed });
      index = ruleEnd + 1;
      continue;
    }
    if (startsCssKeyword(css, index, '@charset')) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) break;
      segments.push({ type: 'text', text: css.slice(index, ruleEnd + 1) });
      index = ruleEnd + 1;
      continue;
    }
    if (startsCssKeyword(css, index, '@layer')) {
      const statementEnd = findCssPreludeStatementEnd(css, index);
      if (statementEnd !== -1 && css[statementEnd] === ';') {
        segments.push({ type: 'text', text: css.slice(index, statementEnd + 1) });
        index = statementEnd + 1;
        continue;
      }
    }
    if (startsCssKeyword(css, index, '@namespace')) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) break;
      segments.push({ type: 'namespace', text: css.slice(index, ruleEnd + 1) });
      index = ruleEnd + 1;
      continue;
    }
    break;
  }
  return { segments, bodyStart: index, hasNamespace: segments.some((segment) => segment.type === 'namespace') };
}

function classifyCssImport(parsed: CssImportRuleParsed, baseDir: RefBase, ctx: ExportContext, depth: number): CssImportClassification {
  if (depth >= ctx.maxDepth) return { kind: 'depth' };
  if (parsed.media && !isPlainCssMediaQueryList(parsed.media)) return { kind: 'unsupported' };
  const descriptor = resolveRef(parsed.ref, baseDir, ctx, { cssSyntax: true });
  if (descriptor.kind === 'file') return { kind: 'candidate', descriptor };
  return { kind: descriptor.kind, descriptor };
}

function warnExternalizedCssImport(
  item: CssPreludeImportSegment,
  baseDir: RefBase,
  ctx: ExportContext,
  depth: number,
  importIndex: number,
  failureIndex: number,
  failureCause: string,
  classificationIn: CssImportClassification | undefined,
): void {
  const classification = classificationIn ?? classifyCssImport(item.parsed, baseDir, ctx, depth);
  if (classification.kind === 'candidate') {
    if (importIndex === failureIndex && failureCause === 'load') return;
    warnCssImportOrder(item.parsed.ref, classification.descriptor, ctx);
    return;
  }
  if (classification.kind === 'depth') {
    warnCssImportDepth(item.parsed.ref, baseDir, ctx);
  } else if (classification.kind === 'unsupported') {
    warnUnsupportedCssImport(item.parsed.ref, baseDir, ctx, item.parsed.media);
  } else {
    warnUnresolvedDescriptor(classification.descriptor, item.parsed.ref, ctx);
  }
}

interface RewriteLateCssImportsResult {
  readonly css: string;
  readonly complete: boolean;
}

function rewriteLateCssImports(css: string, baseDir: RefBase, ctx: ExportContext, outputBaseDir: RefBase): RewriteLateCssImportsResult {
  let result = '';
  let index = 0;
  let complete = true;
  while (index < css.length) {
    const commentEnd = css.startsWith('/*', index) ? findCssCommentEnd(css, index) : -1;
    if (commentEnd !== -1) {
      result += scrubCssComment(css.slice(index, commentEnd), ctx);
      index = commentEnd;
      continue;
    }
    if (css[index] === '"' || css[index] === "'") {
      const stringEnd = findCssStringEnd(css, index);
      result += css.slice(index, stringEnd);
      index = stringEnd;
      continue;
    }
    if (startsCssKeyword(css, index, '@import')) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) {
        result += css.slice(index);
        break;
      }
      const rule = css.slice(index, ruleEnd + 1);
      const parsed = parseCssImportRule(rule);
      if (parsed) {
        complete = false;
        warnLateCssImport(parsed.ref, baseDir, ctx);
        result += rebaseCssImportRule(rule, parsed, baseDir, outputBaseDir);
      } else {
        result += rule;
      }
      index = ruleEnd + 1;
      continue;
    }
    result += css[index] ?? '';
    index += 1;
  }
  return { css: result, complete };
}

async function inlineCssUrls(
  css: string,
  baseDir: RefBase,
  ctx: ExportContext,
  outputBaseDir: RefBase,
  options: RefOptions = {},
): Promise<string> {
  let result = '';
  let index = 0;
  while (index < css.length) {
    const commentEnd = css.startsWith('/*', index) ? findCssCommentEnd(css, index) : -1;
    if (commentEnd !== -1) {
      result += scrubCssComment(css.slice(index, commentEnd), ctx);
      index = commentEnd;
      continue;
    }
    if (css[index] === '"' || css[index] === "'") {
      const stringEnd = findCssStringEnd(css, index);
      result += css.slice(index, stringEnd);
      index = stringEnd;
      continue;
    }
    if (startsCssKeyword(css, index, '@import')) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) {
        result += css.slice(index);
        break;
      }
      const rule = css.slice(index, ruleEnd + 1);
      const parsed = parseCssImportRule(rule);
      result += scrubCopiedCssImportRule(rule, parsed, baseDir, ctx, options);
      index = ruleEnd + 1;
      continue;
    }
    if (startsCssKeyword(css, index, '@namespace')) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) {
        result += css.slice(index);
        break;
      }
      result += rebaseCssNamespaceRule(css.slice(index, ruleEnd + 1), baseDir, outputBaseDir, ctx);
      index = ruleEnd + 1;
      continue;
    }
    const conditionalBlock = parseCssConditionalAtRuleBlock(css, index);
    if (conditionalBlock) {
      result += scrubCssNonFetchPrelude(css.slice(index, conditionalBlock.bodyStart), baseDir, ctx, options);
      result += await inlineCssUrls(css.slice(conditionalBlock.bodyStart, conditionalBlock.bodyEnd), baseDir, ctx, outputBaseDir, options);
      result += css.slice(conditionalBlock.bodyEnd, conditionalBlock.end);
      index = conditionalBlock.end;
      continue;
    }
    const imageSet = parseCssImageSetFunction(css, index);
    if (imageSet) {
      result += css.slice(index, imageSet.argsStart);
      result += await inlineCssImageSetArgs(css.slice(imageSet.argsStart, imageSet.argsEnd), baseDir, ctx, outputBaseDir, options);
      result += css.slice(imageSet.argsEnd, imageSet.end);
      index = imageSet.end;
      continue;
    }
    const token = parseCssUrlToken(css, index);
    if (!token) {
      result += css[index] ?? '';
      index += 1;
      continue;
    }
    result += await rewriteCssUrlToken(token, baseDir, ctx, outputBaseDir, options);
    index = token.end;
  }
  return result;
}

function scrubCopiedCssImportRule(
  rule: string,
  parsed: CssImportRuleParsed | null,
  baseDir: RefBase,
  ctx: ExportContext,
  options: RefOptions = {},
): string {
  if (!parsed) return rule;
  const scrubbed = scrubCssRefWithoutInlining(parsed.ref, baseDir, ctx, {
    decodeHtmlEntities: options.decodeHtmlEntities,
    localWarningKind: null,
    seen: new Set(),
  });
  return scrubbed.replacement !== undefined
    ? `${rule.slice(0, parsed.refStart)}${scrubbed.replacement}${rule.slice(parsed.refEnd)}`
    : rule;
}

async function rewriteCssUrlToken(
  token: CssUrlToken,
  baseDir: RefBase,
  ctx: ExportContext,
  outputBaseDir: RefBase,
  options: RefOptions = {},
): Promise<string> {
  const trimmed = token.ref.trim();
  const refForResolution = options.decodeHtmlEntities ? decodeHtmlCharacterReferences(trimmed) : trimmed;
  if (isInert(refForResolution)) return token.raw;
  const dataUri = await loadDataUri(trimmed, baseDir, ctx, { ...options, cssSyntax: true });
  return dataUri ? `url(${token.quote}${dataUri}${token.quote})` : rebaseCssUrlToken(token, baseDir, outputBaseDir);
}

async function inlineCssImageSetArgs(
  args: string,
  baseDir: RefBase,
  ctx: ExportContext,
  outputBaseDir: RefBase,
  options: RefOptions = {},
): Promise<string> {
  let result = '';
  let index = 0;
  let depth = 0;
  while (index < args.length) {
    const commentEnd = args.startsWith('/*', index) ? findCssCommentEnd(args, index) : -1;
    if (commentEnd !== -1) {
      result += scrubCssComment(args.slice(index, commentEnd), ctx);
      index = commentEnd;
      continue;
    }
    if (depth === 0) {
      const token = parseCssUrlToken(args, index);
      if (token) {
        result += await rewriteCssUrlToken(token, baseDir, ctx, outputBaseDir, options);
        index = token.end;
        continue;
      }
    }
    if (args[index] === '"' || args[index] === "'") {
      const quote = args[index] ?? '"';
      const token = parseCssString(args, index);
      if (depth === 0) {
        const rewritten = await rewriteCssStringUrlOperand(token.value, baseDir, ctx, outputBaseDir, options);
        result += rewritten.changed ? quoteCssString(rewritten.value, quote) : args.slice(index, token.end);
      } else {
        result += args.slice(index, token.end);
      }
      index = token.end;
      continue;
    }
    if (args[index] === '(') depth += 1;
    if (args[index] === ')') depth = Math.max(0, depth - 1);
    result += args[index] ?? '';
    index += 1;
  }
  return result;
}

function scrubCssRefsWithoutInlining(css: string, baseDir: RefBase, ctx: ExportContext, options: ScrubOptions = {}): string {
  return scrubCssRefsWithoutInliningInner(css, baseDir, ctx, { ...options, seen: new Set() });
}

function scrubCssRefsWithoutInliningInner(css: string, baseDir: RefBase, ctx: ExportContext, options: ScrubOptions): string {
  let result = '';
  let index = 0;
  while (index < css.length) {
    const commentEnd = css.startsWith('/*', index) ? findCssCommentEnd(css, index) : -1;
    if (commentEnd !== -1) {
      result += scrubCssComment(css.slice(index, commentEnd), ctx);
      index = commentEnd;
      continue;
    }
    if (startsCssKeyword(css, index, '@import')) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) {
        result += css.slice(index);
        break;
      }
      const rule = css.slice(index, ruleEnd + 1);
      const parsed = parseCssImportRule(rule);
      const scrubbed = parsed ? scrubCssRefWithoutInlining(parsed.ref, baseDir, ctx, options) : null;
      result +=
        scrubbed && scrubbed.replacement !== undefined && parsed
          ? `${rule.slice(0, parsed.refStart)}${scrubbed.replacement}${rule.slice(parsed.refEnd)}`
          : rule;
      index = ruleEnd + 1;
      continue;
    }
    if (startsCssKeyword(css, index, '@namespace')) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) {
        result += css.slice(index);
        break;
      }
      result += rebaseCssNamespaceRule(css.slice(index, ruleEnd + 1), baseDir, baseDir, ctx);
      index = ruleEnd + 1;
      continue;
    }
    const conditionalBlock = parseCssConditionalAtRuleBlock(css, index);
    if (conditionalBlock) {
      result += scrubCssNonFetchPrelude(css.slice(index, conditionalBlock.bodyStart), baseDir, ctx, options);
      result += scrubCssRefsWithoutInliningInner(css.slice(conditionalBlock.bodyStart, conditionalBlock.bodyEnd), baseDir, ctx, options);
      result += css.slice(conditionalBlock.bodyEnd, conditionalBlock.end);
      index = conditionalBlock.end;
      continue;
    }
    const imageSet = parseCssImageSetFunction(css, index);
    if (imageSet) {
      result += css.slice(index, imageSet.argsStart);
      result += scrubCssImageSetArgsWithoutInlining(css.slice(imageSet.argsStart, imageSet.argsEnd), baseDir, ctx, options);
      result += css.slice(imageSet.argsEnd, imageSet.end);
      index = imageSet.end;
      continue;
    }
    if (css[index] === '"' || css[index] === "'") {
      const stringEnd = findCssStringEnd(css, index);
      result += css.slice(index, stringEnd);
      index = stringEnd;
      continue;
    }
    const token = parseCssUrlToken(css, index);
    if (token) {
      const scrubbed = scrubCssRefWithoutInlining(token.ref, baseDir, ctx, options);
      result += scrubbed.replacement !== undefined ? `url(${token.quote}${scrubbed.replacement}${token.quote})` : token.raw;
      index = token.end;
      continue;
    }
    result += css[index] ?? '';
    index += 1;
  }
  return result;
}

function scrubCssNonFetchPrelude(css: string, baseDir: RefBase, ctx: ExportContext, options: ScrubOptions = {}): string {
  return scrubCssRefsWithoutInliningInner(css, baseDir, ctx, {
    ...options,
    localWarningKind: null,
    seen: options.seen ?? new Set(),
  });
}

function scrubCssImageSetArgsWithoutInlining(args: string, baseDir: RefBase, ctx: ExportContext, options: ScrubOptions): string {
  let result = '';
  let index = 0;
  let depth = 0;
  while (index < args.length) {
    const commentEnd = args.startsWith('/*', index) ? findCssCommentEnd(args, index) : -1;
    if (commentEnd !== -1) {
      result += scrubCssComment(args.slice(index, commentEnd), ctx);
      index = commentEnd;
      continue;
    }
    if (depth === 0) {
      const token = parseCssUrlToken(args, index);
      if (token) {
        const scrubbed = scrubCssRefWithoutInlining(token.ref, baseDir, ctx, options);
        result += scrubbed.replacement !== undefined ? `url(${token.quote}${scrubbed.replacement}${token.quote})` : token.raw;
        index = token.end;
        continue;
      }
    }
    if (args[index] === '"' || args[index] === "'") {
      const quote = args[index] ?? '"';
      const token = parseCssString(args, index);
      if (depth === 0) {
        const scrubbed = scrubCssRefWithoutInlining(token.value, baseDir, ctx, options);
        result += scrubbed.replacement !== undefined ? quoteCssString(scrubbed.replacement, quote) : args.slice(index, token.end);
      } else {
        result += args.slice(index, token.end);
      }
      index = token.end;
      continue;
    }
    if (args[index] === '(') depth += 1;
    if (args[index] === ')') depth = Math.max(0, depth - 1);
    result += args[index] ?? '';
    index += 1;
  }
  return result;
}

interface CssScrubResult {
  readonly replacement?: string;
}

function scrubCssRefWithoutInlining(ref: string, baseDir: RefBase, ctx: ExportContext, options: ScrubOptions): CssScrubResult {
  const refOptions: RefOptions = { cssSyntax: true, decodeHtmlEntities: Boolean(options.decodeHtmlEntities) };
  if (shouldRedactUnresolvedRef(ref, refOptions)) {
    if (shouldWarnRedactedLocalRefAsUnresolved(options)) {
      pushCssScrubWarning(ctx, options, {
        kind: options.localWarningKind as ExportWarningKind,
        ref,
        reason: options.localWarningReason || SRCDOC_RESOURCE_REASON,
      });
    }
    pushCssScrubWarning(ctx, options, { kind: 'file-url-redacted', ref });
    return { replacement: REDACTED_FILE_REF };
  }
  if (!options.localWarningKind) return { replacement: '' };
  const descriptor = resolveRef(ref, baseDir, ctx, refOptions);
  if (descriptor.kind === 'file') {
    pushCssScrubWarning(ctx, options, {
      kind: options.localWarningKind,
      ref,
      reason: options.localWarningReason,
    });
  } else if (descriptor.kind === 'unmapped-root') {
    const warning = unresolvedDescriptorWarning(descriptor, ref);
    if (warning) pushCssScrubWarning(ctx, options, warning);
  }
  return { replacement: '' };
}

function shouldWarnRedactedLocalRefAsUnresolved(options: ScrubOptions): boolean {
  return options.localWarningKind === 'srcdoc-resource' || options.localWarningKind === 'nested-svg-resource';
}

function pushCssScrubWarning(ctx: ExportContext, options: ScrubOptions, warning: ExportWarning): void {
  const seen = options.seen ?? new Set<string>();
  const key = `${warning.kind}\0${warning.ref}`;
  if (seen.has(key)) return;
  seen.add(key);
  ctx.warnings.push(warning);
}

function findCssResourceRefs(css: string): string[] {
  const refs: string[] = [];
  let index = 0;
  while (index < css.length) {
    const commentEnd = css.startsWith('/*', index) ? findCssCommentEnd(css, index) : -1;
    if (commentEnd !== -1) {
      index = commentEnd;
      continue;
    }
    if (css[index] === '"' || css[index] === "'") {
      index = findCssStringEnd(css, index);
      continue;
    }
    if (startsCssKeyword(css, index, '@import')) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) break;
      const parsed = parseCssImportRule(css.slice(index, ruleEnd + 1));
      if (parsed) refs.push(parsed.ref);
      index = ruleEnd + 1;
      continue;
    }
    if (startsCssKeyword(css, index, '@namespace')) {
      const ruleEnd = findCssAtRuleEnd(css, index);
      if (ruleEnd === -1) break;
      index = ruleEnd + 1;
      continue;
    }
    const conditionalBlock = parseCssConditionalAtRuleBlock(css, index);
    if (conditionalBlock) {
      refs.push(...findCssResourceRefs(css.slice(conditionalBlock.bodyStart, conditionalBlock.bodyEnd)));
      index = conditionalBlock.end;
      continue;
    }
    const imageSet = parseCssImageSetFunction(css, index);
    if (imageSet) {
      refs.push(...findCssImageSetArgRefs(css.slice(imageSet.argsStart, imageSet.argsEnd)));
      index = imageSet.end;
      continue;
    }
    const token = parseCssUrlToken(css, index);
    if (token) {
      refs.push(token.ref);
      index = token.end;
      continue;
    }
    index += 1;
  }
  return refs;
}

function findCssImageSetArgRefs(args: string): string[] {
  const refs: string[] = [];
  let index = 0;
  let depth = 0;
  while (index < args.length) {
    const commentEnd = args.startsWith('/*', index) ? findCssCommentEnd(args, index) : -1;
    if (commentEnd !== -1) {
      index = commentEnd;
      continue;
    }
    if (depth === 0) {
      const token = parseCssUrlToken(args, index);
      if (token) {
        refs.push(token.ref);
        index = token.end;
        continue;
      }
    }
    if (args[index] === '"' || args[index] === "'") {
      const token = parseCssString(args, index);
      if (depth === 0) refs.push(token.value);
      index = token.end;
      continue;
    }
    if (args[index] === '(') depth += 1;
    if (args[index] === ')') depth = Math.max(0, depth - 1);
    index += 1;
  }
  return refs;
}

interface RewriteCssStringUrlOperandResult {
  readonly changed: boolean;
  readonly value: string;
}

async function rewriteCssStringUrlOperand(
  ref: string,
  baseDir: RefBase,
  ctx: ExportContext,
  outputBaseDir: RefBase,
  options: RefOptions = {},
): Promise<RewriteCssStringUrlOperandResult> {
  const trimmed = String(ref || '').trim();
  const refForResolution = normalizeRefForResolution(trimmed, { ...options, cssSyntax: true }).trim();
  if (isInert(refForResolution)) return { changed: false, value: ref };
  const dataUri = await loadDataUri(trimmed, baseDir, ctx, { ...options, cssSyntax: true });
  if (dataUri) return { changed: true, value: dataUri };
  if (shouldRedactUnresolvedRef(trimmed, { ...options, cssSyntax: true })) return { changed: true, value: REDACTED_FILE_REF };
  const rebased = rebaseLocalCssRef(trimmed, baseDir, outputBaseDir, { ...options, cssSyntax: true });
  return rebased ? { changed: true, value: rebased } : { changed: false, value: ref };
}

function rebaseCssUrlToken(token: CssUrlToken, baseDir: RefBase, outputBaseDir: RefBase): string {
  if (shouldRedactUnresolvedRef(token.ref, { cssSyntax: true })) {
    return `url(${token.quote}${REDACTED_FILE_REF}${token.quote})`;
  }
  const rebased = rebaseLocalCssRef(token.ref, baseDir, outputBaseDir, { cssSyntax: true });
  return rebased ? `url(${token.quote}${rebased}${token.quote})` : token.raw;
}

function rebaseCssImportRule(rule: string, parsed: CssImportRuleParsed, baseDir: RefBase, outputBaseDir: RefBase): string {
  if (shouldRedactUnresolvedRef(parsed.ref, { cssSyntax: true })) {
    return `${rule.slice(0, parsed.refStart)}${REDACTED_FILE_REF}${rule.slice(parsed.refEnd)}`;
  }
  const rebased = rebaseLocalCssRef(parsed.ref, baseDir, outputBaseDir, { cssSyntax: true });
  if (!rebased) return rule;
  return `${rule.slice(0, parsed.refStart)}${rebased}${rule.slice(parsed.refEnd)}`;
}

function rebaseCssNamespaceRule(rule: string, baseDir: RefBase, outputBaseDir: RefBase, ctx: ExportContext): string {
  const parsed = parseCssNamespaceRule(rule);
  if (!parsed) return rule;
  if (shouldRedactUnresolvedRef(parsed.ref, { cssSyntax: true })) {
    ctx.warnings.push({ kind: 'file-url-redacted', ref: parsed.ref });
    return `${rule.slice(0, parsed.refStart)}${REDACTED_FILE_REF}${rule.slice(parsed.refEnd)}`;
  }
  const rebased = rebaseLocalCssRef(parsed.ref, baseDir, outputBaseDir, { cssSyntax: true });
  if (!rebased) return rule;
  return `${rule.slice(0, parsed.refStart)}${rebased}${rule.slice(parsed.refEnd)}`;
}

function rebaseLocalCssRef(ref: string, baseDir: RefBase, outputBaseDir: RefBase, options: RefOptions = {}): string {
  const trimmed = normalizeRefForResolution(ref, options).trim();
  const base = normalizeRefBase(baseDir);
  const outputBase = normalizeRefBase(outputBaseDir);
  if (base.kind !== 'local' || outputBase.kind !== 'local') return '';
  if (resolvePath(base.dir) === resolvePath(outputBase.dir)) return '';
  if (!isRelativeLocalRef(trimmed)) return '';
  const { pathPart, suffix } = splitRefSuffix(trimmed);
  if (!pathPart) return '';
  const absPath = resolvePath(base.dir, decodeLocalPath(pathPart));
  const relativeRef = pathRelative(resolvePath(outputBase.dir), absPath);
  if (!relativeRef || pathIsAbsolute(relativeRef)) return '';
  return `${encodeRelativeRef(relativeRef.split(/[/\\]/).join('/'))}${suffix}`;
}

function isRelativeLocalRef(ref: string): boolean {
  if (isInert(ref)) return false;
  if (ref.startsWith('/') || ref.startsWith('//') || /^https?:\/\//i.test(ref)) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(ref);
}

/** Local duplicate of refs.ts's own module-private `splitRefSuffix` -- that file does not export
 * it, and this port needs the identical split for CSS ref rebasing (see this file's header for
 * the general duplication rationale). */
function splitRefSuffix(ref: string): { pathPart: string; suffix: string } {
  const match = ref.match(/^([^?#]*)(.*)$/s);
  return { pathPart: match ? (match[1] ?? '') : ref, suffix: match ? (match[2] ?? '') : '' };
}

function encodeRelativeRef(ref: string): string {
  return ref.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function parseCssImportRule(rule: string): CssImportRuleParsed | null {
  let index = cssKeywordEnd(rule, 0, '@import');
  if (index === -1) return null;
  index = skipCssWhitespaceAndComments(rule, index);
  let ref: string;
  let refStart: number;
  let refEnd: number;
  if (startsCssKeyword(rule, index, 'url')) {
    const token = parseCssUrlToken(rule, index);
    if (!token) return null;
    ref = token.ref.trim();
    refStart = token.refStart;
    refEnd = token.refEnd;
    index = token.end;
  } else if (rule[index] === '"' || rule[index] === "'") {
    refStart = index + 1;
    const token = parseCssString(rule, index);
    ref = token.value;
    refEnd = token.end - 1;
    index = token.end;
  } else {
    return null;
  }
  const semicolon = rule.lastIndexOf(';');
  if (semicolon === -1) return null;
  const media = rule.slice(skipCssWhitespaceAndComments(rule, index), semicolon).trim();
  return { ref, media, refStart, refEnd };
}

function parseCssNamespaceRule(rule: string): CssNamespaceRefParsed | null {
  let index = cssKeywordEnd(rule, 0, '@namespace');
  if (index === -1) return null;
  index = skipCssWhitespaceAndComments(rule, index);
  let parsed = parseCssNamespaceRef(rule, index);
  if (parsed) return parsed;
  const prefix = consumeCssIdentifier(rule, index);
  if (!prefix) return null;
  index = skipCssWhitespaceAndComments(rule, prefix.end);
  parsed = parseCssNamespaceRef(rule, index);
  return parsed;
}

function parseCssNamespaceRef(rule: string, index: number): CssNamespaceRefParsed | null {
  if (startsCssKeyword(rule, index, 'url')) {
    const token = parseCssUrlToken(rule, index);
    if (!token) return null;
    return { ref: token.ref.trim(), refStart: token.refStart, refEnd: token.refEnd };
  }
  if (rule[index] === '"' || rule[index] === "'") {
    const token = parseCssString(rule, index);
    return { ref: token.value, refStart: index + 1, refEnd: token.end - 1 };
  }
  return null;
}

function parseCssUrlToken(css: string, index: number): CssUrlToken | null {
  const keywordEnd = cssKeywordEnd(css, index, 'url');
  const paren = keywordEnd === -1 ? -1 : skipCssWhitespaceAndComments(css, keywordEnd);
  if (keywordEnd === -1 || css[paren] !== '(') return null;
  let cursor = skipCssWhitespaceAndComments(css, paren + 1);
  let quote = '';
  let ref: string;
  let refStart: number;
  let refEnd: number;
  if (css[cursor] === '"' || css[cursor] === "'") {
    refStart = cursor + 1;
    quote = css[cursor] ?? '';
    const token = parseCssString(css, cursor);
    ref = token.value;
    refEnd = token.end - 1;
    cursor = skipCssWhitespaceAndComments(css, token.end);
    if (css[cursor] !== ')') return null;
    cursor += 1;
  } else {
    const start = cursor;
    for (;;) {
      if (cursor >= css.length) return null;
      if (css[cursor] === ')') break;
      if (css[cursor] === '"' || css[cursor] === "'") return null;
      if (css.startsWith('/*', cursor) || /\s/.test(css[cursor] ?? '')) {
        const close = skipCssWhitespaceAndComments(css, cursor);
        if (css[close] !== ')') return null;
        ref = css.slice(start, cursor);
        refStart = start;
        refEnd = cursor;
        cursor = close + 1;
        return { raw: css.slice(index, cursor), ref, quote, end: cursor, refStart, refEnd };
      }
      cursor = css[cursor] === '\\' ? readCssEscape(css, cursor).end : cursor + 1;
    }
    ref = css.slice(start, cursor);
    refStart = start;
    refEnd = cursor;
    cursor += 1;
  }
  return { raw: css.slice(index, cursor), ref, quote, end: cursor, refStart, refEnd };
}

function parseCssImageSetFunction(css: string, index: number): CssImageSetMatch | null {
  let keywordEnd = cssKeywordEnd(css, index, 'image-set');
  if (keywordEnd === -1) keywordEnd = cssKeywordEnd(css, index, '-webkit-image-set');
  const paren = keywordEnd === -1 ? -1 : skipCssWhitespaceAndComments(css, keywordEnd);
  if (keywordEnd === -1 || css[paren] !== '(') return null;
  const close = findCssFunctionEnd(css, paren);
  return close === -1 ? null : { argsStart: paren + 1, argsEnd: close, end: close + 1 };
}

function parseCssConditionalAtRuleBlock(css: string, index: number): CssConditionalBlock | null {
  if (
    !startsCssKeyword(css, index, '@supports') &&
    !startsCssKeyword(css, index, '@media') &&
    !startsCssKeyword(css, index, '@container')
  ) {
    return null;
  }
  const open = findCssAtRuleBlockStart(css, index);
  if (open === -1) return null;
  const close = findCssBlockEnd(css, open);
  if (close === -1) return null;
  return { bodyStart: open + 1, bodyEnd: close, end: close + 1 };
}

function findCssAtRuleBlockStart(css: string, index: number): number {
  let cursor = index;
  let parenDepth = 0;
  while (cursor < css.length) {
    if (css.startsWith('/*', cursor)) {
      cursor = findCssCommentEnd(css, cursor);
      continue;
    }
    if (css[cursor] === '"' || css[cursor] === "'") {
      cursor = findCssStringEnd(css, cursor);
      continue;
    }
    if (css[cursor] === '(') {
      parenDepth += 1;
      cursor += 1;
      continue;
    }
    if (css[cursor] === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      cursor += 1;
      continue;
    }
    if (css[cursor] === ';' && parenDepth === 0) return -1;
    if (css[cursor] === '{' && parenDepth === 0) return cursor;
    cursor += 1;
  }
  return -1;
}

function findCssBlockEnd(css: string, openParen: number): number {
  let cursor = openParen;
  let depth = 0;
  while (cursor < css.length) {
    if (css.startsWith('/*', cursor)) {
      cursor = findCssCommentEnd(css, cursor);
      continue;
    }
    if (css[cursor] === '"' || css[cursor] === "'") {
      cursor = findCssStringEnd(css, cursor);
      continue;
    }
    if (css[cursor] === '{') depth += 1;
    if (css[cursor] === '}') {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  return -1;
}

function findCssFunctionEnd(css: string, openParen: number): number {
  let cursor = openParen;
  let depth = 0;
  while (cursor < css.length) {
    if (css.startsWith('/*', cursor)) {
      cursor = findCssCommentEnd(css, cursor);
      continue;
    }
    if (css[cursor] === '"' || css[cursor] === "'") {
      cursor = findCssStringEnd(css, cursor);
      continue;
    }
    if (css[cursor] === '(') depth += 1;
    if (css[cursor] === ')') {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  return -1;
}

function parseCssString(css: string, index: number): CssStringToken {
  const quote = css[index];
  let cursor = index + 1;
  let value = '';
  while (cursor < css.length) {
    const char = css[cursor];
    if (char === '\\') {
      value += css.slice(cursor, Math.min(cursor + 2, css.length));
      cursor += 2;
      continue;
    }
    if (char === quote) return { value, end: cursor + 1 };
    value += char ?? '';
    cursor += 1;
  }
  return { value, end: css.length };
}

function findCssStringEnd(css: string, index: number): number {
  return parseCssString(css, index).end;
}

function findCssCommentEnd(css: string, index: number): number {
  const end = css.indexOf('*/', index + 2);
  return end === -1 ? css.length : end + 2;
}

function findCssAtRuleEnd(css: string, index: number): number {
  let cursor = index;
  let parenDepth = 0;
  while (cursor < css.length) {
    if (css.startsWith('/*', cursor)) {
      cursor = findCssCommentEnd(css, cursor);
      continue;
    }
    if (css[cursor] === '"' || css[cursor] === "'") {
      cursor = findCssStringEnd(css, cursor);
      continue;
    }
    if (css[cursor] === '(') {
      parenDepth += 1;
      cursor += 1;
      continue;
    }
    if (css[cursor] === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      cursor += 1;
      continue;
    }
    if (css[cursor] === ';' && parenDepth === 0) return cursor;
    cursor += 1;
  }
  return -1;
}

function findCssPreludeStatementEnd(css: string, index: number): number {
  let cursor = index;
  let parenDepth = 0;
  while (cursor < css.length) {
    if (css.startsWith('/*', cursor)) {
      cursor = findCssCommentEnd(css, cursor);
      continue;
    }
    if (css[cursor] === '"' || css[cursor] === "'") {
      cursor = findCssStringEnd(css, cursor);
      continue;
    }
    if (css[cursor] === '(') {
      parenDepth += 1;
      cursor += 1;
      continue;
    }
    if (css[cursor] === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      cursor += 1;
      continue;
    }
    if ((css[cursor] === ';' || css[cursor] === '{') && parenDepth === 0) return cursor;
    cursor += 1;
  }
  return -1;
}

function skipCssWhitespace(css: string, index: number): number {
  let cursor = index;
  while (cursor < css.length && /\s/.test(css[cursor] ?? '')) cursor += 1;
  return cursor;
}

function skipCssWhitespaceAndComments(css: string, index: number): number {
  let cursor = index;
  for (;;) {
    const next = skipCssWhitespace(css, cursor);
    if (!css.startsWith('/*', next)) return next;
    cursor = findCssCommentEnd(css, next);
  }
}

function startsCssKeyword(css: string, index: number, keyword: string): boolean {
  return cssKeywordEnd(css, index, keyword) !== -1;
}

function cssKeywordEnd(css: string, index: number, keyword: string): number {
  if (!hasCssIdentifierBoundaryBefore(css, index)) return -1;
  const expected = keyword.toLowerCase();
  if (expected.startsWith('@')) {
    if (css[index] !== '@') return -1;
    const ident = consumeCssIdentifier(css, index + 1);
    if (!ident || `@${ident.value.toLowerCase()}` !== expected) return -1;
    return ident.end;
  }
  const ident = consumeCssIdentifier(css, index);
  if (!ident || ident.value.toLowerCase() !== expected) return -1;
  return ident.end;
}

function hasCssIdentifierBoundaryBefore(css: string, index: number): boolean {
  const before = css[index - 1];
  return before !== '\\' && !isCssIdentChar(before);
}

function isPlainCssMediaQueryList(tail: string): boolean {
  return !startsUnsupportedCssImportTail(tail);
}

function startsUnsupportedCssImportTail(tail: string): boolean {
  const index = skipCssWhitespaceAndComments(tail, 0);
  const ident = consumeCssIdentifier(tail, index);
  if (!ident) return false;
  const cursor = ident.end;
  const value = ident.value.toLowerCase();
  if (value === 'layer') return true;
  return tail[cursor] === '(';
}

function isCssIdentChar(char: string | undefined): boolean {
  return char !== undefined && /[a-z0-9_-]/i.test(char);
}

interface CssIdentifierResult {
  readonly value: string;
  readonly end: number;
}

function consumeCssIdentifier(css: string, index: number): CssIdentifierResult | null {
  let cursor = index;
  let value = '';
  while (cursor < css.length) {
    if (css[cursor] === '\\') {
      const escaped = readCssEscape(css, cursor);
      value += escaped.value;
      cursor = escaped.end;
      continue;
    }
    if (!isCssIdentChar(css[cursor])) break;
    value += css[cursor] ?? '';
    cursor += 1;
  }
  return cursor === index ? null : { value, end: cursor };
}

/** Local duplicate of refs.ts's own module-private `readCssEscape` -- that file does not export
 * it (it is used there only inside `decodeCssEscapes`, itself already exported and reused
 * directly wherever possible). This port needs the identical escape reader for CSS identifier/
 * keyword scanning (`consumeCssIdentifier`), a genuinely separate call site from ref-string
 * normalization, mirroring the reference's own single dual-purpose function. */
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

function quoteCssString(value: string, quote: string): string {
  return `${quote}${value
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(escapeRegExp(quote), 'g'), `\\${quote}`)
    .replace(/\n/g, '\\a ')
    .replace(/\r/g, '\\d ')}${quote}`;
}

// ---------------------------------------------------------------------------
// Comment / raw-text file:// scrubbing (dist/cli.mjs lines 2513-2628, 2637)
// ---------------------------------------------------------------------------

function scrubHtmlComment(raw: string, ctx: ExportContext): string {
  const text = String(raw);
  const closed = text.endsWith('-->');
  const bodyEnd = closed ? text.length - 3 : text.length;
  return `${text.slice(0, 4)}${scrubFileUrlsInCommentBody(text.slice(4, bodyEnd), ctx)}${closed ? '-->' : ''}`;
}

function scrubCssComment(raw: string, ctx: ExportContext): string {
  const text = String(raw);
  const closed = text.endsWith('*/');
  const bodyEnd = closed ? text.length - 2 : text.length;
  return `${text.slice(0, 2)}${scrubFileUrlsInCommentBody(text.slice(2, bodyEnd), ctx)}${closed ? '*/' : ''}`;
}

function scrubFileUrlsInCommentBody(text: string, ctx: ExportContext): string {
  const input = String(text);
  let result = '';
  let index = 0;
  while (index < input.length) {
    if (isTextUrlDelimiter(input[index])) {
      result += input[index] ?? '';
      index += 1;
      continue;
    }
    const start = index;
    while (index < input.length && !isTextUrlDelimiter(input[index])) index += 1;
    result += scrubFileUrlsInTextToken(input.slice(start, index), ctx);
  }
  return result;
}

const TEXT_URL_DELIMITERS = new Set(['\t', '\n', '\f', '\r', ' ', '"', "'", '<', '>', '(', ')', '=', '[', ']', '{', '}']);

function isTextUrlDelimiter(char: string | undefined): boolean {
  return char !== undefined && TEXT_URL_DELIMITERS.has(char);
}

function scrubFileUrlsInTextToken(token: string, ctx: ExportContext): string {
  for (let index = 0; index < token.length; index += 1) {
    if (index > 0 && /[a-z0-9+.-]/i.test(token[index - 1] ?? '')) continue;
    const ref = token.slice(index);
    if (!isFileSchemeRef(ref, { cssSyntax: true, decodeHtmlEntities: true })) continue;
    ctx.warnings.push({ kind: 'file-url-redacted', ref });
    return `${token.slice(0, index)}${REDACTED_FILE_REF}`;
  }
  return token;
}

function scrubRawTextFileUrls(text: string, ctx: ExportContext): string {
  return scrubFileUrlsInCommentBody(text, ctx);
}

function scrubClassicScriptFileUrlComments(source: string, ctx: ExportContext): string {
  const input = String(source);
  let result = '';
  let index = 0;
  while (index < input.length) {
    if (input.startsWith('//', index)) {
      const end = input.indexOf('\n', index + 2);
      const bodyEnd = end === -1 ? input.length : end;
      result += `//${scrubFileUrlsInCommentBody(input.slice(index + 2, bodyEnd), ctx)}`;
      if (end === -1) {
        index = input.length;
      } else {
        result += '\n';
        index = end + 1;
      }
      continue;
    }
    if (input.startsWith('/*', index)) {
      const end = input.indexOf('*/', index + 2);
      const bodyEnd = end === -1 ? input.length : end;
      result += `/*${scrubFileUrlsInCommentBody(input.slice(index + 2, bodyEnd), ctx)}${end === -1 ? '' : '*/'}`;
      index = end === -1 ? input.length : end + 2;
      continue;
    }
    if (input.startsWith('<!--', index)) {
      const end = input.indexOf('\n', index + 4);
      const bodyEnd = end === -1 ? input.length : end;
      result += `<!--${scrubFileUrlsInCommentBody(input.slice(index + 4, bodyEnd), ctx)}`;
      if (end === -1) {
        index = input.length;
      } else {
        result += '\n';
        index = end + 1;
      }
      continue;
    }
    if (input.startsWith('-->', index) && isJsHtmlCloseCommentStart(input, index)) {
      const end = input.indexOf('\n', index + 3);
      const bodyEnd = end === -1 ? input.length : end;
      result += `-->${scrubFileUrlsInCommentBody(input.slice(index + 3, bodyEnd), ctx)}`;
      if (end === -1) {
        index = input.length;
      } else {
        result += '\n';
        index = end + 1;
      }
      continue;
    }
    if (input[index] === '"' || input[index] === "'") {
      const end = parseJsString(input, index).end;
      result += input.slice(index, end);
      index = end;
      continue;
    }
    if (input[index] === '`') {
      const end = skipJsTemplate(input, index);
      result += input.slice(index, end);
      index = end;
      continue;
    }
    if (input[index] === '/' && isLikelyJsRegexStart(input, index)) {
      const end = skipJsRegex(input, index);
      result += input.slice(index, end);
      index = end;
      continue;
    }
    result += input[index] ?? '';
    index += 1;
  }
  return result;
}

function isJsHtmlCloseCommentStart(input: string, index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = input[cursor];
    if (char === '\n' || char === '\r') return true;
    if (char !== ' ' && char !== '\t' && char !== '\f' && char !== '\v') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Notice/warning helpers for resources left as references (dist/cli.mjs lines 3083-3465)
// ---------------------------------------------------------------------------

function warnUnsupportedScriptTiming(ref: string, baseDir: RefBase, ctx: ExportContext, options: RefOptions = {}): void {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === 'file') {
    ctx.warnings.push({
      kind: 'unsupported-script-timing',
      ref,
      reason: 'defer and async scripts are left as references to preserve execution timing',
    });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnInactiveStylesheet(ref: string, baseDir: RefBase, ctx: ExportContext, options: RefOptions = {}): void {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === 'file') {
    ctx.warnings.push({
      kind: 'inactive-stylesheet',
      ref,
      reason: 'inactive stylesheet links are left as references to preserve disabled or alternate state',
    });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnBehavioralStylesheet(ref: string, baseDir: RefBase, ctx: ExportContext, options: RefOptions = {}): void {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === 'file') {
    ctx.warnings.push({
      kind: 'behavioral-stylesheet',
      ref,
      reason: 'stylesheet links with event handler attributes are left as references to preserve behavior',
    });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnPreloadStylesheet(ref: string, baseDir: RefBase, ctx: ExportContext, options: RefOptions = {}): void {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === 'file') {
    ctx.warnings.push({
      kind: 'preload-stylesheet',
      ref,
      reason: 'preload-as-style links are left as references to preserve activation behavior',
    });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnFetchableLink(ref: string, baseDir: RefBase, ctx: ExportContext, options: RefOptions = {}): void {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === 'file') {
    ctx.warnings.push({ kind: 'fetchable-link', ref, reason: 'fetchable link hints are left as references' });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnExternalModuleScript(ref: string, baseDir: RefBase, ctx: ExportContext, options: RefOptions = {}): void {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === 'file') {
    ctx.warnings.push({
      kind: 'module-external',
      ref,
      reason: 'module scripts are left as references to preserve relative imports',
    });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnUnterminatedScriptSrc(ref: string, baseDir: RefBase, ctx: ExportContext, options: RefOptions = {}): void {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === 'file') {
    ctx.warnings.push({
      kind: 'unterminated-script-src',
      ref,
      reason: 'unterminated script src is left as a reference to preserve raw-text parsing',
    });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnUnsupportedScriptType(ref: string, baseDir: RefBase, ctx: ExportContext, options: RefOptions = {}): void {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === 'file') {
    ctx.warnings.push({ kind: 'unsupported-script-type', ref, reason: 'non-classic script types are left as references' });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnUnsupportedStylesheetType(ref: string, baseDir: RefBase, ctx: ExportContext, options: RefOptions = {}): void {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === 'file') {
    ctx.warnings.push({ kind: 'unsupported-stylesheet-type', ref, reason: 'non-CSS stylesheet links are left as references' });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function scrubUnsupportedStyleElementBody(css: string, baseDir: RefBase, ctx: ExportContext): string {
  return scrubCssRefsWithoutInlining(css, baseDir, ctx, {
    localWarningKind: 'unsupported-style-type',
    localWarningReason: 'non-CSS style elements are left unchanged',
  });
}

function warnFrameSrc(attrs: string, baseDir: RefBase, ctx: ExportContext): string {
  const ref = getAttr(attrs, 'src');
  if (!ref) return attrs;
  warnUnsupportedFrame(ref, baseDir, ctx, HTML_REF_OPTIONS);
  return replaceUnresolvedAttrRef(attrs, 'src', ref);
}

function scrubFrameSrcdoc(attrs: string, baseDir: RefBase, ctx: ExportContext, options: ScrubOptions = {}): string {
  const attr = findHtmlAttr(attrs, 'srcdoc');
  if (!attr || !attr.hasValue) return attrs;
  const decoded = decodeHtmlCharacterReferences(attr.value);
  const scrubbed = transformInertMarkup(decoded, baseDir, ctx, {
    localWarningKind: options.localWarningKind || 'inert-resource',
    localWarningReason: options.localWarningReason || SRCDOC_RESOURCE_REASON,
  });
  return scrubbed === decoded ? attrs : replaceAttrTokenValue(attrs, attr, scrubbed);
}

function warnUnsupportedFrame(ref: string, baseDir: RefBase, ctx: ExportContext, options: RefOptions = {}): void {
  const descriptor = resolveRef(ref, baseDir, ctx, options);
  if (descriptor.kind === 'file') {
    ctx.warnings.push({
      kind: 'unsupported-frame',
      ref,
      reason: 'iframe documents are left as references because nested HTML is not bundled',
    });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnInertStartTagRefs(
  tagName: string,
  attrs: string,
  baseDir: RefBase,
  ctx: ExportContext,
  options: ScrubOptions = {},
  namespace: HtmlNamespace = 'html',
): void {
  const elementNamespace = namespace || 'html';
  const inHtmlNamespace = elementNamespace === 'html';
  const inSvgNamespace = elementNamespace === 'svg';
  if (inHtmlNamespace && MEDIA_TAGS.has(tagName)) {
    warnInertAttrRef(attrs, 'src', baseDir, ctx, HTML_REF_OPTIONS, options);
    if (tagName === 'video') warnInertAttrRef(attrs, 'poster', baseDir, ctx, HTML_REF_OPTIONS, options);
    if (tagName === 'img' || tagName === 'source') warnInertSrcsetRefs(attrs, baseDir, ctx, options);
  }
  if (SVG_REF_TAGS.has(tagName) && inSvgNamespace) {
    warnInertAttrRef(attrs, 'href', baseDir, ctx, HTML_REF_OPTIONS, options);
    warnInertAttrRef(attrs, 'xlink:href', baseDir, ctx, HTML_REF_OPTIONS, options);
  }
  if (inHtmlNamespace && tagName === 'object') warnInertAttrRef(attrs, 'data', baseDir, ctx, HTML_REF_OPTIONS, options);
  if (tagName === 'script' && inSvgNamespace) {
    warnInertAttrRef(attrs, 'href', baseDir, ctx, HTML_REF_OPTIONS, options);
    warnInertAttrRef(attrs, 'xlink:href', baseDir, ctx, HTML_REF_OPTIONS, options);
  }
  if (inHtmlNamespace && (tagName === 'embed' || tagName === 'script' || tagName === 'iframe')) {
    warnInertAttrRef(attrs, 'src', baseDir, ctx, HTML_REF_OPTIONS, options);
  }
  if (inHtmlNamespace && tagName === 'input' && getDecisionAttr(attrs, 'type').trim().toLowerCase() === 'image') {
    warnInertAttrRef(attrs, 'src', baseDir, ctx, HTML_REF_OPTIONS, options);
  }
  if (inHtmlNamespace && tagName === 'link') {
    const rel = getTokenListAttr(attrs, 'rel');
    if (
      rel.includes('stylesheet') ||
      rel.some((value) => ['icon', 'shortcut', 'apple-touch-icon', 'mask-icon'].includes(value)) ||
      isFetchableLinkRel(rel)
    ) {
      warnInertAttrRef(attrs, 'href', baseDir, ctx, HTML_REF_OPTIONS, options);
    }
  }
  warnInertStyleRefs(attrs, baseDir, ctx, options);
}

function warnInertAttrRef(
  attrs: string,
  name: string,
  baseDir: RefBase,
  ctx: ExportContext,
  refOptions: RefOptions = {},
  warningOptions: ScrubOptions = {},
): void {
  const ref = getAttr(attrs, name);
  if (ref) warnInertResource(ref, baseDir, ctx, refOptions, warningOptions);
}

function warnInertSrcsetRefs(attrs: string, baseDir: RefBase, ctx: ExportContext, options: ScrubOptions = {}): void {
  const value = getAttr(attrs, 'srcset');
  if (!value) return;
  for (const candidate of parseSrcsetCandidates(value)) {
    warnInertResource(value.slice(candidate.urlStart, candidate.urlEnd), baseDir, ctx, HTML_REF_OPTIONS, options);
  }
}

function warnInertStyleRefs(attrs: string, baseDir: RefBase, ctx: ExportContext, options: ScrubOptions = {}): void {
  const attr = findHtmlAttr(attrs, 'style');
  if (!attr || !attr.hasValue) return;
  const decoded = decodeHtmlCharacterReferences(attr.value);
  const seen = new Set<string>();
  for (const ref of findCssResourceRefs(decoded)) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    warnInertResource(ref, baseDir, ctx, { cssSyntax: true }, options);
  }
}

function warnInertResource(
  ref: string,
  baseDir: RefBase,
  ctx: ExportContext,
  refOptions: RefOptions = {},
  warningOptions: ScrubOptions = {},
): void {
  if (shouldRedactUnresolvedRef(ref, refOptions)) {
    if (shouldWarnRedactedLocalRefAsUnresolved(warningOptions)) {
      ctx.warnings.push({
        kind: warningOptions.localWarningKind as ExportWarningKind,
        ref,
        reason: warningOptions.localWarningReason || SRCDOC_RESOURCE_REASON,
      });
    }
    return;
  }
  const descriptor = resolveRef(ref, baseDir, ctx, refOptions);
  if (descriptor.kind !== 'file') {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
    return;
  }
  ctx.warnings.push({
    kind: warningOptions.localWarningKind || 'inert-resource',
    ref,
    reason: warningOptions.localWarningReason || INERT_RESOURCE_REASON,
  });
}

function warnInlineModuleImports(body: string, baseDir: RefBase, ctx: ExportContext): void {
  for (const ref of findInlineModuleImportRefs(body)) {
    const normalized = normalizeJsRefForScheme(ref);
    if (!isLocalModuleImport(normalized)) continue;
    warnInlineModuleImport(normalized, baseDir, ctx);
  }
}

function warnClassicScriptDynamicImports(body: string, baseDir: RefBase, ctx: ExportContext): void {
  for (const ref of findInlineDynamicImportRefs(body)) {
    const normalized = normalizeJsRefForScheme(ref);
    if (!isLocalModuleImport(normalized)) continue;
    warnInlineModuleImport(normalized, baseDir, ctx);
  }
}

function redactInlineModuleFileRefs(body: string, ctx: ExportContext, options: { warnUnresolved?: boolean } = {}): string {
  const refs = findInlineModuleImportRefTokens(body).filter((ref) => isFileSchemeJsRef(ref.value));
  if (refs.length === 0) return body;
  for (const ref of refs) {
    if (options.warnUnresolved) pushInlineModuleImportWarning(ctx, ref.value);
    ctx.warnings.push({ kind: 'file-url-redacted', ref: ref.value });
  }
  let result = body;
  for (let index = refs.length - 1; index >= 0; index -= 1) {
    const ref = refs[index];
    if (!ref) continue;
    result = `${result.slice(0, ref.rawStart)}${quoteJsModuleSpecifier(REDACTED_FILE_REF, ref.quote)}${result.slice(ref.rawEnd)}`;
  }
  return result;
}

function warnInlineImportMapLocalRefs(body: string, baseDir: RefBase, ctx: ExportContext): void {
  for (const ref of findImportMapLocalRefs(body)) {
    const descriptor = resolveRef(ref, baseDir, ctx);
    if (descriptor.kind === 'file') {
      pushInlineImportMapLocalRefWarning(ctx, ref);
    } else {
      warnUnresolvedDescriptor(descriptor, ref, ctx);
    }
  }
}

interface ImportMapDocument {
  imports?: Record<string, unknown>;
  scopes?: Record<string, unknown>;
}

function redactInlineImportMapFileRefs(body: string, ctx: ExportContext, options: { warnUnresolved?: boolean } = {}): string {
  let map: ImportMapDocument;
  try {
    map = JSON.parse(body) as ImportMapDocument;
  } catch {
    return body;
  }
  let changed = false;
  const redactImports = (imports: unknown): unknown => {
    if (!imports || typeof imports !== 'object' || Array.isArray(imports)) return imports;
    let redacted = false;
    const nextImports: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(imports as Record<string, unknown>)) {
      let nextKey = key;
      let nextValue: unknown = value;
      if (isFileSchemeRef(key)) {
        if (options.warnUnresolved) pushInlineImportMapLocalRefWarning(ctx, key);
        ctx.warnings.push({ kind: 'file-url-redacted', ref: key });
        nextKey = REDACTED_FILE_REF;
        redacted = true;
      }
      if (typeof value === 'string' && isFileSchemeRef(value)) {
        if (options.warnUnresolved) pushInlineImportMapLocalRefWarning(ctx, value);
        ctx.warnings.push({ kind: 'file-url-redacted', ref: value });
        nextValue = REDACTED_FILE_REF;
        redacted = true;
      }
      nextImports[nextKey] = nextValue;
    }
    if (redacted) changed = true;
    return redacted ? nextImports : imports;
  };
  if (map.imports) map.imports = redactImports(map.imports) as Record<string, unknown>;
  if (map.scopes && typeof map.scopes === 'object' && !Array.isArray(map.scopes)) {
    const scopes: Record<string, unknown> = {};
    for (const [scopePrefix, scopedImports] of Object.entries(map.scopes)) {
      let nextPrefix = scopePrefix;
      if (isFileSchemeRef(scopePrefix)) {
        if (options.warnUnresolved) pushInlineImportMapLocalRefWarning(ctx, scopePrefix);
        ctx.warnings.push({ kind: 'file-url-redacted', ref: scopePrefix });
        nextPrefix = REDACTED_FILE_REF;
        changed = true;
      }
      scopes[nextPrefix] = redactImports(scopedImports);
    }
    map.scopes = scopes;
  }
  return changed ? JSON.stringify(map) : body;
}

function pushInlineModuleImportWarning(ctx: ExportContext, ref: string): void {
  ctx.warnings.push({ kind: 'inline-module-import', ref, reason: 'inline module imports are left as references' });
}

function pushInlineImportMapLocalRefWarning(ctx: ExportContext, ref: string): void {
  ctx.warnings.push({
    kind: 'inline-importmap-local-ref',
    ref,
    reason: 'inline import maps are left unchanged; local mapped modules are not bundled',
  });
}

function warnInlineModuleImport(ref: string, baseDir: RefBase, ctx: ExportContext): void {
  const descriptor = resolveRef(ref, baseDir, ctx);
  if (descriptor.kind === 'file') {
    pushInlineModuleImportWarning(ctx, ref);
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnUnsupportedCssImport(ref: string, baseDir: RefBase, ctx: ExportContext, tail: string): void {
  const descriptor = resolveRef(ref, baseDir, ctx, { cssSyntax: true });
  if (descriptor.kind === 'file') {
    ctx.warnings.push({ kind: 'unsupported-css-import', ref, reason: `CSS @import tail is left unchanged: ${tail}` });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnCssImportDepth(ref: string, baseDir: RefBase, ctx: ExportContext): void {
  const descriptor = resolveRef(ref, baseDir, ctx, { cssSyntax: true });
  if (descriptor.kind === 'file') {
    ctx.warnings.push({ kind: 'css-import-depth', ref, reason: `CSS @import recursion reached max depth ${ctx.maxDepth}` });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnCssImportOrder(ref: string, descriptor: RefDescriptor, ctx: ExportContext): void {
  if (descriptor.kind === 'file') {
    ctx.warnings.push({ kind: 'css-import-order', ref, reason: 'CSS @import is left as a reference to preserve import ordering' });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnLateCssImport(ref: string, baseDir: RefBase, ctx: ExportContext): void {
  const descriptor = resolveRef(ref, baseDir, ctx, { cssSyntax: true });
  if (descriptor.kind === 'file') {
    ctx.warnings.push({
      kind: 'late-css-import',
      ref,
      reason: 'CSS @import appears outside the valid top-level import prelude and is left unchanged',
    });
  } else {
    warnUnresolvedDescriptor(descriptor, ref, ctx);
  }
}

function warnUnterminatedRawText(tagName: string, ctx: ExportContext): void {
  ctx.warnings.push({
    kind: 'unterminated-raw-text',
    ref: tagName,
    reason: 'raw-text or inert content continues to EOF and is left unbundled',
  });
}

// `unresolvedDescriptorWarning`/`warnUnresolvedDescriptor` are already exported by refs.ts
// (09-01) and imported directly (top of file) -- every call site below uses them verbatim, no
// local wrapper needed.

function isModuleScript(attrs: string): boolean {
  return getDecisionAttr(attrs, 'type').trim().toLowerCase() === 'module';
}

function isImportMapScript(attrs: string): boolean {
  return getDecisionAttr(attrs, 'type').trim().toLowerCase() === 'importmap';
}

const CLASSIC_SCRIPT_MIME_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

function isClassicScript(attrs: string): boolean {
  const type = getDecisionAttr(attrs, 'type').trim().toLowerCase();
  if (!type) return true;
  const mime = (type.split(';')[0] ?? '').trim();
  return CLASSIC_SCRIPT_MIME_TYPES.has(mime);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// JS scanner: classic/module import detection ONLY (dist/cli.mjs lines 3496-3806) -- not a real
// JS parser. Enough to find `import`/`export ... from`/dynamic `import(...)` string literal
// specifiers without executing or fully parsing the script body.
// ---------------------------------------------------------------------------

interface JsImportRefToken {
  readonly value: string;
  readonly quote: string;
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly end: number;
  readonly importKind?: 'bare' | 'dynamic';
}

function findInlineModuleImportRefs(source: string): string[] {
  return findInlineModuleImportRefTokens(source).map((ref) => ref.value);
}

function findInlineDynamicImportRefs(source: string): string[] {
  return findInlineModuleImportRefTokens(source)
    .filter((ref) => ref.importKind === 'dynamic')
    .map((ref) => ref.value);
}

function findInlineModuleImportRefTokens(source: string): JsImportRefToken[] {
  const refs: JsImportRefToken[] = [];
  let index = 0;
  while (index < source.length) {
    const skipped = skipJsIgnored(source, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    if (startsJsKeyword(source, index, 'import') && !isJsPropertyAccessKeyword(source, index)) {
      const parsed = parseJsImport(source, index);
      refs.push(...parsed.refs);
      index = Math.max(parsed.end, index + 'import'.length);
      continue;
    }
    if (startsJsKeyword(source, index, 'export')) {
      const parsed = parseJsExport(source, index);
      refs.push(...parsed.refs);
      index = Math.max(parsed.end, index + 'export'.length);
      continue;
    }
    index += 1;
  }
  return refs;
}

function findImportMapLocalRefs(body: string): string[] {
  let map: ImportMapDocument;
  try {
    map = JSON.parse(body) as ImportMapDocument;
  } catch {
    return [];
  }
  const refs: string[] = [];
  const seen = new Set<string>();
  collectImportMapAddressRefs(map.imports, refs, seen);
  if (map.scopes && typeof map.scopes === 'object' && !Array.isArray(map.scopes)) {
    for (const [scopePrefix, scopedImports] of Object.entries(map.scopes)) {
      collectImportMapScopeRef(scopePrefix, refs, seen);
      collectImportMapAddressRefs(scopedImports, refs, seen);
    }
  }
  return refs;
}

function collectImportMapAddressRefs(imports: unknown, refs: string[], seen: Set<string>): void {
  if (!imports || typeof imports !== 'object' || Array.isArray(imports)) return;
  for (const value of Object.values(imports as Record<string, unknown>)) {
    if (typeof value !== 'string' || !isLocalImportMapAddress(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    refs.push(value);
  }
}

function collectImportMapScopeRef(scopePrefix: string, refs: string[], seen: Set<string>): void {
  if (!isLocalImportMapAddress(scopePrefix)) return;
  if (seen.has(scopePrefix)) return;
  seen.add(scopePrefix);
  refs.push(scopePrefix);
}

function isLocalImportMapAddress(ref: string): boolean {
  const trimmed = String(ref || '').trim();
  if (!trimmed || isInert(trimmed)) return false;
  if (trimmed.startsWith('//') || /^https?:\/\//i.test(trimmed)) return false;
  if (isFileSchemeRef(trimmed)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

interface ParsedJsImport {
  readonly refs: JsImportRefToken[];
  readonly end: number;
}

function parseJsImport(source: string, index: number): ParsedJsImport {
  let cursor = skipJsWhitespaceAndComments(source, index + 'import'.length);
  if (source[cursor] === '.') return { refs: [], end: cursor + 1 };
  if (source[cursor] === '(') {
    cursor = skipJsWhitespaceAndComments(source, cursor + 1);
    if (source[cursor] === '`') {
      const token = parseJsTemplateImportToken(source, cursor);
      const dynamicToken: JsImportRefToken = { ...token, importKind: 'dynamic' };
      return { refs: dynamicToken.value ? [dynamicToken] : [], end: dynamicToken.end };
    }
    if (source[cursor] !== '"' && source[cursor] !== "'") return { refs: [], end: cursor + 1 };
    const token = parseJsStringToken(source, cursor);
    const dynamicToken: JsImportRefToken = { ...token, importKind: 'dynamic' };
    return { refs: [dynamicToken], end: dynamicToken.end };
  }
  if (source[cursor] === '"' || source[cursor] === "'") {
    const token = parseJsStringToken(source, cursor);
    const bareToken: JsImportRefToken = { ...token, importKind: 'bare' };
    return { refs: [bareToken], end: bareToken.end };
  }
  const found = findJsImportFromRef(source, cursor);
  return { refs: found.ref ? [found.ref] : [], end: found.end };
}

function parseJsExport(source: string, index: number): ParsedJsImport {
  const cursor = skipJsWhitespaceAndComments(source, index + 'export'.length);
  const found = findJsImportFromRef(source, cursor);
  return { refs: found.ref ? [found.ref] : [], end: found.end };
}

interface FoundJsImportRef {
  readonly ref: JsImportRefToken | null;
  readonly end: number;
}

function findJsImportFromRef(source: string, index: number): FoundJsImportRef {
  let cursor = index;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  while (cursor < source.length) {
    const skipped = skipJsIgnored(source, cursor);
    if (skipped !== cursor) {
      cursor = skipped;
      continue;
    }
    if (source[cursor] === '{') braceDepth += 1;
    if (source[cursor] === '}') braceDepth = Math.max(0, braceDepth - 1);
    if (source[cursor] === '[') bracketDepth += 1;
    if (source[cursor] === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    if (source[cursor] === '(') parenDepth += 1;
    if (source[cursor] === ')') parenDepth = Math.max(0, parenDepth - 1);
    const topLevel = braceDepth === 0 && bracketDepth === 0 && parenDepth === 0;
    if (topLevel && source[cursor] === ';') return { ref: null, end: cursor + 1 };
    if (topLevel && cursor !== index && (startsJsKeyword(source, cursor, 'import') || startsJsKeyword(source, cursor, 'export'))) {
      return { ref: null, end: cursor };
    }
    if (topLevel && startsJsKeyword(source, cursor, 'from')) {
      const refStart = skipJsWhitespaceAndComments(source, cursor + 'from'.length);
      if (source[refStart] === '"' || source[refStart] === "'") {
        const token = parseJsStringToken(source, refStart);
        return { ref: token, end: token.end };
      }
    }
    cursor += 1;
  }
  return { ref: null, end: cursor };
}

function isLocalModuleImport(ref: string): boolean {
  const trimmed = String(ref || '').trim();
  if (!trimmed || isInert(trimmed)) return false;
  if (trimmed.startsWith('//') || /^https?:\/\//i.test(trimmed)) return false;
  return trimmed.startsWith('/') || /^\.{1,2}\//.test(trimmed);
}

function isFileSchemeJsRef(ref: string): boolean {
  return /^file:/i.test(normalizeJsRefForScheme(ref));
}

function normalizeJsRefForScheme(ref: string): string {
  return decodeJsEscapes(String(ref || ''))
    .replace(/[\t\n\r]/g, '')
    .trim();
}

function skipJsWhitespaceAndComments(source: string, index: number): number {
  let cursor = index;
  for (;;) {
    while (cursor < source.length && /\s/.test(source[cursor] ?? '')) cursor += 1;
    if (source.startsWith('//', cursor)) {
      const next = source.indexOf('\n', cursor + 2);
      cursor = next === -1 ? source.length : next + 1;
      continue;
    }
    if (source.startsWith('/*', cursor)) {
      const next = source.indexOf('*/', cursor + 2);
      cursor = next === -1 ? source.length : next + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function skipJsIgnored(source: string, index: number): number {
  if (source.startsWith('//', index)) {
    const next = source.indexOf('\n', index + 2);
    return next === -1 ? source.length : next + 1;
  }
  if (source.startsWith('/*', index)) {
    const next = source.indexOf('*/', index + 2);
    return next === -1 ? source.length : next + 2;
  }
  if (source[index] === '/' && isLikelyJsRegexStart(source, index)) return skipJsRegex(source, index);
  if (source[index] === '"' || source[index] === "'") return parseJsString(source, index).end;
  if (source[index] === '`') return skipJsTemplate(source, index);
  return index;
}

interface JsStringResult {
  readonly value: string;
  readonly end: number;
}

function parseJsString(source: string, index: number): JsStringResult {
  const quote = source[index];
  let cursor = index + 1;
  let value = '';
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '\\') {
      value += source.slice(cursor, Math.min(cursor + 2, source.length));
      cursor += 2;
      continue;
    }
    if (char === quote) return { value, end: cursor + 1 };
    value += char ?? '';
    cursor += 1;
  }
  return { value, end: source.length };
}

function parseJsStringToken(source: string, index: number): JsImportRefToken {
  const parsed = parseJsString(source, index);
  return { value: parsed.value, quote: source[index] ?? '', rawStart: index, rawEnd: parsed.end, end: parsed.end };
}

function parseJsTemplateImportToken(source: string, index: number): JsImportRefToken {
  const end = skipJsTemplate(source, index);
  return {
    value: source.slice(index + 1, Math.max(index + 1, end - 1)),
    quote: '`',
    rawStart: index,
    rawEnd: end,
    end,
  };
}

function skipJsTemplate(source: string, index: number): number {
  let cursor = index + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === '`') return cursor + 1;
    cursor += 1;
  }
  return source.length;
}

function isLikelyJsRegexStart(source: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor] ?? '')) cursor -= 1;
  if (cursor < 0) return true;
  return /[([{=:;,!?&|+\-*~^<>%]/.test(source[cursor] ?? '');
}

function skipJsRegex(source: string, index: number): number {
  let cursor = index + 1;
  let inClass = false;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === '[') inClass = true;
    if (source[cursor] === ']') inClass = false;
    if (source[cursor] === '/' && !inClass) {
      cursor += 1;
      while (cursor < source.length && /[a-z]/i.test(source[cursor] ?? '')) cursor += 1;
      return cursor;
    }
    cursor += 1;
  }
  return source.length;
}

function startsJsKeyword(source: string, index: number, keyword: string): boolean {
  if (source.slice(index, index + keyword.length) !== keyword) return false;
  const before = source[index - 1];
  const after = source[index + keyword.length];
  return !isJsIdentChar(before) && !isJsIdentChar(after);
}

function isJsPropertyAccessKeyword(source: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor] ?? '')) cursor -= 1;
  return source[cursor] === '.';
}

function isJsIdentChar(char: string | undefined): boolean {
  return char !== undefined && /[a-z0-9_$]/i.test(char);
}

function decodeJsEscapes(value: string): string {
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
    if (/[\n\r]/.test(next)) {
      index += 2;
      continue;
    }
    if (next === 'x' && /^[\da-f]{2}$/i.test(input.slice(index + 2, index + 4))) {
      result += decodeNumericCharacterReference(Number.parseInt(input.slice(index + 2, index + 4), 16), '');
      index += 4;
      continue;
    }
    if (next === 'u' && input[index + 2] === '{') {
      const close = input.indexOf('}', index + 3);
      const hex = close === -1 ? '' : input.slice(index + 3, close);
      if (/^[\da-f]+$/i.test(hex)) {
        result += decodeNumericCharacterReference(Number.parseInt(hex, 16), '');
        index = close + 1;
        continue;
      }
    }
    if (next === 'u' && /^[\da-f]{4}$/i.test(input.slice(index + 2, index + 6))) {
      result += decodeNumericCharacterReference(Number.parseInt(input.slice(index + 2, index + 6), 16), '');
      index += 6;
      continue;
    }
    result += next;
    index += 2;
  }
  return result;
}

function quoteJsModuleSpecifier(value: string, quote: string): string {
  if (quote === '`') {
    return `\`${value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\``;
  }
  const preferred = quote === "'" ? "'" : '"';
  return `${preferred}${value
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(escapeRegExp(preferred), 'g'), `\\${preferred}`)
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')}${preferred}`;
}

// ---------------------------------------------------------------------------
// NEW -- not in the reference at all. See this file's header, point 3.
// ---------------------------------------------------------------------------

const REMOTE_HTTP_REF = /^https?:\/\//i;

/**
 * Mirrors, tag-for-tag, the same fetchable-resource attribute/tag table `transformStartTag`'s own
 * inline* dispatch (and `warnInertStartTagRefs`'s parallel dispatch for inert content) already
 * uses -- deliberately NOT `<a href>`, `<base href>`, or a `<link rel="canonical">`-shaped href:
 * none of those are ever inspected by the transform as a fetchable resource, so flagging them here
 * would misrepresent this pass as broader than the transform it audits.
 */
function fetchableRefsForTag(tag: string, attrs: string, namespace: HtmlNamespace, parentTag: string): string[] {
  const refs: string[] = [];
  const inHtml = namespace === 'html';
  const inSvg = namespace === 'svg';
  const push = (value: string): void => {
    if (value) refs.push(value);
  };
  if (inHtml && MEDIA_TAGS.has(tag)) {
    if (!(tag === 'track' && parentTag !== 'video' && parentTag !== 'audio')) push(getAttr(attrs, 'src'));
    if (tag === 'video') push(getAttr(attrs, 'poster'));
    if (tag === 'img' || (tag === 'source' && parentTag === 'picture')) {
      const srcset = getAttr(attrs, 'srcset');
      if (srcset) {
        for (const candidate of parseSrcsetCandidates(srcset)) push(srcset.slice(candidate.urlStart, candidate.urlEnd));
      }
    }
  }
  if (SVG_REF_TAGS.has(tag) && inSvg) {
    push(getAttr(attrs, 'href'));
    push(getAttr(attrs, 'xlink:href'));
  }
  if (inHtml && tag === 'object') push(getAttr(attrs, 'data'));
  if (tag === 'script' && inSvg) {
    push(getAttr(attrs, 'href'));
    push(getAttr(attrs, 'xlink:href'));
  }
  if (inHtml && (tag === 'embed' || tag === 'script' || tag === 'iframe')) push(getAttr(attrs, 'src'));
  if (inHtml && tag === 'input' && getDecisionAttr(attrs, 'type').trim().toLowerCase() === 'image') {
    push(getAttr(attrs, 'src'));
  }
  if (inHtml && tag === 'link') {
    const rel = getTokenListAttr(attrs, 'rel');
    if (
      rel.includes('stylesheet') ||
      rel.some((value) => ['icon', 'shortcut', 'apple-touch-icon', 'mask-icon'].includes(value)) ||
      isFetchableLinkRel(rel)
    ) {
      push(getAttr(attrs, 'href'));
    }
  }
  return refs;
}

/**
 * Walks the FULLY TRANSFORMED output document (never the pre-transform input) looking for any
 * surviving `http(s)://` reference among the fetchable attributes `fetchableRefsForTag` names.
 * Raw-text/inert bodies (script/style/.../srcdoc content) are skipped entirely -- their own start
 * tag's attributes are still inspected, but nested markup inside them is not this pass's concern
 * (an iframe's `srcdoc` is deliberately left byte-identical by the whole transform; see this
 * file's own `<base>`/`<a>` exclusion note on `fetchableRefsForTag`).
 */
function findRemoteReferenceWarnings(html: string): ExportWarning[] {
  const warnings: ExportWarning[] = [];
  const seen = new Set<string>();
  const openStack: OpenStackEntry[] = [];
  let index = 0;
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
    if (token.type !== 'start') {
      index = token.end;
      continue;
    }
    const tagName = token.tag.toLowerCase();
    const elementNamespace = elementNamespaceForTag(tagName, openStack);
    const effectiveSelfClosing = isEffectiveSelfClosingTag(tagName, token.selfClosing, openStack, elementNamespace);
    const parentTag = currentHtmlParent(openStack);
    for (const ref of fetchableRefsForTag(tagName, token.attrs, elementNamespace, parentTag)) {
      const decoded = decodeHtmlCharacterReferences(ref).trim();
      if (REMOTE_HTTP_REF.test(decoded) && !seen.has(decoded)) {
        seen.add(decoded);
        warnings.push({
          kind: 'remote-reference',
          ref: decoded,
          reason: 'live remote reference survives the export transform and is left as a working link',
        });
      }
    }
    if (
      ((elementNamespace === 'html' && INERT_CONTENT_TAGS.has(tagName)) || isRawTextElementForNamespace(tagName, elementNamespace)) &&
      !effectiveSelfClosing
    ) {
      const close = findContentClose(html, token.end, tagName);
      index = close ? close.end : html.length;
      continue;
    }
    if (!effectiveSelfClosing && !HTML_VOID_TAGS.has(tagName)) pushHtmlParent(openStack, tagName, elementNamespace);
    index = token.end;
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Public entry point (dist/cli.mjs lines 976-1002, adapted -- illuminate-shaped options, no
// `readLocalFile`/`resolveAbsolute` pluggable hooks; see this file's header)
// ---------------------------------------------------------------------------

export interface ExportArtifactOptions {
  readonly baseDir: string;
  readonly confineDir: string;
  readonly maxAssetBytes?: number;
  readonly maxBundleBytes?: number;
  readonly maxDepth?: number;
}

export interface ExportArtifactResult {
  readonly html: string;
  readonly warnings: ExportWarning[];
}

/**
 * The assembled export transform's public entry point -- mirrors the reference's own
 * `buildSelfContainedHtml` shape. Builds an `ExportContext`, runs the whole transform, then runs
 * the NEW remote-reference pass (point 3 in this file's header) against the transformed output
 * before returning.
 */
export async function exportArtifact(html: string, options: ExportArtifactOptions): Promise<ExportArtifactResult> {
  const ctx: ExportContext = {
    baseDir: options.baseDir,
    confineDir: resolvePath(options.confineDir),
    maxAssetBytes: resolveBytes(options.maxAssetBytes, process.env[MAX_ASSET_BYTES_ENV_VAR], DEFAULT_MAX_ASSET_BYTES),
    maxBundleBytes: resolveBytes(options.maxBundleBytes, process.env[MAX_BUNDLE_BYTES_ENV_VAR], DEFAULT_MAX_BUNDLE_BYTES),
    maxDepth: Number.isFinite(options.maxDepth) ? (options.maxDepth as number) : DEFAULT_MAX_DEPTH,
    inlinedBytes: 0,
    warnings: [],
  };
  const out = await transform(html, ctx);
  for (const warning of findRemoteReferenceWarnings(out)) ctx.warnings.push(warning);
  return { html: out, warnings: ctx.warnings };
}
