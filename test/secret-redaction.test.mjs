import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { makeGitRepo, root } from "./helpers.mjs";

const cli = join(root, "dist", "cli.js");
const { looksLikeSecretValue, redactSecrets } = await import("../dist/secret-detect.js");

const b64 = Buffer.from(Array.from({ length: 48 }, (_, i) => (i * 37 + 11) % 256)).toString("base64");
const GOOGLE_KEY = "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY";

const SECRETS = {
  "unlabelled AWS secret": "AWS creds for prod: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "named AWS secret": "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "letters-only api key": "api_key: abcdefghijklmnopqrstuvwxyzABCDEF",
  "Google API key": `Maps uses ${GOOGLE_KEY}`,
  "npm token": "publish with npm_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  "password in a URL": "DB is postgres://admin:Hunter2Secret99@db.internal:5432/app",
  "Slack webhook": "alerts go to https://hooks.slack.com/services/T0001/B0002/XXXXXXXXXXXXXXXXXXXXXXXX",
  "raw base64 blob": `the signing key is ${b64}`,
  "PEM body without header": "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
  "token on the next line": "token=\nghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
  "Anthropic key": "key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  "Stripe live key": "sk_live_51HxYzAbCdEfGh",
  "JSON secret field": '{"client_secret": "Zx9vQ2mK8pL4wN7rT1yU"}',
  "password in prose": "the password is Tr0ub4dor&3xyz",
  "OpenSSH key header": "-----BEGIN OPENSSH PRIVATE KEY-----",
  "Basic auth header": "Authorization: Basic YWRtaW46c3VwZXJzZWNyZXRwYXNzd29yZA==",
  "service account key id": '"private_key_id": "8f3b2c1d9e7a6f5b4c3d2e1f0a9b8c7d6e5f4a3b"',
};

const BENIGN = {
  "env var name only": "Set STRIPE_SECRET_KEY from GCP Secret Manager before running the webhook tests.",
  "token budget": "The hook token budget is 2400 characters, enforced in src/hook.ts cap().",
  "password policy": "password: minimum12chars rule lives in src/auth/policy.ts and is enforced server side",
  "commit sha": "Fix landed in commit 6809c4c1a2b3d4e5f60718293a4b5c6d7e8f9012 on main branch today.",
  "slack link": "Thread: https://acme.slack.com/archives/C0AJ5K2LMNP/p1761234567890123 has the context.",
  "tool use id": "<tool-use-id>toolu_01Qz2Lz1ytqdhToRTc8kKn61</tool-use-id>",
  "long path": "Scratch lives in /Users/me/Library/Application Support/Claude/scratch-workspaces/36217893-9785-4af9",
  "camelCase identifier": "The socialSecurityNumberField1 column is masked in the admin UI.",
};

describe("secret detection", () => {
  for (const [name, text] of Object.entries(SECRETS)) {
    it(`catches: ${name}`, () => {
      assert.equal(looksLikeSecretValue(text), true);
      assert.ok(redactSecrets(text).includes("[REDACTED]"), redactSecrets(text));
    });
  }
  for (const [name, text] of Object.entries(BENIGN)) {
    it(`leaves alone: ${name}`, () => {
      assert.equal(looksLikeSecretValue(text), false);
      assert.equal(redactSecrets(text), text);
    });
  }

  it("redacts the value and keeps the name", () => {
    assert.equal(redactSecrets("api_key: abc123def456ghi789"), "api_key: [REDACTED]");
    assert.equal(redactSecrets("postgres://admin:Hunter2Secret99@db:5432"), "postgres://admin:[REDACTED]@db:5432");
  });
});

function dbBytes(home) {
  return ["graph.db", "graph.db-wal"]
    .map((f) => join(home, ".amem", f))
    .filter(existsSync)
    .map((p) => readFileSync(p).toString("latin1"))
    .join("");
}

describe("secrets never reach the database", () => {
  it("a prompt with a Google key is stored redacted, not dropped", () => {
    const home = mkdtempSync(join(tmpdir(), "amem-secret-home-"));
    const repo = makeGitRepo();
    try {
      const env = { ...process.env, HOME: home, USERPROFILE: home, AMEM_HOME: join(home, ".amem"), CLAUDE_PROJECT_DIR: repo };
      delete env.AMEM_WORKSPACE;
      execFileSync(process.execPath, [cli, "init", "--platform", "claude"], { cwd: repo, env, stdio: "ignore" });
      execFileSync(process.execPath, [cli, "hook"], {
        cwd: repo,
        env,
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          cwd: repo,
          session_id: "s1",
          prompt: `Why does the maps widget fail with key ${GOOGLE_KEY} on staging?`,
        }),
      });

      assert.ok(!dbBytes(home).includes(GOOGLE_KEY), "the key must not be anywhere in graph.db");
      const db = new Database(join(home, ".amem", "graph.db"), { readonly: true });
      const notes = db.prepare("SELECT text FROM conversation_notes").all().map((r) => r.text);
      db.close();
      assert.ok(notes.some((t) => t.includes("maps widget") && t.includes("[REDACTED]")), notes.join("\n"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("upgrading redacts secrets stored by older versions", () => {
    const home = mkdtempSync(join(tmpdir(), "amem-secret-upgrade-"));
    const repo = makeGitRepo();
    try {
      const env = { ...process.env, HOME: home, USERPROFILE: home, AMEM_HOME: join(home, ".amem") };
      delete env.AMEM_WORKSPACE;
      execFileSync(process.execPath, [cli, "init", "--platform", "claude"], { cwd: repo, env, stdio: "ignore" });
      const path = join(home, ".amem", "graph.db");
      let db = new Database(path);
      const repoId = db.prepare("SELECT id FROM repos").get().id;
      db.prepare(
        "INSERT INTO conversation_notes (id, repo_id, platform, session_id, role, text, created_at) VALUES ('note_old', ?, 'claude', NULL, 'user', ?, ?)",
      ).run(repoId, `old prompt with ${GOOGLE_KEY} inside`, new Date().toISOString());
      db.pragma("user_version = 1");
      db.close();

      execFileSync(process.execPath, [cli, "status"], { cwd: repo, env, stdio: "ignore" });

      db = new Database(path, { readonly: true });
      const { text } = db.prepare("SELECT text FROM conversation_notes WHERE id = 'note_old'").get();
      db.close();
      assert.equal(text, "old prompt with [REDACTED] inside");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
