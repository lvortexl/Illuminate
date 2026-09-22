# illuminate

**Point at anything in an agent-generated HTML artifact and get a grounded explanation of the real code behind it — and be told when the artifact has gone stale.**

`illuminate` serves a local HTML artifact in your browser, lets you select any element and pick a typed action, and routes that action to an agent along with the *actual source* the element cites. Answers come back as cards that live in the page and survive reloads, regenerations, and daemon restarts.

It is an **AXI** — a plain CLI any agent harness can drive. Not an MCP server.

```sh
npx illuminate-axi ./architecture.html
```

---

## Contents

- [Quick start](#quick-start)
- [Why](#why)
- [Using it](#using-it) — [select and act](#select-and-act) · [what you can ask for](#what-you-can-ask-for)
- [Citing sources](#citing-sources) — [pinned anchors](#pinned-anchors) · [file lists](#file-lists) · [grounding tiers](#grounding-tiers)
- [Driving it from an agent](#driving-it-from-an-agent)
- [Commands](#commands)
- [How it works](#how-it-works)
- [Design properties](#design-properties)
- [Development](#development)
- [Requirements](#requirements)
- [Acknowledgements](#acknowledgements)
- [License](#license)

---

## Quick start

```sh
npx illuminate-axi ./architecture.html     # serve it, open it
```

That is the whole setup — no install, no config file, no daemon to manage. The command starts a local daemon for the artifact's directory, registers a session, and opens your browser. `Ctrl-C` is not how you stop it; use `illuminate stop <dir>`.

To install it properly:

```sh
npm install -g illuminate-axi
illuminate ./architecture.html
```

Both `illuminate` and `illum` are installed as commands.

## Why

An agent writes you a beautiful architecture document. Three months later it says `index.ts` holds the IPC handlers "at lines ~1030–1200". The file is 288 lines. Nothing errors; the document just quietly became fiction.

illuminate exists because **a confidently stale diagram is worse than no diagram**. Elements carry provenance anchors, so every explanation is grounded in real file content at a real revision — and when that content drifts, the artifact says so.

## Using it

### Select and act

- **Left-click** a section to **select** it. Click again to deselect; click empty space to clear the selection. Selected sections stay outlined.
- **Right-click** to **act** — this opens the composer where you pick an intent and optionally write a note.

Left-click deliberately does *not* open a menu. Reading an artifact should not be interrupted by a popup on every click, and freeing that gesture is what makes selection possible.

**Selecting several sections and right-clicking inside the selection sends them as one request**, so a single agent reasons across all of them together. Right-clicking *outside* the selection acts on that one section and leaves your selection alone.

Every citing section also gets a keyboard-reachable trigger button, in document order, so none of this requires a mouse.

### What you can ask for

- **Explain** — an answer grounded in the code the section cites
- **Go deeper** — a follow-up that knows what came before
- **Explain it in your own words** — write your own understanding, graded against the source
- **Verify** — an adversarial check returning `supported`, `contradicted`, or `not determinable`
- **Fix the artifact** / **fix the code** — the two write-shaped intents

Alongside these: a quiet **staleness** marker when cited source has moved or changed, and **export** to one self-contained file that opens with illuminate uninstalled.

## Citing sources

A section earns a grounded explanation by citing where it came from. There are two ways, and they make different claims.

### Pinned anchors

The strongest form: a specific region, at a specific revision, verified by content hash.

```html
<div data-src="src/main/ai/engine.ts#L120-L180"
     data-rev="4a769da"
     data-anchor-hash="9f2c1e...">
  The AI engine makes one model call per utterance.
</div>
```

- `data-src` — path, optionally with a line range
- `data-rev` — optional. Absent means resolve against `HEAD`, marked *unpinned*
- `data-anchor-hash` — content hash of the anchored region, normalised for line endings and trailing whitespace only

Only a pinned anchor can be checked for **drift**: the hash is what lets illuminate tell you the code moved or changed under the prose.

### File lists

When a section is about whole files rather than one region, list them:

```html
<p data-files="src/router/policy.ts, src/router/envelope.ts">
  Routing is a pure lookup table; the envelope is assembled after.
</p>
```

Each listed file becomes its own target with its own resolution status, so an answer can say which file it could not read. **No hash is needed** — requiring an author to stamp one per file is the ritual this form exists to avoid. Entries may carry their own `#Lx-Ly` range.

### Grounding tiers

| | cites | needs a hash | drift-checked |
|---|---|---|---|
| **pinned** | one region at one revision | yes | **yes** |
| **file-level** | a path, or a list of them | no | no |
| **unanchored** | nothing | — | — |

An unanchored section still works — it just cannot be grounded. A hash-less path is served from the working tree and says so on the wire, so a working-tree read is never mistaken for a revision-pinned one.

Run `illuminate playbook anchors` for authoring guidance.

## Driving it from an agent

illuminate never calls a model. Your harness does, and attaches once:

```sh
illuminate poll ./architecture.html --follow
```

This stays attached and prints **one JSON envelope per line** as each request is queued — review, verification and change requests alike. It is silent while idle, so no output means nothing is waiting, never that the connection dropped.

Run a **dedicated agent per envelope**, using the parameters the envelope already carries:

| field | meaning |
|---|---|
| `role` | one of tutor / verifier / researcher / author / implementer |
| `model_tier` | which tier to run that agent at |
| `tools` | the exact tool list it may use; `[]` means zero tools |
| `deadline_ms` | how long it may take |
| `targets[]` | every selected section, each with its own resolved source |

These come from illuminate's own routing policy. Re-deriving them from the artifact text is how a prompt injected into a page talks you into a more capable agent than the intent warranted.

Return each answer on stdin — the envelope names the exact command in `return_to`:

```sh
echo "..." | illuminate answer --dispatch <id> --port <port> --model <name> --tier <haiku|sonnet|opus> --stdin
```

Declare the model and tier you actually ran; the optional `--cost-usd`, `--input-tokens`, `--output-tokens`, `--cache-read-input-tokens` and `--wall-ms` flags are what `illuminate audit` sums.

Answers may come back in any order; a slow verification never blocks a fast explanation. Run `illuminate playbook attach` for the full contract.

If no harness is polling and a `claude` binary is on PATH, illuminate shells out to `claude -p` itself so the tool works standalone.

## Commands

```
illuminate <file.html> [--no-open]                Serve an artifact and open it
illuminate stop <dir|file.html> [--force]         Stop the daemon for a directory or artifact
illuminate poll <file.html> [--follow]            Wait for work; --follow stays attached
illuminate answer --dispatch <id> --port <port> \
                  --model <name> --tier <haiku|sonnet|opus> --stdin
                                                  Submit an answer via stdin
illuminate audit <file.html>                      Per-dispatch cost, tier deviations, refusals
illuminate export <file.html> [--out <path>] [--allow-remote]
                                                  Standalone copy; fails if a remote reference survives
illuminate design                                 Why illuminate is built this way
illuminate playbook [id]                          Focused guidance; lists ids with no argument
illuminate --version | --help
```

Guidance is progressively disclosed: `--help` → `design` → `playbook <id>`. An agent pays tokens only for what it needs.

## How it works

```
   your browser                          illuminate daemon              your agent
┌────────────────────┐                 ┌──────────────────┐         ┌──────────────┐
│  chrome shell      │ ── HTTP ──────► │  resolve anchor  │         │              │
│  ┌──────────────┐  │                 │  apply policy    │ ──────► │ illuminate   │
│  │ artifact     │  │                 │  emit envelope   │  poll   │ poll         │
│  │ (sandboxed,  │  │ ◄── postMessage │                  │         │              │
│  │  opaque      │  │                 │  ◄───────────────┼─────────┤ illuminate   │
│  │  origin)     │  │                 │   illuminate     │ answer  │ answer       │
│  └──────────────┘  │                 │   answer         │         │              │
└────────────────────┘                 └──────────────────┘         └──────────────┘
```

The artifact runs in a sandboxed iframe with **no `allow-same-origin`**, so it cannot reach the server at all — every call is made by the chrome shell after a `postMessage` carrying a load token. The served bytes differ from your file on disk by **exactly one script tag**.

**illuminate never calls a model API.** It resolves provenance, applies a policy table, and emits a fully-provisioned envelope; your harness does the dispatch.

## Design properties

These are enforced by tests, not convention:

- **Answers never enter the orchestrator's context.** The poll response carries envelopes and receipts, never answer prose — proven by ingesting 20 uniquely-marked answers and grepping the raw response bytes for all of them.
- **Model output can never select a role or tier.** The router is a pure lookup table keyed on typed browser intent. An adversarial `SYSTEM:` directive rides through the resolved content verbatim and cannot move either.
- **A verifier is never asked to judge what it cannot read.** When every cited source resolves to nothing, `verify` answers `not determinable` deterministically, at zero cost, with no model call — rather than letting a model confabulate `supported`.
- **Paths cannot escape the repository.** Both citation forms go through the same containment check, so the weaker tier can never accept a path the pinned one refuses.
- **No outbound requests, ever.** No CDN assets, in the served artifact or an exported one.
- **The artifact is never modified.** illuminate reads it; it never writes to it.
- **Detection is passive.** Nothing blocks the reader, edits the artifact, or wakes an agent uninvited.

## Development

```sh
npm install
npm run build          # bundle to dist/
npm run typecheck      # app + browser projects
npm run typecheck:e2e  # the Playwright project
npm test               # unit tests (node:test), needs a build first
npm run test:browser   # Playwright e2e against a real daemon and a real browser
npm run lint
npm run verify:skill   # fails if skills/illuminate/SKILL.md drifted from the CLI
```

`skills/illuminate/SKILL.md` is **generated** from `src/cli/registry.ts` by `npm run generate:skill`. Edit the registry, not the skill file — the build fails if the two disagree, which is what keeps the shipped guidance from going stale against the CLI.

The e2e suite drives a real daemon in a real browser, including the dispatch and answer round trip; it is the only place several invariants above are actually provable.

## Requirements

Node **≥ 22.18.0**. Two runtime dependencies: `parse5` (parse-only, for byte-exact injection) and `open` (lazy-imported only when actually launching a browser).

## Acknowledgements

illuminate's design owes a great deal to [`lavish-axi`](https://github.com/kunchenguid/lavish-axi) by Kun Chen — the serving loop, the long-poll contract, progressive disclosure, and the two-document sandbox model are all inherited from it, and its export subsystem is ported here directly. illuminate deliberately widens one thing lavish scopes out: multi-agent dispatch.

See [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) for what is borrowed and under what terms.

## License

MIT — see [`LICENSE`](./LICENSE).
