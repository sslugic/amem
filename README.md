# amem

**Personal agent memory that stays on your machine.**

Coding agents forget between sessions. They re-grep the same tree, re-learn the same constraints, and burn tokens rediscovering decisions you already paid for once.

**amem** gives Cursor and Claude Code a private, searchable memory of durable facts about *your* repos — what owns what, which files matter, what broke last time — so the next session starts oriented instead of cold.

```bash
amem context "sync auth startup"
```

```markdown
# Agent Memory Context

## Best Claims
### claim.sync_auth_mode_startup
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
| Your memory database | `~/.amem/graph.db` | **No** |
| Cursor project rule | `.cursor/rules/amem.mdc` in the product repo | Safe to commit — **guidance only**, no memory contents |
| Exports you create | Wherever you write them | **Keep private** — do not commit |

Guarantees:

- `~/.amem` is created with mode `0700`
- Local UI binds to `127.0.0.1` only
- No telemetry, no managed sync, no “share with org” mode
- Agents are instructed to store **repo facts**, not proprietary prompting strategy

---

## Requirements

- **Node.js 20+**
- **git** (repo identity uses remote URL / root path)

---

## Install the tool

```bash
git clone <this-repo-url> amem
cd amem
npm install
npm link          # puts `amem` on your PATH
amem setup        # personal prefs workspace + next steps
amem status       # sanity check from any directory
```

Once published to npm: `npx amem setup` or `npm i -g amem` (Node 20+; builds native `better-sqlite3`).

Other hosts (thin installers on the same local DB):

```bash
amem init --platform windsurf|continue|aider|zed
amem init --personal   # cross-repo “how I work” prefs
```

Optional encrypt-at-rest and local backups:

```bash
amem lock --passphrase '…'     # or AMEM_PASSPHRASE
amem unlock --passphrase '…'
amem backup --passphrase '…'   # ~/.amem/backups by default
amem backup schedule           # daily local timer (no cloud)
```

---

## First-time setup (recommended)

```bash
amem ui
```

That opens `http://127.0.0.1:7843` on the **Setup** tab. It scans your home folder for git repos (skips `Library`, `node_modules`, `Downloads`, and similar noise). Check the ones you want, pick Cursor and/or Claude Code, then **Start tracking selected**. Each pick is bound in `~/.amem` and gets agent install (skills, hooks, rules).

Optional: check **Start amem ui when this computer logs in** so the localhost server comes back after a reboot (macOS LaunchAgent). Same thing from the CLI:

```bash
amem service install    # start on login (macOS LaunchAgent, Linux systemd --user, or Windows Startup)
amem service status
amem service uninstall
```

Tabs after setup:

1. **Setup** — scan/select repos, platforms, login auto-start, bootstrap proposal  
2. **Brain** — facts by file, pending session drafts (approve/dismiss), edit/pin/delete, search, recent hits/misses  
3. **Stats** — estimated tokens saved per LLM (clearly labeled as estimates)

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

### 2. Work as usual

Treat memory as a **map**, not source of truth. Read the anchored files before you change them.

### 3. Save what should survive

Ask the agent to run `amem-update-working-memory`, or apply a proposal yourself:

```bash
amem propose validate /tmp/memory.json
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
| **Claim** | A durable fact with file anchors (may be `active` or `superseded`) |
| **Edge** | Links (claim → flow → component); `kind: "supersedes"` archives the target claim |
| **Usage event** | Each `amem context` hit + token estimate |

Claims are the retrieval unit. Search uses **SQLite FTS5** (Porter stemming) plus keyword ranking, then pulls related flows and components into a short Markdown packet. Claims whose anchors changed on disk after `updated_at` are marked **stale** and down-ranked. Higher-priority kinds (`constraint`, `gotcha`, …) win ties, and each claim includes a **Why:** line explaining the rank. After a context miss, amem can queue a **miss→learn** draft when the agent later cites real files — approve it in Brain.


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

This is a **proxy** for exploration avoided — not your Cursor/Anthropic bill.

Time saved is a separate proxy: each returned file anchor is treated as ~1.2s of tool round-trip the agent did not have to make. Local lookup duration is measured (SQLite on localhost). A **server trip** in the brain map is a miss: amem had nothing useful, so the agent had to explore.

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

MCP tools (stdio or HTTP) — any connected client can ask these:

| Tool | When to use |
| --- | --- |
| `amem_context` | Ranked memory packet for the current question |
| `amem_remember` | Store a durable fact after an outcome |
| `amem_repos` | What is monitored (git repos + named workspaces) |
| `amem_stats` | Lookup time, estimated tokens/ms saved, hit rate |
| `amem_graph` | Claims / components / flows stored for a workspace or repo |
| `amem_status` | Binding + counts; omit workspace for a machine-wide overview |

---

## Command reference

```text
amem init --platform cursor|claude
amem init --workspace <name> [--path <dir>] [--platform app]
amem rename "<display name>" --workspace <slug>
amem status [--workspace <name>]
amem doctor [--attest] [--json]
amem context "<query>" [--workspace <name>] [--platform …]
amem remember "<text>" [--workspace <name>]
amem mcp [--print-config] [--workspace <name>]
amem propose validate <file.json>
amem propose diff <file.json>
amem propose apply <file.json>
amem export [--out <file.json>]
amem wipe --yes
amem wipe --all --yes
amem session touch --platform cursor|claude [--session-id <id>]
amem usage report --saved <n> [--platform …] [--event-id …]
amem ui [--port 7843] [--no-open]
amem service install|uninstall|status
```

| Command | Purpose |
| --- | --- |
| `init` | Bind a git repo or a named app workspace |
| `rename` | Change a workspace display name; MCP slug and memory stay bound |
| `context` | Retrieve a Markdown packet; log usage |
| `remember` | Store one local fact |
| `mcp` | Stdio MCP tools; HTTP MCP is at `http://127.0.0.1:7843/mcp` while the UI is running |
| `propose apply` | Upsert structured memory locally |
| `ui` | Setup wizard + brain + stats on localhost |
| `service` | Install a login item so `amem ui` starts after reboot (macOS / Linux / Windows) |
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
| Hooks | `~/.claude/settings.json` (`UserPromptSubmit` / `Stop`) |

---

## Develop amem itself

```bash
cd amem
npm install
npm run build
npm run test          # unit + integration (node:test)
npm run smoke         # end-to-end CLI/API smoke
npm run test:all      # both
npm link
```

Layout:

```text
src/           CLI, SQLite, policy, attest, installers, localhost API
ui-static/     Setup / Brain / Stats UI
skills/        Agent skill markdown
templates/     Cursor rule + example enterprise policy
docs/          Agent install prompt + IT endpoint runbook
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
- Cloud/remote embedding APIs (local FTS5 is in; optional local embeddings may come later)  
- Writing memory contents into product git history  

Upcoming ideas (not scheduled): see [docs/backlog.md](docs/backlog.md).

---

## License

MIT — see [LICENSE](LICENSE).
