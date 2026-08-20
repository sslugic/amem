import { chmodSync, existsSync, mkdirSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function tryEnsureDir(dir: string): { ok: true } | { ok: false; message: string } {
  try {
    mkdirSync(dir, { recursive: true });
    return { ok: true };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EPERM" || err.code === "EACCES") {
      return { ok: false, message: err.message };
    }
    throw error;
  }
}

/** Memory is in SQLite. A missing placeholder folder must not block workspace create. */
export function amemHomeWriteIssue(): string | null {
  const probe = join(amemHome(), "workspaces", `.write-probe-${process.pid}`);
  try {
    mkdirSync(probe, { recursive: true });
    rmdirSync(probe);
    return null;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EPERM" || err.code === "EACCES") {
      return "Cannot create folders under ~/.amem (this process is likely sandboxed — e.g. amem ui started from Cursor). Quit it and run `amem ui` in Terminal, or `amem service install` so it starts at login.";
    }
    return null;
  }
}

export function amemHome(): string {
  return process.env.AMEM_HOME ?? join(homedir(), ".amem");
}

export function ensureAmemHome(): string {
  const home = amemHome();
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(home, 0o700);
  } catch {
    // Best-effort on platforms that ignore chmod
  }
  const sessions = join(home, "sessions");
  if (!existsSync(sessions)) {
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
  }
  return home;
}

export function dbPath(): string {
  return join(ensureAmemHome(), "graph.db");
}
