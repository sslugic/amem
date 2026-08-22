# amem enterprise endpoint (IT route)

Personal memory stays on the laptop. IT governs **install, policy, attestation, and offboarding** — not a shared cloud brain.

## What security review gets

| Guarantee | How to verify |
| --- | --- |
| No telemetry | Forced `telemetry = false`; attest report |
| No network egress from amem | Attest: `network_egress: "none"` |
| Localhost UI only | Binds `127.0.0.1` only |
| Memory permissions | `~/.amem` mode `0700` |
| Secret hygiene | Builtin + policy `deny_claim_patterns` on propose |
| Export control | `allow_export = false` in system policy |
| Platform allowlist | `allowed_platforms` |
| Repo allowlist | `allowed_remote_hosts` |
| Draft auto-apply | `auto_apply_kinds` (default empty = Memory approve only) |
| Optional at-rest encryption | User/local `amem lock` + encrypted `amem backup` (still no sync) |
| License SKU | Vendor-signed `amem-license.json` only (`amem license apply`). Self-issued /dev unlocks are rejected. IT tier adds vault/host fields to attest |

## IT pack (one folder for the security ticket)

```bash
amem it-pack --out ~/Desktop/amem-it-pack
amem doctor --sbom --out ~/Desktop/amem-it-pack/sbom.json
amem doctor --attest --json
```

The pack includes deny-by-default `policy.toml`, an MDM plist stub, `mdm-offboard.sh`, and a CycloneDX-lite SBOM. Signed installers still need your org’s cert — amem does not upload binaries.

## Install (DevEx / IT)

1. Ship a pinned amem build: `npm i -g @iamem/amem` (or internal mirror / pkg). Node 20+ required (`better-sqlite3` prebuilds on common macOS/Linux).
2. Deploy policy:

```bash
sudo mkdir -p /etc/amem
sudo cp templates/policy.example.toml /etc/amem/policy.toml
sudo chmod 644 /etc/amem/policy.toml
```

3. Optional MDM: install binary + copy policy + run doctor on first login.
4. End users typically run `amem setup` then `amem ui` (or `amem service install` for login auto-start on macOS / Linux / Windows).

## Attestation (ticket attachment)

```bash
amem doctor --attest
# machine-readable only:
amem doctor --attest --json
```

Attach the JSON to security / IT tickets. It includes effective policy, memory path/mode, and install health.

HTTP (local UI only): `GET /api/attest`

## Policy knobs

See [templates/policy.example.toml](../templates/policy.example.toml).

| Key | Effect |
| --- | --- |
| `allow_export` | Blocks `amem export` when false |
| `ui_enabled` | Blocks `amem ui` when false |
| `allowed_platforms` | Restricts `init` / setup (cursor, claude, windsurf, …) |
| `allowed_remote_hosts` | Restricts which git remotes can init/apply |
| `deny_claim_patterns` | Extra regexes blocked in claim text/anchors |
| `auto_apply_kinds` | Draft kinds that may auto-apply without Memory approve (empty = never) |

Hard stops (not overridable): telemetry stays off; UI bind forced to loopback.

## Local UI / MCP CORS threat model

`amem ui` binds **127.0.0.1 only**. HTTP responses (including MCP) set `Access-Control-Allow-Origin: *` so local hosts (Cursor, Claude, browser tools) can call the loopback API without a special Origin.

That is not a remote public API:

- Nothing in `~/.amem` is uploaded or synced.
- Binding is loopback-only — LAN/WAN clients cannot reach the UI by default.
- Treat any process on the same machine as potentially able to call `127.0.0.1:7843` while the UI is running (same as any local MCP server).
- Do not expose the UI on a non-loopback bind; policy forces loopback. Tightening `Access-Control-Allow-Origin` to specific Origins is optional and can break some MCP hosts — leave `*` unless you control every client Origin.

## Offboarding

```bash
amem wipe --all --yes
```

Deletes all local repos in the DB and removes `~/.amem` (memory, sessions, user policy, local backups under that home). Safe to run from MDM logout scripts — see [scripts/mdm-offboard.sh](../scripts/mdm-offboard.sh).

If the DB was locked (`graph.db.enc`), wipe still removes the amem home after unlock/offboard per your runbook; prefer unlocking or wiping the whole home directory.

## Support checklist

- Pin Node 20+ and amem version in the internal package
- Re-run `amem doctor --attest` after Cursor / Claude Code / host updates
- Keep `/etc/amem/policy.toml` root-owned
- Do not commit personal exports or encrypted backup blobs to product git history
- Leave `auto_apply_kinds` empty unless DevEx intentionally allows low-risk kinds
