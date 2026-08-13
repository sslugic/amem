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
amem status       # sanity check from any directory
```

---

## First-time setup (recommended)

Pick a **product repository** you actually work in — not the amem tool repo unless you are testing amem on itself.

```bash
cd ~/path/to/your-real-project
amem ui
```

That opens `http://127.0.0.1:7843` with three tabs:

1. **Setup** — choose Cursor and/or Claude Code, install skills/hooks/rules, apply a bootstrap proposal into local memory  
2. **Brain** — interactive map of components, flows, and claims; highlights what recent context queries used  
3. **Stats** — estimated tokens saved per LLM (clearly labeled as estimates)

Server-only (no browser open):

```bash
amem ui --port 7843 --no-open
```

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
| **Claim** | A durable fact with file anchors |
| **Edge** | Links (claim → flow → component) |
| **Usage event** | Each `amem context` hit + token estimate |

Claims are the retrieval unit. Keyword search ranks claims, then pulls related flows and components into a short Markdown packet.

Example claim:

```json
{
  "id": "claim.webhook_idempotency",
  "kind": "constraint",
  "text": "Stripe webhooks must be idempotent on event.id before mutating invoices.",
  "code_anchors": ["src/webhooks/stripe.ts"]
}
```

---

## Token savings (estimates)

Every `amem context` logs a usage event. The UI **Stats** tab breaks this down by platform (`cursor`, `claude`, …).

Automatic estimate:

```text
estimated_avoided = max(0, anchors×4000 + claims×200 − packet_tokens)
```

This is a **proxy** for exploration avoided — not your Cursor/Anthropic bill.

If you later know a better number:

```bash
amem usage report --platform cursor --saved 12000
# or attach to a specific event:
amem usage report --event-id usage_… --saved 12000
```

---

## Command reference

```text
amem init --platform cursor|claude
amem status
amem doctor [--attest] [--json]
amem context "<query>" [--platform cursor|claude]
amem propose validate <file.json>
amem propose apply <file.json>
amem export [--out <file.json>]
amem wipe --yes
amem wipe --all --yes
amem session touch --platform cursor|claude [--session-id <id>]
amem usage report --saved <n> [--platform …] [--event-id …]
amem ui [--port 7843] [--no-open]
```

| Command | Purpose |
| --- | --- |
| `init` | Bind this git repo to local DB; install agent glue |
| `context` | Retrieve a Markdown packet; log usage |
| `propose apply` | Upsert structured memory locally |
| `ui` | Setup wizard + brain + stats on localhost |
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
npm run smoke
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
- Embedding / hybrid search (v1 is keyword ranking)  
- Writing memory contents into product git history  

---

## License

MIT — see [LICENSE](LICENSE).
