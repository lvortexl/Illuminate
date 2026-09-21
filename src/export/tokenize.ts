// Ported from lavish-axi's export-bundle.js (MIT License, Copyright (c) 2026 Kun Chen).
// Source: https://github.com/kunchenguid/lavish-axi, vendored/ported 2026-09-11 from the locally
// cached build at lavish-axi@0.1.67 (dist/cli.mjs lines 877-4177, // src/export-bundle.js).
// This file covers the raw-text-aware HTML tokenizer: constants, namespace/stack bookkeeping,
// the tokenizer core, attribute reading/rewriting, and start-tag serialization primitives.
// Deliberately independent of parse5 -- a hand-rolled tokenizer, matching the reference's own
// architecture; parse5 elsewhere in illuminate is used only for the byte-offset-splice technique
// in src/html/inject.ts and src/html/detect.ts, never for tokenizing raw text.
// See THIRD-PARTY-NOTICES.md.

// ---------------------------------------------------------------------------
// Constants (dist/cli.mjs lines 915-948)
// ---------------------------------------------------------------------------

export const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  apos: "'",
  colon: ':',
  gt: '>',
  lt: '<',
  nbsp: ' ',
  newline: '\n',
  quot: '"',
  sol: '/',
  tab: '\t',
};

export const RAW_TEXT_TAGS = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'iframe',
  'xmp',
  'noembed',
  'noframes',
]);

export const PLAINTEXT_TAG = 'plaintext';

export const INERT_CONTENT_TAGS = new Set(['template', 'noscript']);

export const MEDIA_TAGS = new Set(['img', 'source', 'video', 'audio', 'track']);

export const SVG_REF_TAGS = new Set(['use', 'image', 'feimage']);

export const SVG_HTML_INTEGRATION_POINTS = new Set(['foreignobject', 'desc', 'title']);

export const HTML_VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

// ---------------------------------------------------------------------------
// Token shapes
// ---------------------------------------------------------------------------

export interface CommentToken {
  readonly type: 'comment';
  readonly raw: string;
  readonly end: number;
}

export interface SpecialToken {
  readonly type: 'special';
  readonly raw: string;
  readonly end: number;
}

export interface CloseToken {
  readonly type: 'close';
  readonly tag: string;
  readonly raw: string;
  readonly end: number;
}

export interface StartToken {
  readonly type: 'start';
  readonly tag: string;
  readonly attrs: string;
  readonly selfClosing: boolean;
  readonly raw: string;
  readonly end: number;
}

export type HtmlToken = CommentToken | SpecialToken | CloseToken | StartToken;

export interface ContentClose {
  readonly start: number;
  readonly raw: string;
  readonly end: number;
}

export type HtmlNamespace = 'html' | 'svg' | 'math';

export interface OpenStackEntry {
  readonly tag: string;
  readonly namespace: HtmlNamespace;
}

// ---------------------------------------------------------------------------
// Namespace / open-element stack bookkeeping (dist/cli.mjs lines 1108-1155)
// ---------------------------------------------------------------------------

export function isEffectiveSelfClosingTag(
  tagName: string,
  selfClosing: boolean,
  openStack: OpenStackEntry[] = [],
  elementNamespace: HtmlNamespace | null = null,
): boolean {
  if (!selfClosing) return false;
  if (HTML_VOID_TAGS.has(tagName)) return true;
  const namespace = elementNamespace ?? elementNamespaceForTag(tagName, openStack);
  return namespace === 'svg' || namespace === 'math';
}

/**
 * Adapted from the reference's own `stackTag`: the reference defensively handles a plain-string
 * stack entry (`typeof entry === 'string' ? entry : entry.tag`), but `pushHtmlParent` below is
 * the only producer of stack entries in this port and it always pushes an `OpenStackEntry`
 * object -- so the string branch is unreachable given this port's types and is dropped.
 */
export function stackTag(entry: OpenStackEntry): string {
  return entry.tag;
}

export function currentHtmlParent(openStack: OpenStackEntry[]): string {
  return openStack.length ? stackTag(openStack[openStack.length - 1]!) : '';
}

export function popHtmlParent(openStack: OpenStackEntry[], tagName: string): void {
  const index = findLastStackIndex(openStack, tagName);
  if (index !== -1) openStack.length = index;
}

export function pushHtmlParent(
  openStack: OpenStackEntry[],
  tagName: string,
  elementNamespace: HtmlNamespace,
): void {
  openStack.push({ tag: tagName, namespace: childNamespaceForTag(tagName, elementNamespace) });
}

export function findLastStackIndex(openStack: OpenStackEntry[], tagName: string): number {
  for (let index = openStack.length - 1; index >= 0; index -= 1) {
    if (stackTag(openStack[index]!) === tagName) return index;
  }
  return -1;
}

export function currentNamespace(openStack: OpenStackEntry[]): HtmlNamespace {
  return openStack.length ? openStack[openStack.length - 1]!.namespace : 'html';
}

export function elementNamespaceForTag(tagName: string, openStack: OpenStackEntry[]): HtmlNamespace {
  const namespace = currentNamespace(openStack);
  if (namespace !== 'html') return namespace;
  if (tagName === 'svg') return 'svg';
  if (tagName === 'math') return 'math';
  return 'html';
}

export function childNamespaceForTag(tagName: string, elementNamespace: HtmlNamespace): HtmlNamespace {
  if (elementNamespace === 'html') {
    if (tagName === 'svg') return 'svg';
    if (tagName === 'math') return 'math';
    return 'html';
  }
  if (elementNamespace === 'svg' && SVG_HTML_INTEGRATION_POINTS.has(tagName)) return 'html';
  return elementNamespace;
}

export function isRawTextElementForNamespace(tagName: string, elementNamespace: HtmlNamespace): boolean {
  if (elementNamespace === 'html') return RAW_TEXT_TAGS.has(tagName);
  return elementNamespace === 'svg' && (tagName === 'script' || tagName === 'style');
}

// ---------------------------------------------------------------------------
// Tokenizer core (dist/cli.mjs lines 2774-2900)
// ---------------------------------------------------------------------------

function isHtmlSpace(char: string | undefined): boolean {
  return char !== undefined && /[\t\n\f\r ]/.test(char);
}

export function readHtmlToken(html: string, index: number): HtmlToken | null {
  if (html[index] !== '<') return null;
  if (html.startsWith('<!--', index)) {
    const commentEnd = html.indexOf('-->', index + 4);
    const tokenEnd = commentEnd === -1 ? html.length : commentEnd + 3;
    return { type: 'comment', raw: html.slice(index, tokenEnd), end: tokenEnd };
  }
  const next = html[index + 1] ?? '';
  if (next === '!' || next === '?') {
    const specialEnd = findHtmlTagEnd(html, index);
    if (specialEnd === -1) return null;
    return { type: 'special', raw: html.slice(index, specialEnd + 1), end: specialEnd + 1 };
  }
  if (next === '/') {
    const closeName = readHtmlTagName(html, index + 2);
    if (!closeName) return null;
    const closeEnd = findHtmlTagEnd(html, index);
    if (closeEnd === -1) return null;
    return { type: 'close', tag: closeName.value, raw: html.slice(index, closeEnd + 1), end: closeEnd + 1 };
  }
  const name = readHtmlTagName(html, index + 1);
  if (!name) return null;
  const end = findHtmlTagEnd(html, index);
  if (end === -1) return null;
  let attrsEnd = end;
  let cursor = end - 1;
  while (cursor > name.end && isHtmlSpace(html[cursor])) cursor -= 1;
  const selfClosing = html[cursor] === '/' && isSelfClosingSlash(html, name.end, end, cursor);
  if (selfClosing) attrsEnd = cursor;
  return {
    type: 'start',
    tag: name.value,
    attrs: html.slice(name.end, attrsEnd),
    selfClosing,
    raw: html.slice(index, end + 1),
    end: end + 1,
  };
}

export function isSelfClosingSlash(html: string, attrsStart: number, tagEnd: number, slashIndex: number): boolean {
  const attrs = html.slice(attrsStart, tagEnd);
  const slashOffset = slashIndex - attrsStart;
  for (const attr of parseHtmlAttrs(attrs)) {
    if (attr.hasValue && !attr.quote && attr.valueRawStart <= slashOffset && slashOffset < attr.valueRawEnd) {
      return false;
    }
  }
  return true;
}

export function readHtmlTagName(html: string, index: number): { value: string; end: number } | null {
  if (!/[a-z]/i.test(html[index] ?? '')) return null;
  let cursor = index + 1;
  while (cursor < html.length && /[\w:-]/.test(html[cursor] ?? '')) cursor += 1;
  const value = html.slice(index, cursor);
  const next = html[cursor] ?? '';
  if (next && !/[\t\n\f\r />]/.test(next)) return null;
  return { value, end: cursor };
}

export function findHtmlTagEnd(html: string, index: number): number {
  let quote = '';
  for (let cursor = index + 1; cursor < html.length; cursor += 1) {
    const char = html[cursor] ?? '';
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return cursor;
  }
  return -1;
}

export function findRawTextClose(html: string, index: number, tag: string): ContentClose | null {
  let cursor = index;
  while (cursor < html.length) {
    const lt = html.indexOf('</', cursor);
    if (lt === -1) return null;
    const token = readHtmlToken(html, lt);
    if (token?.type === 'close' && token.tag.toLowerCase() === tag) {
      return { start: lt, raw: token.raw, end: token.end };
    }
    cursor = lt + 2;
  }
  return null;
}

export function findContentClose(html: string, index: number, tag: string): ContentClose | null {
  if (tag === 'template') return findTemplateClose(html, index);
  return findRawTextClose(html, index, tag);
}

export function findTemplateClose(html: string, index: number): ContentClose | null {
  let depth = 1;
  let cursor = index;
  while (cursor < html.length) {
    const lt = html.indexOf('<', cursor);
    if (lt === -1) return null;
    const token = readHtmlToken(html, lt);
    if (!token) {
      cursor = lt + 1;
      continue;
    }
    if (token.type === 'close' && token.tag.toLowerCase() === 'template') {
      depth -= 1;
      if (depth === 0) return { start: lt, raw: token.raw, end: token.end };
      cursor = token.end;
      continue;
    }
    if (token.type === 'start') {
      const tagName = token.tag.toLowerCase();
      const effectiveSelfClosing = isEffectiveSelfClosingTag(tagName, token.selfClosing);
      if (tagName === 'template' && !effectiveSelfClosing) {
        depth += 1;
        cursor = token.end;
        continue;
      }
      if (tagName === PLAINTEXT_TAG && !effectiveSelfClosing) return null;
      if (RAW_TEXT_TAGS.has(tagName) && !effectiveSelfClosing) {
        const close = findRawTextClose(html, token.end, tagName);
        if (!close) return null;
        cursor = close.end;
        continue;
      }
    }
    cursor = token.end;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Attribute reading (dist/cli.mjs lines 4016-4029, 4052-4129)
// ---------------------------------------------------------------------------

export interface ParsedHtmlAttr {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly nameEnd: number;
  readonly hasValue: boolean;
  readonly value: string;
  readonly valueRawStart: number;
  readonly valueRawEnd: number;
  readonly quote: string;
}

export function parseHtmlAttrs(attrs: string): ParsedHtmlAttr[] {
  const input = String(attrs || '');
  const parsed: ParsedHtmlAttr[] = [];
  let index = 0;
  while (index < input.length) {
    while (index < input.length && isHtmlSpace(input[index])) index += 1;
    if (index >= input.length) break;
    if (input[index] === '/') {
      index += 1;
      continue;
    }
    if (/[<>"'=]/.test(input[index] ?? '')) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < input.length && !/[\t\n\f\r />"'=]/.test(input[index] ?? '')) index += 1;
    if (index === start) {
      index += 1;
      continue;
    }
    const name = input.slice(start, index);
    const nameEnd = index;
    let cursor = index;
    while (cursor < input.length && isHtmlSpace(input[cursor])) cursor += 1;
    if (input[cursor] !== '=') {
      parsed.push({
        start,
        end: nameEnd,
        name,
        nameEnd,
        hasValue: false,
        value: '',
        valueRawStart: nameEnd,
        valueRawEnd: nameEnd,
        quote: '',
      });
      index = cursor;
      continue;
    }
    cursor += 1;
    while (cursor < input.length && isHtmlSpace(input[cursor])) cursor += 1;
    const valueRawStart = cursor;
    let valueStart = cursor;
    let valueEnd: number;
    let valueRawEnd: number;
    let quote = '';
    const quoteChar = input[cursor];
    if (quoteChar === '"' || quoteChar === "'") {
      quote = quoteChar;
      valueStart = cursor + 1;
      cursor += 1;
      while (cursor < input.length && input[cursor] !== quote) cursor += 1;
      valueEnd = cursor;
      valueRawEnd = cursor < input.length ? cursor + 1 : cursor;
    } else {
      while (cursor < input.length && !/[\t\n\f\r >]/.test(input[cursor] ?? '')) cursor += 1;
      valueEnd = cursor;
      valueRawEnd = cursor;
    }
    parsed.push({
      start,
      end: valueRawEnd,
      name,
      nameEnd,
      hasValue: true,
      value: input.slice(valueStart, valueEnd),
      valueRawStart,
      valueRawEnd,
      quote,
    });
    index = valueRawEnd;
  }
  return parsed;
}

export function findHtmlAttr(attrs: string, name: string): ParsedHtmlAttr | null {
  const lower = name.toLowerCase();
  return parseHtmlAttrs(attrs).find((attr) => attr.name.toLowerCase() === lower) ?? null;
}

export function getAttr(attrs: string, name: string): string {
  const attr = findHtmlAttr(attrs, name);
  return attr && attr.hasValue ? attr.value : '';
}

export function getDecisionAttr(attrs: string, name: string): string {
  const value = getAttr(attrs, name);
  return value ? decodeHtmlCharacterReferences(value) : '';
}

export function getTokenListAttr(attrs: string, name: string): string[] {
  return getDecisionAttr(attrs, name)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function hasAttr(attrs: string, name: string): boolean {
  return Boolean(findHtmlAttr(attrs, name));
}

// ---------------------------------------------------------------------------
// Attribute rewriting (dist/cli.mjs lines 4030-4051, 4130-4137)
// ---------------------------------------------------------------------------

export function replaceAttrValue(source: string, name: string, value: string): string {
  const attr = findHtmlAttr(source, name);
  return attr ? replaceAttrTokenValue(source, attr, value) : source;
}

export function replaceAttrValuePreservingEntities(source: string, name: string, value: string): string {
  const attr = findHtmlAttr(source, name);
  return attr ? replaceAttrTokenValue(source, attr, value, { preserveEntities: true }) : source;
}

export function removeAttrs(attrs: string, names: string[]): string {
  const remove = new Set(names.map((name) => name.toLowerCase()));
  const parsed = parseHtmlAttrs(attrs);
  let result = '';
  let lastIndex = 0;
  for (const attr of parsed) {
    if (!remove.has(attr.name.toLowerCase())) continue;
    result += attrs.slice(lastIndex, attr.start);
    lastIndex = attr.end;
  }
  result += attrs.slice(lastIndex);
  const trimmed = result.trim();
  return trimmed ? ` ${trimmed}` : '';
}

export function replaceAttrTokenValue(
  source: string,
  attr: ParsedHtmlAttr,
  value: string,
  options: { preserveEntities?: boolean } = {},
): string {
  const quote = attr.quote || '"';
  const raw = options.preserveEntities
    ? quoteAttrValuePreservingEntities(value, quote)
    : quoteAttrValue(value, quote);
  if (!attr.hasValue) {
    return `${source.slice(0, attr.nameEnd)}=${raw}${source.slice(attr.nameEnd)}`;
  }
  return `${source.slice(0, attr.valueRawStart)}${raw}${source.slice(attr.valueRawEnd)}`;
}

// ---------------------------------------------------------------------------
// Serialization primitives (dist/cli.mjs lines 4009-4015, 4138-4169)
// ---------------------------------------------------------------------------

export function formatStartTag(tag: string, attrs: string, selfClosing: boolean): string {
  if (selfClosing) return `<${tag}${attrs.replace(/\s+$/, '')} />`;
  return `<${tag}${attrs}>`;
}

export function escapeRawText(text: string, tag: string): string {
  return text.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');
}

export function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export function quoteAttrValuePreservingEntities(value: string, preferredQuote: string): string {
  const text = String(value);
  if (!text.includes(preferredQuote)) return `${preferredQuote}${text}${preferredQuote}`;
  const alternateQuote = preferredQuote === '"' ? "'" : '"';
  if (!text.includes(alternateQuote)) return `${alternateQuote}${text}${alternateQuote}`;
  return `"${text.replace(/"/g, '&quot;')}"`;
}

export function quoteAttrValue(value: string, preferredQuote: string): string {
  const quote = preferredQuote === "'" ? "'" : '"';
  return `${quote}${escapeAttrForQuote(value, quote)}${quote}`;
}

export function escapeAttrForQuote(value: string, quote: string): string {
  let escaped = value.replace(/&/g, '&amp;');
  escaped = quote === '"' ? escaped.replace(/"/g, '&quot;') : escaped.replace(/'/g, '&#39;');
  return escaped;
}

// ---------------------------------------------------------------------------
// Entity decoding (dist/cli.mjs lines 3934-3986)
// ---------------------------------------------------------------------------

export function decodeHtmlCharacterReferences(value: string): string {
  return String(value).replace(
    /&(?:#(\d+);?|#x([\da-f]+);?|([a-z][a-z0-9]+);|([a-z][a-z0-9]+)(?=[^a-z0-9=]|$))/gi,
    (
      match: string,
      decimal: string | undefined,
      hex: string | undefined,
      named: string | undefined,
      legacyNamed: string | undefined,
    ) => {
      if (decimal) return decodeNumericCharacterReference(Number.parseInt(decimal, 10), match);
      if (hex) return decodeNumericCharacterReference(Number.parseInt(hex, 16), match);
      const entity = named ?? legacyNamed ?? '';
      return HTML_ENTITY_MAP[entity.toLowerCase()] ?? match;
    },
  );
}

export function decodeNumericCharacterReference(codePoint: number, fallback: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 1114111) return fallback;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Misc (dist/cli.mjs line 4167)
// ---------------------------------------------------------------------------

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
