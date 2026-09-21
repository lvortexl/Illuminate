import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { forceRemoveSync } from './cleanup.ts';

/**
 * A deterministic, network-free, fully isolated git repository for tests.
 *
 * Isolation is achieved via `GIT_CONFIG_GLOBAL` (pointed at an empty file,
 * never the developer's real `~/.gitconfig`) and `GIT_CONFIG_NOSYSTEM=1`
 * (ignore any machine-wide system config). Determinism is achieved via
 * explicit `GIT_AUTHOR_*`/`GIT_COMMITTER_*` name, email AND date on every
 * commit. Every git invocation in this module passes arguments as an array
 * to `execFileSync`, never as a shell-interpolated string — see T-02-08 in
 * this plan's threat model.
 */
export type FixtureRepo = {
  readonly root: string;
  git(args: readonly string[]): string;
  commitFile(relPath: string, content: string, message: string, opts?: { crlf?: boolean }): string;
  /** `git mv` + commit. Produces the "unambiguous rename" case. Returns the new HEAD sha. */
  renameFile(oldPath: string, newPath: string, message: string): string;
  /** Delete + commit. Produces the "file deleted, no rename detected" case. Returns the new HEAD sha. */
  deleteFile(path: string, message: string): string;
  /** Write WITHOUT committing. Produces the "dirty working tree" case. */
  writeDirty(relPath: string, content: string): void;
  /** A syntactically valid 40-hex sha never actually committed in this repo. */
  unreachableRev(): string;
  /** Shallow clone this repo. Produces the "data-rev predates the shallow boundary" case. */
  cloneShallow(depth: number): FixtureRepo;
  /** `git submodule add` the given fixture repo at `atPath`, then commit. Returns the new HEAD sha. */
  addSubmodule(submoduleFixtureRepo: FixtureRepo, atPath: string): string;
};

const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@illuminate.test',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@illuminate.test',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00',
} as const;

/**
 * Builds the full `FixtureRepo` method set over an already-initialized (or
 * already-cloned) working directory. Shared by `createFixtureRepo` and
 * `cloneShallow` so a shallow clone's handle exposes every scenario helper
 * too, not just a bare `{ root, git }`.
 */
function buildFixtureRepo(
  root: string,
  baseEnv: NodeJS.ProcessEnv,
  autocrlf: boolean,
): FixtureRepo {
  const git = (args: readonly string[]): string =>
    execFileSync('git', args, { cwd: root, env: baseEnv, encoding: 'utf8' }).trim();

  const commit = (message: string): string => {
    execFileSync('git', ['commit', '-q', '-m', message], {
      cwd: root,
      env: { ...baseEnv, ...COMMIT_IDENTITY },
    });
    return git(['rev-parse', 'HEAD']);
  };

  const commitFile: FixtureRepo['commitFile'] = (relPath, content, message, opts) => {
    const full = join(root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, opts?.crlf ? content.replace(/\n/g, '\r\n') : content);
    git(['add', '-A']);
    return commit(message);
  };

  const renameFile: FixtureRepo['renameFile'] = (oldPath, newPath, message) => {
    mkdirSync(dirname(join(root, newPath)), { recursive: true });
    git(['mv', oldPath, newPath]);
    return commit(message);
  };

  const deleteFile: FixtureRepo['deleteFile'] = (path, message) => {
    rmSync(join(root, path));
    git(['add', '-A']);
    return commit(message);
  };

  const writeDirty: FixtureRepo['writeDirty'] = (relPath, content) => {
    const full = join(root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  const unreachableRev: FixtureRepo['unreachableRev'] = () =>
    // A syntactically valid 40-hex-char sha that was never actually committed
    // in this repo. It only needs to fail `git cat-file -e <rev>^{commit}` —
    // deriving it deterministically by hashing a throwaway string is simpler
    // and faster than creating and then pruning a real orphaned commit, and
    // produces identical observable behavior for every caller of this fixture.
    createHash('sha1').update(`${root}:unreachable-rev`).digest('hex');

  const cloneShallow: FixtureRepo['cloneShallow'] = (depth) => {
    // The clone command itself needs GIT_CONFIG_GLOBAL to already point at an
    // existing (empty) file, but `git clone`'s destination must not exist yet
    // (or must be empty) — so the config file for the clone invocation lives
    // in a small, transient holder directory, separate from the clone's own
    // temp dir, and is removed immediately once the clone is done. The
    // clone's own directory gets its OWN `.empty-gitconfig` written into it
    // afterward (same shape as createFixtureRepo's root), so the returned
    // handle's `root` is fully self-contained: one `rmSync(root, { recursive
    // : true })` by the caller cleans up everything, with no separate
    // container directory left behind.
    const configHolder = mkdtempSync(join(tmpdir(), 'illum-fixture-clone-cfg-'));
    const holderConfig = join(configHolder, '.empty-gitconfig');
    writeFileSync(holderConfig, '');
    const holderEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: holderConfig,
      GIT_CONFIG_NOSYSTEM: '1',
    };

    const cloneRoot = mkdtempSync(join(tmpdir(), 'illum-fixture-clone-'));
    try {
      // --no-local is required: git silently IGNORES --depth for
      // same-filesystem local-path clones (it takes the hardlink fast path
      // instead), which would make this scenario helper produce a full,
      // non-shallow clone with no error — a shallow-boundary bug that would
      // only surface as flaky behavior in a real repo, not a fixture.
      // --no-local forces the real pack-negotiation path so --depth is
      // honored, matching a genuine network shallow clone.
      execFileSync(
        'git',
        [
          '-c',
          'protocol.file.allow=always',
          'clone',
          '-q',
          '--no-local',
          '--depth',
          String(depth),
          root,
          cloneRoot,
        ],
        { cwd: configHolder, env: holderEnv },
      );
    } finally {
      forceRemoveSync(configHolder);
    }

    const cloneConfig = join(cloneRoot, '.empty-gitconfig');
    writeFileSync(cloneConfig, '');
    const cloneEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: cloneConfig,
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const clone = buildFixtureRepo(cloneRoot, cloneEnv, autocrlf);
    clone.git(['config', 'core.autocrlf', autocrlf ? 'true' : 'false']);
    clone.git(['config', 'commit.gpgsign', 'false']);
    return clone;
  };

  const addSubmodule: FixtureRepo['addSubmodule'] = (submoduleFixtureRepo, atPath) => {
    git([
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      submoduleFixtureRepo.root,
      atPath,
    ]);
    return commit(`add submodule at ${atPath}`);
  };

  return {
    root,
    git,
    commitFile,
    renameFile,
    deleteFile,
    writeDirty,
    unreachableRev,
    cloneShallow,
    addSubmodule,
  };
}

export function createFixtureRepo(autocrlf: boolean): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), 'illum-fixture-'));
  const emptyGlobalConfig = join(root, '.empty-gitconfig');
  writeFileSync(emptyGlobalConfig, '');

  const baseEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyGlobalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };

  const repo = buildFixtureRepo(root, baseEnv, autocrlf);
  repo.git(['-c', 'init.defaultBranch=main', 'init', '-q', '.']);
  repo.git(['config', 'core.autocrlf', autocrlf ? 'true' : 'false']);
  repo.git(['config', 'commit.gpgsign', 'false']);
  return repo;
}
