# illuminate

**Point at anything in an agent-generated HTML artifact and get a grounded explanation of the real code behind it — and be told when the artifact has gone stale.**

`illuminate` serves a local HTML artifact in your browser, lets you click any element and pick a typed action, and routes that action to an agent along with the *actual source* the element cites. Answers come back as cards that live in the page and survive reloads, regenerations, and daemon restarts.

It is an **AXI** — a plain CLI any agent harness can drive. Not an MCP server.

```sh
npx illuminate-axi ./architecture.html
```

---

## Why

An agent writes you a beautiful architecture document. Three months later it says `index.ts` holds the IPC handlers "at lines ~1030–1200". The file is 288 lines. Nothing errors; the document just quietly became fiction.

illuminate exists because **a confidently stale diagram is worse than no diagram**. Elements carry provenance anchors, so every explanation is grounded in real file content at a real revision — and when that content drifts, the artifact says so.

## What it does

- **Explain** — click an element, get an answer grounded in the code it cites
- **Go deeper** — chain a follow-up that knows what came before
- **Explain it in your own words** — write your own understanding, graded against the anchored source
- **Verify** — an adversarial check returning `supported`, `contradicted`, or `not determinable from this anchor`
- **Staleness** — a quiet marker when cited source has moved or changed
- **Export** — one self-contained file that opens with illuminate uninstalled

## Commands

```
illuminate <file.html> [--no-open]              Serve an artifact and open it
illuminate stop <dir> [--force]                 Stop the daemon serving <dir>
illuminate poll <file.html>                     Long-poll for the next dispatch
illuminate answer --dispatch <id> --port <port> Submit an answer via stdin
illuminate audit <file.html>                    Per-dispatch cost, tier deviations, refusals
illuminate export <file.html> [--out <path>]    Standalone copy, local assets inlined
illuminate design                               Why illuminate is built this way
illuminate playbook [id]                        Focused guidance; lists ids with no argument
```

Guidance is progressively disclosed: `--help` → `design` → `playbook <id>`. An agent pays tokens only for what it needs.

## Anchors

An element earns a grounded explanation by citing its source:

```html
<div data-src="src/main/ai/engine.ts#L120-L180"
     data-rev="4a769da"
     data-anchor-hash="9f2c1e...">
  The AI engine makes one model call per utterance.
</div>
```

- `data-src` — path, optionally with a line range
- `data-rev` — optional. Absent means resolve against `HEAD`, marked *unpinned* and ineligible for staleness
- `data-anchor-hash` — required. Content hash of the anchored region, normalised for line endings and trailing whitespace only

Unanchored elements still work; they just can't be grounded or checked for drift. Run `illuminate playbook anchors` for authoring guidance.

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

**illuminate never calls a model API.** It resolves provenance, applies a policy table, and emits a fully-provisioned envelope; your harness does the dispatch. A `claude -p` adapter ships for standalone use when no harness is polling.

## Design properties

These are enforced by tests, not convention:

- **Answers never enter the orchestrator's context.** The poll response carries envelopes and receipts, never answer prose — proven by ingesting 20 uniquely-marked answers and grepping the raw response bytes for all of them.
- **Model output can never select a role or tier.** The router is a pure lookup table keyed on typed browser intent. An adversarial `SYSTEM:` directive rides through the resolved content verbatim and cannot move either.
- **No outbound requests, ever.** No CDN assets, in the served artifact or an exported one.
- **The artifact is never modified.** illuminate reads it; it never writes to it.
- **Detection is passive.** Nothing blocks the reader, edits the artifact, or wakes an agent uninvited.

## Requirements

Node **≥ 22.18.0**. Two runtime dependencies: `parse5` (parse-only, for byte-exact injection) and `open` (lazy-imported only when actually launching a browser).

## Acknowledgements

illuminate's design owes a great deal to [`lavish-axi`](https://github.com/kunchenguid/lavish-axi) by Kun Chen — the serving loop, the long-poll contract, progressive disclosure, and the two-document sandbox model are all inherited from it, and its export subsystem is ported here directly. illuminate deliberately widens one thing lavish scopes out: multi-agent dispatch.

See [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) for what is borrowed and under what terms.

## License

MIT — see [`LICENSE`](./LICENSE).
