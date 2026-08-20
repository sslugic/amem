# amem backlog (next)

Updated after completing the Feature Map **Next** phase (draft quality, conflict UI, savings export, richer Continue/Zed adapters).

## Shipped recently

- FTS retrieval, claim staleness, supersede/conflict
- Session-end **draft capture** + Brain approve/dismiss
- Brain **edit / delete / pin / search**
- Login service on **macOS + Linux + Windows**
- **Miss → learn** drafts after empty context lookups
- **Claim-kind ranking** + **Why:** explainability in context packets
- **`amem propose diff`** before apply
- Claude Code hooks call full `amem hook` pipeline
- **`amem setup`** / npx-ready package metadata
- Thin installers: **Windsurf, Continue, Aider, Zed**
- Cross-repo **personal** prefs workspace (`amem init --personal`)
- Optional **AES-256-GCM lock/unlock** + encrypted **backup** / schedule
- On-device **hashing embeddings** hybrid with FTS
- Smarter multi-turn draft compaction + **`auto_apply_kinds`** policy
- **CI + pack:check** for `npx amem setup` (release workflow on `v*` tags; see `docs/npm-release.md`)
- **Remember contract** — `amem recipe`, `GET /api/recipe`, MCP `amem_recipe`, Setup copy card
- **Brain / header chrome** — lock indicator, backup status + schedule, **Personal** switcher
- **Draft quality scoring** — confidence 0–100; reject noisy session-end drafts; Brain “Reject noisy”
- **Conflict UI** — structured supersede suggestions; apply requires `resolve=supersede|keep` when facts overlap
- **Savings export** — `amem usage export` / Stats JSON · markdown · PDF (proxy, not a bill)
- **Richer host adapters** — Continue `mcpServers/amem.yaml`, Zed HTTP `url`, doctor health for continue/zed/windsurf

## Later

- Optional on-device embedding model (still local) if hashing hybrid plateaus.
- Signed license + attest SKU (Pro / IT). Do not add cloud sync.

## Explicit non-goals (keep)

- Cloud/team sync, shared org brain, hosted RAG
- Exact Cursor/Anthropic billing integration
- Writing memory into product git history
