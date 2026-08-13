import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
