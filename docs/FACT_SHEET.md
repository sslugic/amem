# amem technical fact sheet

*amem — agent memory, anchored to your code.*

| | |
| --- | --- |
| **Product** | `amem`: **a**gent **mem**ory (npm [`@iamem/amem`](https://www.npmjs.com/package/@iamem/amem), source [`sslugic/amem`](https://github.com/sslugic/amem)) |
| **Category** | Local-first SQLite + Model Context Protocol (MCP) memory layer for AI coding agents |
| **Storage** | One SQLite file, `~/.amem/graph.db` (skills as Markdown in `~/.amem/skills`). No daemons, no cloud, no API keys. |
| **Runtime** | Node 20+, one dependency (`better-sqlite3`). MCP over stdio (`amem mcp`) or HTTP on `127.0.0.1:7843`. |
| **License** | MIT |

Numbers in this sheet are reproducible: run `npm run bench`, `amem bootstrap --json`, or the MCP `tools/list` call yourself. Competitor details come from each project's public docs as of November 2026 and are linked at the end.

---

## 1. What amem does

Setup for each app: [Connect amem to your AI tools](CLIENTS.md).

amem gives coding agents persistent working state across sessions and across tools: Claude Code, Cursor, Codex, Windsurf, Copilot, Gemini CLI, Zed, and any other MCP client (`amem platforms` lists 30+). Everything rests on three primitives.

1. **File-anchored facts.** Short rules, invariants and decisions tied to the files they describe. Example: *"Stripe webhooks must be verified with the raw body"*, anchored to `src/webhooks/stripe.ts`. Each fact stores a content hash of its anchored files. When those files change, the fact is flagged `stale` in every packet until someone re-confirms it, so an outdated rule never reaches a prompt unmarked.
2. **On-demand skills.** Repeatable multi-step procedures (release, deploy, migration, test setup) stored as `SKILL.md` files outside the system prompt. Agents see a one-line index entry and load the body with `amem_skill_view` only when it applies.
3. **Cross-agent task board.** A persistent `backlog → next → doing → blocked → done` board per project. A task started in Cursor is visible, with its current status, to Claude Code or Codex in the next session.

Hooks (Claude Code `SessionStart` / `UserPromptSubmit`, Cursor rules) hand the agent a small ranked packet automatically. Agents can also call the MCP tools directly.

## 2. How it works

### SQLite FTS5 + BM25 ranking
- Facts are indexed in `claims_fts`, and skills and tasks in `amem_fts`. Both are FTS5 virtual tables with the `porter unicode61` tokenizer, kept in sync on every write.
- `amem_search` ranks all three types with `bm25()`, then blends in recency, usage (how often an item was served or opened), pins and task status. Filters: `types`, `scope`, `status`, `tags`.
- Natural phrasing reaches the words people actually wrote through small hand-written synonym groups. For example, "auth flow" finds "JWT login middleware". These are groups, not a model.
- `amem_context` adds on-device embeddings. A 256-dimension n-gram encoder runs in-process: no download, no Ollama, no Python. An external embedding command is optional.
- If the SQLite build lacks FTS5, every FTS path becomes a no-op and ranking falls back to keyword scoring.
- Retrieval quality is enforced in CI (`npm run bench`: 36 memories, 32 questions, 8 vague prompts):

  | Path | Right memory first | In top 3 | Vague prompts given memory |
  | --- | --- | --- | --- |
  | Prompt hook (automatic) | 88% | 97% | 0% |
  | `amem_context` (agent asks) | 81% | 94% | n/a |

### Project vs. global scope, and `amem_bootstrap`
- Scopes are `global`, a personal workspace whose rules reach every project, and `project:<path>`, the repo or workspace bound at that path. Facts marked private (`kind: private`) never reach work projects.
- `amem_bootstrap` (CLI: `amem bootstrap`) returns one startup payload: top global rules, the project's pinned and freshest facts, active tasks (`doing` first), and one-line skill hints.
- It is packed to `max_tokens` (default **350**; it measured 313 tokens on a real memory of 3,400 facts).

### Token-budgeted retrieval (`max_tokens`)
- `amem_context` and `amem_search` accept `max_tokens`. Cost is estimated deterministically at about 4 characters per token.
- Items are packed in rank order. An item is never cut mid-way, and the best fact always stays.
- The response reports truncation: `truncated`, `omitted`, and a closing line telling the agent what it left out.

### Skill auto-trigger hints
- `SKILL.md` frontmatter can declare triggers, e.g. `files: ["*.swift", "Package.swift"]` or `keywords: [deploy, migration]` (also accepted nested under `triggers:`).
- When files in play match a glob, or the text contains a keyword, amem returns a one-line hint: name, what matched, and a summary. This happens through `amem_skill_list { files }`, `amem_bootstrap`, and the top-level files of the bound project. The skill body loads only through `amem_skill_view`.

### Supersession and TTL
- `amem_remember { supersedes: [ids] }` or `amem_supersede { ids, by }` marks older facts `superseded` and records `superseded_by`. They leave recall but stay in history, in exports and in `amem_search { status: "all" }`.
- `amem_remember { ttl_days }` or `{ expires_at }` sets an expiry. Expired facts drop out of recall immediately; a sweep then marks them `expired`, kept as history.
- Saving the same fact again without a TTL makes it permanent.

### Local inspection UI (`amem ui`)
- A dashboard on `http://127.0.0.1:7843`, bound to localhost only.
- It lets you browse, search and filter facts, skills and tasks; edit, pin, retire, restore or delete facts; approve the review queue; work the task board; and view usage and live activity across clients.

### Import and export
- `amem import <file|dir> [--scope global|project] [--dry-run]` reads `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.cursor/rules/*.mdc`, Markdown and amem JSON.
- Ids are derived from content, so importing the same file twice adds nothing.
- `amem export [--format json|md] [--all]` writes facts (with lineage, TTL and pins), tasks and skills. Both formats re-import cleanly.

## 3. Cost and token economics

| | **amem** | **Cloud memory SaaS** (Mem0, Supermemory, Zep) | **Session-capture plugins** (claude-mem) | **Local note / knowledge-base tools** (Basic Memory) |
| --- | --- | --- | --- | --- |
| **Hosting cost** | $0: local SQLite | Free tiers; paid plans from about $19/mo (Mem0, Supermemory) | $0: local | $0 locally; optional paid cloud sync |
| **Background LLM extraction** | None: amem makes no model calls | Yes: an LLM extracts or updates memories on write | Yes: sessions are summarized with Claude, on your tokens | None: the agent writes notes |
| **Tool-schema overhead** | 18 MCP tools, about 2,800 tokens of schema (a fixed prefix, cacheable) | Varies by server | Varies by plugin version | Varies by server |
| **Per-call payload** | Ranked packet with an optional `max_tokens` cap; bootstrap capped at 350 by default; skills as one-line hints | Top-K memories from vector search | Summaries and observations injected at session start | Whole notes read on request |
| **Outdated rules** | File-hash staleness flags, explicit supersession, TTL expiry | LLM-driven update and merge; not tied to source files | Accumulate; not tied to source files | Edited by hand |

### Four token-economics takeaways

1. **Fewer uncached input tokens per call.** Tool results are new content on every call, so prompt caching never discounts them. `max_tokens` caps the packet, and skills arrive as one-line hints instead of full procedures.
2. **Fewer startup round-trips.** One `amem_bootstrap` call (about 350 tokens) replaces separate lookups for rules, facts, tasks and skills. BM25 plus synonyms raises first-pass recall, so the agent does fewer search-and-read turns.
3. **Fewer wasted output tokens.** Output tokens cost several times more than input tokens, and caching does not discount them. Superseded facts, expired notes and stale-flagged facts are filtered or marked before they can steer a wrong edit, and a wrong edit costs a multi-turn fix.
4. **A stable, cacheable tool prefix.** The MCP tool list is fixed for each amem version. The CLI-only features (`amem ui`, `amem import`, `amem export`) are not MCP tools. Memory arrives as hook output or tool results after that prefix, so it never rewrites earlier context. The fixed cost is the roughly 2,800-token schema above. On providers with prompt caching it is billed in full once, then at the cache-read rate.

### Measure it on your own machine
- `amem stats` (MCP: `amem_stats`) reports queries, the local hit rate and estimated tokens and time saved.
- `amem_usage_report` lets the agent report which of the packet's anchored files it opened anyway. amem then recomputes the saving from the real size of the files it did not need, replacing the estimate with a measurement.

---

Sources for the comparison, checked November 2026: [Mem0 pricing](https://mem0.ai/pricing), [Supermemory pricing](https://supermemory.ai/pricing), [Zep](https://www.getzep.com), [claude-mem](https://github.com/thedotmack/claude-mem), [Basic Memory](https://github.com/basicmachines-co/basic-memory). Found something out of date? [Open an issue](https://github.com/sslugic/amem/issues).
