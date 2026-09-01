import { readFileSync } from "node:fs";
import { relative, isAbsolute, resolve } from "node:path";

/**
 * Reading what a session actually opened, out of the host's own transcript.
 *
 * Attestation that depends on an agent remembering to call a reporting tool at
 * the end of a task will mostly not happen. The transcript already records
 * every file read, so the honest signal is sitting there — this reads it.
 */

/** Tool-input keys that name a file across Claude Code, Cursor and friends. */
const PATH_KEYS = new Set([
  "file_path",
  "filePath",
  "notebook_path",
  "notebookPath",
  "path",
  "target_file",
  "targetFile",
]);

/** Tools whose use means a file was actually read or written. */
const FILE_TOOLS = /^(read|edit|write|notebookedit|multiedit|str_replace|view|open)/i;

export type TranscriptOpens = {
  /** Absolute or host-relative paths the session touched. */
  paths: string[];
  /**
   * Whether any file-touching tool use was found at all. False means the
   * transcript could not be understood — NOT that the session opened nothing.
   */
  sawToolActivity: boolean;
};

function collectPaths(node: unknown, out: Set<string>, sawTool: { value: boolean }): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectPaths(item, out, sawTool);
    return;
  }
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  // A tool_use block: { type: "tool_use", name: "Read", input: { file_path } }
  const name = typeof obj.name === "string" ? obj.name : null;
  const isFileTool = name != null && FILE_TOOLS.test(name);
  if (isFileTool) sawTool.value = true;

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && PATH_KEYS.has(key) && value.trim()) {
      // Only trust a path when it came from something that reads files;
      // "path" appears in plenty of unrelated payloads.
      if (isFileTool || key !== "path") out.add(value.trim());
      if (isFileTool) sawTool.value = true;
    } else if (value && typeof value === "object") {
      collectPaths(value, out, sawTool);
    }
  }
}

/**
 * Extract the files a session opened. Handles JSONL (one message per line) and
 * whole-file JSON, and never throws — an unreadable transcript yields no
 * evidence, which callers must treat as "unknown", not as "opened nothing".
 */
export function readTranscriptOpens(transcriptPath: string): TranscriptOpens {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return { paths: [], sawToolActivity: false };
  }
  const paths = new Set<string>();
  const sawTool = { value: false };

  const lines = raw.split("\n");
  let parsedAny = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      collectPaths(JSON.parse(trimmed), paths, sawTool);
      parsedAny = true;
    } catch {
      // not JSONL — fall through to a whole-file parse below
    }
  }
  if (!parsedAny) {
    try {
      collectPaths(JSON.parse(raw), paths, sawTool);
    } catch {
      return { paths: [], sawToolActivity: false };
    }
  }
  return { paths: [...paths], sawToolActivity: sawTool.value };
}

/**
 * Match transcript paths against the anchors a packet returned. Anchors are
 * repo-relative; transcript paths are usually absolute, so compare both ways.
 */
export function anchorsOpenedFrom(
  anchorsReturned: string[],
  openedPaths: string[],
  rootPath: string | null,
): string[] {
  if (!anchorsReturned.length || !openedPaths.length) return [];
  const opened = new Set<string>();
  for (const raw of openedPaths) {
    const p = raw.trim();
    if (!p) continue;
    opened.add(p);
    if (rootPath && isAbsolute(p)) {
      const rel = relative(rootPath, p);
      // Outside the repo entirely — not one of our anchors.
      if (rel && !rel.startsWith("..")) opened.add(rel);
    }
  }
  return anchorsReturned.filter((anchor) => {
    if (opened.has(anchor)) return true;
    if (rootPath && !isAbsolute(anchor)) return opened.has(resolve(rootPath, anchor));
    return false;
  });
}
