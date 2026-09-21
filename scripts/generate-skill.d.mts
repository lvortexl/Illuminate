// Hand-written ambient declaration for scripts/generate-skill.mjs (plain
// JS, deliberately outside tsconfig.json's `include` -- scripts/ has no
// build step of its own). Under NodeNext module resolution, TypeScript
// looks up a colocated `.d.mts` for a `.mjs` specifier, so this keeps
// test/generate-skill.test.ts's direct import within `strict`/
// `noImplicitAny` instead of reaching for a repo-wide `allowJs`.
import type { CommandEntry, PlaybookEntry } from '../src/cli/registry.ts';

export declare const SKILL_STUB_PATH: string;

export declare function renderSkillMarkdown(
  commands: readonly CommandEntry[],
  playbooks: readonly PlaybookEntry[],
): string;

export interface SkillStubCheckResult {
  readonly ok: boolean;
  readonly message: string;
}

export declare function checkSkillStub(
  path: string,
  commands: readonly CommandEntry[],
  playbooks: readonly PlaybookEntry[],
): SkillStubCheckResult;

export declare function writeSkillStub(
  path: string,
  commands: readonly CommandEntry[],
  playbooks: readonly PlaybookEntry[],
): void;
