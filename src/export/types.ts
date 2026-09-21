// Ported from lavish-axi's export-bundle.js (MIT License, Copyright (c) 2026 Kun Chen).
// Source: https://github.com/kunchenguid/lavish-axi, vendored/ported 2026-09-11 from the locally
// cached build at lavish-axi@0.1.67 (dist/cli.mjs lines 877-4177, // src/export-bundle.js).
// This file types the reference's UNRESOLVED_LOCAL_ASSET_WARNING_KINDS constant (dist/cli.mjs
// lines 951-975) and the shape of its per-export `ctx` accumulator. See THIRD-PARTY-NOTICES.md.

/**
 * Ported verbatim from export-bundle.js's `UNRESOLVED_LOCAL_ASSET_WARNING_KINDS` Set (23 string
 * literals, dist/cli.mjs lines 951-975), plus two illuminate-specific additions appended at the
 * end. Deliberately excludes the reference's `csp-meta`-shaped concerns -- illuminate already has
 * `detectAuthorCsp`/`detectBaseHref` in src/html/detect.ts for that, reused directly by 09-03/
 * 09-04 rather than re-derived here. This union is scoped to ASSET/REFERENCE problems only.
 */
export const EXPORT_WARNING_KINDS = [
  'behavioral-stylesheet',
  'css-import-depth',
  'css-import-order',
  'fetchable-link',
  'file-url-unresolved',
  'inactive-stylesheet',
  'inline-importmap-local-ref',
  'inline-module-import',
  'load-failed',
  'module-external',
  'nested-svg-resource',
  'outside-root',
  'preload-stylesheet',
  'srcdoc-resource',
  'too-large',
  'unmapped-root-absolute',
  'unterminated-script-src',
  'unsupported-css-import',
  'unsupported-frame',
  'unsupported-script-timing',
  'unsupported-script-type',
  'unsupported-style-type',
  'unsupported-stylesheet-type',
  // The reference pushes these three additional kinds too (export-bundle.js's own
  // `ctx.warnings.push`), but they live OUTSIDE its `UNRESOLVED_LOCAL_ASSET_WARNING_KINDS` Set
  // (they are "notices" in the reference's own `splitExportWarnings` split, not "unresolved local
  // assets") -- 09-01's initial port of that 23-member Set did not carry them, since 09-01 only
  // typed the Set itself. 09-03 needs all three for its own ported `transform`/CSS-scanner
  // functions to compile, so they are added here rather than in a second, competing type:
  'inert-resource',
  'late-css-import',
  'unterminated-raw-text',
  // NOT in the reference's own Set -- the reference treats a redacted file:// ref as a separate
  // notice, tracked outside that Set. illuminate folds it into the same severity bucket: a
  // redacted file:// reference is exactly as broken-once-moved as anything else in this list.
  'file-url-redacted',
  // NEW -- not in the reference at all. 09-03's own addition: a live http(s):// reference
  // surviving the export transform is a portability problem specific to illuminate (see
  // 09-03's inline-html.ts doc comment for why it is tracked as its own warning kind).
  'remote-reference',
] as const;

export type ExportWarningKind = (typeof EXPORT_WARNING_KINDS)[number];

export interface ExportWarning {
  readonly kind: ExportWarningKind;
  readonly ref: string;
  readonly reason?: string;
}

/**
 * Adapted from the reference's own per-call `ctx` object (built inline in
 * `buildSelfContainedHtml`, dist/cli.mjs lines 978-999). Mutable `inlinedBytes`/`warnings` are
 * deliberate, matching the reference: this is a plain accumulator threaded by reference through
 * the whole transform, mutated by nearly every function that touches it -- not an immutable
 * value type. `confineDir` is non-optional here (unlike the reference's nullable
 * `options.confineDir`): illuminate's export always operates within a known artifact root.
 */
export interface ExportContext {
  readonly baseDir: string;
  readonly confineDir: string;
  maxAssetBytes: number;
  maxBundleBytes: number;
  maxDepth: number;
  inlinedBytes: number;
  readonly warnings: ExportWarning[];
}
