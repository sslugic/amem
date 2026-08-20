# amem license SKU

Memory still never leaves the laptop. A license only unlocks **local** extras.

| Tier | What it unlocks |
| --- | --- |
| **free** | Full memory, MCP, Brain, stats, backups |
| **pro** | Local n-gram embedding model (`amem embed use ngram`) |
| **it** | Pro + richer `amem doctor --attest` SKU packet (vault + host health) |

There is no license server and no telemetry.

## This machine (dev / early access)

```bash
amem license activate --dev --tier pro
amem embed use ngram
amem embed reindex
amem license status
```

Dev licenses are bound to this machine’s fingerprint. They are not transferable.

## Signed file (later sales)

Issue with the vendor private key (never commit it):

```bash
AMEM_LICENSE_PRIVKEY=… amem license issue --tier pro --subject acme --out acme.json
amem license apply --file acme.json
```

Verify uses the public key in `src/license.ts` (override with `AMEM_LICENSE_PUBKEY` in tests).

`AMEM_LICENSE_TIER=pro` overrides the file for local/CI checks.

## Clear

```bash
amem license clear
amem embed use hash
```
