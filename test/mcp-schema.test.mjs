import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAmemHome } from "./helpers.mjs";

/**
 * A client that trusts inputSchema must not be surprised: every argument a handler
 * refuses to run without ("X is required") is listed in that tool's `required`, and a
 * tool with no required arguments says so on purpose (`required: []` plus a note).
 */
describe("MCP tool schemas", () => {
  it("lists every argument a handler requires, and marks optional-only tools explicitly", async () => {
    await withAmemHome(async () => {
      const { dispatchMcp } = await import("../dist/mcp.js");
      const tools = dispatchMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }).result.tools;
      assert.ok(tools.length >= 16);
      for (const tool of tools) {
        const required = tool.inputSchema.required;
        assert.ok(Array.isArray(required), `${tool.name} declares required`);
        for (const r of required) assert.ok(r in tool.inputSchema.properties, `${tool.name}: ${r} has a schema`);
        if (required.length === 0) {
          assert.match(tool.description, /All arguments are optional\.|Takes no arguments\./, `${tool.name} says why nothing is required`);
        }
        const res = dispatchMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool.name, arguments: {} } }).result;
        const text = res.content?.map((c) => c.text).join(" ") ?? "";
        for (const m of text.matchAll(/\b([a-z_]+) (?:\([a-z]+\) )?is required/g)) {
          assert.ok(required.includes(m[1]), `${tool.name} refuses without ${m[1]} but does not list it in required`);
        }
        if (required.length > 0) assert.equal(res.isError, true, `${tool.name} must refuse an empty call`);
      }
    });
  });
});
