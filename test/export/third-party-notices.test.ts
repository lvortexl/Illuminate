// Drift-check backstop for EXP-02: THIRD-PARTY-NOTICES.md must always list
// every file under src/export/ that carries the lavish-axi porting
// attribution marker, and never claim a file carries it when it does not.
// Mirrors GUID-02's own "the build fails when the generated stub drifts
// from its generator" precedent (scripts/generate-skill.mjs's
// checkSkillStub), applied here to a legal-attribution artifact instead of
// a CLI skill stub -- this file IS the automated backstop
// THIRD-PARTY-NOTICES.md's own "Publication Gate" section promises.
//
// All checks below are plain substring (`.includes`) matches, never exact
// string equality -- unlike checkSkillStub's own exact-match drift check
// (which has to normalize CRLF -> LF before comparing, per this repo's
// Windows-first eol=lf/autocrlf=true combination), none of the substrings
// matched here (the attribution marker, or a bare file path like
// `src/export/refs.ts`) ever contains a newline, so a file's line-ending
// style cannot change whether a substring is found inside it. No CRLF
// normalization is needed for that reason, not because it was overlooked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forceRemoveSync } from '../fixtures/cleanup.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(HERE, '..', '..');
const EXPORT_SRC_DIR = join(ROOT_DIR, 'src', 'export');
const NOTICES_PATH = join(ROOT_DIR, 'THIRD-PARTY-NOTICES.md');

/** Exact phrase opening every file header in src/export/ that ports logic
 * from lavish-axi's export-bundle.js (see src/export/{types,tokenize,refs,
 * inline-html}.ts). THIRD-PARTY-NOTICES.md's own "File-level map" section
 * names this exact phrase as the repository's attribution marker. */
const ATTRIBUTION_MARKER =
  "Ported from lavish-axi's export-bundle.js (MIT License, Copyright (c) 2026 Kun Chen).";

/** Recursive .ts file walk. Same shape as test/html/no-cdn.test.ts's own
 * private listTsFiles -- not imported from there (that copy is private to
 * this file's own module and scoped to a different root), but deliberately
 * NOT a third divergent implementation either: identical readdirSync
 * options, identical filter, identical parentPath join. */
function listTsFiles(rootDir: string): string[] {
  const entries = readdirSync(rootDir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(join(entry.parentPath, entry.name));
    }
  }
  return files;
}

/**
 * Paths (relative to `relativeTo`, forward-slash-normalized) of every
 * `.ts` file under `dir` whose text contains the attribution marker.
 *
 * Pure and parameterized on BOTH `dir` and `relativeTo` -- never hardcoded
 * to EXPORT_SRC_DIR/ROOT_DIR -- specifically so the "this is a real walk,
 * not a hardcoded array of the 4 known files" test below can point it at a
 * disposable temp directory instead of the real src/export/ tree.
 */
function findAttributedFiles(dir: string, relativeTo: string): string[] {
  return listTsFiles(dir)
    .filter((path) => readFileSync(path, 'utf8').includes(ATTRIBUTION_MARKER))
    .map((path) => relative(relativeTo, path).split('\\').join('/'));
}

/** Attributed paths (as produced by findAttributedFiles) that `noticesText`
 * does not mention anywhere. Empty result = every attributed file is
 * covered by the notices doc. */
function findUnlistedAttributions(attributedPaths: string[], noticesText: string): string[] {
  return attributedPaths.filter((path) => !noticesText.includes(path));
}

test('findAttributedFiles walks the real filesystem rather than using a hardcoded file list', () => {
  // A disposable fixture directory, unrelated to src/export/, proves the
  // walk itself -- not this test's own foreknowledge of the 4 real
  // borrowed files -- is what finds attributed files. A brand-new file
  // dropped in here with the marker is discovered with zero code changes,
  // exactly like a future real file added under src/export/ would be.
  const dir = mkdtempSync(join(tmpdir(), 'illuminate-notices-test-'));
  try {
    writeFileSync(join(dir, 'known.ts'), `// ${ATTRIBUTION_MARKER}\nexport const a = 1;\n`);
    writeFileSync(join(dir, 'plain.ts'), 'export const b = 2;\n');
    writeFileSync(
      join(dir, 'newly-borrowed.ts'),
      `// ${ATTRIBUTION_MARKER}\nexport const c = 3;\n`,
    );

    const attributed = findAttributedFiles(dir, dir).sort();
    assert.deepStrictEqual(attributed, ['known.ts', 'newly-borrowed.ts']);

    // The exact drift scenario EXP-02's backstop exists to catch: a real
    // future file (`newly-borrowed.ts`) borrows more code from lavish-axi
    // without a matching notices update.
    const incompleteNotices = 'This notices doc only ever mentions known.ts.';
    assert.deepStrictEqual(findUnlistedAttributions(attributed, incompleteNotices), [
      'newly-borrowed.ts',
    ]);

    const completeNotices = 'This notices doc mentions known.ts and newly-borrowed.ts both.';
    assert.deepStrictEqual(findUnlistedAttributions(attributed, completeNotices), []);
  } finally {
    forceRemoveSync(dir);
  }
});

test('every real src/export/ file carrying the attribution marker is listed in THIRD-PARTY-NOTICES.md', () => {
  const attributed = findAttributedFiles(EXPORT_SRC_DIR, ROOT_DIR);
  assert.ok(
    attributed.length >= 4,
    `expected at least the 4 known-borrowed files under src/export/, found ${attributed.length}: ${attributed.join(', ')}`,
  );
  const noticesText = readFileSync(NOTICES_PATH, 'utf8');
  const missing = findUnlistedAttributions(attributed, noticesText);
  assert.deepStrictEqual(
    missing,
    [],
    `THIRD-PARTY-NOTICES.md does not list these attributed src/export/ files: ${missing.join(', ')} -- update THIRD-PARTY-NOTICES.md's file-level map`,
  );
});

test('src/export/materialize-cards.ts does NOT carry the attribution marker (original to illuminate, not ported)', () => {
  const path = join(EXPORT_SRC_DIR, 'materialize-cards.ts');
  const text = readFileSync(path, 'utf8');
  assert.ok(
    !text.includes(ATTRIBUTION_MARKER),
    'materialize-cards.ts unexpectedly carries the lavish-axi attribution marker -- it has no lavish-axi equivalent and must not claim to be ported',
  );
});

test('THIRD-PARTY-NOTICES.md names the component, license, copyright holder, and every borrowed file path', () => {
  const noticesText = readFileSync(NOTICES_PATH, 'utf8');
  const required = [
    'lavish-axi',
    'MIT',
    'Kun Chen',
    'src/export/types.ts',
    'src/export/tokenize.ts',
    'src/export/refs.ts',
    'src/export/inline-html.ts',
  ];
  for (const needle of required) {
    assert.ok(
      noticesText.includes(needle),
      `THIRD-PARTY-NOTICES.md is missing required string: ${JSON.stringify(needle)}`,
    );
  }
});
