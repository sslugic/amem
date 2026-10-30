import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("secret detection blocks values, not names", () => {
  it("accepts mentions of secret names and references", async () => {
    const { looksLikeSecretValue } = await import("../dist/secret-detect.js");
    for (const text of [
      "Staging reads SUMSUB_MOCK_WEBHOOK_SECRET from GCP secret STAGING_SUMSUB_MOCK_WEBHOOK_SECRET",
      'SUMSUB_MOCK_WEBHOOK_SECRET="$(gcloud secrets versions access latest --secret X)" npm run apply',
      "Set API_KEY=${API_KEY} in CI; the token lives in 1Password",
      "Rotate the webhook secret every quarter",
      "password: {{vault:db_password}}",
      "Commit 0483cbc changed the api key loader",
    ]) {
      assert.equal(looksLikeSecretValue(text), false, text);
    }
  });

  it("rejects literal credentials and known token formats", async () => {
    const { looksLikeSecretValue } = await import("../dist/secret-detect.js");
    for (const text of [
      "API_KEY=sk-live-abcdefghijklmnopqrstuvwx",
      'client_secret: "9f8e7d6c5b4a39281706"',
      "DB_PASSWORD=hunter22",
      "aws key AKIAABCDEFGHIJKLMNOP",
      "slack xoxb-1234567890-abcdefghij",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
    ]) {
      assert.equal(looksLikeSecretValue(text), true, text);
    }
  });

  it("remember accepts a fact that only names a secret", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("secret-names");
      const { upsertRepo } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { handleApi } = await import("../dist/api/routes.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");
      const call = (text) =>
        handleApi({
          method: "POST",
          pathname: "/api/remember",
          searchParams: new URLSearchParams({ repo: repo.id }),
          body: { text, kind: "project" },
          cwd: repoDir,
        }).status;
      assert.equal(call("Staging needs SUMSUB_MOCK_WEBHOOK_SECRET set from the GCP secret before Terraform applies"), 200);
      assert.equal(call("The staging token is TOKEN=abc123def456ghi789 for now"), 400);
    });
  });
});

describe("skills that name secrets", () => {
  it("accepts a procedure that reads a secret from a store", async () => {
    await withAmemHome(async () => {
      const { scanSkillContent } = await import("../dist/skills.js");
      const ok = scanSkillContent(
          "# Apply mock rules\n\nSUMSUB_MOCK_WEBHOOK_SECRET=\"$(gcloud secrets versions access latest --secret X)\" npm run apply\n",
        );
      assert.equal(ok.ok, true, ok.reason);
    });
  });
});

describe("Claude Code hook output", () => {
  it("UserPromptSubmit and SessionStart return hookSpecificOutput.additionalContext", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("claude-hook");
      const { upsertRepo } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { handleApi } = await import("../dist/api/routes.js");
      const { handleHookPayload } = await import("../dist/hook.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");
      handleApi({
        method: "POST",
        pathname: "/api/remember",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: { text: "Billing retries live in src/billing.ts and back off for 30 minutes", kind: "constraint", anchors: ["README.md"] },
        cwd: repoDir,
      });

      const prompt = handleHookPayload(
        JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: repoDir, session_id: "s1", prompt: "How do billing retries back off?" }),
      );
      assert.equal(prompt.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
      assert.match(prompt.hookSpecificOutput.additionalContext, /amem already knows/);

      const start = handleHookPayload(JSON.stringify({ hook_event_name: "SessionStart", cwd: repoDir, session_id: "s1" }));
      assert.equal(start.hookSpecificOutput?.hookEventName, "SessionStart");
      assert.match(start.hookSpecificOutput.additionalContext, /^Before answering anything that builds on earlier work, check amem/);

      const cursor = handleHookPayload(
        JSON.stringify({ hook_event_name: "beforeSubmitPrompt", cwd: repoDir, session_id: "s2", prompt: "How do billing retries back off?" }),
      );
      assert.equal(cursor.hookSpecificOutput, undefined);
      assert.match(cursor.additional_context, /amem already knows/);
    });
  });
});

function transcriptLine(...tools) {
  return `${JSON.stringify({
    type: "assistant",
    message: { content: tools.map((name) => ({ type: "tool_use", name, input: {} })) },
  })}\n`;
}

describe("stop checkpoint", () => {
  it("classifies tools", async () => {
    const { isMutatingTool, needsCheckpoint } = await import("../dist/checkpoint.js");
    assert.equal(isMutatingTool("Read"), false);
    assert.equal(isMutatingTool("mcp__amem__amem_remember"), false);
    assert.equal(isMutatingTool("mcp__testera__testera_list_mock_state"), false);
    assert.equal(isMutatingTool("Edit"), true);
    assert.equal(isMutatingTool("Bash"), true);
    assert.equal(isMutatingTool("mcp__testera__testera_create_mock_rule"), true);
    assert.equal(isMutatingTool("mcp__atlassian__getJiraIssue"), false);
    assert.equal(isMutatingTool("mcp__atlassian__transitionJiraIssue"), true);
    assert.equal(isMutatingTool("mcp__slack__slack_send_message"), true);
    assert.equal(needsCheckpoint(["Read", "Grep"]), false);
    assert.equal(needsCheckpoint(["Edit", "mcp__amem__amem_remember"]), false);
    assert.equal(needsCheckpoint(["mcp__amem__amem_remember", "Bash"]), true);
  });

  it("counts an amem CLI save from a shell tool as a save", async () => {
    const { toolCallsInTranscript, needsCheckpoint } = await import("../dist/checkpoint.js");
    const line = (name, command) =>
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input: command ? { command } : {} }] } })}\n`;
    const saved = toolCallsInTranscript(
      line("Edit") + line("Bash", '~/.local/bin/amem remember "2026-10-23 worklog (done): shipped" --workspace personal'),
    );
    assert.deepEqual(saved, ["Edit", "amem_cli_save"]);
    assert.equal(needsCheckpoint(saved), false);
    const notSaved = toolCallsInTranscript(
      line("Bash", "amem context 'billing'") + line("Bash", "git commit -m 'remember to amem'"),
    );
    assert.equal(needsCheckpoint(notSaved), true);
  });

  it("does not ask for a save after shell commands that only read", async () => {
    const { toolCallsInTranscript, needsCheckpoint, isMutatingShell } = await import("../dist/checkpoint.js");
    const line = (command) =>
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } })}\n`;
    const reads = ["git status", "gh pr checks 23 --watch", "curl -s https://api.npmjs.org/x | grep a", "npm test 2>&1 | tail", "ls 2>/dev/null"];
    assert.equal(needsCheckpoint(toolCallsInTranscript(reads.map(line).join(""))), false);
    for (const cmd of reads) assert.equal(isMutatingShell(cmd), false, cmd);
    for (const cmd of [
      "gh pr merge 23 --squash",
      "git push origin main",
      "npm publish",
      "sed -i '' s/a/b/ f",
      "echo x > out.txt",
      "python3 - <<'EOF'",
      "aws apprunner start-deployment --region us-east-1",
      "curl -X POST https://example.com",
    ]) {
      assert.equal(isMutatingShell(cmd), true, cmd);
    }
  });

  it("blocks once per changed window, never when off or already continuing", async () => {
    await withAmemHome(async () => {
      const { stopCheckpoint } = await import("../dist/checkpoint.js");
      const dir = mkdtempSync(join(tmpdir(), "amem-transcript-"));
      const path = join(dir, "t.jsonl");
      writeFileSync(path, transcriptLine("Read", "Grep"));
      const base = { sessionId: "sess-1", transcriptPath: path, enabled: true };

      assert.equal(stopCheckpoint(base), null, "read-only turn");
      appendFileSync(path, transcriptLine("Edit"));
      assert.equal(stopCheckpoint({ ...base, enabled: false }), null, "disabled");
      assert.equal(stopCheckpoint(base)?.decision, "block", "edit since last stop");
      appendFileSync(path, transcriptLine("mcp__amem__amem_remember"));
      assert.equal(stopCheckpoint({ ...base, stopHookActive: true }), null, "continuing from hook");
      appendFileSync(path, transcriptLine("Bash", "mcp__amem__amem_remember"));
      assert.equal(stopCheckpoint(base), null, "saved after the change");
      appendFileSync(path, transcriptLine("Read"));
      assert.equal(stopCheckpoint(base), null, "nothing new");
    });
  });
});
