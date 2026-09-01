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
    name: "amem_recipe",
    description:
      "Return the generic amem remember contract: when to call amem_context vs amem_remember. Use if you are unsure whether to read or write memory. Same recipe for every MCP host.",
    inputSchema: { type: "object", properties: {} },
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
  {
    name: "amem_skill_list",
    description:
      "List stored skills (procedures the agent learned) as an index of names and descriptions only. Cheap — call this first, then amem_skill_view to load the one you need. Skills are longer procedures; use amem_context for small durable facts.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional: rank the index against this task description",
        },
      },
    },
  },
  {
    name: "amem_skill_view",
    description:
      "Load the full body of one skill by name, or a supporting file inside it. Call this only after amem_skill_list (or the 'Relevant skills' section of an amem context packet) shows a skill worth following.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name from amem_skill_list" },
        file: {
          type: "string",
          description: "Optional supporting file, e.g. references/api.md",
        },
        sessionId: {
          type: "string",
          description:
            "Optional conversation id, so amem can tell whether this procedure actually worked out",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "amem_skill_save",
    description:
      "Save a non-trivial multi-step procedure you just worked out as a reusable skill. Use after solving something worth repeating — a workflow, a dead end you found the way past, or a correction the user gave you. Provide a full SKILL.md in `content`, or a description plus body.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short slug, e.g. deploy-staging",
        },
        description: {
          type: "string",
          description: "One line on when to use this skill",
        },
        content: {
          type: "string",
          description: "Full SKILL.md, or the markdown body to wrap",
        },
        sessionId: {
          type: "string",
          description: "Optional conversation id, so amem can clear the nudge that prompted this",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "amem_task_list",
    description:
      "List deferred agent tasks (Kanban) for a workspace/repo. Use for work to do later — not durable facts (use amem_remember for those). Default excludes done tasks.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string" },
        status: {
          type: "string",
          description: "backlog | next | doing | blocked | done",
        },
        include_done: { type: "boolean" },
      },
    },
  },
  {
    name: "amem_task_add",
    description:
      "Create a deferred agent task on the project Kanban (default backlog). Use for work that should not get lost in chat. Durable facts still go through amem_remember.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string", description: "Why / notes" },
        workspace: { type: "string" },
        status: { type: "string", description: "backlog | next | doing | blocked | done" },
        anchors: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
    },
  },
  {
    name: "amem_task_update",
    description:
      "Update a task title, notes, anchors, or move its Kanban status (backlog/next/doing/blocked/done).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        workspace: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        status: { type: "string" },
        anchors: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
    },
  },
  {
    name: "amem_task_complete",
    description: "Mark a deferred agent task as done on the Kanban board.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        workspace: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "amem_usage_report",
    description:
      "Report what you actually did with the last amem context packet, so its savings estimate becomes a measurement instead of a guess. Call this once after you have finished acting on a packet. Do NOT estimate tokens — just list which of the anchors amem gave you you ended up opening anyway (anchors_opened), and whether the packet answered the question without further exploration (answered). amem computes the saving from the real size of the files you did not have to open. Reporting that you opened everything is a useful and expected answer.",
    inputSchema: {
      type: "object",
      properties: {
        anchors_opened: {
          type: "array",
          items: { type: "string" },
          description:
            "File paths from the packet's Anchors lines that you actually read. Empty array if the claims alone were enough. Paths not in the packet are ignored.",
        },
        answered: {
          type: "boolean",
          description:
            "True if the packet answered the question without broad exploration. False if you had to grep or read widely anyway.",
        },
        event_id: {
          type: "string",
          description: "Specific usage event. Omit to attest the most recent packet for this repo.",
        },
        workspace: { type: "string" },
      },
      required: ["anchors_opened", "answered"],
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

/**
 * Keep the skill index at level 0. Returning bodies here would defeat the point of having
 * a separate view call, so this hands back names and descriptions only.
 */
function compactSkillIndex(body: unknown, ranked: boolean) {
  const source = (body ?? {}) as {
    skills?: Array<Record<string, unknown>>;
    matches?: Array<Record<string, unknown>>;
  };
  const list = ranked ? (source.matches ?? []) : (source.skills ?? []);
  return {
    skills: list.map((s) => ({
      name: s.name,
      description: s.description,
      tags: s.tags,
      uses: s.uses,
    })),
    hint: "Call amem_skill_view with a name to load the full procedure.",
  };
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
  if (name === "amem_recipe") {
    const result = api("GET", "/api/recipe", null);
    if (result.status >= 400) return apiResult(result);
    const contract = result.body as { paste?: string; markdown?: string };
    return textResult(contract.paste || contract.markdown || JSON.stringify(result.body));
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
  if (name === "amem_skill_list") {
    const query: Record<string, string> = {};
    if (typeof args.query === "string" && args.query.trim()) query.q = args.query.trim();
    const result = api("GET", "/api/skills", null, { query });
    if (result.status >= 400) return apiResult(result);
    return jsonResult(compactSkillIndex(result.body, Boolean(query.q)));
  }
  if (name === "amem_skill_view") {
    const skillName = typeof args.name === "string" ? args.name.trim() : "";
    if (!skillName) return textResult("name is required", true);
    const query: Record<string, string> = { name: skillName };
    if (typeof args.file === "string" && args.file.trim()) query.file = args.file.trim();
    if (typeof args.sessionId === "string" && args.sessionId.trim()) {
      query.session_id = args.sessionId.trim();
    }
    const result = api("GET", "/api/skills/view", null, { query });
    if (result.status >= 400) return apiResult(result);
    const body = result.body as { content?: string };
    // The body is markdown the agent should read as-is, not JSON to re-parse.
    return textResult(typeof body?.content === "string" ? body.content : JSON.stringify(body));
  }
  if (name === "amem_skill_save") {
    const skillName = typeof args.name === "string" ? args.name.trim() : "";
    if (!skillName) return textResult("name is required", true);
    const result = api(
      "POST",
      "/api/skills",
      {
        name: skillName,
        description: typeof args.description === "string" ? args.description : "",
        content: typeof args.content === "string" ? args.content : "",
        session_id: typeof args.sessionId === "string" ? args.sessionId : undefined,
      },
      { workspace },
    );
    return apiResult(result);
  }
  if (name === "amem_task_list") {
    const query: Record<string, string> = {};
    if (typeof args.status === "string" && args.status.trim()) query.status = args.status.trim();
    if (args.include_done === true) query.include_done = "1";
    const result = api("GET", "/api/tasks", null, { workspace, query });
    if (result.status >= 400) return apiResult(result);
    return jsonResult(result.body);
  }
  if (name === "amem_task_add") {
    const title = typeof args.title === "string" ? args.title : "";
    if (!title.trim()) return textResult("title is required", true);
    const result = api(
      "POST",
      "/api/tasks",
      {
        title,
        body: typeof args.body === "string" ? args.body : "",
        status: typeof args.status === "string" ? args.status : "backlog",
        anchors: args.anchors,
        source: "mcp",
      },
      { workspace },
    );
    if (result.status >= 400) return textResult(JSON.stringify(result.body), true);
    return textResult(JSON.stringify(result.body));
  }
  if (name === "amem_task_update") {
    const id = typeof args.id === "string" ? args.id : "";
    if (!id.trim()) return textResult("id is required", true);
    const result = api(
      "PATCH",
      "/api/tasks",
      {
        id,
        title: typeof args.title === "string" ? args.title : undefined,
        body: typeof args.body === "string" ? args.body : undefined,
        status: typeof args.status === "string" ? args.status : undefined,
        anchors: args.anchors,
      },
      { workspace },
    );
    if (result.status >= 400) return textResult(JSON.stringify(result.body), true);
    return textResult(JSON.stringify(result.body));
  }
  if (name === "amem_task_complete") {
    const id = typeof args.id === "string" ? args.id : "";
    if (!id.trim()) return textResult("id is required", true);
    const result = api("POST", "/api/tasks/complete", { id }, { workspace });
    if (result.status >= 400) return textResult(JSON.stringify(result.body), true);
    return textResult(JSON.stringify(result.body));
  }
  if (name === "amem_usage_report") {
    // Deliberately does not accept a token count. The agent reports what it
    // observed — which anchors it opened — and amem does the arithmetic from
    // real file sizes. Asking a model for a savings figure invites it to
    // flatter the tool it is being graded on.
    const anchorsOpened = Array.isArray(args.anchors_opened)
      ? (args.anchors_opened as unknown[]).map((a) => String(a))
      : [];
    if (typeof args.answered !== "boolean") {
      return textResult("answered (boolean) is required", true);
    }
    const result = api(
      "POST",
      "/api/usage/attest",
      {
        eventId: typeof args.event_id === "string" ? args.event_id : undefined,
        anchorsOpened,
        answered: args.answered,
      },
      { workspace },
    );
    if (result.status >= 400) return textResult(JSON.stringify(result.body), true);
    return jsonResult(result.body);
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
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const msg = body as JsonRpc;
  return msg.jsonrpc === "2.0";
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
