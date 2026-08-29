import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
      cpSync(from, to, { recursive: true });
      installed.push(to);
    }
  }
  return installed;
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

export function resolveAmemBin(): string {
  const args = resolveAmemProgramArgs();
  return args.length === 1 ? args[0]! : args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ");
}

export function resolveAmemProgramArgs(...extra: string[]): string[] {
  try {
    const found = execFileSync("which", ["amem"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (found) return [found, ...extra];
  } catch {
    // fall through
  }
  const cli = join(getPackageRoot(), "dist", "cli.js");
  return [process.execPath, cli, ...extra];
}
