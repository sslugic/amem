/**
 * Local IT pack: deny-default policy, MDM snippet, SBOM, offboard pointer.
 * No cloud, no telemetry. IT tier recommended; generating the folder is allowed on any machine.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { amemHome } from "./paths.js";
import { licenseStatus } from "./license.js";
import { embedStatus } from "./embed.js";
import { vaultStatus } from "./vault.js";

function packageRoot(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "..");
}

export type SbomComponent = {
  name: string;
  version: string;
  type: "application" | "library";
};

export type Sbom = {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  serialNumber: string;
  metadata: { timestamp: string; component: SbomComponent };
  components: SbomComponent[];
};

export function buildSbom(): Sbom {
  const pkgPath = join(packageRoot(), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
  };
  const components: SbomComponent[] = Object.entries(pkg.dependencies ?? {}).map(([name, version]) => ({
    name,
    version: String(version).replace(/^[\^~]/, ""),
    type: "library",
  }));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${createHash("sha256").update(`${pkg.name}@${pkg.version}`).digest("hex").slice(0, 32)}`,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        name: pkg.name || "amem",
        version: pkg.version || "0.0.0",
        type: "application",
      },
    },
    components,
  };
}

export function writeItPack(outDir: string): { dir: string; files: string[] } {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const files: string[] = [];
  const root = packageRoot();

  const denySrc = join(root, "templates", "policy.deny-default.toml");
  const denyOut = join(outDir, "policy.toml");
  copyFileSync(existsSync(denySrc) ? denySrc : join(root, "templates", "policy.example.toml"), denyOut);
  files.push(denyOut);

  const mdmSrc = join(root, "templates", "mdm", "co.amem.managed.plist");
  if (existsSync(mdmSrc)) {
    const mdmOut = join(outDir, "co.amem.managed.plist");
    copyFileSync(mdmSrc, mdmOut);
    files.push(mdmOut);
  }

  const offboardSrc = join(root, "scripts", "mdm-offboard.sh");
  if (existsSync(offboardSrc)) {
    const offOut = join(outDir, "mdm-offboard.sh");
    copyFileSync(offboardSrc, offOut);
    files.push(offOut);
  }

  const sbomOut = join(outDir, "sbom.json");
  writeFileSync(sbomOut, `${JSON.stringify(buildSbom(), null, 2)}\n`, "utf8");
  files.push(sbomOut);

  const notes = `# amem IT pack (local)

Memory stays on each laptop under ${amemHome()}.
There is no license server and no cloud sync.

1. Deploy policy.toml as /etc/amem/policy.toml (root-owned).
2. Install a pinned amem build (internal npm or mirrored clone).
3. Optional: wrap co.amem.managed.plist in your MDM profile.
4. Offboard with mdm-offboard.sh (wipes ~/.amem on that machine).
5. Attach sbom.json + \`amem doctor --attest --json\` to the security ticket.
   IT tier adds a richer vault/host attest packet; the pack folder itself is available on Free.

Signed macOS/Windows installers need your org’s code-signing cert — amem does not upload binaries.

License: ${licenseStatus().tier}
Embed: ${embedStatus().backend}
Vault backups: ${vaultStatus().backup.dir}
`;
  const notesOut = join(outDir, "README.txt");
  writeFileSync(notesOut, notes, "utf8");
  files.push(notesOut);
  return { dir: outDir, files };
}
