import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { handleApi } from "../api/routes.js";
import { detectRepoIdentity, setRepoIdentityCacheTtl } from "../repo-identity.js";
import { handleMcpHttpBody, isJsonRpcMessage } from "../mcp.js";
import { latestActivityId, listActivity } from "../activity-log.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
};

function uiRoot(): string {
  // dist/ui/server.js -> package root is ../..
  const here = fileURLToPath(new URL(".", import.meta.url));
  const packageRoot = join(here, "..", "..");
  const viteDist = join(packageRoot, "dist", "ui-app");
  const staticFallback = join(packageRoot, "ui-static");
  if (existsSync(join(viteDist, "index.html"))) return viteDist;
  if (existsSync(join(staticFallback, "index.html"))) return staticFallback;
  return staticFallback;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Accept, mcp-session-id, mcp-protocol-version, x-amem-workspace",
  });
  res.end(payload);
}

const MCP_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, mcp-session-id, mcp-protocol-version, x-amem-workspace",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
};

function workspaceFromMcpReq(req: IncomingMessage, url: URL): string | undefined {
  const q = url.searchParams.get("workspace")?.trim();
  if (q) return q;
  const header = req.headers["x-amem-workspace"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return process.env.AMEM_WORKSPACE || undefined;
}

/** A short label for an HTTP MCP caller; `initialize` refines it to the client's own name. */
function httpClientHint(req: IncomingMessage): string {
  const ua = String(req.headers["user-agent"] ?? "").trim();
  return ua ? ua.split(/[\s/(]/)[0]!.slice(0, 32) || "http-mcp" : "http-mcp";
}

function sendMcp(res: ServerResponse, req: IncomingMessage, body: unknown, workspace?: string): void {
  const handled = handleMcpHttpBody(body, workspace, httpClientHint(req));
  if (handled.status === 202) {
    res.writeHead(202, MCP_CORS);
    res.end();
    return;
  }
  const payload = JSON.stringify(handled.body);
  const accept = String(req.headers.accept ?? "");
  const preferSse = accept.includes("text/event-stream") && !accept.includes("application/json");
  if (preferSse) {
    res.writeHead(handled.status, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...MCP_CORS,
    });
    res.end(`event: message\ndata: ${payload}\n\n`);
    return;
  }
  res.writeHead(handled.status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...MCP_CORS,
  });
  res.end(payload);
}

function serveStatic(res: ServerResponse, urlPath: string): void {
  const root = uiRoot();
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  rel = rel.split("?")[0] ?? rel;
  const filePath = join(root, rel.replace(/^\//, ""));
  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    // A missing asset must 404: falling back to index.html would hand the browser
    // HTML with a JS content type and fail the module load for an unclear reason.
    const ext = extname(filePath);
    if (ext && ext !== ".html") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    // SPA fallback
    const index = join(root, "index.html");
    if (existsSync(index)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(index));
      return;
    }
    res.writeHead(404).end("UI not built. Run npm run build.");
    return;
  }
  const type = MIME[extname(filePath)] ?? "application/octet-stream";
  const noStore =
    filePath.endsWith(".js") ||
    filePath.endsWith(".css") ||
    filePath.endsWith(".html") ||
    filePath.endsWith("index.html");
  res.writeHead(200, {
    "Content-Type": type,
    ...(noStore ? { "Cache-Control": "no-store" } : {}),
  });
  res.end(readFileSync(filePath));
}

/** How often the stream checks the store for rows written by other processes. */
const ACTIVITY_POLL_MS = 700;

/**
 * Server-sent events for the Activity view. MCP servers, hooks and the CLI run in their
 * own processes and write to SQLite, so the stream tails the table rather than listening
 * to an in-process emitter. Same-origin only: no CORS header on purpose.
 */
function streamActivity(req: IncomingMessage, res: ServerResponse, url: URL): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const fromHeader = Number(req.headers["last-event-id"] ?? NaN);
  const fromQuery = Number(url.searchParams.get("since") ?? NaN);
  let lastId = Number.isFinite(fromHeader)
    ? fromHeader
    : Number.isFinite(fromQuery)
      ? fromQuery
      : safeLatestId();
  res.write(`retry: 3000\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ latestId: lastId })}\n\n`);
  let beats = 0;
  const timer = setInterval(() => {
    try {
      const events = listActivity({ sinceId: lastId, limit: 200 });
      for (const e of events) {
        lastId = e.id;
        res.write(`id: ${e.id}\nevent: activity\ndata: ${JSON.stringify(e)}\n\n`);
      }
      if (++beats % 20 === 0) res.write(`: keepalive\n\n`);
    } catch {
      // database locked or busy: try again on the next tick
    }
  }, ACTIVITY_POLL_MS);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  req.on("close", stop);
  res.on("error", stop);
}

function safeLatestId(): number {
  try {
    return latestActivityId();
  } catch {
    return 0;
  }
}

export type UiServerOptions = {
  port?: number;
  cwd?: string;
  openBrowser?: boolean;
  /** Loopback only — non-loopback values are forced to 127.0.0.1 */
  host?: string;
  landingUrl?: string;
};

function resolveLoopbackHost(host?: string): string {
  if (!host || host === "localhost" || host === "127.0.0.1") return "127.0.0.1";
  return "127.0.0.1";
}

export function buildUiLandingUrl(port: number, cwd: string): string {
  const identity = detectRepoIdentity(cwd);
  const q = new URLSearchParams();
  q.set("tab", "settings");
  q.set("scope", "all");
  q.set("path", identity.rootPath);
  return `http://127.0.0.1:${port}/?${q.toString()}`;
}

export function openUiInBrowser(url: string): void {
  try {
    if (process.platform === "darwin") execFile("open", [url]);
    else if (process.platform === "win32") execFile("cmd", ["/c", "start", url]);
    else execFile("xdg-open", [url]);
  } catch {
    // ignore
  }
}

export function isAddrInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}

export async function probeUiHealth(
  port: number,
  host = "127.0.0.1",
): Promise<{ reachable: boolean; hasVault: boolean; features: string[] }> {
  try {
    const res = await fetch(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      const body = (await res.json()) as { features?: unknown };
      const features = Array.isArray(body.features)
        ? body.features.filter((f): f is string => typeof f === "string")
        : [];
      return { reachable: true, hasVault: features.includes("vault"), features };
    }
  } catch {
    // older builds have no /api/health
  }
  try {
    const res = await fetch(`http://${host}:${port}/api/vault`, {
      signal: AbortSignal.timeout(1000),
    });
    return { reachable: true, hasVault: res.ok, features: res.ok ? ["vault"] : [] };
  } catch {
    return { reachable: false, hasVault: false, features: [] };
  }
}

export async function startUiServer(options: UiServerOptions = {}): Promise<{
  port: number;
  url: string;
  close: () => Promise<void>;
}> {
  const requestedPort = options.port ?? 7843;
  const cwd = options.cwd ?? process.cwd();
  // Tab switches fire several API calls, and each resolved the repo with git subprocesses.
  setRepoIdentityCacheTtl(15_000);
  const listenHost = resolveLoopbackHost(options.host);

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? `${listenHost}:${requestedPort}`;
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (req.method === "OPTIONS") {
        res.writeHead(204, MCP_CORS);
        res.end();
        return;
      }
      const mcpPath = url.pathname === "/mcp" || url.pathname === "/sse";
      if (mcpPath && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...MCP_CORS,
        });
        res.write(": amem mcp\n\n");
        req.on("close", () => res.end());
        return;
      }
      if (mcpPath && req.method === "DELETE") {
        res.writeHead(204, MCP_CORS);
        res.end();
        return;
      }
      if (url.pathname === "/api/activity/stream" && req.method === "GET") {
        streamActivity(req, res, url);
        return;
      }
      if (url.pathname === "/activity" || url.pathname === "/activity/" || url.pathname === "/activity/mini") {
        // The full Activity page lives inside the dashboard shell (sidebar + header).
        // The bare page is still served for the shell's iframe (?embed=1) and the side panel.
        const bare = url.pathname === "/activity/mini" || url.searchParams.get("embed") === "1" || url.searchParams.get("compact") === "1";
        if (!bare) {
          res.writeHead(302, { Location: "/?tab=activity" });
          res.end();
          return;
        }
        serveStatic(res, "/activity.html");
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        const body = req.method === "GET" || req.method === "HEAD" ? null : await readBody(req);
        const result = handleApi({
          method: req.method ?? "GET",
          pathname: url.pathname,
          searchParams: url.searchParams,
          body,
          cwd,
        });
        sendJson(res, result.status, result.body);
        return;
      }
      if (mcpPath && req.method === "POST") {
        sendMcp(res, req, await readBody(req), workspaceFromMcpReq(req, url));
        return;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        if (isJsonRpcMessage(body)) {
          sendMcp(res, req, body, workspaceFromMcpReq(req, url));
          return;
        }
      }
      serveStatic(res, url.pathname);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, listenHost, () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : requestedPort;
  const url = options.landingUrl ?? `http://${listenHost}:${port}`;
  if (options.openBrowser !== false) {
    openUiInBrowser(url);
  }

  return {
    port,
    url,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
