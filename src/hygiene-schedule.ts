/**
 * Schedule weekly local hygiene (decay + merge). Pro/IT at run time.
 * Uses LaunchAgent (macOS), systemd user timer (Linux), or Startup cmd (Windows).
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { amemHome } from "./paths.js";
import { resolveAmemProgramArgs } from "./install/skills.js";

export const HYGIENE_LABEL = "co.amem.hygiene";
export const HYGIENE_SYSTEMD_SERVICE = "amem-hygiene.service";
export const HYGIENE_SYSTEMD_TIMER = "amem-hygiene.timer";

export type HygieneScheduleOpts = {
  /** Hour of day local time 0–23 (default 4). */
  hour?: number;
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hygieneArgs(): string[] {
  return resolveAmemProgramArgs("hygiene", "--scheduled");
}

function shellQuote(args: string[]): string {
  return args.map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
}

export function hygieneLaunchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${HYGIENE_LABEL}.plist`);
}

export function hygieneSystemdServicePath(): string {
  return join(homedir(), ".config", "systemd", "user", HYGIENE_SYSTEMD_SERVICE);
}

export function hygieneSystemdTimerPath(): string {
  return join(homedir(), ".config", "systemd", "user", HYGIENE_SYSTEMD_TIMER);
}

export function hygieneWindowsStartupPath(): string {
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "amem-hygiene.cmd");
}

export function isHygieneScheduleInstalled(): boolean {
  if (process.platform === "darwin") return existsSync(hygieneLaunchAgentPath());
  if (process.platform === "linux") return existsSync(hygieneSystemdTimerPath());
  if (process.platform === "win32") return existsSync(hygieneWindowsStartupPath());
  return false;
}

export function hygieneSchedulePath(): string {
  if (process.platform === "darwin") return hygieneLaunchAgentPath();
  if (process.platform === "linux") return hygieneSystemdTimerPath();
  if (process.platform === "win32") return hygieneWindowsStartupPath();
  return "";
}

function uid(): string {
  return String(process.getuid?.() ?? "");
}

export function installHygieneSchedule(opts: HygieneScheduleOpts = {}): {
  path: string;
  platform: string;
  hour: number;
} {
  const hour = Math.min(23, Math.max(0, opts.hour ?? 4));
  const args = hygieneArgs();

  if (process.platform === "darwin") {
    const path = hygieneLaunchAgentPath();
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    const argXml = args.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
    // Weekly: Sunday at hour:20
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${HYGIENE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>0</integer>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>20</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(amemHome(), "hygiene.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(amemHome(), "hygiene.err.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
    writeFileSync(path, body, "utf8");
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid()}`, path], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // not loaded
    }
    try {
      execFileSync("launchctl", ["bootstrap", `gui/${uid()}`, path], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // next login picks it up
    }
    return { path, platform: "darwin", hour };
  }

  if (process.platform === "linux") {
    const unitDir = join(homedir(), ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    const svc = hygieneSystemdServicePath();
    const timer = hygieneSystemdTimerPath();
    writeFileSync(
      svc,
      `[Unit]
Description=amem local memory hygiene
[Service]
Type=oneshot
ExecStart=${shellQuote(args)}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homedir()}/.local/bin
`,
      "utf8",
    );
    writeFileSync(
      timer,
      `[Unit]
Description=Weekly amem memory hygiene
[Timer]
OnCalendar=Sun *-*-* ${String(hour).padStart(2, "0")}:20:00
Persistent=true
[Install]
WantedBy=timers.target
`,
      "utf8",
    );
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      execFileSync("systemctl", ["--user", "enable", "--now", HYGIENE_SYSTEMD_TIMER], {
        stdio: "ignore",
      });
    } catch {
      // unit files are on disk
    }
    return { path: timer, platform: "linux", hour };
  }

  if (process.platform === "win32") {
    const path = hygieneWindowsStartupPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      `@echo off\r\nrem amem weekly hygiene (runs at login; Pro/IT required)\r\n${shellQuote(args)}\r\n`,
      "utf8",
    );
    return { path, platform: "win32", hour };
  }

  throw new Error(`Hygiene scheduling not supported on ${process.platform}`);
}

export function uninstallHygieneSchedule(): { path: string; platform: string } {
  if (process.platform === "darwin") {
    const path = hygieneLaunchAgentPath();
    if (existsSync(path)) {
      try {
        execFileSync("launchctl", ["bootout", `gui/${uid()}`, path], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        // ignore
      }
      unlinkSync(path);
    }
    return { path, platform: "darwin" };
  }
  if (process.platform === "linux") {
    const timer = hygieneSystemdTimerPath();
    const svc = hygieneSystemdServicePath();
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", HYGIENE_SYSTEMD_TIMER], {
        stdio: "ignore",
      });
    } catch {
      // ignore
    }
    if (existsSync(timer)) unlinkSync(timer);
    if (existsSync(svc)) unlinkSync(svc);
    return { path: timer, platform: "linux" };
  }
  if (process.platform === "win32") {
    const path = hygieneWindowsStartupPath();
    if (existsSync(path)) unlinkSync(path);
    return { path, platform: "win32" };
  }
  throw new Error(`Hygiene scheduling not supported on ${process.platform}`);
}

export function writeHygieneHelperScript(): string {
  const script = join(amemHome(), "bin", "amem-hygiene.sh");
  mkdirSync(join(amemHome(), "bin"), { recursive: true, mode: 0o700 });
  const body = `#!/usr/bin/env bash
set -euo pipefail
exec ${shellQuote(hygieneArgs())}
`;
  writeFileSync(script, body, { mode: 0o700 });
  try {
    chmodSync(script, 0o700);
  } catch {
    // ignore
  }
  return script;
}

export function hygieneScheduleStatus(): {
  installed: boolean;
  path: string;
  platform: string;
} {
  return {
    installed: isHygieneScheduleInstalled(),
    path: hygieneSchedulePath(),
    platform: process.platform,
  };
}
