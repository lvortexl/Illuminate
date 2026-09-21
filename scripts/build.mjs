import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { checkSkillStub, SKILL_STUB_PATH } from './generate-skill.mjs';
import { COMMANDS, PLAYBOOKS } from '../src/cli/registry.ts';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const define = { __ILLUMINATE_VERSION__: JSON.stringify(pkg.version) };

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/cli.mjs',
  banner: { js: '#!/usr/bin/env node' },
  packages: 'external',
  define,
});

// Spawned by src/daemon/orchestrate.ts as a child process (never invoked
// directly by a user) — no shebang banner needed, just its own bundle so
// spawnDaemon can `node dist/daemon-entry.mjs <artifactRoot>`.
await build({
  entryPoints: ['src/daemon/daemon-entry.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/daemon-entry.mjs',
  packages: 'external',
  define,
});

// The artifact SDK: injected into the sandboxed, opaque-origin artifact
// iframe via a single <script> tag (SERVE-03). Must be dependency-free and
// self-contained -- no `packages: 'external'`, everything bundled in.
await build({
  entryPoints: ['src/sdk/index.ts'],
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  outfile: 'dist/sdk.js',
  minify: true,
});

// The real chrome-client script: injected via a plain <script src="/chrome-client.js">
// tag on GET /session/:key's shell HTML (server.ts). Same house style as
// dist/sdk.js -- dependency-free, self-contained, no `packages: 'external'`.
await build({
  entryPoints: ['src/chrome/client.ts'],
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  outfile: 'dist/chrome-client.js',
  minify: true,
});

// GUID-02: the checked-in skill stub must never drift from what
// generate-skill.mjs would currently produce from the CLI's own command
// registry. Runs AFTER all four bundles above so a developer mid-edit
// still gets a working dist/ to test against, plus a clear failure signal
// -- not a thrown, stack-trace-dumping error, an expected/actionable one.
const skillPath = process.env.ILLUMINATE_SKILL_STUB_PATH ?? SKILL_STUB_PATH;
const skillCheck = checkSkillStub(skillPath, COMMANDS, PLAYBOOKS);
if (!skillCheck.ok) {
  process.stderr.write(`${skillCheck.message}\n`);
  process.exitCode = 1;
}
