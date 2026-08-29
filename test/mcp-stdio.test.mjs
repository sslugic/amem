import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./helpers.mjs";

const cli = join(root, "dist", "cli.js");

const rpc = (id, method, params) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

const lspFrame = (body) => `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;

/** Decode whichever framing the server replied with. */
function decode(raw) {
  const msgs = [];
  let rest = raw;
  while (rest.length) {
    const header = /^Content-Length:\s*(\d+)\r?\n\r?\n/i.exec(rest);
    if (header) {
      const start = header[0].length;
      const len = Number(header[1]);
      msgs.push({ framing: "lsp", msg: JSON.parse(rest.slice(start, start + len)) });
      rest = rest.slice(start + len);
      continue;
    }
    const nl = rest.indexOf("\n");
    const line = (nl === -1 ? rest : rest.slice(0, nl)).trim();
    rest = nl === -1 ? "" : rest.slice(nl + 1);
    if (line) msgs.push({ framing: "ndjson", msg: JSON.parse(line) });
  }
  return msgs;
}

/**
 * Spawn the real `amem mcp` server and feed it stdin in caller-controlled chunks,
 * which is the only way to exercise the buffering in runMcpServer.
 */
async function mcpSession(writes) {
  const home = mkdtempSync(join(tmpdir(), "amem-mcp-"));
  const child = spawn(process.execPath, [cli, "mcp"], {
    env: { ...process.env, AMEM_HOME: home, HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let errOut = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (errOut += d));

  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    for (const w of writes) {
      if (typeof w === "number") await new Promise((r) => setTimeout(r, w));
      else child.stdin.write(w);
    }
    child.stdin.end();
    const code = await new Promise((res) => child.on("close", res));
    return { messages: decode(out), raw: out, stderr: errOut, code };
  } finally {
    clearTimeout(timer);
    rmSync(home, { recursive: true, force: true });
  }
}

describe("MCP stdio transport", () => {
  it("answers newline-delimited requests in order", async () => {
    const { messages, code } = await mcpSession([
      `${rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {} })}\n`,
      `${rpc(2, "tools/list")}\n`,
      `${rpc(3, "ping")}\n`,
    ]);
    assert.equal(code, 0, "server should exit cleanly when stdin closes");
    assert.deepEqual(
      messages.map((m) => m.msg.id),
      [1, 2, 3],
    );
    assert.ok(messages.every((m) => m.framing === "ndjson"));
    assert.equal(messages[0].msg.result.serverInfo.name, "amem");
    const names = messages[1].msg.result.tools.map((t) => t.name);
    for (const t of ["amem_context", "amem_remember", "amem_status", "amem_task_list", "amem_task_add"]) {
      assert.ok(names.includes(t), `tools/list should expose ${t}`);
    }
  });

  it("speaks Content-Length framing and replies in kind", async () => {
    const { messages } = await mcpSession([
      lspFrame(rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {} })),
      lspFrame(rpc(2, "tools/list")),
    ]);
    assert.equal(messages.length, 2);
    // Replying in ndjson to an LSP-framed client is what silently breaks editors.
    assert.ok(messages.every((m) => m.framing === "lsp"), "must echo the client's framing");
    assert.deepEqual(
      messages.map((m) => m.msg.id),
      [1, 2],
    );
  });

  it("buffers a request split across chunk boundaries", async () => {
    const body = rpc(1, "tools/list");
    const cut = Math.floor(body.length / 2);
    const { messages } = await mcpSession([body.slice(0, cut), 60, `${body.slice(cut)}\n`]);
    assert.equal(messages.length, 1, "a split message must still be answered once");
    assert.equal(messages[0].msg.id, 1);
    assert.ok(Array.isArray(messages[0].msg.result.tools));
  });

  it("buffers an LSP body split away from its header", async () => {
    const body = rpc(7, "ping");
    const framed = lspFrame(body);
    const cut = framed.indexOf("\r\n\r\n") + 4 + 3;
    const { messages } = await mcpSession([framed.slice(0, cut), 60, framed.slice(cut)]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].msg.id, 7);
    assert.equal(messages[0].framing, "lsp");
  });

  it("handles several requests arriving in a single chunk", async () => {
    const { messages } = await mcpSession([
      `${rpc(1, "ping")}\n${rpc(2, "ping")}\n${rpc(3, "tools/list")}\n`,
    ]);
    assert.deepEqual(
      messages.map((m) => m.msg.id),
      [1, 2, 3],
    );
  });

  it("skips a malformed line without dropping the connection", async () => {
    const { messages, code } = await mcpSession([
      "{ this is not json }\n",
      `${rpc(2, "ping")}\n`,
    ]);
    assert.equal(code, 0, "a bad line must not crash the server");
    assert.deepEqual(
      messages.map((m) => m.msg.id),
      [2],
      "only the well-formed request gets a reply",
    );
  });

  it("stays silent on notifications", async () => {
    const { messages, code } = await mcpSession([
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      `${rpc(9, "ping")}\n`,
    ]);
    assert.equal(code, 0);
    // A response to a notification is a protocol violation and confuses strict clients.
    assert.deepEqual(
      messages.map((m) => m.msg.id),
      [9],
    );
  });

  it("returns a JSON-RPC error for an unknown method instead of hanging", async () => {
    const { messages } = await mcpSession([`${rpc(4, "does/notExist")}\n`]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].msg.id, 4);
    assert.ok(messages[0].msg.error, "unknown methods must produce an error object");
    assert.equal(typeof messages[0].msg.error.code, "number");
  });

  it("keeps stdout free of anything that is not a protocol message", async () => {
    const { raw } = await mcpSession([`${rpc(1, "tools/list")}\n`]);
    // Stray logging on stdout corrupts the stream for the client.
    for (const line of raw.split("\n").filter(Boolean)) {
      assert.doesNotThrow(
        () => JSON.parse(line),
        `stdout carried non-protocol output: ${line.slice(0, 80)}`,
      );
    }
  });
});
