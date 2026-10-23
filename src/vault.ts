import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  defaultBackupDir,
  encryptedDbPath,
  encryptionConfigured,
  isDbEncryptedAtRest,
} from "./crypto.js";
import { backupSchedulePath, isBackupScheduleInstalled, readBackupScheduleHour } from "./backup-schedule.js";
import { dbPath } from "./paths.js";
import { backupRetention } from "./crypto.js";

export type BackupEntry = {
  name: string;
  path: string;
  bytes: number;
  mtime: string;
  encrypted: boolean;
};

export type VaultStatus = {
  dbPath: string;
  encryptedAtRest: boolean;
  unlocked: boolean;
  encCopyPresent: boolean;
  encryptionConfigured: boolean;
  backup: {
    dir: string;
    scheduled: boolean;
    schedulePath: string;
    scheduledHour: number | null;
    totalBytes: number;
    retention: { keepDays: number; keepMonths: number; keepRecent: number };
    last: BackupEntry | null;
    recent: BackupEntry[];
    count: number;
  };
};

export function listBackups(dir = defaultBackupDir()): BackupEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".db") || name.endsWith(".db.enc"))
    .map((name) => {
      const path = join(dir, name);
      const st = statSync(path);
      return {
        name,
        path,
        bytes: st.size,
        mtime: st.mtime.toISOString(),
        encrypted: name.endsWith(".enc"),
      };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/** Lock/backup chrome — does not open the SQLite DB (works while locked). */
export function vaultStatus(): VaultStatus {
  const backups = listBackups();
  return {
    dbPath: dbPath(),
    encryptedAtRest: isDbEncryptedAtRest(),
    unlocked: existsSync(dbPath()),
    encCopyPresent: existsSync(encryptedDbPath()),
    encryptionConfigured: encryptionConfigured(),
    backup: {
      dir: defaultBackupDir(),
      scheduled: isBackupScheduleInstalled(),
      schedulePath: isBackupScheduleInstalled() ? backupSchedulePath() : "",
      /** Hour (0-23) of the daily run, minute is always :15. Null when unknown or off. */
      scheduledHour: readBackupScheduleHour(),
      last: backups[0] ?? null,
      recent: backups.slice(0, 8),
      count: backups.length,
      totalBytes: backups.reduce((n, b) => n + (b.bytes || 0), 0),
      retention: (({ keepDays, keepMonths, keepRecent }) => ({ keepDays, keepMonths, keepRecent }))(backupRetention()),
    },
  };
}
