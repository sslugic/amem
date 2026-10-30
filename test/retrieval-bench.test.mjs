import { it } from "node:test";
import assert from "node:assert/strict";
import { runBench } from "../scripts/bench-retrieval.mjs";

// Floors a little under today's numbers (prompt 88% / 97% / 0%): a ranking change that
// drops below them made retrieval worse, whatever else it fixed.
it("retrieval benchmark stays above its floors", async () => {
  const r = await runBench();
  assert.ok(r.prompt.hitAt1 >= 0.85, `prompt hook right-first ${r.prompt.hitAt1}`);
  assert.ok(r.prompt.recallAt3 >= 0.93, `prompt hook top-3 ${r.prompt.recallAt3}`);
  assert.equal(r.prompt.falseInjectionRate, 0, "vague prompts get no memory");
  assert.ok(r.context.hitAt1 >= 0.78, `amem_context right-first ${r.context.hitAt1}`);
  assert.ok(r.context.recallAt3 >= 0.9, `amem_context top-3 ${r.context.recallAt3}`);
});
