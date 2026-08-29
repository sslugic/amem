# amem backlog (next)

Updated after completing the Feature Map **Later** phase (local embedding model + license/attest SKU).

## Shipped recently

- **Agent Tasks Kanban** — per-project board + MCP `amem_task_*` + open tasks in context packets (complement to Memory facts)
- FTS retrieval, claim staleness, supersede/conflict
- Session-end **draft capture** + Memory approve/dismiss
- Memory **edit / delete / pin / search**
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
- **CI + pack:check** for `npx @iamem/amem setup` (release workflow on `v*` tags; see `docs/npm-release.md`)
- **Remember contract** — `amem recipe`, `GET /api/recipe`, MCP `amem_recipe`, Setup copy card
- **Memory / header chrome** — lock indicator, backup status + schedule, **Personal** switcher
- **Draft quality scoring** — confidence 0–100; reject noisy session-end drafts; Memory “Reject noisy”
- **Conflict UI** — structured supersede suggestions; apply requires `resolve=supersede|keep` when facts overlap
- **Savings export** — `amem usage export` / Stats JSON · markdown · PDF (proxy, not a bill)
- **Richer host adapters** — Continue `mcpServers/amem.yaml`, Zed HTTP `url`, doctor health for continue/zed/windsurf
- **Local n-gram embedder** — Pro/IT; no model download, no cloud API (`amem embed use ngram`)
- **License + IT attest SKU** — vendor-signed license only; IT attest adds vault/host packet

- **Auto-capture** — high-quality session-end facts apply without `amem_remember`
- **Restore** — `amem restore --file` + vault UI path (encrypted or plaintext backup)
- **Hygiene** — Pro: unused decay, near-duplicate merge, Memory Review inbox
- **External embedder** — Pro: local stdin/stdout command (Ollama, llama.cpp, your script)
- **IT pack** — `amem it-pack` + `amem doctor --sbom` (deny-default policy, MDM plist, offboard)
- **Pin → Cursor rules** — Pro: `amem rules sync` writes `.cursor/rules/amem-pinned.mdc`

## Open

- **Skills in backup/restore** — `createBackup` copies only the DB file, so `~/.amem/skills/`
  is lost on restore. Now sharper than before: the `skills` index, `skill_drafts`, and
  `skill_uses` tables all survive a restore while the SKILL.md bodies they point at do not,
  so a restored machine gets an index of skills that no longer exist. Needs a decision:
  make backups an archive (DB + skills dir), or keep backups DB-only, prune the index on
  restore, and document skills as separately versioned.
- **Skill drafts have no retention policy** — dismissed and applied rows accumulate. Memory
  drafts have hygiene sweeps; skill drafts do not yet.
- Prompt-pack before/after Stats benchmark; restore wizard polish; IT seat pack.
- Decide one-time vs subscription (offline files cannot revoke on cancel unless you add `expires_at` and re-issue).
- Optional vendored ONNX/MiniLM weights in a paid pack (external command is the local hook today).
- Move CI publish to npm Trusted Publishing (OIDC) before Jan 2027 GAT bypass-2FA publish sunset.

## Shipped (go-to-market / upsell)

- Public Checkout at **getamem.com** (tryamem redirects); Stripe live webhook.
- Mailtrap **live send** (`MAILTRAP_USE_TESTING=false`); thank-you download still works if mail fails.
- **`@iamem/amem@0.1.0` on npm** — `npx @iamem/amem setup` / `npm i -g @iamem/amem` (CLI binary `amem`).
- UI **Apply license** (paste/drop) + **Turn on Pro retrieval** checklist.
- Memory **retrieval showdown** (free hash vs Pro n-gram) + top-bar **Try retrieval**.
- Remember-contract guidance: prefer durable kinds; avoid `session` spam.
- **Hygiene auto-cleanup** — `accept-safe`, weekly OS schedule, soft paywall banner at ~200 facts / noisy dups (free preview; apply stays Pro).

## Explicit non-goals (keep)

- Cloud/team sync, shared org brain, hosted RAG
- Exact Cursor/Anthropic billing integration
- Writing memory into product git history
