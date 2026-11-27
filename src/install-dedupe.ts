import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { currentInstall, defaultInstallPrefixes, findInstalls, type AmemInstall } from "./install-check.js";

/**
 * Fix "more than one amem install": keep one, point every host config and launch
 * agent at it, and remove the others. Run by `amem doctor --fix` and, when the
 * dashboard starts from the install it would keep, automatically.
 *
 * Config files are edited as text, replacing only the exact install paths
 * (`<prefix>/bin/amem`, `<prefix>/lib/node_modules/@iamem/amem`). Nothing else in
 * them is read out or changed, and each edited file gets a `.amem-bak` copy.
 */

export type DedupePlan = {
  keep: AmemInstall;
  remove: AmemInstall[];
  /** Config files that reference an install being removed. */
  rewrites: Array<{ path: string; count: number }>;
  reason: string;
};

export type DedupeResult = DedupePlan & {
  rewritten: string[];
  removed: string[];
  reloaded: string[];
  errors: string[];
};

type Deps = {
  home?: string;
  env?: NodeJS.ProcessEnv;
  prefixes?: string[];
  platform?: NodeJS.Platform;
  /** Runs a command; tests replace it. Throws on failure. */
  run?: (cmd: string, args: string[]) => void;
  /** Root of the running process, to prefer on a tie and never to remove under itself. */
  current?: string | null;
};

const PKG_SUFFIX = join("lib", "node_modules", "@iamem", "amem");

/** `/opt/homebrew/lib/node_modules/@iamem/amem` → `/opt/homebrew`. */
export function prefixOf(root: string): string | null {
  const norm = resolve(root);
  return norm.endsWith(sep + PKG_SUFFIX) ? norm.slice(0, -(PKG_SUFFIX.length + 1)) : null;
}

/** Host configs and launch agents that may launch amem by absolute path. */
export function referencingFiles(home = homedir(), platform: NodeJS.Platform = process.platform): string[] {
  const files = [
    join(home, ".claude", "settings.json"),
    join(home, ".claude.json"),
    join(home, ".cursor", "mcp.json"),
    join(home, ".cursor", "hooks.json"),
    join(home, ".codeium", "windsurf", "mcp_config.json"),
    join(home, ".gemini", "settings.json"),
    join(home, ".codex", "config.toml"),
    join(home, ".qwen", "settings.json"),
    join(home, ".config", "opencode", "opencode.json"),
    join(home, ".continue", "config.json"),
    join(home, ".continue", "mcpServers", "amem.yaml"),
    platform === "darwin"
      ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : join(home, ".config", "Claude", "claude_desktop_config.json"),
    platform === "darwin" ? join(home, "Library", "Application Support", "Zed", "settings.json") : join(home, ".config", "zed", "settings.json"),
  ];
  const gem = join(home, ".gemini");
  try {
    for (const d of readdirSync(gem)) if (d.startsWith("antigravity")) files.push(join(gem, d, "mcp_config.json"));
  } catch {
    // no Gemini folder
  }
  if (platform === "darwin") {
    const agents = join(home, "Library", "LaunchAgents");
    try {
      for (const f of readdirSync(agents)) if (/^co\.amem\..*\.plist$/.test(f)) files.push(join(agents, f));
    } catch {
      // no launch agents
    }
  } else {
    const units = join(home, ".config", "systemd", "user");
    try {
      for (const f of readdirSync(units)) if (/^amem.*\.(service|timer)$/.test(f)) files.push(join(units, f));
    } catch {
      // no systemd units
    }
  }
  return files.filter((f) => existsSync(f));
}

/** The exact strings that name an install: its bin link and its package folder. */
function installPaths(inst: AmemInstall): string[] {
  const prefix = prefixOf(inst.root);
  return [inst.root, ...(prefix ? [join(prefix, "bin", "amem")] : [])];
}

function countRefs(text: string, inst: AmemInstall): number {
  return installPaths(inst).reduce((n, p) => n + text.split(p).length - 1, 0);
}

function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/** Decide what to keep: newest version, then the one most hosts already launch, then this process. */
export function planDedupe(deps: Deps = {}): DedupePlan | null {
  // Windows global installs use another layout (prefix/node_modules, .cmd shims); not handled yet.
  if ((deps.platform ?? process.platform) === "win32" || process.platform === "win32") return null;
  const env = deps.env ?? process.env;
  const installs = findInstalls(env, deps.prefixes ?? defaultInstallPrefixes()).filter((i) => prefixOf(i.root));
  if (installs.length < 2) return null;
  const files = referencingFiles(deps.home, deps.platform);
  const texts = files.map((path) => {
    try {
      return { path, text: readFileSync(path, "utf8") };
    } catch {
      return { path, text: "" };
    }
  });
  const refs = new Map(installs.map((i) => [i.root, texts.reduce((n, t) => n + countRefs(t.text, i), 0)]));
  const current = deps.current === undefined ? currentInstall()?.root ?? null : deps.current;
  const ranked = [...installs].sort(
    (a, b) =>
      compareVersions(b.version, a.version) ||
      (refs.get(b.root) ?? 0) - (refs.get(a.root) ?? 0) ||
      Number(b.root === current) - Number(a.root === current),
  );
  const keep = ranked[0]!;
  const remove = ranked.slice(1);
  const newest = installs.every((i) => i.version === keep.version) ? "all the same version" : `newest (${keep.version})`;
  const reason = `${newest}; ${refs.get(keep.root) ?? 0} host reference(s) already use it`;
  const rewrites = texts
    .map(({ path, text }) => ({ path, count: remove.reduce((n, r) => n + countRefs(text, r), 0) }))
    .filter((r) => r.count > 0);
  return { keep, remove, rewrites, reason };
}

function writeAtomic(path: string, text: string): void {
  const mode = statSync(path).mode & 0o777;
  copyFileSync(path, `${path}.amem-bak`);
  chmodSync(`${path}.amem-bak`, mode);
  const tmp = `${path}.amem-tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

function defaultRun(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: "ignore", timeout: 120_000 });
}

/** Remove an install with its own npm, falling back to deleting its package and bin link. */
function removeInstall(inst: AmemInstall, run: (cmd: string, args: string[]) => void): void {
  const prefix = prefixOf(inst.root);
  if (!prefix) throw new Error(`not a global npm install: ${inst.root}`);
  const npm = join(prefix, "bin", "npm");
  try {
    run(existsSync(npm) ? npm : "npm", ["uninstall", "-g", "--prefix", prefix, "@iamem/amem"]);
    if (!existsSync(inst.root)) return;
  } catch {
    // fall through to a manual removal
  }
  const bin = join(prefix, "bin", "amem");
  try {
    if (lstatSync(bin).isSymbolicLink() && resolve(dirname(bin), readlinkSync(bin)).startsWith(inst.root + sep)) rmSync(bin, { force: true });
  } catch {
    // no bin link
  }
  rmSync(inst.root, { recursive: true, force: true });
}

/** Execute a plan: rewrite references, reload changed launch agents, remove the extra installs. */
export function applyDedupe(plan: DedupePlan, deps: Deps = {}): DedupeResult {
  const run = deps.run ?? defaultRun;
  const platform = deps.platform ?? process.platform;
  const result: DedupeResult = { ...plan, rewritten: [], removed: [], reloaded: [], errors: [] };
  const keepPrefix = prefixOf(plan.keep.root)!;
  const pairs: Array<[string, string]> = [];
  for (const r of plan.remove) {
    const p = prefixOf(r.root)!;
    pairs.push([join(p, "bin", "amem"), join(keepPrefix, "bin", "amem")], [r.root, plan.keep.root]);
  }
  for (const { path } of plan.rewrites) {
    try {
      const before = readFileSync(path, "utf8");
      let after = before;
      for (const [from, to] of pairs) after = after.split(from).join(to);
      if (after === before) continue;
      writeAtomic(path, after);
      result.rewritten.push(path);
      if (platform === "darwin" && path.endsWith(".plist") && path.includes(`${sep}LaunchAgents${sep}`)) {
        const uid = process.getuid?.() ?? 0;
        try {
          run("launchctl", ["bootout", `gui/${uid}`, path]);
        } catch {
          // not loaded
        }
        try {
          run("launchctl", ["bootstrap", `gui/${uid}`, path]);
          result.reloaded.push(path);
        } catch (e) {
          result.errors.push(`reload ${path}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      result.errors.push(`rewrite ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Only remove an install once nothing we know of launches it any more.
  if (result.errors.length) return result;
  const current = deps.current === undefined ? currentInstall()?.root ?? null : deps.current;
  for (const r of plan.remove) {
    if (r.root === current) {
      result.errors.push(`not removing ${r.root}: this command is running from it. Run \`${join(keepPrefix, "bin", "amem")} doctor --fix\`.`);
      continue;
    }
    try {
      removeInstall(r, run);
      result.removed.push(r.root);
    } catch (e) {
      result.errors.push(`remove ${r.root}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

/** Auto-fix is on unless AMEM_AUTOFIX_INSTALLS=0 (or false/off). */
export function autoFixInstallsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|off|no)$/i.test(String(env.AMEM_AUTOFIX_INSTALLS ?? "").trim());
}

/**
 * Background fix when the dashboard starts: only when this process is the install
 * we would keep, so it never removes the code it is running from.
 */
export function autoFixInstalls(deps: Deps = {}): DedupeResult | null {
  if (!autoFixInstallsEnabled(deps.env)) return null;
  const plan = planDedupe(deps);
  if (!plan) return null;
  const current = deps.current === undefined ? currentInstall()?.root ?? null : deps.current;
  if (plan.keep.root !== current) return null;
  return applyDedupe(plan, deps);
}

/** PATH dirs, for messages. */
export function pathDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PATH ?? "").split(delimiter).filter(Boolean);
}
