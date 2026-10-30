# amem

[![npm version](https://img.shields.io/npm/v/@iamem/amem?color=2ec4b6&label=npm)](https://www.npmjs.com/package/@iamem/amem)
[![npm downloads](https://img.shields.io/npm/dm/@iamem/amem?color=2ec4b6)](https://www.npmjs.com/package/@iamem/amem)
[![CI](https://github.com/sslugic/amem/actions/workflows/ci.yml/badge.svg)](https://github.com/sslugic/amem/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-%3E%3D20-339933)](https://nodejs.org)
[![MCP server](https://img.shields.io/badge/MCP-server-7eb8ff)](https://modelcontextprotocol.io)
[![Local only](https://img.shields.io/badge/data-stays%20on%20your%20machine-2ec4b6)](#privacy-non-negotiable)

[![amem MCP server](https://mcprush.com/badge/sslugic-amem-mcp/card.svg)](https://mcprush.com/to/sslugic-amem-mcp?ref=badge) [![amem on Glama](https://glama.ai/mcp/servers/sslugic/amem/badges/score.svg)](https://glama.ai/mcp/servers/sslugic/amem)

**Personal agent memory that stays on your machine.** Works with Claude Code, Cursor, Claude Desktop, Copilot, Codex, Gemini CLI, Windsurf, Continue, Aider and Zed, on macOS, Linux and Windows.

```bash
npx @iamem/amem setup --platform claude   # or cursor, codex, copilot …
```

![amem dashboard: Home, Memory and Tasks](https://raw.githubusercontent.com/sslugic/amem/main/docs/media/amem-demo.gif)

[Website](https://getamem.com) · [Features](https://getamem.com/features) · [Why amem](https://getamem.com/why) · [How it works](https://getamem.com/what)
Coding agents forget between sessions. They re-read the same files, re-learn the same constraints and spend tokens rediscovering decisions you already made.

**amem** gives them a private memory that lives on your machine. The next session starts with what the last one learned.

## What you get

- **Memory:** short facts (constraints, gotchas, decisions, owners) tied to the files they describe. Facts are flagged stale when those files change.
- **Context on autopilot:** hooks hand your agent a small, ranked packet at session start and with each prompt. No pasting a project brief.
- **Skills:** repeatable procedures (release steps, deploy order, test setup), loaded only when they apply.
- **Tasks:** a Backlog → Next → Doing → Done board your agents update, so follow-ups survive the chat.
- **A dashboard:** `amem ui` shows what your agents remember, what needs review and open tasks. Retire or delete a fact in one click.
- **Private by design:** one SQLite file in `~/.amem`, a localhost-only UI, optional encryption and local backups.

Works with Claude Code, Cursor, Claude Desktop, Copilot, Codex, Gemini CLI, Windsurf, Continue, Aider, Zed and any other MCP client.

## Quick start

```bash
cd ~/code/your-project
npx @iamem/amem setup --platform claude   # or: cursor, codex, copilot, windsurf … (amem platforms)
amem ui                                   # open the dashboard at http://127.0.0.1:7843
```

Setup installs the `amem` CLI, adds the hooks, registers the amem MCP server (restart your client once) and seeds the repo with build, test and CI facts from its manifests, so the first question already has an answer. From then on your agent checks memory before exploring and saves what it learns. You can also do it by hand:

```bash
amem remember "Stripe webhooks must be verified with the raw body" --kind gotcha --anchor src/webhooks/stripe.ts
amem context "stripe webhook signature"
```

```markdown
### claim.remember_2f41c0c9e1ff
Kind: `gotcha`
Why: `keyword+12`, `fts+4.2`, `embed+5.4`, `kind:gotcha`, `fresh`

Stripe webhooks must be verified with the raw body.
Anchors: `src/webhooks/stripe.ts`
```

Any MCP client can use the same memory: `amem mcp --print-config` prints a ready-to-paste config.

## Privacy (non-negotiable)

- Memory never leaves your machine: no sync, no cloud embeddings, no "share with org" mode.
- The UI and HTTP MCP endpoint bind to `127.0.0.1` only, and `~/.amem` is created with mode `0700`.
- Credentials and tokens are blocked from being saved. Personal notes stay out of work projects unless you ask about them.
- Optional AES-256-GCM lock (`amem lock`) and encrypted local backups (`amem backup schedule`).
- The only network call is an optional anonymous install ping; turn it off with `AMEM_TELEMETRY_DISABLED=1`.

## Learn more

- [Full guide](docs/guide.md): setup, the day-to-day loop, what gets stored, skills, savings, other clients, every command
- [Security & architecture FAQ](docs/guide.md#security--architecture-faq)
- [IT-managed installs](docs/enterprise-endpoint.md)
- [Website](https://getamem.com) · [Issues and ideas](https://github.com/sslugic/amem/issues)

## License

MIT, see [LICENSE](LICENSE).
