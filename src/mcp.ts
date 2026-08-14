import { existsSync } from "node:fs";
import { handleApi } from "./api/routes.js";
import { getRepoByName } from "./db.js";

export type JsonRpc = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
};

type Framing = "ndjson" | "lsp";

const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

const TOOLS = [
  {
    name: "amem_context",
    description:
      "Retrieve compact local amem memory for a query. Use before exploring files or calling a remote LLM with a large prompt. Pass workspace for named app memory, not only git repos.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        workspace: { type: "string", description: "Named workspace (not a git repo)" },
        platform: { type: "string" },
        sessionId: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "amem_remember",
    description: "Store a durable local fact in amem (stays on this machine).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        workspace: { type: "string" },
        kind: { type: "string" },
        anchors: { type: "array", items: { type: "string" } },
      },
      required: ["text"],
    },
  },
  {
    name: "amem_repos",
    description:
      "List what amem is monitoring. Each item has kind git or workspace. Workspaces also have a stable slug (MCP id); the display name can differ. Use when asked which projects, workspaces, or repos amem knows about.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "all (default), git, or workspace",
        },
      },
    },
  },
  {
    name: "amem_stats",
    description:
      "Usage and savings stats (local lookup time, estimated tokens/ms saved, hit rate) for one workspace/repo or everything. Use when asked how much amem helped, how often it hit, or usage over time.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string" },
        days: { type: "number", description: "Lookback window (default 30)" },
        scope: {
          type: "string",
          description: "all (every tracked repo/workspace) or current (the given workspace / cwd)",
        },
      },
    },
  },
  {
    name: "amem_graph",
    description:
      "Dump stored facts for a workspace or git repo: claims, components, flows, and recent activity. Use when asked what amem remembers about a project. Prefer amem_context for a ranked packet for the current question.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string" },
        days: { type: "number", description: "Activity lookback (default 30)" },
      },
    },
  },
  {
    name: "amem_status",
    description:
      "Binding, policy, and counts for one workspace/repo, plus the full monitored inventory. Omit workspace for a machine-wide overview.",
    inputSchema: {
      type: "object",
      properties: { workspace: { type: "string" } },
    },
  },
];

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

function defaultWorkspace(explicit?: unknown, fallback?: string): string | undefined {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  if (fallback?.trim()) return fallback.trim();
  return process.env.AMEM_WORKSPACE || undefined;
}

function api(
  method: string,
  pathname: string,
  body: unknown,
  opts?: { workspace?: string; query?: Record<string, string> },
) {
  const searchParams = new URLSearchParams();
  if (opts?.workspace) searchParams.set("workspace", opts.workspace);
  for (const [key, value] of Object.entries(opts?.query ?? {})) {
    if (value) searchParams.set(key, value);
  }
  return handleApi({
    method,
    pathname,
    searchParams,
    body,
    cwd: process.cwd(),
  });
}

function jsonResult(value: unknown, isError = false) {
  return textResult(JSON.stringify(value, null, 2), isError);
}

function apiResult(result: { status: number; body: unknown }) {
  if (result.status >= 400) return jsonResult(result.body, true);
  return jsonResult(result.body);
}

function parseDays(value: unknown, fallback = 30): string {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : fallback;
  if (!Number.isFinite(n) || n <= 0) return String(fallback);
  return String(Math.min(365, Math.floor(n)));
}

function compactGraph(body: unknown) {
  if (!body || typeof body !== "object") return body;
  const g = body as {
    claims?: Array<{ id: string; kind: string; text: string; code_anchors: string }>;
    components?: Array<{ id: string; name: string; code_anchor: string | null }>;
    flows?: Array<{ id: string; name: string }>;
    recentClaimIds?: string[];
    activity?: { nodes?: unknown[]; links?: unknown[] };
  };
  const claims = (g.claims ?? []).slice(0, 80).map((c) => ({
    id: c.id,
    kind: c.kind,
    text: c.text,
    anchors: (() => {
      try {
        return JSON.parse(c.code_anchors) as string[];
      } catch {
        return c.code_anchors;
      }
    })(),
  }));
  return {
    claims,
    claimCount: (g.claims ?? []).length,
    truncated: (g.claims ?? []).length > claims.length,
    components: (g.components ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      anchor: c.code_anchor,
    })),
    flows: g.flows ?? [],
    recentClaimIds: g.recentClaimIds ?? [],
    activity: g.activity,
  };
}

function compactStats(body: unknown) {
  if (!body || typeof body !== "object") return body;
  const s = body as {
    scope?: string;
    days?: number;
    aggregate?: unknown;
    repos?: unknown;
  };
  return {
    scope: s.scope,
    days: s.days,
    aggregate: s.aggregate,
    repos: s.repos,
  };
}

function callTool(name: string, args: Record<string, unknown>, fallbackWorkspace?: string) {
  const workspace = defaultWorkspace(args.workspace, fallbackWorkspace);
  if (name === "amem_context") {
    const query = typeof args.query === "string" ? args.query : "";
    if (!query.trim()) return textResult("query is required", true);
    const result = api(
      "POST",
      "/api/context",
      {
        query,
        workspace,
        platform: typeof args.platform === "string" ? args.platform : "mcp",
        sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
      },
      { workspace },
    );
    if (result.status >= 400) {
      return textResult(JSON.stringify(result.body), true);
    }
    const body = result.body as { markdown?: string };
    return textResult(body.markdown || JSON.stringify(result.body));
  }
  if (name === "amem_remember") {
    const text = typeof args.text === "string" ? args.text : "";
    if (!text.trim()) return textResult("text is required", true);
    const result = api(
      "POST",
      "/api/remember",
      {
        text,
        workspace,
        kind: typeof args.kind === "string" ? args.kind : "session",
        anchors: args.anchors,
        source: "mcp",
      },
      { workspace },
    );
    if (result.status >= 400) return textResult(JSON.stringify(result.body), true);
    return textResult(JSON.stringify(result.body));
  }
  if (name === "amem_repos") {
    const result = api("GET", "/api/repos", null);
    if (result.status >= 400) return apiResult(result);
    const kind = typeof args.kind === "string" ? args.kind.trim().toLowerCase() : "all";
    const repos = ((result.body as { repos?: Array<{ kind?: string }> }).repos ?? []).filter((r) => {
      if (kind === "git" || kind === "workspace") return r.kind === kind;
      return true;
    });
    return jsonResult({
      count: repos.length,
      kind: kind === "git" || kind === "workspace" ? kind : "all",
      repos,
    });
  }
  if (name === "amem_stats") {
    const scope =
      typeof args.scope === "string" && args.scope.trim()
        ? args.scope.trim()
        : workspace
          ? "current"
          : "all";
    const result = api("GET", "/api/usage", null, {
      workspace,
      query: { scope, days: parseDays(args.days) },
    });
    if (result.status >= 400) return apiResult(result);
    return jsonResult(compactStats(result.body));
  }
  if (name === "amem_graph") {
    const result = api("GET", "/api/graph", null, {
      workspace,
      query: { days: parseDays(args.days) },
    });
    if (result.status >= 400) return apiResult(result);
    return jsonResult(compactGraph(result.body));
  }
  if (name === "amem_status") {
    if (workspace && !getRepoByName(workspace)) {
      return textResult(`Workspace not found: ${workspace}`, true);
    }
    const result = api("GET", "/api/status", null, { workspace });
    return apiResult(result);
  }
  return textResult(`Unknown tool: ${name}`, true);
}

function rpcResult(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: number | string, message: string, code = -32601): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function isJsonRpcMessage(body: unknown): body is JsonRpc {
  if (!body || typeof body !== "object") return false;
  const msg = body as JsonRpc;
  return msg.jsonrpc === "2.0" || typeof msg.method === "string";
}

/** Handle one JSON-RPC message. Notifications (no id) return null. */
export function dispatchMcp(msg: JsonRpc, fallbackWorkspace?: string): JsonRpcResponse | null {
  const { id, method, params } = msg;
  if (!method) return null;
  if (id === undefined || id === null) return null;

  if (method === "initialize") {
    const requested =
      params && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSIONS.has(requested) ? requested : "2024-11-05",
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
        prompts: { listChanged: false },
      },
      serverInfo: { name: "amem", version: "0.1.0" },
    });
  }

  if (method === "ping") return rpcResult(id, {});

  if (method === "tools/list") {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === "resources/list") return rpcResult(id, { resources: [] });
  if (method === "prompts/list") return rpcResult(id, { prompts: [] });

  if (method === "tools/call") {
    const name = typeof params?.name === "string" ? params.name : "";
    const args =
      params?.arguments && typeof params.arguments === "object"
        ? (params.arguments as Record<string, unknown>)
        : {};
    return rpcResult(id, callTool(name, args, fallbackWorkspace));
  }

  return rpcError(id, `Method not found: ${method}`);
}

export function handleMcpHttpBody(
  body: unknown,
  fallbackWorkspace?: string,
): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    const results = body
      .filter(isJsonRpcMessage)
      .map((msg) => dispatchMcp(msg, fallbackWorkspace))
      .filter((r): r is JsonRpcResponse => r !== null);
    return { status: 200, body: results };
  }
  if (!isJsonRpcMessage(body)) {
    return {
      status: 400,
      body: { jsonrpc: "2.0", error: { code: -32600, message: "Invalid JSON-RPC" } },
    };
  }
  const result = dispatchMcp(body, fallbackWorkspace);
  if (!result) return { status: 202, body: null };
  return { status: 200, body: result };
}

function encodeMessage(msg: unknown, framing: Framing): Buffer {
  const payload = Buffer.from(JSON.stringify(msg), "utf8");
  if (framing === "ndjson") {
    return Buffer.concat([payload, Buffer.from("\n")]);
  }
  const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, payload]);
}

function headerEndIndex(buf: Buffer): { index: number; size: number } | null {
  const crlf = buf.indexOf("\r\n\r\n");
  if (crlf !== -1) return { index: crlf, size: 4 };
  const lf = buf.indexOf("\n\n");
  if (lf !== -1) return { index: lf, size: 2 };
  return null;
}

function looksLikeJsonStart(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]!;
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    return c === 0x7b; // {
  }
  return false;
}

function parseStdio(buf: Buffer): { rest: Buffer; items: { msg: JsonRpc; framing: Framing }[] } {
  const items: { msg: JsonRpc; framing: Framing }[] = [];
  let rest = buf;

  while (rest.length) {
    if (looksLikeJsonStart(rest)) {
      const nl = rest.indexOf("\n");
      if (nl === -1) break;
      const line = rest.slice(0, nl).toString("utf8").trim();
      rest = rest.slice(nl + 1);
      if (!line) continue;
      try {
        items.push({ msg: JSON.parse(line) as JsonRpc, framing: "ndjson" });
      } catch {
        // skip malformed line
      }
      continue;
    }

    const headerEnd = headerEndIndex(rest);
    if (!headerEnd) break;
    const header = rest.slice(0, headerEnd.index).toString("utf8");
    const lenMatch = /Content-Length:\s*(\d+)/i.exec(header);
    if (!lenMatch) {
      rest = rest.slice(headerEnd.index + headerEnd.size);
      continue;
    }
    const len = Number(lenMatch[1]);
    const start = headerEnd.index + headerEnd.size;
    if (rest.length < start + len) break;
    const raw = rest.slice(start, start + len).toString("utf8");
    rest = rest.slice(start + len);
    try {
      items.push({ msg: JSON.parse(raw) as JsonRpc, framing: "lsp" });
    } catch {
      // skip malformed
    }
  }

  return { rest, items };
}

export function stdioMcpLaunch(workspace?: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const script = process.argv[1];
  const useNode = Boolean(script && existsSync(script));
  return {
    command: useNode ? process.execPath : "amem",
    args: useNode ? [script, "mcp"] : ["mcp"],
    env: workspace ? { AMEM_WORKSPACE: workspace } : {},
  };
}

export function mcpClientConfig(workspace = "my-app", port = 7843) {
  const stdio = stdioMcpLaunch(workspace);
  const httpUrl = `http://127.0.0.1:${port}/mcp?workspace=${encodeURIComponent(workspace)}`;
  return {
    mcpServers: {
      amem: {
        command: stdio.command,
        args: stdio.args,
        env: stdio.env,
      },
    },
    http: { url: httpUrl },
  };
}

export async function runMcpServer(): Promise<void> {
  let buf = Buffer.alloc(0);
  let framing: Framing = "ndjson";
  for await (const chunk of process.stdin) {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const parsed = parseStdio(buf);
    buf = Buffer.from(parsed.rest);
    for (const item of parsed.items) {
      framing = item.framing;
      const response = dispatchMcp(item.msg);
      if (response) process.stdout.write(encodeMessage(response, framing));
    }
  }
}
