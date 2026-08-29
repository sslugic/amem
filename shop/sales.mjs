/**
 * Seller sales rollup from Stripe Checkout (paid amem licenses).
 * Counts sessions with metadata.product=amem and payment_status=paid.
 * No customer PII is returned — only tier totals.
 */
import { normalizeTier } from "./fulfill.mjs";

const CACHE_MS = 60_000;
/** @type {{ at: number, days: number, value: object } | null} */
let cache = null;

async function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const { default: Stripe } = await import("stripe");
  return new Stripe(key);
}

/**
 * @param {{ days?: number }} [opts]
 */
export async function getSalesStats(opts = {}) {
  const days = Math.min(90, Math.max(1, Number(opts.days) || 7));
  if (cache && cache.days === days && Date.now() - cache.at < CACHE_MS) {
    return cache.value;
  }

  const empty = {
    pro: { all: 0, window: 0 },
    it: { all: 0, window: 0 },
    total: { all: 0, window: 0 },
    windowDays: days,
    source: "none",
    note: "STRIPE_SECRET_KEY missing — sales unavailable",
  };

  const stripe = await stripeClient();
  if (!stripe) {
    cache = { at: Date.now(), days, value: empty };
    return empty;
  }

  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  let proAll = 0;
  let itAll = 0;
  let proWin = 0;
  let itWin = 0;
  let scanned = 0;
  const maxScan = 2000;

  try {
    // Prefer Search when available (filters metadata server-side).
    let hasMore = true;
    /** @type {string | undefined} */
    let page;
    while (hasMore && scanned < maxScan) {
      const res = await stripe.checkout.sessions.search({
        query: "status:'complete' AND metadata['product']:'amem'",
        limit: 100,
        page,
      });
      for (const session of res.data || []) {
        scanned += 1;
        if (String(session.payment_status || "") !== "paid") continue;
        const tier = normalizeTier(session.metadata?.tier);
        if (!tier) continue;
        const created = Number(session.created) || 0;
        if (tier === "pro") {
          proAll += 1;
          if (created >= cutoff) proWin += 1;
        } else {
          itAll += 1;
          if (created >= cutoff) itWin += 1;
        }
      }
      hasMore = Boolean(res.has_more && res.next_page);
      page = res.next_page || undefined;
    }
  } catch (searchErr) {
    // Fallback: paginated list (no metadata filter — filter client-side).
    try {
      /** @type {string | undefined} */
      let startingAfter;
      let hasMore = true;
      while (hasMore && scanned < maxScan) {
        const res = await stripe.checkout.sessions.list({
          limit: 100,
          status: "complete",
          starting_after: startingAfter,
        });
        for (const session of res.data || []) {
          scanned += 1;
          if (String(session.metadata?.product || "") !== "amem") continue;
          if (String(session.payment_status || "") !== "paid") continue;
          const tier = normalizeTier(session.metadata?.tier);
          if (!tier) continue;
          const created = Number(session.created) || 0;
          if (tier === "pro") {
            proAll += 1;
            if (created >= cutoff) proWin += 1;
          } else {
            itAll += 1;
            if (created >= cutoff) itWin += 1;
          }
        }
        hasMore = Boolean(res.has_more && res.data?.length);
        startingAfter = res.data?.length ? res.data[res.data.length - 1].id : undefined;
      }
    } catch (listErr) {
      const msg = listErr instanceof Error ? listErr.message : String(listErr);
      const value = {
        ...empty,
        source: "error",
        note: `Stripe sales lookup failed: ${msg}`,
      };
      cache = { at: Date.now(), days, value };
      return value;
    }
    void searchErr;
  }

  const value = {
    pro: { all: proAll, window: proWin },
    it: { all: itAll, window: itWin },
    total: { all: proAll + itAll, window: proWin + itWin },
    windowDays: days,
    source: "stripe",
    scanned,
    note: "Paid Checkout sessions with metadata product=amem (no buyer PII).",
  };
  cache = { at: Date.now(), days, value };
  return value;
}

/** @internal */
export function _resetSalesCacheForTests() {
  cache = null;
}
