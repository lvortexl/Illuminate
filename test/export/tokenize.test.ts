import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readHtmlToken,
  findRawTextClose,
  findContentClose,
  findTemplateClose,
  isEffectiveSelfClosingTag,
  elementNamespaceForTag,
  isRawTextElementForNamespace,
  pushHtmlParent,
  popHtmlParent,
  parseHtmlAttrs,
  findHtmlAttr,
  getAttr,
  getDecisionAttr,
  getTokenListAttr,
  hasAttr,
  replaceAttrValue,
  replaceAttrValuePreservingEntities,
  removeAttrs,
  formatStartTag,
  escapeRawText,
  escapeAttr,
  quoteAttrValue,
  quoteAttrValuePreservingEntities,
  decodeHtmlCharacterReferences,
  decodeNumericCharacterReference,
  escapeRegExp,
  RAW_TEXT_TAGS,
  INERT_CONTENT_TAGS,
  HTML_VOID_TAGS,
  MEDIA_TAGS,
  SVG_REF_TAGS,
} from '../../src/export/tokenize.ts';
import type { OpenStackEntry } from '../../src/export/tokenize.ts';

// ---------------------------------------------------------------------------
// Raw-text bodies never split on a decoy `</body>` or a stray `<`
// ---------------------------------------------------------------------------

test('a <script> body containing a decoy </body> string and a stray < does not terminate the raw-text scan', () => {
  const html = '<script>if (x < 1) { /* </body> */ }</script><p>after</p>';
  const startToken = readHtmlToken(html, 0);
  assert.ok(startToken && startToken.type === 'start' && startToken.tag === 'script');
  const close = findRawTextClose(html, startToken.end, 'script');
  assert.ok(close, 'expected the real </script> to be found');
  assert.strictEqual(html.slice(close.start, close.end), '</script>');
  assert.strictEqual(close.start, html.indexOf('</script>'));
  // The decoy </body> is entirely inside the opaque raw-text run, not treated as a boundary.
  assert.ok(close.start > html.indexOf('</body>'));
});

test('findContentClose delegates to findRawTextClose for ordinary raw-text tags', () => {
  const html = '<style>.a { content: "</style-ish>"; }</style><p>after</p>';
  const startToken = readHtmlToken(html, 0);
  assert.ok(startToken && startToken.type === 'start');
  const viaContentClose = findContentClose(html, startToken.end, 'style');
  const viaRawTextClose = findRawTextClose(html, startToken.end, 'style');
  assert.deepStrictEqual(viaContentClose, viaRawTextClose);
  assert.ok(viaContentClose);
  assert.strictEqual(html.slice(viaContentClose.start, viaContentClose.end), '</style>');
});

test('an unterminated raw-text element (no matching close tag anywhere) is detected as unterminated', () => {
  const html = '<script>var x = 1; // no closing tag follows';
  const close = findRawTextClose(html, '<script>'.length, 'script');
  assert.strictEqual(close, null);
});

// ---------------------------------------------------------------------------
// <template>/<noscript> inertness vs. ordinary elements
// ---------------------------------------------------------------------------

test('INERT_CONTENT_TAGS recognizes template/noscript as inert, distinct from an ordinary element', () => {
  assert.strictEqual(INERT_CONTENT_TAGS.has('template'), true);
  assert.strictEqual(INERT_CONTENT_TAGS.has('noscript'), true);
  assert.strictEqual(INERT_CONTENT_TAGS.has('div'), false);
});

test('findContentClose delegates to findTemplateClose (depth-aware) for <template>', () => {
  const html = '<template><div></div></template><p>after</p>';
  const startToken = readHtmlToken(html, 0);
  assert.ok(startToken && startToken.type === 'start');
  const close = findContentClose(html, startToken.end, 'template');
  assert.ok(close);
  assert.strictEqual(html.slice(close.end), '<p>after</p>');
});

test('findTemplateClose tracks nested <template> depth correctly, closing on the OUTER tag', () => {
  const html = '<template><template></template></template><p>after</p>';
  const outerOpen = readHtmlToken(html, 0);
  assert.ok(outerOpen && outerOpen.type === 'start');
  const close = findTemplateClose(html, outerOpen.end);
  assert.ok(close);
  assert.strictEqual(html.slice(close.end), '<p>after</p>');
});

test('an unterminated <template> is detected as unterminated (distinct from an unterminated raw-text tag)', () => {
  const html = '<template><div>never closes';
  const close = findTemplateClose(html, '<template>'.length);
  assert.strictEqual(close, null);
});

// ---------------------------------------------------------------------------
// SVG/foreignObject namespace switching
// ---------------------------------------------------------------------------

function walkNamespaces(html: string): { tag: string; namespace: string }[] {
  const result: { tag: string; namespace: string }[] = [];
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
    if (token.type === 'start') {
      const tag = token.tag.toLowerCase();
      const namespace = elementNamespaceForTag(tag, openStack);
      result.push({ tag, namespace });
      const effectiveSelfClosing = isEffectiveSelfClosingTag(tag, token.selfClosing, openStack, namespace);
      if (!effectiveSelfClosing && !HTML_VOID_TAGS.has(tag)) pushHtmlParent(openStack, tag, namespace);
    }
    index = token.end;
  }
  return result;
}

test('<foreignObject> switches the element namespace back to html inside svg, and back to svg on exit', () => {
  const html = '<svg><foreignObject><div></div></foreignObject><path/></svg>';
  assert.deepStrictEqual(walkNamespaces(html), [
    { tag: 'svg', namespace: 'svg' },
    { tag: 'foreignobject', namespace: 'svg' },
    { tag: 'div', namespace: 'html' },
    { tag: 'path', namespace: 'svg' },
  ]);
});

test('isRawTextElementForNamespace only treats script/style as raw-text inside svg (not other tags)', () => {
  assert.strictEqual(isRawTextElementForNamespace('script', 'svg'), true);
  assert.strictEqual(isRawTextElementForNamespace('style', 'svg'), true);
  assert.strictEqual(isRawTextElementForNamespace('path', 'svg'), false);
  assert.strictEqual(isRawTextElementForNamespace('script', 'html'), true);
  assert.strictEqual(isRawTextElementForNamespace('div', 'html'), false);
});

// ---------------------------------------------------------------------------
// Void elements are effectively self-closing without an explicit slash
// ---------------------------------------------------------------------------

test('<br> and <img src="x"> are recognized as HTML void elements independent of an explicit trailing slash', () => {
  assert.strictEqual(HTML_VOID_TAGS.has('br'), true);
  assert.strictEqual(HTML_VOID_TAGS.has('img'), true);

  const brToken = readHtmlToken('<br>', 0);
  assert.ok(brToken && brToken.type === 'start');
  assert.strictEqual(brToken.selfClosing, false, 'no explicit slash in the source');
  // isEffectiveSelfClosingTag answers "does a literal trailing slash carry meaning here" -- for
  // <br> there is none, so it correctly reports false. HTML_VOID_TAGS membership is the separate,
  // independent signal callers combine with it (see opensChildScope below, matching the exact
  // `!effectiveSelfClosing && !HTML_VOID_TAGS.has(tagName)` gate this port's callers use).
  assert.strictEqual(isEffectiveSelfClosingTag('br', brToken.selfClosing), false);

  const imgToken = readHtmlToken('<img src="x">', 0);
  assert.ok(imgToken && imgToken.type === 'start');
  assert.strictEqual(isEffectiveSelfClosingTag('img', imgToken.selfClosing), false);

  function opensChildScope(tag: string, selfClosing: boolean): boolean {
    const namespace = elementNamespaceForTag(tag, []);
    const effectiveSelfClosing = isEffectiveSelfClosingTag(tag, selfClosing, [], namespace);
    return !effectiveSelfClosing && !HTML_VOID_TAGS.has(tag);
  }
  assert.strictEqual(opensChildScope('br', brToken.selfClosing), false);
  assert.strictEqual(opensChildScope('img', imgToken.selfClosing), false);
  assert.strictEqual(opensChildScope('div', false), true);

  // An explicit slash on a void tag (<br/>) is also correctly recognized.
  const selfClosedBr = readHtmlToken('<br/>', 0);
  assert.ok(selfClosedBr && selfClosedBr.type === 'start' && selfClosedBr.selfClosing === true);
  assert.strictEqual(isEffectiveSelfClosingTag('br', selfClosedBr.selfClosing), true);
});

test('MEDIA_TAGS and SVG_REF_TAGS are ported as constants for 09-03 to consume', () => {
  assert.strictEqual(MEDIA_TAGS.has('img'), true);
  assert.strictEqual(MEDIA_TAGS.has('video'), true);
  assert.strictEqual(SVG_REF_TAGS.has('use'), true);
  assert.strictEqual(RAW_TEXT_TAGS.has('textarea'), true);
});

// ---------------------------------------------------------------------------
// parseHtmlAttrs round-trip
// ---------------------------------------------------------------------------

test('parseHtmlAttrs round-trips a representative attribute string; entities are NOT decoded during parsing', () => {
  const attrs = ` class="a b" data-x='y' disabled title="with &quot;entities&quot;"`;
  const parsed = parseHtmlAttrs(attrs);
  assert.strictEqual(parsed.length, 4);

  assert.strictEqual(getAttr(attrs, 'class'), 'a b');
  assert.strictEqual(getAttr(attrs, 'data-x'), 'y');
  assert.strictEqual(hasAttr(attrs, 'disabled'), true);
  assert.strictEqual(getAttr(attrs, 'disabled'), '');
  assert.ok(findHtmlAttr(attrs, 'DISABLED'), 'attribute lookup is case-insensitive');

  // Parsing does not decode entities -- that is a separate, explicit step.
  assert.strictEqual(getAttr(attrs, 'title'), 'with &quot;entities&quot;');
  assert.strictEqual(getDecisionAttr(attrs, 'title'), 'with "entities"');

  assert.deepStrictEqual(getTokenListAttr(attrs, 'class'), ['a', 'b']);
  assert.strictEqual(hasAttr(attrs, 'missing'), false);
});

test('replaceAttrValue rewrites an existing attribute value, quote style preserved', () => {
  const source = `src='old.png' alt="x"`;
  const rewritten = replaceAttrValue(source, 'src', 'new.png');
  assert.strictEqual(getAttr(rewritten, 'src'), 'new.png');
  assert.strictEqual(getAttr(rewritten, 'alt'), 'x');
  assert.match(rewritten, /src='new\.png'/);
});

test('replaceAttrValuePreservingEntities falls back to &quot;-escaping when the new value contains both quote characters', () => {
  const source = `title="a &quot;quoted&quot; word"`;
  // preferredQuote is '"' (matches source's own quote character). The replacement value
  // contains BOTH ' and ", so neither quote character can wrap it unescaped -- the preserving
  // variant must fall back to re-escaping " as &quot; inside a "-quoted attribute.
  const rewritten = replaceAttrValuePreservingEntities(source, 'title', `has "both" and 'both'`);
  assert.match(rewritten, /&quot;/);
  // getAttr returns the raw (still-entity-encoded) value; getDecisionAttr decodes it back.
  assert.strictEqual(getDecisionAttr(rewritten, 'title'), `has "both" and 'both'`);
});

test('removeAttrs strips only the named attributes, preserving the rest', () => {
  const source = ` id="x" data-secret="y" class="z"`;
  const result = removeAttrs(source, ['data-secret']);
  assert.strictEqual(hasAttr(result, 'data-secret'), false);
  assert.strictEqual(getAttr(result, 'id'), 'x');
  assert.strictEqual(getAttr(result, 'class'), 'z');
});

// ---------------------------------------------------------------------------
// Serialization primitives
// ---------------------------------------------------------------------------

test('formatStartTag reconstructs a start tag from a tag name and raw attrs string', () => {
  assert.strictEqual(formatStartTag('div', ' class="a"', false), '<div class="a">');
  assert.strictEqual(formatStartTag('br', '', true), '<br />');
  assert.strictEqual(formatStartTag('img', ' src="x"  ', true), '<img src="x" />');
});

test('escapeRawText escapes a literal closing tag occurring inside raw text of the same tag name', () => {
  const escaped = escapeRawText('var s = "</script>";', 'script');
  assert.strictEqual(escaped, 'var s = "<\\/script>";');
});

test('escapeAttr and quoteAttrValue variants escape ampersands and quotes correctly', () => {
  assert.strictEqual(escapeAttr(`a & b "c"`), 'a &amp; b &quot;c&quot;');
  assert.strictEqual(quoteAttrValue('a "b"', '"'), '"a &quot;b&quot;"');
  assert.strictEqual(quoteAttrValue(`a 'b'`, "'"), `'a &#39;b&#39;'`);
  // Preserving-entities variant prefers an alternate quote over re-escaping when possible.
  assert.strictEqual(quoteAttrValuePreservingEntities('no quotes here', '"'), '"no quotes here"');
  assert.strictEqual(quoteAttrValuePreservingEntities('has "double" only', '"'), `'has "double" only'`);
});

// ---------------------------------------------------------------------------
// Entity decoding
// ---------------------------------------------------------------------------

test('decodeHtmlCharacterReferences decodes named, decimal, and hex character references', () => {
  assert.strictEqual(decodeHtmlCharacterReferences('a &amp; b'), 'a & b');
  assert.strictEqual(decodeHtmlCharacterReferences('&#65;&#x42;'), 'AB');
  assert.strictEqual(decodeHtmlCharacterReferences('&quot;x&quot;'), '"x"');
  assert.strictEqual(decodeHtmlCharacterReferences('no entities here'), 'no entities here');
});

test('decodeNumericCharacterReference rejects out-of-range code points, returning the fallback', () => {
  assert.strictEqual(decodeNumericCharacterReference(65, 'FALLBACK'), 'A');
  assert.strictEqual(decodeNumericCharacterReference(-1, 'FALLBACK'), 'FALLBACK');
  assert.strictEqual(decodeNumericCharacterReference(0x110000, 'FALLBACK'), 'FALLBACK');
});

test('escapeRegExp escapes regex metacharacters for safe embedding in a RegExp constructor', () => {
  const escaped = escapeRegExp('a.b*c?');
  assert.strictEqual(new RegExp(escaped).test('a.b*c?'), true);
  assert.strictEqual(new RegExp(escaped).test('aXbYc'), false);
});
