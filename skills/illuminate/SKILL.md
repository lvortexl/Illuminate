---
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

- `npx -y illuminate-axi --help` -- commands
- `npx -y illuminate-axi design` -- why it is built this way
- `npx -y illuminate-axi playbook <id>` -- focused guidance (ids: anchors, intents, stop, dispatches, attach)

You do not need illuminate-axi installed globally -- invoke it with `npx -y illuminate-axi <file.html>`.
