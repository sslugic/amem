import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type AmemInstall = { root: string; version: string; via: string };

/** Walk up from a file to the @iamem/amem package root. */
export function packageRootOf(file: string): string | null {
  let dir = existsSync(file) && statSync(file).isDirectory() ? file : dirname(file);
  for (let i = 0; i < 8; i += 1) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name === "@iamem/amem") return dir;
      } catch {
        // unreadable package.json: keep walking
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function versionOf(root: string): string {
  try {
    return String((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "?");
  } catch {
    return "?";
  }
}

function resolveRoot(path: string): string | null {
  try {
    return packageRootOf(realpathSync(path));
  } catch {
    return null;
  }
}

/** The package this process runs from. */
export function currentInstall(): AmemInstall | null {
  const root = packageRootOf(fileURLToPath(import.meta.url));
  return root ? { root, version: versionOf(root), via: "this process" } : null;
}

/** Every amem install reachable from PATH or the usual global prefixes. */
export function defaultInstallPrefixes(): string[] {
  return [join(homedir(), ".local"), "/opt/homebrew", "/usr/local", join(homedir(), ".npm-global")];
}

export function findInstalls(
  env: NodeJS.ProcessEnv = process.env,
  prefixes: string[] = defaultInstallPrefixes(),
): AmemInstall[] {
  const found = new Map<string, AmemInstall>();
  const add = (path: string, via: string) => {
    const root = resolveRoot(path);
    if (root && !found.has(root)) found.set(root, { root, version: versionOf(root), via });
  };
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const bin = join(dir, "amem");
    if (existsSync(bin)) add(bin, `PATH ${dir}`);
  }
  for (const p of prefixes) {
    const pkg = join(p, "lib", "node_modules", "@iamem", "amem");
    if (existsSync(pkg)) add(pkg, `global ${p}`);
  }
  return [...found.values()];
}

/** amem commands that hosts launch: Claude Desktop MCP config and Claude Code hooks. */
export function hostLaunches(home = homedir()): Array<{ host: string; command: string; install: AmemInstall | null }> {
  const out: Array<{ host: string; command: string; install: AmemInstall | null }> = [];
  const resolveCmd = (cmd: string): AmemInstall | null => {
    const exe = cmd.trim().split(/\s+/).find((part) => part.includes("amem") && part.startsWith("/"));
    if (!exe) return null;
    const root = resolveRoot(exe);
    return root ? { root, version: versionOf(root), via: exe } : null;
  };
  const desktop = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  try {
    const cfg = JSON.parse(readFileSync(desktop, "utf8")) as { mcpServers?: Record<string, { command?: string }> };
    const cmd = cfg.mcpServers?.amem?.command;
    if (cmd) out.push({ host: "Claude Desktop MCP", command: cmd, install: resolveCmd(cmd) });
  } catch {
    // no desktop config
  }
  try {
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    const seen = new Set<string>();
    for (const [event, rows] of Object.entries(settings.hooks ?? {})) {
      for (const row of rows ?? []) {
        for (const h of row.hooks ?? []) {
          const cmd = h.command ?? "";
          if (!/amem/.test(cmd) || seen.has(cmd)) continue;
          seen.add(cmd);
          out.push({ host: `Claude Code ${event} hook`, command: cmd, install: resolveCmd(cmd) });
        }
      }
    }
  } catch {
    // no Claude Code settings
  }
  return out;
}

/** Doctor findings: more than one install, or a host launching a different version. */
export function installIssues(opts: { env?: NodeJS.ProcessEnv; home?: string; prefixes?: string[] } = {}): string[] {
  const issues: string[] = [];
  const installs = findInstalls(opts.env, opts.prefixes);
  if (installs.length > 1) {
    issues.push(
      `More than one amem install: ${installs.map((i) => `${i.root} (${i.version})`).join(", ")}. Keep one so hooks, MCP and the dashboard run the same code.`,
    );
  }
  const newest = installs.map((i) => i.version).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  for (const launch of hostLaunches(opts.home)) {
    if (!launch.install) continue;
    if (newest && launch.install.version !== newest) {
      issues.push(`${launch.host} runs amem ${launch.install.version} from ${launch.install.root}; the newest install is ${newest}.`);
    }
    if (/\/\.git\b|\/GitHub|\/src\//.test(launch.install.root) && existsSync(join(launch.install.root, ".git"))) {
      issues.push(`${launch.host} runs amem from a git checkout (${launch.install.root}), not an installed release.`);
    }
  }
  return issues;
}
