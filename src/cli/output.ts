/**
 * POLL-05's compact, ASCII-safe design language, established once here so
 * Phase 6's poll/dispatch/audit output (and everything else that prints)
 * inherits it. No new runtime dependency: STACK.md's measured -31%
 * character saving from @toon-format/toon is specific to large, uniform
 * arrays of objects -- this phase's own output (a handful of commands and
 * playbooks) is too small to meet that bar. Phase 6 is expected to adopt
 * it when it has a payload shaped like that; this module does not
 * speculatively add the dependency.
 */

import type { CommandEntry, PlaybookEntry } from './registry.ts';
import type { DispatchEnvelope, PollResponse } from '../router/types.ts';
import type { AuditSummary } from '../router/ingest.ts';
import type { ExportWarning } from '../export/types.ts';

const MAX_WIDTH = 100;

/** Sufficient, not just a proxy: mojibake is specifically the garbled
 * rendering of a non-ASCII byte sequence under a mismatched codepage.
 * Bytes 0x00-0x7E render identically under UTF-8, every Windows codepage
 * in real use (CP437, CP1252, ...), and Git Bash's terminal -- so proving
 * output is ASCII-only is a COMPLETE, not partial, automated proof against
 * "no mojibake in cmd.exe, PowerShell 5.1, PowerShell 7, Windows Terminal,
 * Git Bash." */
export function isAsciiOnly(text: string): boolean {
  return /^[\x00-\x7E]*$/.test(text);
}

export function wrapLine(text: string, maxWidth: number = MAX_WIDTH): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function renderHelp(commands: readonly CommandEntry[]): string {
  const lines = [
    'illuminate -- point at an element, get a grounded explanation',
    '',
    ...commands.map((c) => `  ${c.usage.padEnd(32)} ${c.summary}`),
    '',
    'Next: illuminate design (why) -> illuminate playbook <id> (how)',
  ];
  return lines.join('\n') + '\n';
}

export function renderDesign(): string {
  const lines = [
    'illuminate renders artifact-side UI into a shadow root, never into',
    'the artifact document -- opening the same file with illuminate off',
    'looks identical.',
    '',
    'Every action a human takes is a typed intent (explain, verify,',
    'deeper, fix-artifact, fix-code), chosen from a closed menu rather',
    'than inferred from prose -- this is what lets the router be a pure',
    'lookup table that model output can never steer. Free text the human',
    'writes rides as payload on that typed intent, and steers nothing.',
    '',
    'No CDN script, ever. One injected script tag, dependency-free.',
    '',
    'Next: illuminate playbook <id> for focused guidance.',
  ];
  return lines.join('\n') + '\n';
}

export function renderPlaybookIndex(playbooks: readonly PlaybookEntry[]): string {
  const lines = [
    'Available playbooks:',
    ...playbooks.map((p) => `  ${p.id.padEnd(12)} ${p.title}`),
    '',
    'Run: illuminate playbook <id>',
  ];
  return lines.join('\n') + '\n';
}

export function renderPlaybook(entry: PlaybookEntry): string {
  return [`${entry.title} (${entry.id})`, '', ...entry.body].join('\n') + '\n';
}

/** One short line per non-`dispatch` poll outcome -- POLL-01's "stays
 * silent until feedback arrives, the session ends, or the browser stays
 * disconnected past its grace period" contract, named plainly with no
 * further detail (there is nothing more to say about any of these three
 * states). `Record<...>` over the non-`dispatch` half of `PollResponse
 * ['status']` is this codebase's own established exhaustiveness idiom
 * (mirrors `router/policy.ts`'s `POLICY_TABLE`) -- adding a fourth status
 * to `PollResponse` without a matching entry here is a compile error, not
 * a silent fallthrough. */
const POLL_STATE_LINES: Record<Exclude<PollResponse['status'], 'dispatch'>, string> = {
  waiting: 'illuminate poll: no feedback yet -- still waiting',
  ended: 'illuminate poll: session ended',
  browser_disconnected: 'illuminate poll: browser disconnected past its grace period',
};

/** Collapses internal whitespace/newlines and truncates -- never lets a
 * multi-line element `text` or anchor path blow up a one-line summary. */
function truncateForSummary(text: string, maxLen: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen)}...` : collapsed;
}

/** The "first ~60 chars of task/anchor path" a poll line names: the
 * resolved anchor's own path+range when the dispatch was anchored,
 * otherwise the targeted element's own text (ANCH-08's unanchored case --
 * there is no anchor path to show, so the element's text is the closest
 * thing to "what this dispatch is about"). */
function describeDispatchSubject(envelope: DispatchEnvelope): string {
  if (envelope.source) {
    const range = envelope.source.range;
    const rangeSuffix = range ? `#L${String(range.startLine)}-L${String(range.endLine)}` : '';
    return truncateForSummary(`${envelope.source.path}${rangeSuffix}`, 60);
  }
  return truncateForSummary(envelope.element.text, 60);
}

/** Splits a human-written field into printable lines. Empty and absent are
 * the same thing here -- both mean 'nothing to print' -- so this returns an
 * empty array for each, and the caller's `for` loop simply does not run. */
function splitLines(value: string | null): readonly string[] {
  if (value === null || value.length === 0) return [];
  return value.split(/\r?\n/);
}
/**
 * POLL-05's compact rendering of a `GET /api/:key/poll` response --
 * `illuminate poll`'s ENTIRE stdout (src/cli.ts). `port` is this
 * function's own argument (the CLI's already-known daemon port from
 * `ensureDaemonRunning`), not read off any envelope field, so every
 * printed `illuminate answer` command is built fresh against the actual
 * daemon this poll just talked to and is genuinely copy-pasteable with no
 * further lookup.
 */
export function renderPollResult(response: PollResponse, port: number): string {
  if (response.status !== 'dispatch') {
    return `${POLL_STATE_LINES[response.status]}\n`;
  }
  const lines: string[] = [];
  for (const envelope of response.dispatches) {
    lines.push(
      `${envelope.dispatch_id}  ${envelope.role}/${envelope.model_tier}  ${envelope.intent}  ${describeDispatchSubject(envelope)}`,
    );
    // The human's own words. Without these lines the composer in the chrome
    // rail is invisible to whoever is polling: the agent would see
    // "explain  src/foo.ts:1-20" and none of what was actually asked, and
    // would answer the wrong question.
    //
    // Printed in FULL and never truncated -- a half-quoted instruction is
    // worse than none, and this is the one field whose whole value is its
    // exact wording. Indented continuation lines rather than JSON, so the
    // "never prints raw JSON to stdout" contract still holds and a newline
    // inside a note stays readable instead of becoming an escape sequence.
    for (const noteLine of splitLines(envelope.note)) lines.push(`  note: ${noteLine}`);
    // A distinct label because it carries a distinct instruction: this one
    // is to be GRADED against the resolved source, not answered.
    for (const noteLine of splitLines(envelope.learnerNote)) {
      lines.push(`  their explanation: ${noteLine}`);
    }
    // Absolute paths, because an agent's cwd is its own business and a
    // relative path here would be a guess about it.
    for (const attachment of envelope.attachments) {
      lines.push(`  image: ${attachment.path}`);
    }
    lines.push(`  -> illuminate answer --dispatch ${envelope.dispatch_id} --port ${String(port)} --stdin`);
  }
  return lines.join('\n') + '\n';
}

/**
 * `illuminate audit`'s entire stdout. Reads ONLY the named fields
 * `summarizeForAudit` (router/ingest.ts) documents -- never spreads or
 * passes the whole object through, so even if `AuditSummary` were ever
 * widened upstream to carry a prose field, this renderer would not
 * automatically start printing it (T-06-19's accepted-risk mitigation,
 * reinforced here).
 */
export function renderAuditResult(summary: AuditSummary): string {
  const lines: string[] = [
    `cost: $${summary.totalCostUsd.toFixed(4)}  tokens: ${String(summary.totalTokensIn)} in / ` +
      `${String(summary.totalTokensOut)} out  cache-read: ${String(summary.totalCacheReadInputTokens)}`,
  ];

  if (summary.deviations.length === 0) {
    lines.push('deviations: none');
  } else {
    lines.push(`deviations: ${String(summary.deviations.length)}`);
    for (const d of summary.deviations) {
      lines.push(`  ${d.dispatchId}  expected ${d.expectedTier}, reported ${d.reportedTier}`);
    }
  }

  if (summary.refusals.length === 0) {
    lines.push('refusals: none');
  } else {
    lines.push(`refusals: ${String(summary.refusals.length)}`);
    for (const r of summary.refusals) {
      lines.push(`  ${r.dispatchId}  ${r.reason}`);
    }
  }

  return lines.join('\n') + '\n';
}

export interface ExportRenderOptions {
  readonly outputPath: string;
  readonly byteLength: number;
  readonly warnings: readonly ExportWarning[];
  readonly baseHref: boolean;
  readonly authorCsp: boolean;
}

/**
 * `illuminate export`'s entire stdout (09-04). POLL-05 discipline: compact,
 * ASCII-safe, one line per warning KIND count (never one line per warning --
 * a heavily-referenced fixture could otherwise produce hundreds of lines),
 * matching the reference's own `unresolved_local_assets`/`notices` split at
 * a coarser, terminal-friendly grain. `baseHref`/`authorCsp` are booleans
 * the caller already computed via `detectBaseHref`/`detectAuthorCsp`
 * (src/html/detect.ts) against the POST-transform html -- this function
 * reuses illuminate's existing detectors, never re-derives a second one.
 */
export function renderExportResult(options: ExportRenderOptions): string {
  const lines: string[] = [`exported ${String(options.byteLength)} bytes -> ${options.outputPath}`];

  if (options.warnings.length === 0) {
    lines.push('warnings: none');
  } else {
    const counts = new Map<string, number>();
    for (const warning of options.warnings) {
      counts.set(warning.kind, (counts.get(warning.kind) ?? 0) + 1);
    }
    lines.push(`warnings: ${String(options.warnings.length)}`);
    for (const [kind, count] of counts) {
      lines.push(`  ${kind}: ${String(count)}`);
    }
  }

  if (options.baseHref) lines.push('notice: base-href present -- illuminate never rewrites or strips it');
  if (options.authorCsp) lines.push('notice: csp-meta present -- illuminate never rewrites or strips it');

  return lines.join('\n') + '\n';
}
