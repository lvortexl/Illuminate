/**
 * The verdict label map -- the human-facing spelling of a `Verdict`.
 *
 * Lives in `shared/` because it now has three consumers across two runtime
 * boundaries: the in-artifact card renderer (`src/sdk/cards.ts`, DOM), the
 * static export appendix (`src/export/materialize-cards.ts`, Node) and the
 * chrome review rail (`src/chrome/rail.ts`, DOM).
 *
 * It was previously duplicated between the first two, with the stated
 * reason that importing it from `cards.ts` would drag a DOM-heavy
 * live-renderer module into a Node/CLI export path just to reuse three
 * strings. That reason was sound and is now moot: this module is DOM-free
 * and depends on nothing, so every consumer can import it directly and the
 * rail does not have to become a third copy.
 *
 * `verdict` is deliberately a bare `string`, not `Verdict` -- these labels
 * are rendered from untrusted wire data (`WireCardThreadEntry.verdict` is a
 * bare string by protocol-in.ts's own documented convention), so an unknown
 * value must render as itself rather than throw.
 */
const VERDICT_LABELS: Record<string, string> = {
  supported: 'Supported',
  contradicted: 'Contradicted',
  'not-determinable': 'Not determinable',
};

export function verdictLabel(verdict: string): string {
  return VERDICT_LABELS[verdict] ?? verdict;
}
