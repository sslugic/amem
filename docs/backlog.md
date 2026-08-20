# amem backlog (next)

Updated after auto-capture drafts, Brain memory manager, and cross-platform login service.

## Shipped recently

- FTS retrieval, claim staleness, supersede/conflict
- Session-end **draft capture** + Brain approve/dismiss
- Brain **edit / delete / pin / search**
- Login service on **macOS + Linux + Windows**

## Next candidates

1. **One-command install** — publish to npm so `npx amem` / `npm i -g amem` works (native `better-sqlite3` story).
2. **More hosts** — Windsurf, Continue, Aider, Zed, etc. (thin installers on the same local DB).
3. **Cross-repo personal prefs** — optional local “how I work” memory spanning projects (not org wiki).
4. **Miss → learn loop** — when context misses and the agent later finds the answer, auto-propose a claim.
5. **Optional encrypted-at-rest `~/.amem`**
6. **Claim-kind injection priority** — constraint / gotcha / owner / howto weighting.
7. **Diff on propose apply** — show what will change before write.
8. **Scheduled local encrypted backup** to a user-chosen path (still no sync).
9. **“Why was this injected?”** ranking explainability in packet / UI.
10. **Claude Code full hook parity** — same draft capture path as Cursor (today Claude mostly session-touch).

## Explicit non-goals (keep)

- Cloud/team sync, shared org brain, hosted RAG
- Exact Cursor/Anthropic billing integration
- Writing memory into product git history
