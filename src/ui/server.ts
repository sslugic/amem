import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi } from "../api/routes.js";

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
};

export async function startUiServer(options: UiServerOptions = {}): Promise<{
  port: number;
  url: string;
  close: () => Promise<void>;
}> {
  const port = options.port ?? 7843;
  const cwd = options.cwd ?? process.cwd();

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? `127.0.0.1:${port}`;
      const url = new URL(req.url ?? "/", `http://${host}`);
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
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const url = `http://127.0.0.1:${port}`;
  if (options.openBrowser !== false) {
    try {
      const { execFile } = await import("node:child_process");
      const platform = process.platform;
      if (platform === "darwin") execFile("open", [url]);
      else if (platform === "win32") execFile("cmd", ["/c", "start", url]);
      else execFile("xdg-open", [url]);
    } catch {
      // ignore
    }
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
