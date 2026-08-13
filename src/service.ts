import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { amemHome } from "./paths.js";
import { resolveAmemProgramArgs } from "./install/skills.js";

export const SERVICE_LABEL = "co.amem.ui";

export function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

export function isServiceInstalled(): boolean {
  return existsSync(launchAgentPath());
}

function plistBody(): string {
  const args = resolveAmemProgramArgs("ui", "--no-open");
  const argXml = args.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  const logs = amemHome();
  const pathEnv = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>WorkingDirectory</key>
  <string>${escapeXml(homedir())}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logs, "ui.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logs, "ui.err.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(pathEnv)}</string>
  </dict>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function uid(): string {
  return String(process.getuid?.() ?? "");
}

function launchctl(args: string[]): void {
  execFileSync("launchctl", args, { stdio: ["ignore", "pipe", "pipe"] });
}

export function installLoginService(): { path: string; installed: boolean } {
  if (process.platform !== "darwin") {
    throw new Error("Login auto-start is currently supported on macOS only.");
  }
  const path = launchAgentPath();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(path, plistBody(), "utf8");
  const domain = `gui/${uid()}`;
  try {
    launchctl(["bootout", domain, path]);
  } catch {
    // not loaded yet
  }
  try {
    launchctl(["bootstrap", domain, path]);
  } catch {
    try {
      launchctl(["load", "-w", path]);
    } catch {
      // plist is on disk; next login still picks it up
    }
  }
  return { path, installed: true };
}

export function uninstallLoginService(): { path: string; installed: boolean } {
  const path = launchAgentPath();
  if (process.platform === "darwin" && existsSync(path)) {
    try {
      launchctl(["bootout", `gui/${uid()}`, path]);
    } catch {
      try {
        launchctl(["unload", "-w", path]);
      } catch {
        // ignore
      }
    }
    unlinkSync(path);
  }
  return { path, installed: false };
}
