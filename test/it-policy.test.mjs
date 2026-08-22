import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withAmemHome, installTestLicense, root } from "./helpers.mjs";

const TEMPLATE = join(root, "templates", "policy.deny-default.toml");

/** Load the shipped deny-default policy the way a managed fleet would. */
async function withDenyDefault(fn) {
  const prev = process.env.AMEM_POLICY_PATH;
  process.env.AMEM_POLICY_PATH = TEMPLATE;
  const policy = await import("../dist/policy.js");
  policy.clearPolicyCache?.();
  try {
    return await fn(policy, policy.loadPolicy(true));
  } finally {
    if (prev === undefined) delete process.env.AMEM_POLICY_PATH;
    else process.env.AMEM_POLICY_PATH = prev;
    policy.clearPolicyCache?.();
  }
}

describe("IT deny-default policy (shipped to customers)", () => {
  it("parses cleanly with no source errors", async () => {
    await withAmemHome(async () => {
      await withDenyDefault(async (_policy, loaded) => {
        for (const src of loaded.sources) {
          assert.equal(src.error, undefined, `source ${src.role} failed: ${src.error}`);
        }
        assert.ok(
          loaded.sources.some((s) => s.role === "env" && s.applied),
          "the policy under test must actually be applied",
        );
      });
    });
  });

  it("enforces the posture its comments promise", async () => {
    await withAmemHome(async () => {
      await withDenyDefault(async (_policy, loaded) => {
        const p = loaded.policy;
        assert.equal(p.telemetry, false, "telemetry must stay off");
        assert.equal(p.ui_bind, "127.0.0.1", "UI must bind loopback only");
        assert.equal(p.allow_export, false, "export must be denied by default");
        assert.deepEqual(p.allowed_platforms, ["cursor", "claude"]);
        assert.deepEqual(p.auto_apply_kinds, [], "managed fleets must approve every draft");
      });
    });
  });

  it("actually refuses platforms outside the allow-list", async () => {
    await withAmemHome(async () => {
      await withDenyDefault(async (policy, loaded) => {
        for (const allowed of ["cursor", "claude"]) {
          assert.doesNotThrow(
            () => policy.assertPlatformAllowed(allowed, loaded.policy),
            `${allowed} should be allowed`,
          );
        }
        for (const blocked of ["luna", "windsurf", "continue", "zed"]) {
          assert.throws(
            () => policy.assertPlatformAllowed(blocked, loaded.policy),
            /blocked by policy\.allowed_platforms/,
            `${blocked} should be refused`,
          );
        }
      });
    });
  });

  it("blocks export while leaving the local UI usable", async () => {
    await withAmemHome(async () => {
      await withDenyDefault(async (policy, loaded) => {
        assert.throws(
          () => policy.assertExportAllowed(loaded.policy),
          /allow_export = false/,
          "deny-default must block export",
        );
        // ui_enabled stays true: the point is loopback-only, not unusable.
        assert.doesNotThrow(() => policy.assertUiAllowed(loaded.policy));
      });
    });
  });

  it("keeps the builtin secret deny patterns on top of the file", async () => {
    await withAmemHome(async () => {
      await withDenyDefault(async (policy, loaded) => {
        const effective = policy.effectiveDenyPatterns(loaded.policy);
        for (const builtin of policy.BUILTIN_DENY_CLAIM_PATTERNS) {
          assert.ok(
            effective.includes(builtin),
            `deploying a policy file must not drop builtin pattern ${builtin}`,
          );
        }
      });
    });
  });

  it("ships the deny-default file itself, not the permissive example", async () => {
    await withAmemHome(async (home) => {
      const { writeItPack } = await import("../dist/it-pack.js");
      await installTestLicense("it");
      const pack = writeItPack(join(home, "pack"));
      const shipped = readFileSync(join(pack.dir, "policy.toml"), "utf8");

      // A silent fallback to policy.example.toml would hand fleets a permissive config.
      assert.equal(shipped, readFileSync(TEMPLATE, "utf8"), "pack must carry the deny-default");
      assert.match(shipped, /allow_export\s*=\s*false/);
      assert.match(shipped, /auto_apply_kinds\s*=\s*\[\]/);

      const example = readFileSync(join(root, "templates", "policy.example.toml"), "utf8");
      assert.notEqual(shipped, example);
      rmSync(pack.dir, { recursive: true, force: true });
    });
  });

  it("rejects a malformed policy file loudly rather than silently mis-parsing", async () => {
    await withAmemHome(async () => {
      const policy = await import("../dist/policy.js");
      assert.throws(() => policy.parsePolicyToml("this is [not valid"), /Invalid policy line 1/);
    });
  });

  it("fails CLOSED on a broken policy file instead of relaxing to defaults", async () => {
    await withAmemHome(async (home) => {
      const broken = join(home, "broken-policy.toml");
      writeFileSync(broken, "this is [not valid\n", "utf8");
      const prev = process.env.AMEM_POLICY_PATH;
      process.env.AMEM_POLICY_PATH = broken;
      const policy = await import("../dist/policy.js");
      policy.clearPolicyCache?.();
      try {
        const loaded = policy.loadPolicy(true);
        const env = loaded.sources.find((s) => s.role === "env");
        assert.equal(env.applied, false, "a broken file must not be half-applied");
        assert.match(env.error, /Invalid policy line/);

        // The whole point: a typo in a deny-default deployment must not hand back
        // allow_export, which is what the permissive defaults would have done.
        assert.equal(loaded.policy.allow_export, false, "export must stay denied");
        assert.throws(() => policy.assertExportAllowed(loaded.policy), /allow_export = false/);
        assert.deepEqual(loaded.policy.auto_apply_kinds, [], "no unattended auto-apply");

        // Hosts stay usable — clamping these would brick the tool, not protect anything.
        assert.doesNotThrow(() => policy.assertPlatformAllowed("cursor", loaded.policy));

        const { buildAttestReport } = await import("../dist/attest.js");
        const report = buildAttestReport(process.cwd());
        assert.ok(
          report.issues.some((i) => /Policy env .*Invalid policy line/.test(i)),
          `attest must report the broken policy, got ${JSON.stringify(report.issues)}`,
        );
        assert.equal(report.ok, false, "a broken fleet policy must fail the attestation");
      } finally {
        if (prev === undefined) delete process.env.AMEM_POLICY_PATH;
        else process.env.AMEM_POLICY_PATH = prev;
        policy.clearPolicyCache?.();
      }
    });
  });

  it("fails CLOSED when AMEM_POLICY_PATH points at a missing file", async () => {
    await withAmemHome(async (home) => {
      const prev = process.env.AMEM_POLICY_PATH;
      process.env.AMEM_POLICY_PATH = join(home, "does-not-exist.toml");
      const policy = await import("../dist/policy.js");
      policy.clearPolicyCache?.();
      try {
        const loaded = policy.loadPolicy(true);
        // A typo'd path is the same class of misconfiguration as a typo'd file.
        assert.equal(loaded.policy.allow_export, false);
        assert.ok(loaded.sources.some((s) => s.role === "env" && s.error));
      } finally {
        if (prev === undefined) delete process.env.AMEM_POLICY_PATH;
        else process.env.AMEM_POLICY_PATH = prev;
        policy.clearPolicyCache?.();
      }
    });
  });

  it("leaves export alone when every policy source is healthy", async () => {
    await withAmemHome(async () => {
      const policy = await import("../dist/policy.js");
      policy.clearPolicyCache?.();
      const loaded = policy.loadPolicy(true);
      assert.ok(
        loaded.sources.every((s) => !s.error),
        "baseline must have no broken sources",
      );
      // Guards against the clamp firing on ordinary installs.
      assert.equal(loaded.policy.allow_export, true);
    });
  });
});
