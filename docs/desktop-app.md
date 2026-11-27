# The amem desktop app

The desktop app is amem packaged for people who don't want a terminal. It is one download
for Mac, Windows and Linux. It ships amem inside itself, walks through a short setup, and
then shows the dashboard and live activity. It updates itself from GitHub releases.

Download it from [getamem.com](https://getamem.com/#download) or the
[latest release](https://github.com/sslugic/amem/releases/latest).

## What happens on first launch

1. **Mac only:** if the app isn't in Applications, it offers to move itself there. Your AI
   tools run amem from where the app lives, so it shouldn't stay in Downloads.
2. It writes a small `amem` command to `~/.amem/bin` (`amem.cmd` on Windows). That command
   runs the copy of amem inside the app with the app's own runtime, so you don't need Node
   or npm. Every hook, MCP entry and background job amem sets up points at it. The command
   is rewritten on every launch, so moving or updating the app keeps it working.
3. It starts the dashboard on `127.0.0.1:7843`. If a newer amem is already serving that
   port it uses that one; if an older one holds the port, it starts on the next free port.
4. The **guided setup** opens:
   - **Your AI tools:** amem looks for Claude Code, Cursor, Codex, Gemini CLI, Qwen Code,
     OpenCode, Claude Desktop, Windsurf, Zed, Continue, Aider and VS Code, and ticks the
     ones it finds.
   - **Your projects:** the git projects in your home folder. Tick the ones you use with
     AI tools, or add a folder.
   - **Connect:** writes each tool's MCP entry (and hooks for Claude Code and Cursor), plus
     the instruction file each tool reads in each project. Every step reports on its own.
     You can also add `amem` to your terminal PATH here.
   - **Done:** what to restart in each tool so it loads amem.

You can run the setup again any time from **Settings → Run guided setup**.

## Updates

The app checks for a new release every few hours and downloads it in the background. When
it is ready, a banner offers **Restart to update**. In **Settings → amem app** you can turn
on *Install updates automatically when I quit amem*. The bundled amem updates with the
app, because the app version always equals the amem version.

## Building it

```bash
npm run build                  # compile amem
npm ci --prefix desktop        # Electron + electron-builder
npm run dist:mac --prefix desktop     # or dist:win, dist:linux, dist:mac-x64
```

`desktop/scripts/dist.mjs` syncs the version, stages amem into `desktop/build/amem`, and
runs electron-builder. Staging uses production dependencies, plus the better-sqlite3
binary for the app's Electron version and the target platform. Those binaries are
prebuilt downloads, so a Mac can build the Windows and Linux apps too. Output goes to
`desktop/release/`.

Electron is pinned to the newest major that better-sqlite3 publishes prebuilt binaries
for. Raise it when a new better-sqlite3 release adds the next ABI.

## Releasing

Pushing a `v*` tag runs `.github/workflows/release.yml`. After the npm publish and the
GitHub release, the `desktop` job builds Windows and Linux and uploads them along with the
update feeds (`latest.yml`, `latest-linux.yml`).

The Mac build must be signed and notarised for Gatekeeper and for self-updates. CI builds it
only when these repository secrets exist:

| Secret | What it is |
| --- | --- |
| `MAC_CSC_LINK` | The *Developer ID Application* certificate as a base64 `.p12` |
| `MAC_CSC_KEY_PASSWORD` | The `.p12` password |
| `APPLE_API_KEY_P8` | Contents of the App Store Connect API key (`AuthKey_….p8`) |
| `APPLE_API_KEY_ID` | That key's ID |
| `APPLE_API_ISSUER` | The issuer UUID from App Store Connect → Integrations |

Until those secrets are set, build and upload the Mac app from a Mac that has the
certificate in its keychain:

```bash
export APPLE_API_KEY=~/.appstoreconnect/private_keys/AuthKey_XXXX.p8
export APPLE_API_KEY_ID=XXXX
export APPLE_API_ISSUER=<issuer uuid>
export GH_TOKEN=$(gh auth token)
git checkout vX.Y.Z && npm ci && npm run build && npm ci --prefix desktop
node desktop/scripts/dist.mjs mac --publish
```

That signs, notarises and staples the app and the dmg, and uploads `amem-mac-arm64.dmg`,
the zip and `latest-mac.yml` to the release.

Windows builds are not code-signed yet, so Windows shows a SmartScreen prompt
(*More info → Run anyway*) until a signing certificate is added (`WIN_CSC_LINK`).
