# Connect amem to your AI tools

*amem — agent memory, anchored to your code.*

amem talks to any app that supports the **Model Context Protocol (MCP)**. Some apps have a one-command installer. The rest need a small config entry that you paste once. Everything stays on your machine: apps start amem locally or call `127.0.0.1`.

- [Fastest: plugins and one-click installs](#fastest-plugins-and-one-click-installs)
- [Before you start](#before-you-start)
- [One-command setup](#one-command-setup): Claude Code, Cursor, Windsurf, Claude Desktop, Continue, Zed, Aider
- [Paste a config](#paste-a-config): Codex, GitHub Copilot, Gemini CLI, Antigravity, Cline / Roo / Kilo, JetBrains, LM Studio, Goose
- [Add in the app's settings](#add-in-the-apps-settings): Perplexity, Warp
- [Apps that can't use amem yet](#apps-that-cant-use-amem-yet)
- [Check it works](#check-it-works)
- [Troubleshooting](#troubleshooting)

---

## Fastest: plugins and one-click installs

| App | Install | What you get |
| --- | --- | --- |
| **Claude Code** | `/plugin marketplace add sslugic/amem`, then `/plugin install amem@amem` | MCP server, the automatic context hooks and amem skills |
| **Codex** | `codex plugin marketplace add sslugic/amem`, then `/plugins` in Codex → install **amem** | MCP server and skills; hooks once you trust them |
| **Gemini CLI** | `gemini extensions install https://github.com/sslugic/amem` | MCP server and the amem instructions |
| **Cursor** | **Add to Cursor** on [getamem.com](https://getamem.com/#setup) | MCP server |
| **VS Code (Copilot)** | **Add to VS Code** on [getamem.com](https://getamem.com/#setup) | MCP server (use Agent mode) |
| **LM Studio** | **Add to LM Studio** on [getamem.com](https://getamem.com/#setup) | MCP server |
| **Claude Desktop** | Download [`amem.mcpb`](https://github.com/sslugic/amem/releases/latest/download/amem.mcpb) and double-click it (or Settings → Extensions → Install Extension) | MCP server; pick which memory to use when it asks |

All of these run amem locally (`npx -y @iamem/amem mcp`, or your installed `amem`) and need Node 20+. Prefer manual setup or don't see your app? Read on.

---

## Before you start

1. **Install amem** (Node 20+):

   ```bash
   npx @iamem/amem setup
   ```

2. **Get your config block.** Desktop apps don't start from your shell, so they can't find a bare `amem` on your PATH. They need absolute paths. This prints a ready-to-paste block with the right paths for your machine:

   ```bash
   amem mcp --print-config --workspace personal
   ```

   It looks like this (your paths will differ):

   ```json
   {
     "mcpServers": {
       "amem": {
         "command": "/usr/local/bin/node",
         "args": ["/usr/local/bin/amem", "mcp"],
         "env": { "AMEM_WORKSPACE": "personal" }
       }
     }
   }
   ```

3. **Pick a workspace.**
   - **`personal`** is your memory shared across every project. Use it for apps that aren't tied to a code folder: Claude Desktop, Perplexity, Warp, LM Studio.
   - **A project name** keeps the app's memory with that project; create one with `amem init --workspace <name>`.
   - **Editors that open a repo** (Cursor, Copilot, Windsurf) can leave `AMEM_WORKSPACE` out. amem then uses the repo the editor opened.

> **HTTP instead of a command.** If an app accepts a URL instead of a command, keep the dashboard running with `amem ui`, or `amem service install` to start it at login. Then use `http://127.0.0.1:7843/mcp?workspace=personal`.

---

## One-command setup

These apps have a built-in installer. It writes the config and the instruction file the app reads, so its agent knows to check amem first.

| App | Command | After |
| --- | --- | --- |
| **Claude Code** | `amem setup --platform claude` | Restart Claude Code. Adds the MCP server and hooks that hand over context automatically at session start and on each prompt. |
| **Cursor** | `amem setup --platform cursor` | Reload the window. Writes `~/.cursor/mcp.json` and `.cursor/rules/amem.mdc`. |
| **Windsurf** | `amem setup --platform windsurf` | Restart Windsurf. Writes `~/.codeium/windsurf/mcp_config.json`. |
| **Claude Desktop** | `amem init --platform claude-desktop` | **Quit with Cmd+Q** and reopen; closing the window isn't enough. Writes `claude_desktop_config.json` with workspace `personal`. |
| **Continue** | `amem setup --platform continue` | Reload VS Code / JetBrains. Writes Continue's MCP config. |
| **Zed** | `amem setup --platform zed` | Restart Zed. Adds amem to `settings.json`. |
| **Aider** | `amem setup --platform aider` | Aider has no MCP, so amem writes `.aider.amem.md` with CLI commands it can run. |
| **OpenAI Codex** | `amem init --platform codex` | Start a new Codex session. Adds `[mcp_servers.amem]` to `~/.codex/config.toml` (or `$CODEX_HOME`) and writes `AGENTS.md`. |
| **Gemini CLI** | `amem init --platform gemini` | Start a new session; `/mcp` lists amem. Adds amem to `~/.gemini/settings.json` and writes `GEMINI.md`. |
| **Qwen Code** | `amem init --platform qwen` | Start a new session; `/mcp` lists amem. Adds amem to `~/.qwen/settings.json` and writes `QWEN.md`. |
| **OpenCode** | `amem init --platform opencode` | Restart OpenCode. Adds a local `mcp.amem` server to `~/.config/opencode/opencode.json` and writes `AGENTS.md`. A config with comments is left alone; paste the entry by hand there. |

Run the command inside the project you want the app to use; `amem platforms` lists every client id.

---

## Paste a config

Paste the `amem` entry from `amem mcp --print-config` into the file or panel below, then restart the app.

### OpenAI Codex (CLI, IDE extension and app)
All three read `~/.codex/config.toml`:

```toml
[mcp_servers.amem]
command = "/usr/local/bin/node"            # from amem mcp --print-config
args = ["/usr/local/bin/amem", "mcp"]
env = { AMEM_WORKSPACE = "personal" }      # or leave out inside a repo
```

`amem init --platform codex` writes this entry for you, and `AGENTS.md` so Codex knows to query amem first.

### GitHub Copilot (VS Code agent mode)
Create `.vscode/mcp.json` in the project, or use *MCP: Open User Configuration* for all projects. Note that VS Code uses `servers`, not `mcpServers`:

```json
{
  "servers": {
    "amem": { "type": "stdio", "command": "/usr/local/bin/node", "args": ["/usr/local/bin/amem", "mcp"] }
  }
}
```

Switch Copilot Chat to **Agent** mode; MCP tools are only offered there. `amem setup --platform copilot` writes `.github/copilot-instructions.md`.

### Gemini CLI
`amem init --platform gemini` adds amem under `mcpServers` in `~/.gemini/settings.json` and writes `GEMINI.md`. To limit it to one project, put the block in `.gemini/settings.json` there instead.

### Google Antigravity
Agent panel → **⋯** → **MCP Servers** → **Manage MCP Servers** → **View raw config**. Add the `amem` block under `mcpServers` and save.

### Cline, Roo Code, Kilo Code
Open the **MCP Servers** panel → **Configure** (or *Edit MCP Settings*). Paste the `amem` block under `mcpServers`.

### JetBrains (AI Assistant / Junie)
**Settings → Tools → AI Assistant → Model Context Protocol (MCP) → Add**, choose **As JSON**, and paste the block.

### LM Studio
**Program** tab → **Install → Edit mcp.json**. Paste the block under `mcpServers` and save.

### Goose
Run `goose configure`, then **Add Extension → Command-line Extension**. Name it `amem`. For the command, use the `command` and `args` from `--print-config` joined with spaces, e.g. `/usr/local/bin/node /usr/local/bin/amem mcp`. Then add the `AMEM_WORKSPACE=personal` environment variable.

### Any other MCP client
Use the `amem mcp --print-config` block as is, or the HTTP URL if the app takes one. `amem recipe` prints the generic read-then-write contract to give any agent.

---

## Add in the app's settings

These apps don't read a config file; you add amem in their UI once.

### Perplexity (Mac app)
1. **Settings → Connectors → Add Connector.** If Perplexity asks to install its local helper, allow it; local connectors need it.
2. Choose **Simple**. Name: `amem`. Command: the `command` and `args` from `amem mcp --print-config`, joined with spaces:

   ```
   /usr/local/bin/node /usr/local/bin/amem mcp
   ```

3. Under environment variables, add `AMEM_WORKSPACE` = `personal`.
4. Save, then turn the amem connector on in the chat's source menu.

### Warp
**Settings → AI → MCP Servers → + Add.** Paste the `amem` block from `amem mcp --print-config`, then **Start** the server. `amem setup --platform warp` writes `AGENTS.md`, which Warp reads.

---

## Apps that can't use amem yet

| App | Why |
| --- | --- |
| **Gemini app** (desktop / web) | No support for local MCP servers. Use **Gemini CLI** or **Antigravity** instead; both work with amem. |
| **ChatGPT** (desktop / web) | Connectors must be remote HTTPS servers; it can't start a local command or reach `127.0.0.1`. Use **Codex** instead; it shares your OpenAI sign-in. |

These can change as apps add MCP support. `amem platforms` lists what amem knows how to wire.

---

## Check it works

1. Open `amem ui`, then **Activity**. An app appears there the first time its agent calls amem.
2. In the app, ask: **"Call amem_status and tell me what you see."** A working setup replies with your workspace and fact counts.
3. Ask something your memory knows. The agent should call `amem_context` before reading files.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Tool discovery failed", or the server shows red/`error` | The app can't find `node` or `amem`. Use absolute paths from `amem mcp --print-config`, or the HTTP URL. |
| "Unknown workspace. Pass workspace=" | The app doesn't start inside a repo. Add `"env": { "AMEM_WORKSPACE": "personal" }`, or create a workspace with `amem init --workspace <name>`. |
| Connected, but never appears in Activity | The agent hasn't called amem yet. Run `amem instructions --platform <id>` so it's told to check amem first, then ask it directly once. |
| Changes don't show up | Restart the app fully. Desktop apps read MCP config only at launch (Cmd+Q on macOS). |
| HTTP URL doesn't connect | The dashboard isn't running: `amem ui`, or `amem service install` to start it at login. |

Still stuck? `amem doctor --fix` re-wires the current repo's client, and [issues](https://github.com/sslugic/amem/issues) are welcome.
