import assert from "node:assert/strict";
import test from "node:test";
import { getSalesStats, _resetSalesCacheForTests } from "../shop/sales.mjs";

test("getSalesStats returns empty shape when Stripe key missing", async () => {
  _resetSalesCacheForTests();
  const prev = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const stats = await getSalesStats({ days: 7 });
  assert.equal(stats.source, "none");
  assert.equal(stats.pro.all, 0);
  assert.equal(stats.it.all, 0);
  assert.equal(stats.total.window, 0);
  if (prev == null) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = prev;
  _resetSalesCacheForTests();
});
