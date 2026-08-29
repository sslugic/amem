import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Paths that must be inside the published tarball for `npx @iamem/amem setup`. */
export const REQUIRED_PACK_PATHS = [
  "dist/cli.js",
  "dist/mcp.js",
  "dist/remember-contract.js",
  "ui-static/index.html",
  "ui-static/app.js",
  "ui-static/styles.css",
  "docs/remember-contract.md",
  "docs/agent-install-prompt.md",
  "docs/npm-release.md",
  "skills/amem-update-working-memory/SKILL.md",
  "scripts/mdm-offboard.sh",
  "scripts/postinstall.js",
] as const;

export const PUBLISH_PACKAGE_NAME = "@iamem/amem";

export type PublishReady = {
  root: string;
  name: string;
  version: string;
  bin: string;
  engines: string;
  filesField: string[];
  missing: string[];
  ok: boolean;
};

export function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function readPackageJson(root = packageRoot()): {
  name?: string;
  version?: string;
  bin?: Record<string, string> | string;
  engines?: { node?: string };
  files?: string[];
  publishConfig?: { access?: string };
} {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as ReturnType<
    typeof readPackageJson
  >;
}

export function inspectPublishReady(root = packageRoot()): PublishReady {
  const pkg = readPackageJson(root);
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.amem ?? "";
  const missing: string[] = REQUIRED_PACK_PATHS.filter((rel) => !existsSync(join(root, rel)));
  if (!bin) missing.push("package.json#bin.amem");
  if (pkg.publishConfig?.access !== "public") missing.push("package.json#publishConfig.access=public");
  if (!pkg.engines?.node) missing.push("package.json#engines.node");
  const filesField = pkg.files ?? [];
  for (const required of ["dist", "ui-static", "docs", "skills"]) {
    if (!filesField.includes(required)) missing.push(`package.json#files missing ${required}`);
  }
  return {
    root,
    name: pkg.name ?? "",
    version: pkg.version ?? "",
    bin,
    engines: pkg.engines?.node ?? "",
    filesField,
    missing,
    ok: missing.length === 0 && pkg.name === PUBLISH_PACKAGE_NAME && Boolean(bin),
  };
}

export function assertPublishReady(root = packageRoot()): PublishReady {
  const info = inspectPublishReady(root);
  if (!info.ok) {
    throw new Error(`Package is not npx-ready:\n${info.missing.map((m) => `  - ${m}`).join("\n")}`);
  }
  return info;
}
