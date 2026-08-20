/**
 * Schedule local encrypted backups (no cloud sync).
 * Uses LaunchAgent (macOS), systemd user timer (Linux), or Startup cmd (Windows).
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { defaultBackupDir } from "./crypto.js";
import { amemHome } from "./paths.js";
import { resolveAmemProgramArgs } from "./install/skills.js";

export const BACKUP_LABEL = "co.amem.backup";
export const BACKUP_SYSTEMD_SERVICE = "amem-backup.service";
export const BACKUP_SYSTEMD_TIMER = "amem-backup.timer";

export type BackupScheduleOpts = {
  outDir?: string;
  /** Hour of day local time 0–23 (default 3). */
  hour?: number;
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function backupArgs(outDir: string): string[] {
  return resolveAmemProgramArgs("backup", "--out", outDir);
}

function shellQuote(args: string[]): string {
  return args.map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
}

export function backupLaunchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${BACKUP_LABEL}.plist`);
}

export function backupSystemdServicePath(): string {
  return join(homedir(), ".config", "systemd", "user", BACKUP_SYSTEMD_SERVICE);
}

export function backupSystemdTimerPath(): string {
  return join(homedir(), ".config", "systemd", "user", BACKUP_SYSTEMD_TIMER);
}

export function backupWindowsStartupPath(): string {
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "amem-backup.cmd");
}

export function isBackupScheduleInstalled(): boolean {
  if (process.platform === "darwin") return existsSync(backupLaunchAgentPath());
  if (process.platform === "linux") return existsSync(backupSystemdTimerPath());
  if (process.platform === "win32") return existsSync(backupWindowsStartupPath());
  return false;
}

export function backupSchedulePath(): string {
  if (process.platform === "darwin") return backupLaunchAgentPath();
  if (process.platform === "linux") return backupSystemdTimerPath();
  if (process.platform === "win32") return backupWindowsStartupPath();
  return "";
}

function uid(): string {
  return String(process.getuid?.() ?? "");
}

export function installBackupSchedule(opts: BackupScheduleOpts = {}): {
  path: string;
  outDir: string;
  platform: string;
} {
  const outDir = opts.outDir || defaultBackupDir();
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const hour = Math.min(23, Math.max(0, opts.hour ?? 3));
  const args = backupArgs(outDir);

  if (process.platform === "darwin") {
    const path = backupLaunchAgentPath();
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    const argXml = args.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${BACKUP_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>15</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(amemHome(), "backup.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(amemHome(), "backup.err.log"))}</string>
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
    return { path, outDir, platform: "darwin" };
  }

  if (process.platform === "linux") {
    const unitDir = join(homedir(), ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    const svc = backupSystemdServicePath();
    const timer = backupSystemdTimerPath();
    writeFileSync(
      svc,
      `[Unit]
Description=amem local encrypted backup
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
Description=Daily amem local backup
[Timer]
OnCalendar=*-*-* ${String(hour).padStart(2, "0")}:15:00
Persistent=true
[Install]
WantedBy=timers.target
`,
      "utf8",
    );
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      execFileSync("systemctl", ["--user", "enable", "--now", BACKUP_SYSTEMD_TIMER], {
        stdio: "ignore",
      });
    } catch {
      // unit files are on disk
    }
    return { path: timer, outDir, platform: "linux" };
  }

  if (process.platform === "win32") {
    const path = backupWindowsStartupPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      `@echo off\r\nrem amem daily backup (runs at login)\r\n${shellQuote(args)}\r\n`,
      "utf8",
    );
    return { path, outDir, platform: "win32" };
  }

  throw new Error(`Backup scheduling not supported on ${process.platform}`);
}

export function uninstallBackupSchedule(): { path: string; platform: string } {
  if (process.platform === "darwin") {
    const path = backupLaunchAgentPath();
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
    const timer = backupSystemdTimerPath();
    const svc = backupSystemdServicePath();
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", BACKUP_SYSTEMD_TIMER], {
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
    const path = backupWindowsStartupPath();
    if (existsSync(path)) unlinkSync(path);
    return { path, platform: "win32" };
  }
  throw new Error(`Backup scheduling not supported on ${process.platform}`);
}

/** Write a tiny wrapper script under ~/.amem for manual cron users. */
export function writeBackupHelperScript(outDir?: string): string {
  const dir = outDir || defaultBackupDir();
  const script = join(amemHome(), "bin", "amem-backup.sh");
  mkdirSync(join(amemHome(), "bin"), { recursive: true, mode: 0o700 });
  const body = `#!/usr/bin/env bash
set -euo pipefail
exec ${shellQuote(backupArgs(dir))}
`;
  writeFileSync(script, body, { mode: 0o700 });
  try {
    chmodSync(script, 0o700);
  } catch {
    // ignore
  }
  return script;
}
