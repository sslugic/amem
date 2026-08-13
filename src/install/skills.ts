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
  for (const name of ["amem-bootstrap", "amem-update-working-memory"]) {
    const from = join(source, name);
    const to = join(targetSkillsDir, name);
    if (!existsSync(from)) {
      throw new Error(`Missing bundled skill: ${from}`);
    }
    cpSync(from, to, { recursive: true });
    installed.push(to);
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
  // Prefer PATH-installed binary; fall back to node running this package's CLI.
  return "amem";
}
