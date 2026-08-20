import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { handleApi } from "../api/routes.js";
import { detectRepoIdentity } from "../repo-identity.js";
import { handleMcpHttpBody, isJsonRpcMessage } from "../mcp.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
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

function sendMcp(res: ServerResponse, req: IncomingMessage, body: unknown, workspace?: string): void {
  const handled = handleMcpHttpBody(body, workspace);
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
  res.writeHead(200, { "Content-Type": type });
  res.end(readFileSync(filePath));
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
  q.set("tab", "setup");
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

export async function startUiServer(options: UiServerOptions = {}): Promise<{
  port: number;
  url: string;
  close: () => Promise<void>;
}> {
  const port = options.port ?? 7843;
  const cwd = options.cwd ?? process.cwd();
  const listenHost = resolveLoopbackHost(options.host);

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? `${listenHost}:${port}`;
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
      if (req.method === "POST") {
        const body = await readBody(req);
        if (mcpPath || isJsonRpcMessage(body)) {
          sendMcp(res, req, body, workspaceFromMcpReq(req, url));
          return;
        }
        if (url.pathname.startsWith("/api/")) {
          const result = handleApi({
            method: req.method,
            pathname: url.pathname,
            searchParams: url.searchParams,
            body,
            cwd,
          });
          sendJson(res, result.status, result.body);
          return;
        }
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
      serveStatic(res, url.pathname);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, listenHost, () => resolve());
  });

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
