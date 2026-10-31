import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// dist/install/skills.js -> package root is ../..
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function getPackageRoot(): string {
  return packageRoot;
}

export function skillsSourceDir(): string {
  return join(packageRoot, "skills");
}

export function templatePath(...parts: string[]): string {
  return join(packageRoot, "templates", ...parts);
}

export function copyBundledSkills(targetSkillsDir: string): string[] {
  mkdirSync(targetSkillsDir, { recursive: true });
  const source = skillsSourceDir();
  const installed: string[] = [];
  const skillNames = [
    "amem-bootstrap",
    "amem-update-working-memory",
    "amem-tasks",
    "amem-write-skill",
  ];
  for (const name of skillNames) {
    const from = join(source, name);
    const to = join(targetSkillsDir, name);
    if (existsSync(from)) {
      copyDirSafely(from, to);
      installed.push(to);
    }
  }
  return installed;
}

/**
 * Copy a skill folder file by file through a temp name and a rename, skipping files that
 * are already identical. Two setups running at once (or an agent reading the skill) never
 * see a half-written file, which cpSync's copy-then-chmod allowed.
 */
function copyDirSafely(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) {
      copyDirSafely(src, dest);
      continue;
    }
    const content = readFileSync(src);
    if (existsSync(dest) && readFileSync(dest).equals(content)) continue;
    const tmp = `${dest}.amem-tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, content);
    renameSync(tmp, dest);
  }
}

export function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // replace corrupt file carefully by returning empty and letting caller rewrite
  }
  return {};
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Does a hook command run amem's hook? Matches `amem hook`, `amem.cmd" hook`, `cli.js hook`. */
export function isAmemHookCommand(command: string): boolean {
  return /amem(\.cmd|\.exe)?"?\s+hook\b|cli\.js"?\s+hook\b/i.test(command);
}

export function resolveAmemBin(): string {
  const args = resolveAmemProgramArgs();
  // Hooks run this through a shell: "C:\Program Files\nodejs\amem.cmd" needs its quotes.
  return args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ");
}

export function resolveAmemProgramArgs(...extra: string[]): string[] {
  try {
    // npx puts its cache bin first on PATH; prefer an install that will still be there.
    const win = process.platform === "win32";
    const found = execFileSync(win ? "where" : "which", win ? ["amem"] : ["-a", "amem"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    // Windows lists npm's extensionless sh shim before amem.cmd; only the .cmd runs from a hook.
    const runnable = win ? found.filter((p) => /\.(cmd|exe)$/i.test(p)) : found;
    const stable = runnable.find((p) => !/[\\/]_npx[\\/]/.test(p)) ?? runnable[0];
    if (stable) return [stable, ...extra];
  } catch {
    // fall through
  }
  const cli = join(getPackageRoot(), "dist", "cli.js");
  return [process.execPath, cli, ...extra];
}
