# amem license SKU

Memory still never leaves the laptop. A license only unlocks **local** extras.

| Tier | What it unlocks |
| --- | --- |
| **free** | Memory UI, MCP, stats, backups |
| **pro** | Local n-gram or **external** embedder, hygiene inbox, pin → Cursor rules |
| **it** | Pro + richer `amem doctor --attest` packet + `amem it-pack` |

There is no license server and no telemetry.

## This machine (dev / early access)

```bash
amem license activate --dev --tier pro
amem embed use ngram
# or a local command that reads text on stdin and prints { "vector": […] }
# amem embed use external --cmd /usr/bin/my-embedder
amem embed reindex
amem hygiene
amem rules sync
amem license status
```

Dev licenses are bound to this machine’s fingerprint. They are not transferable.

## Signed file (sales)

The published CLI has no Stripe keys. A separate **shop** process (not shipped on npm) runs Checkout and emails a signed JSON via Mailtrap. See [shop/README.md](../shop/README.md).

Prices (one-time, live): **Pro $12**, **IT $49** at [getamem.com](https://getamem.com). After pay, download `amem-license.json` from the thank-you page (Mailtrap testing also keeps a sandbox copy).

**Apply in the UI (recommended):** open `amem ui` → Plans or Setup → paste the JSON or choose the file → Apply license. Then **Turn on Pro retrieval** (n-gram + reindex). Memory tab has a **retrieval showdown** (free hash vs Pro n-gram).

Or from a terminal:

```bash
# seller (this repo, not published) — local only
cd shop && npm install && npm start
stripe listen --forward-to localhost:8788/webhook

# buyer
amem license apply --file ~/Downloads/amem-license.json
amem license status
amem embed use ngram && amem embed reindex
```

Or issue one file yourself with the vendor private key (never commit it):

```bash
amem license keys --out-dir shop/.data
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
