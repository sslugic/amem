# amem

**Personal agent memory that stays on your machine.**

Coding agents forget between sessions. They re-grep the same tree, re-learn the same constraints, and burn tokens rediscovering decisions you already paid for once.

**amem** gives Cursor, Claude Code, and other local hosts a private, searchable memory of durable facts about *your* repos — what owns what, which files matter, what broke last time — so the next session starts oriented instead of cold.

```bash
amem context "sync auth startup"
```

```markdown
# Agent Memory Context

## Best Claims
### claim.sync_auth_mode_startup
Kind: `constraint`
Why: `keyword+8`, `fts+18.0`, `embed+6.3`, `kind:constraint`, `fresh`

The sync service checks auth mode during startup before enabling Drive sync.
Anchors: `src/background/sync-service.ts`
```

Nothing is uploaded. Nothing is written into your product git history. Memory lives under `~/.amem/` on your laptop only.

---

## Why amem exists

| Without amem | With amem |
| --- | --- |
| Agent explores broadly every session | Agent queries memory first, then verifies the right files |
| Decisions live in chat scrollback | Decisions become structured claims with file anchors |
| Team sharing pressure on “AI context” docs | Explicitly **personal** — your prompts and learnings stay local |
| Flat `AGENTS.md` that goes stale | Small graph: components → flows → claims, updated via proposals |

amem is **not** shared company wikiware and **not** a cloud RAG product. It is a local tool for individual developers who want agents that remember *their* work.

---

## Privacy (non-negotiable)

| Piece | Location | Shared? |
| --- | --- | --- |
| The amem tool (this repo) | GitHub / npm | Yes — installable |
| Your memory database | `~/.amem/graph.db` (or `.enc` when locked) | **No** |
| Cursor project rule | `.cursor/rules/amem.mdc` in the product repo | Safe to commit — **guidance only**, no memory contents |
| Exports / backups you create | Wherever you write them | **Keep private** — do not commit |

Guarantees:

- `~/.amem` is created with mode `0700`
- Local UI binds to `127.0.0.1` only
- No telemetry, no managed sync, no “share with org” mode
- Agents are instructed to store **repo facts**, not proprietary prompting strategy
- Optional AES-256-GCM lock and encrypted local backups — still no cloud

---

## Requirements

- **Node.js 20+** (native `better-sqlite3`)
- **git** (repo identity uses remote URL / root path)

---

## Install the tool

```bash
npx @iamem/amem setup   # Node 20+ — installs the `amem` CLI
# or
npm i -g @iamem/amem && amem setup
```

From a clone while developing:

```bash
git clone https://github.com/sslugic/amem.git
cd amem
npm install
npm link
amem setup
```

See [docs/npm-release.md](docs/npm-release.md). CI runs `npm test` and `npm run pack:check`. `better-sqlite3` uses its own prebuilds — no extra native step on common macOS/Linux + Node 20/22.

If `npm install` fails compiling native code, install Xcode CLT (macOS) or `build-essential` (Linux) and retry, or use a Node 20/22 official binary that matches the prebuild matrix.

### Quick paths

```bash
# Cursor or Claude Code in a git repo
amem init --platform cursor    # or: claude

# Other hosts (thin installers, same local DB)
amem init --platform windsurf|continue|aider|zed

# Cross-repo “how I work” prefs (blended into project context)
amem init --personal
# or: amem setup --personal
```

### Encrypt-at-rest + local backups

```bash
amem lock --passphrase '…'       # or AMEM_PASSPHRASE
amem unlock --passphrase '…'
amem backup --passphrase '…'     # ~/.amem/backups by default
amem backup schedule             # daily local timer (no cloud)
amem backup unschedule
```

While locked, set `AMEM_PASSPHRASE` (or unlock) before any command that opens the DB.

### License SKU + local embeddings

Free includes the hashing embedder (no download). Pro/IT can switch to a **local n-gram model** or an **external local command** (stdin text → JSON vector). Still no cloud embed API.

```bash
amem license apply --file ~/Downloads/amem-license.json   # after checkout on getamem.com
amem embed use ngram
amem embed reindex
amem restore --file ~/.amem/backups/amem-….db.enc
amem hygiene
amem rules sync
amem it-pack --out ~/.amem/it-pack
amem doctor --attest                     # IT tier adds a vault/host SKU packet
```

See [docs/license.md](docs/license.md). Only vendor-signed license files unlock Pro/IT (verified offline). Nothing is uploaded.

Checkout + email delivery is a **separate** seller process (`npm run shop`) that is not published with the CLI. It can whitelist Mailtrap and Stripe names from another project’s `.env` — see [shop/README.md](shop/README.md).

---

## First-time setup (recommended)

```bash
amem ui
```

That opens `http://127.0.0.1:7843` on the **Setup** tab. It scans your home folder for git repos (skips `Library`, `node_modules`, `Downloads`, and similar noise). Check the ones you want, pick clients (Cursor, Claude Code, Windsurf, Continue, Aider, Zed, …), then **Start tracking selected**. Each pick is bound in `~/.amem` and gets the matching installer when available.

The header has a **Personal** switcher (cross-repo prefs) and **Lock / backup** chrome — lock status, last backup, and a daily local schedule. Memory shows the same lock/backup chips. The Setup tab includes a copyable **remember contract** for any MCP host (`amem recipe`).

Optional: check **Start amem ui when this computer logs in** so the localhost server comes back after a reboot:

```bash
amem service install    # macOS LaunchAgent, Linux systemd --user, or Windows Startup
amem service status
amem service uninstall
```

Tabs after setup:

1. **Setup** — scan/select repos, platforms, login auto-start, bootstrap proposal  
2. **Memory** — facts by file, scored drafts (approve / replace older / dismiss / reject noisy), edit/pin/delete, search, recent hits/misses  
3. **Stats** — estimated tokens saved per LLM, plus JSON / markdown / PDF export (proxies, not a bill)

Server-only (no browser open):

```bash
amem ui --port 7843 --no-open
```

To scan extra folders (or only a subset), set `AMEM_SCAN_ROOTS` to a colon-separated list of directories.

### CLI alternative (no UI)

```bash
cd ~/path/to/your-real-project
amem init --platform cursor    # or: --platform claude
amem doctor
amem status
```

To wire both agents to the same local memory, run `init` once per platform (or select both in the UI).

---

## Day-to-day loop

### 1. Query before exploring

```bash
amem context "billing webhook retry"
```

Or let the agent do it — Cursor gets an always-on project rule; Claude gets hook guidance. Both install the skills:

- `amem-bootstrap` — seed baseline memory  
- `amem-update-working-memory` — save durable learnings after a session  

Hooks also inject context on session start / prompt submit, store conversation notes, queue **session-end drafts**, and can queue **miss→learn** drafts after empty context lookups when the agent later cites real files. Approve drafts in **Memory** (or allow low-risk kinds via policy `auto_apply_kinds`).

### 2. Work as usual

Treat memory as a **map**, not source of truth. Read the anchored files before you change them. Prefer claims marked fresh; verify **stale** ones (anchored files changed after the claim).

### 3. Save what should survive

Ask the agent to run `amem-update-working-memory`, approve Memory drafts, or apply a proposal yourself:

```bash
amem propose validate /tmp/memory.json
amem propose diff /tmp/memory.json
amem propose apply /tmp/memory.json
```

### 4. Optional agent one-shot install

From inside the product repo, paste [docs/agent-install-prompt.md](docs/agent-install-prompt.md) into Cursor or Claude Code and let it run setup for you.

---

## What gets stored

Memory is a small local graph in SQLite:

| Object | Meaning |
| --- | --- |
| **Component** | A subsystem / module (`component.api`) |
| **Flow** | How work moves (`flow.checkout`) |
| **Claim** | A durable fact with file anchors (may be `active` or `superseded`; optional pin) |
| **Edge** | Links (claim → flow → component); `kind: "supersedes"` archives the target claim |
| **Draft** | Pending session / miss→learn proposals waiting for Memory approve |
| **Usage event** | Each `amem context` hit + token estimate |

Claims are the retrieval unit. Ranking combines:

- **SQLite FTS5** (Porter stemming) + keyword score  
- On-device **hashing embeddings** (no model download)  
- Pin boost, kind weights (`constraint` / `gotcha` > `session`), freshness  
- Optional **personal** prefs claims blended into project context  

Each injected claim includes a **Why:** line. Stale claims (anchors changed after `updated_at`) are down-ranked.

Example claim:

```json
{
  "id": "claim.webhook_idempotency",
  "kind": "constraint",
  "text": "Stripe webhooks must be idempotent on event.id before mutating invoices.",
  "code_anchors": ["src/webhooks/stripe.ts"],
  "supersedes": ["claim.webhook_old_rule"]
}
```

`supersedes` (or an edge with `kind: "supersedes"`) marks older claim ids as archived so they leave retrieval.

---

## Token savings (estimates)

Every `amem context` logs a usage event. The UI **Stats** tab breaks this down by platform (`cursor`, `claude`, …).

Automatic estimate:

```text
estimated_avoided = max(0, anchors×4000 + claims×200 − packet_tokens)
```

This is a **proxy** for exploration avoided — not your Cursor/Anthropic bill. Money uses the same token proxy at **$3 per 1M input tokens** (Sonnet-class input). Cursor included usage and output tokens are not billed this way, so treat `$` as an order-of-magnitude estimate.

Time saved is a separate proxy: each returned file anchor is treated as ~1.2s of tool round-trip the agent did not have to make. Local lookup duration is measured (SQLite on localhost). **Hit rate** is keyword matches on `amem context` — not Cursor/model API calls (those still happen). A **miss** means no stored fact matched the query; newest facts may still be injected as a weak fallback, and the agent still talks to the model.

Stats also shows a **monthly projection**: last 7 days of calls (or fewer if you just started), scaled to 30 days. Still a proxy, not a bill.

If you later know a better number:

```bash
amem usage report --platform cursor --saved 12000
# or attach to a specific event:
amem usage report --event-id usage_… --saved 12000
```

---

## LLM clients (beyond git repos)

amem can bind a **named workspace** that is not a git checkout — for Luna Client or any tool that talks to Cursor/Claude/other models.

```bash
amem init --workspace my-app
# seeds starter facts and runs a context check automatically
```

Attach any LLM client yourself (HTTP or MCP). Keep `amem ui` running for HTTP. From the client, **before** each model call:

```js
const res = await fetch("http://127.0.0.1:7843/api/context", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    workspace: "my-app",
    query: userMessage,
    platform: "app",
    sessionId,
  }),
});
const { markdown } = await res.json();
// prepend markdown to the prompt / tool result so the model skips a large retrieve
```

After a durable outcome:

```js
await fetch("http://127.0.0.1:7843/api/remember", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    workspace: "my-app",
    text: takeaway,
    kind: "session",
    anchors: ["my-app"],
  }),
});
```

MCP config (any MCP host):

Keep `amem ui` running (or `amem service install` so it starts at login). GUI apps often cannot find `amem` on `PATH`, which shows up as “live tool discovery failed” / MCP `error` — not a sign-in prompt. Prefer HTTP:

```json
{
  "mcpServers": {
    "amem": {
      "url": "http://127.0.0.1:7843/mcp?workspace=my-app"
    }
  }
}
```

Stdio also works if the host can spawn the binary. Print a config with absolute paths:

```bash
amem mcp --print-config --workspace my-app
```

Same localhost DB as git-repo memory. The UI switcher groups **Git repos** and **Workspaces**. Rename a workspace's display name anytime — the MCP slug (`workspace=luna-ai`) and stored claims stay on the same id.

```bash
amem rename "Luna Client" --workspace luna-ai
```

MCP tools (stdio or HTTP):

| Tool | When to use |
| --- | --- |
| `amem_context` | Ranked memory packet for the current question |
| `amem_remember` | Store a durable fact after an outcome |
| `amem_recipe` | Generic read-then-write contract (any MCP host) |
| `amem_repos` | What is monitored (git repos + named workspaces) |
| `amem_stats` | Lookup time, estimated tokens/ms saved, hit rate |
| `amem_graph` | Claims / components / flows stored for a workspace or repo |
| `amem_status` | Binding + counts; omit workspace for a machine-wide overview |

---

## Command reference

```text
amem setup [--personal] [--platform <host>]
amem init --platform cursor|claude|windsurf|continue|aider|zed
amem init --workspace <name> [--path <dir>] [--platform …]
amem init --personal
amem rename "<display name>" --workspace <slug>
amem status [--workspace <name>]
amem doctor [--attest] [--json]
amem context "<query>" [--workspace <name>] [--platform …]
amem remember "<text>" [--workspace <name>] [--kind …] [--anchor <path>]
amem recipe [--json]
amem mcp [--print-config] [--workspace <name>]
amem propose validate|diff|apply <file.json>
amem export [--out <file.json>]
amem wipe --yes
amem wipe --all --yes
amem lock|unlock --passphrase <secret>
amem backup [--out <dir>] [--passphrase <secret>] [--label <name>]
amem backup schedule [--out <dir>] [--hour <0-23>]
amem backup unschedule
amem session touch --platform cursor|claude [--session-id <id>]
amem hook
amem usage report --saved <n> [--platform …] [--event-id …]
amem usage export [--format json|md|pdf] [--days 30] [--scope current|all] [--out <file>]
amem license status|apply|activate|clear|issue|keys
amem embed status|use hash|use ngram|reindex
amem ui [--port 7843] [--no-open]
amem service install|uninstall|status
```

| Command | Purpose |
| --- | --- |
| `setup` | One-shot personal workspace + optional host install |
| `init` | Bind a git repo, named workspace, personal prefs, or host |
| `rename` | Change a workspace display name; MCP slug and memory stay bound |
| `context` | Retrieve a Markdown packet; log usage |
| `remember` | Store one local fact |
| `mcp` | Stdio MCP tools; HTTP MCP at `http://127.0.0.1:7843/mcp` while UI runs |
| `propose diff` | Preview claim/component/flow changes before apply |
| `propose apply` | Upsert structured memory locally |
| `lock` / `unlock` | Optional AES-256-GCM encrypt-at-rest for `graph.db` |
| `backup` | Local snapshot (optionally encrypted); `schedule` for daily timer |
| `ui` | Setup wizard + Memory + Stats on localhost |
| `service` | Login item so `amem ui` starts after reboot |
| `doctor --attest` | Privacy/policy attestation for IT tickets |
| `export` / `wipe` | Personal backup or delete (still local) |
| `wipe --all --yes` | Offboard: wipe every repo and remove `~/.amem` |

---

## What install puts where

### Cursor

| Artifact | Path |
| --- | --- |
| Skills | `~/.cursor/skills/amem-*` |
| Project rule | `.cursor/rules/amem.mdc` (in the product repo) |
| Hooks | `~/.cursor/hooks.json` |

Reload Cursor if skills/rules do not appear immediately.

### Claude Code

| Artifact | Path |
| --- | --- |
| Skills | `~/.claude/skills/amem-*` |
| Hooks | `~/.claude/settings.json` (`UserPromptSubmit` / `Stop` / related → full `amem hook`) |

### Other hosts

| Host | What amem writes |
| --- | --- |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` MCP entry |
| Continue | `~/.continue/config.json` MCP servers |
| Aider | `.aider.amem.md` CLI hints in the repo |
| Zed | `settings.json` `context_servers` / HTTP hint |

---

## Develop amem itself

```bash
cd amem
npm install
npm run build
npm run test          # unit + integration + CLI e2e (node:test)
npm run smoke         # end-to-end CLI/API smoke
npm run test:all      # both
npm link
```

Layout:

```text
src/           CLI, SQLite, policy, attest, installers, localhost API
ui-static/     Setup / Memory / Stats UI
skills/        Agent skill markdown
templates/     Cursor rule + example enterprise policy
docs/          Agent install prompt + IT endpoint runbook + backlog
test/          Comprehensive node:test suite
scripts/       Smoke tests + MDM offboard helper
```

Override the memory home for tests:

```bash
AMEM_HOME=/tmp/amem-test amem status
```

---

## Enterprise endpoint (IT-managed)

amem is still **personal memory on the laptop** — not a shared wiki or cloud RAG.  
IT / DevEx can govern the **fleet**: approved install, policy, attestation, offboarding.

| Control | Mechanism |
| --- | --- |
| Policy | `/etc/amem/policy.toml` (system) overrides `~/.amem/policy.toml`; or `AMEM_POLICY_PATH` |
| Attestation | `amem doctor --attest` / `--json` (also `GET /api/attest` on local UI) |
| Secret hygiene | Builtin deny patterns + policy `deny_claim_patterns` on propose |
| Export lock | `allow_export = false` |
| Platform / repo allowlists | `allowed_platforms`, `allowed_remote_hosts` |
| Auto-apply drafts | `auto_apply_kinds` (empty = never; still local) |
| Offboarding | `amem wipe --all --yes` or [scripts/mdm-offboard.sh](scripts/mdm-offboard.sh) |

Hard guarantees (not configurable away):

- No telemetry  
- UI binds to loopback only (`127.0.0.1`)  
- Memory stays under `~/.amem` (mode `0700`)  

### IT quick start

```bash
# 1) Pin / install amem on the endpoint (internal npm, pkg, or npm link)
# 2) Deploy policy (root-owned on managed machines)
sudo mkdir -p /etc/amem
sudo cp templates/policy.example.toml /etc/amem/policy.toml

# 3) Verify for security review
amem doctor --attest --json

# 4) On offboard / laptop return
amem wipe --all --yes
# or: scripts/mdm-offboard.sh
```

Example policy: [templates/policy.example.toml](templates/policy.example.toml)  
Full IT runbook: [docs/enterprise-endpoint.md](docs/enterprise-endpoint.md)

Suggested rollout: small DevEx pilot → MDM package + policy → signed builds/SBOM if procurement asks. Shared org memory is intentionally out of scope.

---

## Non-goals

- Company-shared or synced memory  
- Cloud hosted “team brain”  
- Exact provider billing integration  
- Cloud/remote embedding APIs (local FTS5 + on-device hashing embeddings only)  
- Writing memory contents into product git history  

Upcoming ideas (not scheduled): see [docs/backlog.md](docs/backlog.md).

---

## License

MIT — see [LICENSE](LICENSE).
