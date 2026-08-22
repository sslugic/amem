# amem license SKU

Memory still never leaves the laptop. A license only unlocks **local** extras.

| Tier | What it unlocks |
| --- | --- |
| **free** | Memory UI, MCP, stats, backups |
| **pro** | Local n-gram or **external** embedder, hygiene (inbox + weekly schedule + accept-safe), pin → Cursor rules |
| **it** | Pro + richer `amem doctor --attest` packet (the exclusive). `amem it-pack` templates are available on Free. |

There is no license server and no telemetry. Pro/IT requires a **vendor-signed** `amem-license.json` (Ed25519). Self-issued / `--dev` unlocks are not accepted.

## Buy + apply

Prices (one-time, live): **Pro $12**, **IT $49** at [getamem.com](https://getamem.com). After pay, download `amem-license.json` from the thank-you page.

**Apply in the UI (recommended):** open `amem ui` → Plans or Setup → paste the JSON or choose the file → Apply license. Then **Turn on Pro retrieval** (n-gram + reindex). Memory tab has a **retrieval showdown** (free hash vs Pro n-gram).

Or from a terminal:

```bash
amem license apply --file ~/Downloads/amem-license.json
amem license status
amem embed use ngram && amem embed reindex
amem hygiene
amem hygiene --accept-safe
amem hygiene schedule
amem rules sync
```

The published CLI has no Stripe keys. A separate **shop** process (not shipped on npm) runs Checkout and emails a signed JSON via Mailtrap. See [shop/README.md](../shop/README.md).

```bash
# seller (this repo, not published) — local only
cd shop && npm install && npm start
stripe listen --forward-to localhost:8788/webhook
```

Or issue one file yourself with the vendor private key (never commit it):

```bash
amem license keys --out-dir shop/.data
AMEM_LICENSE_PRIVKEY=… amem license issue --tier pro --subject acme --out acme.json
amem license apply --file acme.json
```

Verify uses the public key in `src/license.ts` (override with `AMEM_LICENSE_PUBKEY` in tests only).

## Clear

```bash
amem license clear
amem embed use hash
```
