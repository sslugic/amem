import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

const PASS = "correct horse battery staple";

async function seedClaims(repoDir, texts) {
  const { upsertRepo } = await import("../dist/db.js");
  const { detectRepoIdentity } = await import("../dist/repo-identity.js");
  const { applyProposal } = await import("../dist/proposal.js");
  const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
  applyProposal(repo.id, {
    claims: texts.map((text, i) => ({
      id: `claim.v${i}`,
      kind: "constraint",
      text,
      code_anchors: [`src/mod${i}.ts`],
    })),
  });
  return repo;
}

async function claimTexts(repoId) {
  const { listClaims } = await import("../dist/db.js");
  return listClaims(repoId)
    .map((c) => c.text)
    .sort();
}

const mode = (p) => (statSync(p).mode & 0o777).toString(8);

describe("vault: backup and restore", () => {
  it("round-trips an encrypted backup with the facts intact", async () => {
    await withAmemHome(async (home) => {
      const repoDir = makeGitRepo("vault-backup");
      const { createBackup, restoreBackup } = await import("../dist/crypto.js");
      const { closeDb } = await import("../dist/db.js");

      const repo = await seedClaims(repoDir, ["alpha constraint", "beta constraint"]);
      const before = await claimTexts(repo.id);
      assert.equal(before.length, 2);

      closeDb();
      const backup = createBackup({ outDir: join(home, "bk"), passphrase: PASS, label: "test" });
      assert.equal(backup.encrypted, true);
      assert.equal(mode(backup.path), "600", "an encrypted backup must not be world-readable");

      // Prove it is really ciphertext, not a copied SQLite file.
      const blob = readFileSync(backup.path);
      assert.equal(blob.subarray(0, 5).toString(), "AMEM1");
      assert.doesNotMatch(blob.subarray(0, 16).toString("latin1"), /SQLite/);
      assert.equal(blob.includes(Buffer.from("alpha constraint")), false, "plaintext leaked");

      // Diverge the live DB so a no-op restore cannot pass by accident.
      await seedClaims(repoDir, ["alpha constraint", "beta constraint", "gamma added later"]);
      assert.equal((await claimTexts(repo.id)).length, 3);

      closeDb();
      const restored = restoreBackup({ file: backup.path, passphrase: PASS });
      closeDb();
      assert.equal(restored.encrypted, true);
      assert.deepEqual(await claimTexts(repo.id), before, "restore must bring back exactly the backup");
    });
  });

  it("keeps a safety copy of the database it overwrites", async () => {
    await withAmemHome(async (home) => {
      const repoDir = makeGitRepo("vault-safety");
      const { createBackup, restoreBackup } = await import("../dist/crypto.js");
      const { closeDb } = await import("../dist/db.js");

      const repo = await seedClaims(repoDir, ["original fact"]);
      closeDb();
      const backup = createBackup({ outDir: join(home, "bk"), passphrase: PASS });

      await seedClaims(repoDir, ["original fact", "fact added after the backup"]);
      closeDb();

      const restored = restoreBackup({ file: backup.path, passphrase: PASS });
      closeDb();
      // Restoring is destructive, so the pre-restore state must be recoverable.
      assert.ok(restored.safetyCopy, "restore must leave a safety copy");
      assert.ok(existsSync(restored.safetyCopy));

      const recovered = restoreBackup({ file: restored.safetyCopy });
      closeDb();
      assert.ok(
        (await claimTexts(repo.id)).includes("fact added after the backup"),
        "the safety copy must actually restore the overwritten state",
      );
      assert.equal(recovered.encrypted, false);
    });
  });

  it("refuses a wrong passphrase without touching the live database", async () => {
    await withAmemHome(async (home) => {
      const repoDir = makeGitRepo("vault-wrongpass");
      const { createBackup, restoreBackup } = await import("../dist/crypto.js");
      const { closeDb } = await import("../dist/db.js");

      const repo = await seedClaims(repoDir, ["survivor fact"]);
      closeDb();
      const backup = createBackup({ outDir: join(home, "bk"), passphrase: PASS });

      closeDb();
      assert.throws(() => restoreBackup({ file: backup.path, passphrase: "wrong passphrase" }));
      closeDb();
      assert.deepEqual(await claimTexts(repo.id), ["survivor fact"], "live DB must be untouched");
    });
  });

  it("rejects an encrypted backup with no passphrase, and junk files", async () => {
    await withAmemHome(async (home) => {
      const repoDir = makeGitRepo("vault-junk");
      const { createBackup, restoreBackup } = await import("../dist/crypto.js");
      const { closeDb } = await import("../dist/db.js");
      await seedClaims(repoDir, ["a fact"]);
      closeDb();

      const backup = createBackup({ outDir: join(home, "bk"), passphrase: PASS });
      const prev = process.env.AMEM_PASSPHRASE;
      delete process.env.AMEM_PASSPHRASE;
      try {
        assert.throws(() => restoreBackup({ file: backup.path }), /pass --passphrase/);
      } finally {
        if (prev !== undefined) process.env.AMEM_PASSPHRASE = prev;
      }

      assert.throws(() => restoreBackup({ file: join(home, "nope.db") }), /Backup not found/);

      const empty = join(home, "empty.db");
      writeFileSync(empty, "");
      assert.throws(() => restoreBackup({ file: empty }), /empty or not a database/);
    });
  });

  it("produces a plaintext backup only when no passphrase is given", async () => {
    await withAmemHome(async (home) => {
      const repoDir = makeGitRepo("vault-plain");
      const { createBackup } = await import("../dist/crypto.js");
      const { closeDb } = await import("../dist/db.js");
      await seedClaims(repoDir, ["a fact"]);
      closeDb();

      const plain = createBackup({ outDir: join(home, "bk") });
      assert.equal(plain.encrypted, false);
      assert.ok(plain.path.endsWith(".db"));
      assert.equal(readFileSync(plain.path).subarray(0, 6).toString(), "SQLite");
    });
  });
});

describe("vault: lock and unlock", () => {
  it("round-trips lock/unlock with the facts intact", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("vault-lock");
      const { lockDatabase, unlockDatabase, encryptedDbPath, isDbEncryptedAtRest } = await import(
        "../dist/crypto.js"
      );
      const { closeDb } = await import("../dist/db.js");
      const { dbPath } = await import("../dist/paths.js");

      const repo = await seedClaims(repoDir, ["locked fact one", "locked fact two"]);
      const before = await claimTexts(repo.id);
      closeDb();

      const locked = lockDatabase(PASS);
      assert.ok(existsSync(locked.encPath));
      assert.equal(existsSync(dbPath()), false, "plaintext DB must be removed on lock");
      assert.equal(isDbEncryptedAtRest(), true);
      assert.equal(mode(locked.encPath), "600");
      assert.equal(
        readFileSync(encryptedDbPath()).includes(Buffer.from("locked fact one")),
        false,
        "locked vault must not contain plaintext",
      );

      unlockDatabase(PASS);
      closeDb();
      assert.ok(existsSync(dbPath()));
      assert.deepEqual(await claimTexts(repo.id), before);
    });
  });

  it("removes WAL/SHM sidecars that survived an unclean shutdown", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("vault-wal");
      const { lockDatabase } = await import("../dist/crypto.js");
      const { closeDb } = await import("../dist/db.js");
      const { dbPath } = await import("../dist/paths.js");

      await seedClaims(repoDir, ["fact whose page sits in the wal"]);
      closeDb();

      // A clean close checkpoints and deletes these, so recreate what a crash would leave:
      // sidecars holding plaintext pages next to a vault the user thinks is locked.
      const wal = `${dbPath()}-wal`;
      const shm = `${dbPath()}-shm`;
      writeFileSync(wal, "fact whose page sits in the wal");
      writeFileSync(shm, "shared memory index");
      assert.ok(existsSync(wal) && existsSync(shm), "precondition: sidecars exist");

      lockDatabase(PASS);
      assert.equal(existsSync(wal), false, "plaintext -wal must not survive lock");
      assert.equal(existsSync(shm), false, "-shm must not survive lock");
    });
  });

  it("does not unlock with the wrong passphrase", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("vault-lock-wrong");
      const { lockDatabase, unlockDatabase } = await import("../dist/crypto.js");
      const { closeDb } = await import("../dist/db.js");
      const { dbPath } = await import("../dist/paths.js");

      await seedClaims(repoDir, ["secret fact"]);
      closeDb();
      lockDatabase(PASS);

      assert.throws(() => unlockDatabase("not the passphrase"));
      assert.equal(existsSync(dbPath()), false, "a failed unlock must not leave a plaintext DB");
    });
  });

  it("copies an already-locked vault without silently decrypting it", async () => {
    await withAmemHome(async (home) => {
      const repoDir = makeGitRepo("vault-locked-backup");
      const { lockDatabase, createBackup } = await import("../dist/crypto.js");
      const { closeDb } = await import("../dist/db.js");

      await seedClaims(repoDir, ["fact behind the lock"]);
      closeDb();
      lockDatabase(PASS);

      const backup = createBackup({ outDir: join(home, "bk") });
      assert.equal(backup.encrypted, true, "backing up a locked vault must stay encrypted");
      const blob = readFileSync(backup.path);
      assert.equal(blob.subarray(0, 5).toString(), "AMEM1");
      assert.equal(blob.includes(Buffer.from("fact behind the lock")), false);
    });
  });

  it("requires a non-empty passphrase", async () => {
    await withAmemHome(async () => {
      const { resolvePassphrase, fingerprintPassphrase } = await import("../dist/crypto.js");
      const prev = process.env.AMEM_PASSPHRASE;
      delete process.env.AMEM_PASSPHRASE;
      try {
        for (const bad of [undefined, "", "   "]) {
          assert.throws(() => resolvePassphrase(bad), /Passphrase required/);
        }
        assert.equal(resolvePassphrase(PASS), PASS);
        process.env.AMEM_PASSPHRASE = "from-env";
        assert.equal(resolvePassphrase(), "from-env");
      } finally {
        if (prev === undefined) delete process.env.AMEM_PASSPHRASE;
        else process.env.AMEM_PASSPHRASE = prev;
      }

      // The fingerprint is shown in the UI, so it must not be reversible to the passphrase.
      const fp = fingerprintPassphrase(PASS);
      assert.equal(fp.length, 12);
      assert.equal(fp, fingerprintPassphrase(PASS));
      assert.notEqual(fp, fingerprintPassphrase(`${PASS} `));
      assert.doesNotMatch(fp, /horse/);
    });
  });
});
