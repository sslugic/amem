# amem backlog (next)

Captured for follow-up work after FTS retrieval, claim staleness, and supersede/conflict handling shipped.

## Next candidates

1. **Auto-capture at session end** — draft proposals from durable outcomes without relying on the agent remembering `amem-update-working-memory`; human approve in UI (or auto-apply low-risk kinds).
2. **Brain UI as memory manager** — edit / delete / pin / search claims; fix bad facts without CLI JSON.
3. **One-command install** — `npx amem` / published npm package (clones ≠ installs).
4. **Linux / Windows login service** — `amem service` beyond macOS LaunchAgent so MCP/HTTP stays up.
5. **More hosts** — Windsurf, Continue, Aider, Zed, etc. (thin installers on the same local DB).
6. **Cross-repo personal prefs** — optional local “how I work” memory spanning projects (not org wiki).
7. **Miss → learn loop** — when context misses and the agent later finds the answer, auto-propose a claim.
8. **Optional encrypted-at-rest `~/.amem`**
9. **Claim-kind injection priority** — constraint / gotcha / owner / howto weighting.
10. **Diff on propose apply** — show what will change before write.
11. **Scheduled local encrypted backup** to a user-chosen path (still no sync).
12. **“Why was this injected?”** ranking explainability in packet / UI.

## Explicit non-goals (keep)

- Cloud/team sync, shared org brain, hosted RAG
- Exact Cursor/Anthropic billing integration
- Writing memory into product git history
