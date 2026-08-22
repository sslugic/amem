# amem shop (seller process)

Stripe Checkout → signed license JSON → email via Mailtrap (live send in production).

This is **not** part of the published `@iamem/amem` CLI. Memory still never leaves the buyer’s machine. The shop only emails a file they apply with `amem license apply`.

## Production

Public shop: **https://getamem.com** (alias **https://tryamem.com** redirects there).

- App Runner service `amem-shop` (us-east-1), image `…/amem-shop:latest` (linux/amd64).
- Secrets from Secrets Manager `amem/shop` (Stripe, Mailtrap, `AMEM_LICENSE_PRIVKEY` hex).
- Health: `GET /health` (never redirected by canonical-host logic).
- Mail: set `MAILTRAP_USE_TESTING=false` and a verified `AMEM_FROM_EMAIL` / `INVITE_FROM_EMAIL` for real inbox delivery. Thank-you page download still works if email fails.

### Stripe live webhook

1. Stripe Dashboard → Developers → Webhooks → Add endpoint  
   `https://getamem.com/webhook`  
   Event: `checkout.session.completed`.
2. Copy the signing secret (`whsec_…`) into Secrets Manager `amem/shop` → `STRIPE_WEBHOOK_SECRET`.
3. Redeploy / restart the App Runner service so it picks up the new secret version.

Buyers: open getamem.com or the Buy links in `amem ui` (default shop URL is `https://getamem.com`).

```bash
npx @iamem/amem setup
amem license apply --file ~/Downloads/amem-license.json
amem license status
```

## What it reads from another `.env` (local)

Set `AMEM_SHOP_ENV` to a dotenv path (for example Testera’s). Only these names are imported:

- `MAILTRAP_TOKEN`, `MAILTRAP_USE_TESTING`, `MAILTRAP_TEST_INBOX_ID`, `MAILTRAP_PROJECT_ID`
- `INVITE_FROM_EMAIL`, `INVITE_FROM_NAME`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_IT`

Everything else in that file is ignored. `shop/.env` wins on conflicts. Use `AMEM_FROM_NAME=amem`.

## Run locally

```bash
cd shop && npm install
cp .env.example .env
amem license keys --out-dir shop/.data
npm start   # or from repo root: npm run shop
```

Local Stripe CLI:

```bash
stripe listen --live --forward-to localhost:8788/webhook
```

Put the printed `whsec_…` in `shop/.env` as `STRIPE_WEBHOOK_SECRET` and restart. Override the UI shop URL with `AMEM_SHOP_URL=http://127.0.0.1:8788` when testing locally.

## Prices

Default one-time amounts (overridable): Pro **$12**, IT **$49**. Offline files cannot revoke if someone cancels later — re-issue with `expires_at` if you switch to subscriptions.

## Keys

`DEFAULT_LICENSE_PUBKEY_HEX` in `src/license.ts` must match the private key the shop uses (`AMEM_LICENSE_PRIVKEY` or `shop/.data/license.priv`). Never commit the private key.
