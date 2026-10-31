import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./helpers.mjs";

const { looksLikeSecretValue, redactSecrets, REDACTED } = await import("../dist/secret-detect.js");

/**
 * secrets-corpus.json is the tuning set. heldout/secrets-heldout*.json were written
 * separately and scored before any change was made against them; a held-out set that has
 * been looked at stays here as a regression set, and a fresh one replaces it.
 * Positives are stored base64-encoded so the fake secrets never sit verbatim in git.
 */
const fixtures = join(root, "test", "fixtures");
const files = [
  join(fixtures, "secrets-corpus.json"),
  ...readdirSync(join(fixtures, "heldout"))
    .filter((f) => f.startsWith("secrets-"))
    .map((f) => join(fixtures, "heldout", f)),
];

for (const file of files) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const positives = raw.positives_b64.map((b) => Buffer.from(b, "base64").toString("utf8"));
  const negatives = raw.negatives;
  describe(`secret corpus ${file.slice(fixtures.length + 1)}`, () => {
    it(`blocks and redacts all ${positives.length} secrets`, () => {
      const leaks = positives.filter((s) => !looksLikeSecretValue(s) || !redactSecrets(s).includes(REDACTED));
      assert.deepEqual(leaks, []);
    });
    it(`stores all ${negatives.length} look-alikes unchanged`, () => {
      const blocked = negatives.filter((s) => looksLikeSecretValue(s) || redactSecrets(s) !== s);
      assert.deepEqual(blocked, []);
    });
  });
}
