// GUID-02: skills/illuminate/SKILL.md is a GENERATED stub, not hand-authored.
// It renders from src/cli/registry.ts -- the identical COMMANDS/PLAYBOOKS
// data src/cli.ts's --help/design/playbook branches already read from
// (Plan 04-04) -- so the skill stub can never restate guidance that then
// goes stale against a newer CLI. scripts/build.mjs calls checkSkillStub
// after bundling and fails the build the moment the checked-in file no
// longer matches what this generator would currently produce.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { COMMANDS, PLAYBOOKS } from '../src/cli/registry.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default location -- overridable ONLY via ILLUMINATE_SKILL_STUB_PATH, and
 * only for this file's own tests (test/generate-skill.test.ts) and
 * scripts/build.mjs's drift check (which defaults to this same path).
 * Never overridden in normal operation. */
export const SKILL_STUB_PATH = join(__dirname, '..', 'skills', 'illuminate', 'SKILL.md');

/**
 * Pure: same inputs -> same output, every time. This is what makes the
 * build-time drift check meaningful rather than flaky -- GUID-02's
 * acceptance test depends on this function never producing two different
 * outputs for the same registry content.
 */
export function renderSkillMarkdown(commands, playbooks) {
  const ids = playbooks.map((p) => p.id).join(', ');
  return `---
name: illuminate
description: Turn agent-authored HTML into a point-and-explain review and learning surface backed by real source, using the illuminate-axi CLI. Use when an artifact needs a grounded explanation, verification against source, or per-element review feedback.
license: MIT
metadata:
  argument-hint: <file.html>
---

# illuminate

illuminate serves agent-generated HTML locally so a human can point at any element and get a grounded, verifiable explanation of the real code behind it, or ask for a review action.

## Current guidance lives in the CLI

Do not follow workflow or command instructions from this file -- installed copies go stale. Get the current source of truth from the CLI:

- \`npx -y illuminate-axi --help\` -- commands
- \`npx -y illuminate-axi design\` -- why it is built this way
- \`npx -y illuminate-axi playbook <id>\` -- focused guidance (ids: ${ids})

You do not need illuminate-axi installed globally -- invoke it with \`npx -y illuminate-axi <file.html>\`.
`;
}

/** This repo's .gitattributes normalizes `* text=auto eol=lf`, but
 * core.autocrlf=true is ALSO set (Windows-first repo) -- on some clone /
 * checkout / editor combinations the working-tree copy of a checked-in
 * text file can still surface CRLF line endings even though eol=lf should
 * win. renderSkillMarkdown always builds its expected string with bare
 * `\n` (template literals never emit `\r`), so the only side that can
 * legitimately disagree on line endings is a file read back off disk.
 * Normalizing CRLF -> LF on the READ side only (never on `expected`, which
 * is already canonical) means checkSkillStub judges content drift, not
 * line-ending drift, on a fresh Windows clone. */
function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, '\n');
}

/** Path-parameterized (not hardcoded to SKILL_STUB_PATH) specifically so
 * test/generate-skill.test.ts, and scripts/build.mjs's own drift check when
 * overridden via ILLUMINATE_SKILL_STUB_PATH, can point it at a throwaway
 * temp file -- proving both the pass and fail paths without ever touching
 * the real, committed skill stub. */
export function checkSkillStub(path, commands, playbooks) {
  const expected = renderSkillMarkdown(commands, playbooks);
  if (!existsSync(path)) {
    return { ok: false, message: `${path} does not exist -- run npm run generate:skill` };
  }
  const actual = normalizeLineEndings(readFileSync(path, 'utf8'));
  if (actual !== expected) {
    return { ok: false, message: `${path} is stale -- run npm run generate:skill` };
  }
  return { ok: true, message: `${path} is in sync` };
}

export function writeSkillStub(path, commands, playbooks) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderSkillMarkdown(commands, playbooks), 'utf8');
}

function main(argv) {
  const path = process.env.ILLUMINATE_SKILL_STUB_PATH ?? SKILL_STUB_PATH;
  if (argv.includes('--check')) {
    const result = checkSkillStub(path, COMMANDS, PLAYBOOKS);
    process.stdout.write(`${result.message}\n`);
    return result.ok ? 0 : 1;
  }
  writeSkillStub(path, COMMANDS, PLAYBOOKS);
  process.stdout.write(`wrote ${path}\n`);
  return 0;
}

// Only run when executed directly (`node scripts/generate-skill.mjs`), not
// when imported by scripts/build.mjs or test/generate-skill.test.ts.
// pathToFileURL (not a bare `file://` template) because process.argv[1] is
// a platform path -- on Windows it is backslash-separated and lacks the
// `file:///` drive-letter prefix, so a naive string comparison against
// import.meta.url always fails and the CLI would silently no-op.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
