# amem backlog (next)

Updated after completing the prior “next candidates” set (hosts, personal prefs, encrypt/backup, local embeddings, smarter drafts, auto-apply policy).

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

## Next candidates

1. **Publish to npm** — land `npx amem setup` for real (CI release, prebuilds for `better-sqlite3`).
2. **Brain UX polish** — personal workspace switcher, backup status, lock indicator.
3. **Richer host adapters** — Continue/Zed deep links as those MCP shapes stabilize.
4. **Optional on-device embedding model** (still local) if hashing hybrid plateaus.
5. **Draft quality scoring** — confidence / reject noisy session-end drafts in Brain.
6. **Conflict UI** — surface supersede suggestions before apply in Brain.

## Explicit non-goals (keep)

- Cloud/team sync, shared org brain, hosted RAG
- Exact Cursor/Anthropic billing integration
- Writing memory into product git history
