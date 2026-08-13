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

## Install (DevEx / IT)

1. Ship a pinned amem build (internal npm, pkg, or `npm link` from a mirrored clone).
2. Deploy policy:

```bash
sudo mkdir -p /etc/amem
sudo cp templates/policy.example.toml /etc/amem/policy.toml
sudo chmod 644 /etc/amem/policy.toml
```

3. Optional MDM: install binary + copy policy + run doctor on first login.

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
| `allowed_platforms` | Restricts `init` / setup |
| `allowed_remote_hosts` | Restricts which git remotes can init/apply |
| `deny_claim_patterns` | Extra regexes blocked in claim text/anchors |

## Offboarding

```bash
amem wipe --all --yes
```

Deletes all local repos in the DB and removes `~/.amem` (memory, sessions, user policy). Safe to run from MDM logout scripts — see [scripts/mdm-offboard.sh](../scripts/mdm-offboard.sh).

## Support checklist

- Pin Node 20+ and amem version in the internal package
- Re-run `amem doctor --attest` after Cursor / Claude Code updates
- Keep `/etc/amem/policy.toml` root-owned
- Do not commit personal exports to product git history
