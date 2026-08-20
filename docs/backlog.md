# amem backlog (next)

Updated after miss→learn, kind-weighted ranking, why-injected, propose diff, and Claude hook parity.

## Shipped recently

- FTS retrieval, claim staleness, supersede/conflict
- Session-end **draft capture** + Brain approve/dismiss
- Brain **edit / delete / pin / search**
- Login service on **macOS + Linux + Windows**
- **Miss → learn** drafts after empty context lookups
- **Claim-kind ranking** + **Why:** explainability in context packets
- **`amem propose diff`** before apply
- Claude Code hooks call full `amem hook` pipeline

## Next candidates

1. **One-command install** — publish to npm so `npx amem` / `npm i -g amem` works (native `better-sqlite3` story).
2. **More hosts** — Windsurf, Continue, Aider, Zed, etc. (thin installers on the same local DB).
3. **Cross-repo personal prefs** — optional local “how I work” memory spanning projects (not org wiki).
4. **Optional encrypted-at-rest `~/.amem`**
5. **Scheduled local encrypted backup** to a user-chosen path (still no sync).
6. **Local embeddings** (optional, still on-device) for hybrid search beyond FTS.
7. **Smarter draft quality** — LLM-free summarization heuristics / multi-turn compaction.
8. **Auto-apply low-risk kinds** with policy allowlist (still local).

## Explicit non-goals (keep)

- Cloud/team sync, shared org brain, hosted RAG
- Exact Cursor/Anthropic billing integration
- Writing memory into product git history
