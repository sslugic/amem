# amem shop (seller process)

Stripe Checkout → signed license JSON → email via Mailtrap (live send in production).

This is **not** part of the published `@iamem/amem` CLI. Memory still never leaves the buyer’s machine. The shop only emails a file they apply with `amem license apply`.

## Production

Public shop: **https://getamem.com** (alias **https://tryamem.com** redirects there).

- App Runner service `amem-shop` (us-east-1), image `…/amem-shop:latest` (linux/amd64).
- Secrets from Secrets Manager `amem/shop` (Stripe, Mailtrap, `AMEM_LICENSE_PRIVKEY`, `AMEM_ADMIN_TOKEN`, `AMEM_HITS_S3_BUCKET`).
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

### Admin analytics (seller only)

First-party metrics only (no third-party analytics). **Visitors** come from a small client **beacon** (`POST /api/beacon` after DOM ready) — almost no scanners run JS. Server-side HTTP logs are stored separately as raw requests for security monitoring and are filtered out of headline counts (404s, asset/probe paths, bot UAs, empty UA, non-GET/HEAD, datacenter CIDRs). Sessions are deduped via `amem_vid` / hashed IP+UA+daily salt; **raw IPs are never stored**.

1. Set `AMEM_ADMIN_TOKEN` in Secrets Manager `amem/shop` (long random string) and redeploy.
2. Optional: set `AMEM_HITS_S3_BUCKET` (e.g. `amem-shop-hits`) so `beacons/`, `raw/`, and `npm-beacons/` survive App Runner redeploys; grant the service instance role `s3:GetObject` + `s3:PutObject` on that bucket.
3. Open **https://getamem.com/admin**, paste the token once (sets an HttpOnly cookie), or use `Authorization: Bearer …` / `?token=`.
4. Dashboard: Visitors today / 7-day, pageviews, NPM installs (7-day), bot/scanner volume, **Pro/IT sales from Stripe** (all-time + window), heat map (datacenter muted; “show unfiltered” toggle), top paths, and a security panel of top 404 probes. JSON: `GET /admin/api/stats`. `/health`, `/webhook`, and `/api/beacon*` are not counted as page hits. Do not link `/admin` from the public homepage.

Locally: put `AMEM_ADMIN_TOKEN` in `shop/.env`; data appends to `shop/.data/beacons.jsonl`, `shop/.data/raw-requests.jsonl`, and `shop/.data/npm-beacons.jsonl`.

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
