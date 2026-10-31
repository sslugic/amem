import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./helpers.mjs";

const { isFactLike, nonFactReason } = await import("../dist/kinds.js");

/**
 * facts-corpus.json is the tuning set; heldout/facts-heldout.json was written separately
 * and first scored after tuning (22/23 facts, 28/28 noise). Both are regression sets now.
 */
const fixtures = join(root, "test", "fixtures");
for (const file of ["facts-corpus.json", join("heldout", "facts-heldout.json")]) {
  const { facts, noise } = JSON.parse(readFileSync(join(fixtures, file), "utf8"));
  describe(`fact corpus ${file}`, () => {
    it(`admits all ${facts.length} facts, whatever word they open with`, () => {
      assert.deepEqual(facts.filter((s) => !isFactLike(s)), []);
    });
    it(`rejects all ${noise.length} chatter lines, even ones that name files`, () => {
      assert.deepEqual(noise.filter((s) => isFactLike(s)), []);
    });
    it("never deletes a fact, and only deletes what it would also refuse to admit", () => {
      assert.deepEqual(facts.filter((s) => nonFactReason(s)), []);
      assert.deepEqual([...facts, ...noise].filter((s) => nonFactReason(s) && isFactLike(s)), []);
    });
  });
}
