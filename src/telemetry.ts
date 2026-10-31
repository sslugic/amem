/**
 * Anonymous usage ping: one `first_run` event, then at most one `active` event per day.
 * Payload: random install id, version, Node, OS/arch, first-seen date and how many times
 * each entry point (MCP, hooks, UI, CLI, setup) ran since the last ping. Never memory
 * content, repo names, paths, usernames or emails.
 *
 * Opt-in: nothing is sent until the user turns it on (`amem setup` asks once, or
 * `amem telemetry on`), which sets `telemetry = true` in ~/.amem/policy.toml. That policy
 * value is the only switch. Even when on, it stays off when AMEM_TELEMETRY_DISABLED /
 * DO_NOT_TRACK is set, in CI and tests, and under a managed (system or AMEM_POLICY_PATH)
 * policy. Never throws and never blocks the command: the request runs in a detached child.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readVersion } from "./attest.js";
import { amemHome } from "./paths.js";
import { loadPolicy, setUserTelemetry, telemetryEnabled } from "./policy.js";

export const TELEMETRY_FEATURES = ["mcp", "hook", "ui", "cli", "setup"] as const;
export type TelemetryFeature = (typeof TELEMETRY_FEATURES)[number];

/** Bookkeeping only (install id, last ping, unsent counts); on/off lives in policy. */
type TelemetryState = {
  id: string;
  firstSeen: string;
  lastPing?: string;
  pending: Partial<Record<TelemetryFeature, number>>;
};

const DEFAULT_ENDPOINT = "https://getamem.com/api/beacon/usage";

export const TELEMETRY_NOTICE =
  "amem can send an anonymous daily usage ping (version, OS, which features ran; never memory content). It is off unless you turn it on: amem telemetry on";

function statePath(): string {
  return join(amemHome(), "telemetry.json");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function truthyEnv(name: string): boolean {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

function readState(): TelemetryState | null {
  try {
    const file = statePath();
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<TelemetryState>;
    if (typeof raw.id !== "string" || !raw.id) return null;
    return {
      id: raw.id,
      firstSeen: typeof raw.firstSeen === "string" ? raw.firstSeen : today(),
      lastPing: typeof raw.lastPing === "string" ? raw.lastPing : undefined,
      pending: raw.pending && typeof raw.pending === "object" ? raw.pending : {},
    };
  } catch {
    return null;
  }
}

function writeState(state: TelemetryState): void {
  const file = statePath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** Why the ping is off before the user's own on/off choice, or null when allowed. */
export function telemetryBlockedReason(): string | null {
  if (truthyEnv("AMEM_TELEMETRY_DISABLED")) return "AMEM_TELEMETRY_DISABLED is set";
  if (truthyEnv("DO_NOT_TRACK")) return "DO_NOT_TRACK is set";
  if (truthyEnv("CI")) return "CI environment";
  if (process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT) return "test run";
  try {
    const managed = loadPolicy().sources.some((s) => s.applied && (s.role === "system" || s.role === "env"));
    if (managed) return "managed policy";
  } catch {
    return "policy unreadable";
  }
  return null;
}

export type TelemetryStatus = { enabled: boolean; reason: string; id: string | null };

export function telemetryStatus(): TelemetryStatus {
  const state = readState();
  if (!telemetryEnabled(loadPolicy(true).policy)) {
    return { enabled: false, reason: "opt-in: amem telemetry on", id: state?.id ?? null };
  }
  const blocked = telemetryBlockedReason();
  if (blocked) return { enabled: false, reason: blocked, id: state?.id ?? null };
  return { enabled: true, reason: "anonymous daily usage ping", id: state?.id ?? null };
}

/** `amem telemetry on|off`: writes the policy switch. Off also drops counts not yet sent. */
export function setTelemetryEnabled(enabled: boolean): void {
  setUserTelemetry(enabled);
  const state = readState();
  if (state && !enabled) {
    state.pending = {};
    writeState(state);
  }
}

export function featureForCommand(cmd: string): TelemetryFeature | null {
  switch (cmd) {
    case "telemetry":
    case "help":
    case "--help":
    case "-h":
      return null;
    case "hook":
      return "hook";
    case "mcp":
      return "mcp";
    case "ui":
    case "app":
      return "ui";
    case "setup":
    case "init":
      return "setup";
    default:
      return "cli";
  }
}

function send(payload: Record<string, unknown>): void {
  const sender = join(dirname(fileURLToPath(import.meta.url)), "telemetry-send.js");
  if (!existsSync(sender)) return;
  const child = spawn(process.execPath, [sender, process.env.AMEM_TELEMETRY_URL || DEFAULT_ENDPOINT, JSON.stringify(payload)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
}

/** Count one run of `feature`; sends the first-run or daily ping when one is due. */
export function noteUsage(feature: TelemetryFeature): void {
  try {
    if (!telemetryEnabled() || telemetryBlockedReason()) return;
    let state = readState();
    let event: "first_run" | "active" | null = null;
    if (!state) {
      state = { id: randomUUID(), firstSeen: today(), pending: {} };
      event = "first_run";
    }
    state.pending[feature] = (state.pending[feature] ?? 0) + 1;
    if (!event && state.lastPing !== today()) event = "active";
    if (event) {
      send({
        event,
        id: state.id,
        version: readVersion(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        firstSeen: state.firstSeen,
        features: state.pending,
      });
      state.lastPing = today();
      state.pending = {};
    }
    writeState(state);
  } catch {
    /* telemetry must never affect the command */
  }
}
