import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * LIFE-01, enforced at the source level.
 *
 * Every child process this codebase launches must pass `windowsHide: true`.
 * On Windows a spawn without it pops a real console window — and with
 * `shell: true` (which routes through cmd.exe) it is unmistakably a cmd
 * window. The daemon's staleness loop shells out to `git` on every reconcile
 * tick, so a single missing flag is not one flash: it is a window flashing
 * continuously for as long as the daemon runs, severe enough to make the
 * machine hard to type on.
 *
 * This shipped undetected because the win32 daemon died the instant the CLI
 * exited (LIFE-05). Nothing lived long enough to reconcile, so nothing ever
 * flashed. Fixing LIFE-05 made the daemon real and exposed nine unflagged
 * `execFileSync('git', ...)` calls in git-meta.ts plus two `shell: true`
 * spawns. One bug was hiding the other.
 *
 * A source-text test rather than a behavioural one: no automated check can
 * see a console window appear for 40ms, which is exactly why LIFE-01 was
 * left to a human in the first place. This makes the mechanical half
 * enforceable so the human half is only ever a confirmation.
 */

const SRC = new URL('../../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Call sites that actually launch a process.
 *
 * `spawnFn` is listed explicitly and is the important one: this codebase
 * injects its spawners for testability, so the REAL launches read
 * `spawnFn('claude', ...)`, not `spawn(...)`. A pattern covering only the
 * `node:child_process` names matches the one-line forwarders and misses every
 * genuine call site — which is how the first version of this test passed while
 * both offending spawns were still unflagged.
 *
 * `exec(` is deliberately absent: it collides with `RegExp.prototype.exec`,
 * which this codebase uses heavily and which spawns nothing. Wrapper calls
 * like `spawnDaemon(...)` are absent by design too — they are not launches,
 * they delegate to one (spawn.ts), which this test checks on its own.
 */
const LAUNCHERS = /\b(?:execFileSync|execFile|spawnSync|spawnFn|spawn)\s*\(/g;

/**
 * Blanks out comments and string/template literals, preserving byte offsets
 * and newlines so reported line numbers stay accurate.
 *
 * Load-bearing, not tidiness: this file's modules document their own spawn
 * behaviour in prose, so several doc comments contain the literal text
 * `spawn(`. Scanning raw source flags those and the test fails on its own
 * documentation — which is how a source-text check earns a reputation for
 * crying wolf and gets deleted.
 */
function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');

  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === quote) break;
        else j++;
      }
      const stop = Math.min(j + 1, src.length);
      out += quote + blank(src.slice(i + 1, stop));
      i = stop;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

/**
 * Extracts the balanced argument list of a call starting at `openParenIndex`,
 * so a nested object/array in the options never truncates the match the way a
 * non-greedy `.*?\)` regex would.
 */
function callArgs(source: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return source.slice(openParenIndex + 1, i);
    }
  }
  return source.slice(openParenIndex);
}

test('LIFE-01: every child-process launch in src/ sets windowsHide, so no console window can appear', () => {
  const offenders: string[] = [];

  for (const file of walk(SRC)) {
    const raw = readFileSync(file, 'utf8');
    const source = stripCommentsAndStrings(raw);
    for (const match of source.matchAll(LAUNCHERS)) {
      const openParen = match.index + match[0].length - 1;
      const args = callArgs(source, openParen);

      // A launcher that merely forwards a caller-supplied options object
      // (the injectable `spawnFn` seams) is the caller's responsibility --
      // the real call sites are asserted on their own below.
      if (/^\s*command\s*,\s*args\s*,\s*options\s*$/.test(args)) continue;

      if (!args.includes('windowsHide')) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${relative(SRC, file).replace(/\\/g, '/')}:${line}  ${match[0]}`);
      }
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `these child-process launches would pop a console window on Windows:\n  ${offenders.join('\n  ')}`,
  );
});

test('LIFE-01: any launch that goes through a shell -- the cmd.exe case -- also carries windowsHide', () => {
  // Called out separately from the blanket check because `shell: true` is the
  // severe case: a real cmd.exe window, not a transient conhost flash.
  //
  // Scoped to the ARGUMENTS of an actual launcher call, not to every `shell:`
  // in the file. A looser regex also matched `function buildArgs(envelope,
  // shell: boolean)` -- a parameter type annotation that launches nothing --
  // and failed on it. A check that reports things which are not the problem
  // gets muted, so precision here is what keeps it alive.
  const shellLaunches: string[] = [];

  for (const file of walk(SRC)) {
    const source = stripCommentsAndStrings(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(LAUNCHERS)) {
      const args = callArgs(source, match.index + match[0].length - 1);
      if (!/\bshell\b/.test(args)) continue;

      const line = source.slice(0, match.index).split('\n').length;
      const rel = relative(SRC, file).replace(/\\/g, '/');
      shellLaunches.push(rel);
      assert.ok(
        args.includes('windowsHide'),
        `${rel}:${line}: a shell-routed spawn without windowsHide opens a visible cmd.exe window`,
      );
    }
  }

  // Non-vacuity: if a refactor stops these parsing as shell launches, every
  // assertion above passes by examining nothing. Both known sites must be seen.
  // Files, not line numbers -- pinning lines makes this fail on any edit above
  // the call site, and a check that cries wolf gets deleted.
  assert.deepStrictEqual(
    [...new Set(shellLaunches)].sort(),
    ['daemon/active-polls.ts', 'daemon/self-dispatch.ts'],
    'expected exactly the two known shell-routed launches to be inspected',
  );
});
