# Licensing

**Everything in amem is free.** Every feature (n-gram embeddings, hygiene and its weekly schedule, pinned rules sync, the attestation packet) works without a license.

The signed license file below is still supported for organisations that want a vendor-signed record for compliance. It unlocks nothing extra. There is no license server and no telemetry.

Apply a license file, and turn on the optional extras:

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
