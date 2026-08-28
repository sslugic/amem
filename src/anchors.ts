/**
 * Code anchors: file paths, optional symbol or line.
 *
 * Canonical forms:
 *   src/api.ts
 *   src/api.ts:validateWebhook
 *   src/api.ts:42
 *
 * Accepted aliases: path#Symbol, path::Symbol
 */

const PATH_EXT =
  "ts|tsx|js|jsx|mjs|cjs|py|go|rs|md|json|yml|yaml|sql|java|kt|swift|rb|php|cs|cpp|cc|h|hpp|ex|exs|erl|hs|scala|dart|lua|sh|zsh|bash|toml|proto|graphql|tf|zig";

const ANCHOR_RE = new RegExp(
  String.raw`\b((?:[\w.-]+\/)*[\w.-]+\.(?:${PATH_EXT}))(?:(?::(\d+)\b)|(?:(?::|#|::)([A-Za-z_][\w.]*)))?`,
  "g",
);

const SYMBOL_NEAR_PATH =
  /\b(?:(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|def|fn|type|interface|enum)\s+)?([A-Za-z_][\w.]{2,})\b/g;

export type ParsedAnchor = {
  /** Original trimmed input */
  raw: string;
  /** Filesystem path portion (repo-relative or absolute) */
  path: string;
  /** Optional symbol / identifier */
  symbol?: string;
  /** Optional 1-based line */
  line?: number;
};

export function parseAnchor(raw: string): ParsedAnchor {
  const trimmed = raw.trim();
  if (!trimmed) return { raw: trimmed, path: "" };

  // path#Symbol or path::Symbol
  const hash = trimmed.match(/^(.+?)#([A-Za-z_][\w.]*)$/);
  if (hash) {
    return { raw: trimmed, path: hash[1]!.replace(/\\/g, "/"), symbol: hash[2] };
  }
  const dbl = trimmed.match(/^(.+?)::([A-Za-z_][\w.]*)$/);
  if (dbl) {
    return { raw: trimmed, path: dbl[1]!.replace(/\\/g, "/"), symbol: dbl[2] };
  }

  // path:line or path:Symbol (prefer line when all digits)
  const colon = trimmed.match(/^(.+?):([^:]+)$/);
  if (colon) {
    const path = colon[1]!.replace(/\\/g, "/");
    const rest = colon[2]!;
    if (/^\d+$/.test(rest)) {
      return { raw: trimmed, path, line: Number(rest) };
    }
    if (/^[A-Za-z_][\w.]*$/.test(rest)) {
      return { raw: trimmed, path, symbol: rest };
    }
  }

  return { raw: trimmed, path: trimmed.replace(/\\/g, "/") };
}

/** Canonical storage form. */
export function normalizeAnchor(raw: string): string {
  const p = parseAnchor(raw);
  if (!p.path) return "";
  if (p.symbol) return `${p.path}:${p.symbol}`;
  if (p.line != null && p.line > 0) return `${p.path}:${p.line}`;
  return p.path;
}

export function normalizeAnchors(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const n = normalizeAnchor(item);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** Path used for filesystem freshness / existence checks. */
export function anchorFsPath(raw: string): string {
  return parseAnchor(raw).path;
}

/** True when either exact match or same path (symbol/line ignored). */
export function anchorsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const exact = new Set(a.map(normalizeAnchor));
  const paths = new Set(a.map(anchorFsPath).filter(Boolean));
  for (const item of b) {
    const n = normalizeAnchor(item);
    if (exact.has(n)) return true;
    const path = anchorFsPath(item);
    if (path && paths.has(path)) return true;
  }
  return false;
}

export function sharedAnchorLabels(a: string[], b: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const bNorm = b.map(normalizeAnchor);
  const bPaths = new Set(b.map(anchorFsPath).filter(Boolean));
  for (const item of a) {
    const n = normalizeAnchor(item);
    if (bNorm.includes(n) || bPaths.has(anchorFsPath(item))) {
      if (!seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
  }
  return out;
}

/** Unique filesystem paths from a claim's code_anchors JSON or list. */
export function uniqueAnchorPaths(anchors: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of anchors) {
    const path = anchorFsPath(a);
    if (!path || seen.has(path)) continue;
    // Skip workspace-style labels (no slash/dot)
    if (!path.includes("/") && !path.includes(".") && !path.includes("\\")) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * Pull path and path:symbol anchors from free text.
 * When a bare path is found near a symbol keyword, attach the symbol.
 */
export function extractAnchorsFromText(text: string, opts?: { existingPaths?: Set<string> }): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const n = normalizeAnchor(raw);
    if (!n || seen.has(n)) return;
    seen.add(n);
    found.push(n);
  };

  for (const m of text.matchAll(ANCHOR_RE)) {
    const path = m[1]!;
    const line = m[2];
    const symbol = m[3];
    if (line) push(`${path}:${line}`);
    else if (symbol) push(`${path}:${symbol}`);
    else push(path);
  }

  // If we only got bare paths, try to attach a nearby symbol from the same sentence.
  if (opts?.existingPaths) {
    for (const path of opts.existingPaths) {
      if (![...seen].some((s) => s === path || s.startsWith(`${path}:`))) {
        // path known on disk but not yet in text — skip
      }
    }
  }

  const sentences = text.split(/[.!?\n]+/);
  for (const sentence of sentences) {
    const pathsInSentence = [...sentence.matchAll(ANCHOR_RE)].map((m) => m[1]!);
    if (pathsInSentence.length === 0) continue;
    const symbols = [...sentence.matchAll(SYMBOL_NEAR_PATH)]
      .map((m) => m[1]!)
      .filter(
        (s) =>
          s.length >= 3 &&
          !/^(function|class|const|let|var|export|async|return|import|from|this|true|false|null|undefined|string|number|boolean)$/i.test(
            s,
          ),
      );
    for (const path of pathsInSentence) {
      const alreadySymbolic = [...seen].some((s) => s.startsWith(`${path}:`));
      if (alreadySymbolic) continue;
      const best = symbols.find((s) => !path.toLowerCase().includes(s.toLowerCase()));
      const symbolic =
        Boolean(best) &&
        (/^[A-Z]/.test(best!) || (best!.length >= 4 && /[A-Z]/.test(best!)));
      if (best && symbolic) {
        // Prefer PascalCase / camelCase identifiers as symbols
        const bareIdx = found.indexOf(path);
        if (bareIdx >= 0) found.splice(bareIdx, 1);
        seen.delete(path);
        push(`${path}:${best}`);
      }
    }
  }

  return found.slice(0, 8);
}

/** Extra keyword tokens from symbol portions of anchors. */
export function symbolTokensFromAnchors(anchors: string[]): string[] {
  const out: string[] = [];
  for (const a of anchors) {
    const p = parseAnchor(a);
    if (!p.symbol) continue;
    for (const part of p.symbol.split(/[._]/).filter((t) => t.length > 1)) {
      out.push(part.toLowerCase());
    }
  }
  return out;
}
