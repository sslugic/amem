# amem remember contract (v1)

Generic MCP host recipe. Same tools for every client — do not fork per product.

## Connect

Keep `amem ui` running, then attach:

`http://127.0.0.1:7843/mcp?workspace=<slug>`

GUI hosts often cannot see Homebrew on PATH. Prefer the HTTP URL over a bare `amem` command.

Print this from any machine with amem installed:

```bash
amem recipe
# or: curl -s http://127.0.0.1:7843/api/recipe
```

Hosts can also call the `amem_recipe` MCP tool.

## Tools

- `amem_context` (read) — Before exploring files or sending a large prompt. Pass `workspace=<slug>`.
- `amem_remember` (write) — After a durable outcome: a decision, constraint, owner, or gotcha that should survive this chat.
- `amem_recipe` (meta) — If you are unsure when to read or write — fetch this contract.

## Rules

- Must: Call `amem_context` at the start of a task. Do not treat a successful read as a substitute for writing later.
- Must: Call `amem_remember` when the user confirms a durable fact, or when you discover a constraint that the next session will need.
- Must: Memory stays on this machine under `~/.amem`. Do not upload claims, paste them into shared docs, or commit them to product git.
- Must: Never remember passwords, API keys, tokens, or private key material.
- Must: Store repo or workspace facts with file anchors — not proprietary prompting strategy.
- Must: Prefer kinds constraint, gotcha, structure, howto, or owner. Use kind=session only for short-lived chat takeaways — session spam drowns retrieval.
- Must: Named workspaces are not git repos. Always pass the workspace slug on context and remember.

## Example

1. `amem_context` query="What should I know before changing auth?" workspace=my-app
2. Do the work, verify files.
3. `amem_remember` text="Auth mode is checked in src/auth.ts before Drive sync" workspace=my-app kind=constraint anchors=["src/auth.ts"]
