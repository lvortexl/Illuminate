# Third-Party Notices

illuminate ports source code from one third-party project into its export
subsystem (`src/export/`). Each component listed below remains under its own
original license; this file exists to satisfy that license's attribution
requirement. It is re-audited whenever the borrowed footprint changes (see
"Publication Gate" below), and an automated test
(`test/export/third-party-notices.test.ts`) keeps the file-level map current
between audits.

## `lavish-axi` (export subsystem)

- **Component:** `lavish-axi`
- **Version:** `0.1.67` (pinned to the build cached locally at the time of
  porting: `~/AppData/Local/npm-cache/_npx/1be68cb99ce3a4fa/node_modules/lavish-axi`)
- **Source:** `export-bundle.js`, reachable inside the published package's
  bundled build at `dist/cli.mjs` lines 877-4177 (module boundary comment
  `// src/export-bundle.js`; the next module's own boundary comment,
  `// src/html-app.js`, opens at line 4177, so the borrowed module's content
  itself runs 877-4176). This range was checked directly against the cached
  `dist/cli.mjs` and contains no OTHER `// src/<file>.js` module boundary
  comment -- `export-bundle.js` has no transitive dependency of its own on
  any other part of the lavish-axi bundle, so there is exactly one upstream
  license to track, not a chain of them.
- **Upstream project:** https://github.com/kunchenguid/lavish-axi (per that
  package's own `package.json` `repository`/`homepage` fields)
- **License:** MIT
- **Copyright:** Copyright (c) 2026 Kun Chen

### Full upstream license text (verbatim, as required by the MIT license's own terms)

```
MIT License

Copyright (c) 2026 Kun Chen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### File-level map -- what illuminate borrowed and where it landed

Every file below opens with a header comment starting `Ported from
lavish-axi's export-bundle.js (MIT License, Copyright (c) 2026 Kun Chen).` --
that exact phrase is this repository's own attribution marker, checked by
`test/export/third-party-notices.test.ts` against every file under
`src/export/`, not just the four listed here.

| File | What it covers |
|------|-----------------|
| `src/export/types.ts` | The shared export warning-kind taxonomy (ported from the reference's `UNRESOLVED_LOCAL_ASSET_WARNING_KINDS` constant) and the per-export context (`ctx`) shape. |
| `src/export/tokenize.ts` | The raw-text-aware HTML tokenizer: constants, namespace/stack bookkeeping, the tokenizer core, attribute reading/rewriting, and start-tag serialization primitives. |
| `src/export/refs.ts` | Document-base / reference resolution, budgeted local reads, and data-URI encoding. The reference's own file-read confinement helper is **not** part of this port -- every local read here is instead gated exactly once, downstream, by illuminate's own `resolveAssetPath` (`src/serve/containment.ts`). The reference's pure `isOutside(root, target)` helper itself *is* ported (for API parity with the upstream module), but it is dead with respect to security: no local file read in this file is gated by it, as the file's own header comment states explicitly. |
| `src/export/inline-html.ts` | The assembled inlining/scrubbing transform: the CSS-token-level scanner, the JS-token-level import scanner, transform orchestration, and the full inline/scrub/warn surface for links, scripts, styles, SVG, srcset, media, frames, and module-script/import-map content. The single largest borrowed chunk of the export subsystem. |

### Deliberately excluded

The following were present in the reference's `export-bundle.js` but were
deliberately **not** ported:

- **`resolveDesignAssetPath` / Lavish's design-asset-CDN resolution** -- illuminate never resolves assets against an external design-asset CDN; every asset it exports is read from the local artifact root only.
- **The `share` / publish-to-web command** -- illuminate has no publish-to-a-hosted-service feature; export always produces a local, standalone file.
- **`analyzeSelfPaint`** -- no illuminate equivalent; this was a Lavish-specific self-paint diagnostic with no counterpart in illuminate's own review/education flow.
- **`warnBaseHref` / `warnCspMeta`** -- illuminate already has `detectBaseHref` / `detectAuthorCsp` (`src/html/detect.ts`, built earlier for the live injection path) and reuses those directly against this transform's output instead of porting a second, narrower pair of the same idea.
- **`isInjectedLavishSdkSrc`** -- has no illuminate equivalent. The reference checks this because its own export command can run against an already-served, already-SDK-injected copy of a page. illuminate's `export` command always reads the artifact's raw bytes directly off disk, so no injected script tag can ever appear in this function's input.

### Original to illuminate

The following are **not** borrowed from `lavish-axi` and carry no attribution
obligation, despite living alongside the ported files in `src/export/`:

- **`src/export/materialize-cards.ts`** -- the static card appendix. No `lavish-axi` equivalent exists; annotations/cards are a Phase 7 (Education Mode) concept the reference never had. Its own header comment states this explicitly and does not carry the porting marker above.
- **The `'remote-reference'` warning kind** (`src/export/inline-html.ts`'s `findRemoteReferenceWarnings`) -- illuminate's own stricter no-outbound-requests posture. The reference silently accepts a surviving `http(s)://` reference in exported output; illuminate flags it instead. No reference equivalent exists for this function.

## Publication Gate

This file must be re-audited -- the component list, the pinned version, and
the file-map above re-verified against the actual current `src/export/`
tree -- before any future `git push` to a public remote or any `npm
publish`. `test/export/third-party-notices.test.ts` enforces the file-map
half of that automatically on every `npm test` run: it walks `src/export/`
for the attribution marker and fails the build if a file carries the marker
without being listed here, or is listed here without carrying the marker.
A version bump of the borrowed upstream source itself (a new `lavish-axi`
release with different `export-bundle.js` content) is **not**
machine-detectable by that test and needs a human re-check before
publication.

## License compatibility

illuminate's own `package.json` declares `"license": "MIT"`. MIT-licensed
code embedding MIT-licensed borrowed code carries no compatibility
conflict -- both permit exactly this, provided this notice (and the LICENSE
file at the repository root) travel with any distribution, including the
published npm package (see `package.json`'s `files` array).
