/**
 * Secret detection for memory text. Blocks secret *values* (keys, tokens, passwords
 * written out), not mentions of secret *names*: "set SUMSUB_MOCK_WEBHOOK_SECRET from
 * GCP" or `TOKEN="$(gcloud …)"` are durable facts worth keeping, while
 * `API_KEY=sk-live-…` is not.
 *
 * Each pattern matches the value only (names sit in lookbehinds), so redactSecrets()
 * can keep "api_key: [REDACTED]" readable.
 */

/** A value that is a reference, not a literal: $VAR, $(cmd), ${VAR}, {{tpl}}, <placeholder>, env lookups. */
const REFERENCE = String.raw`(?:\$|\{\{|<|%|process\.env|env\.|os\.environ|getenv|secrets\.|vault:|op://)`;

/** Names that hold credentials, e.g. password, DB_PASSWORD, client_secret, apiKey, X_TOKEN. */
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|credential)[A-Za-z0-9_]*`;

/** `name: "` / `name = ` — what sits between a credential name and its value. */
const ASSIGN = String.raw`["']?\s*[:=]\s*["']?`;

/**
 * A word (one short number at most) followed by more prose — "minimum12chars rule lives
 * in …" — is a sentence, not a credential. "abc123def456 for now" still counts.
 */
const NOT_PROSE = String.raw`(?![a-z]*\d{0,2}[a-z]*\s+[a-z]+\s+[a-z]+\b)`;

const VALUE_CHARS = String.raw`[^\s"'\x60,;]`;

/**
 * Regex sources shared with the claim deny-list (policy.ts), so remember, capture and
 * skill writes agree on what a secret looks like. Compiled case-insensitive.
 */
export const SECRET_VALUE_PATTERNS: string[] = [
  // PEM private keys: the header, and body lines pasted without it
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
  String.raw`\bMII[A-Za-z0-9+/]{40,}`,
  // name = literal value: 8+ chars with a digit, or 16+ letters-only (no separators, so
  // ENV_VAR_NAMES and hyphenated phrases stay readable)
  String.raw`(?<=\b${SECRET_NAME}${ASSIGN})(?!["']?${REFERENCE})${NOT_PROSE}(?=${VALUE_CHARS}*\d)${VALUE_CHARS}{8,}`,
  String.raw`(?<=\b${SECRET_NAME}${ASSIGN})(?!["']?${REFERENCE})[A-Za-z+/=]{16,}(?!${VALUE_CHARS})`,
  String.raw`(?<=\bpass(?:word|wd)?${ASSIGN})(?!["']?${REFERENCE})${NOT_PROSE}${VALUE_CHARS}{6,}`,
  // "the password is Tr0ub4dor&3" — prose form needs a digit or symbol to count
  String.raw`(?<=\bpass(?:word|wd)?\s+is\s+)(?!${REFERENCE})(?=\S*[\d&!@#^*~])${VALUE_CHARS}{6,}`,
  // Credentials inside URLs: scheme://user:password@host
  String.raw`(?<=\b[a-z][a-z0-9+.-]*://[^\s:/@]+:)[^\s@/]+(?=@)`,
  String.raw`(?<=hooks\.slack\.com/services/)[A-Za-z0-9/_-]{12,}`,
  // Well-known token formats
  String.raw`\bAKIA[0-9A-Z]{16}\b`,
  String.raw`\bAIza[0-9A-Za-z_-]{35}`,
  String.raw`\bnpm_[A-Za-z0-9]{36}`,
  String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}`,
  String.raw`\bgh[pousr]_[A-Za-z0-9]{30,}`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
  String.raw`\bsk-(?:live|test|proj|ant)?[A-Za-z0-9_-]{20,}`,
  String.raw`\b(?:sk|pk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{3,}`,
  String.raw`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+`,
  String.raw`(?<=\bBearer\s+)[A-Za-z0-9._~+/-]{20,}`,
  String.raw`(?<=\bBasic\s+)[A-Za-z0-9+/=]{16,}`,
];

const COMPILED = SECRET_VALUE_PATTERNS.map((p) => new RegExp(p, "i"));
const COMPILED_GLOBAL = SECRET_VALUE_PATTERNS.map((p) => new RegExp(p, "gi"));

/** Runs of the base64/hex/url-safe alphabet; anything else (and an inner `=`) separates tokens. */
const TOKEN_RE = /[A-Za-z0-9+/_-]{24,}={0,2}/g;

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** A plain word: lowercase, Capitalized or ALLCAPS, not rAnDoM case. */
const WORD = /^(?:[a-z]{3,}|[A-Z][a-z]{2,}|[A-Z]{3,})$/;

/**
 * An unlabelled random-looking token: 24+ chars, upper and lower case and a digit, and
 * Shannon entropy of at least 4 bits per char. What looks random but isn't is let through:
 * paths and dashed/underscored names (two or more plain-word parts), camelCase
 * identifiers, git SHAs (one case), and prefixed ids with a short random part
 * (toolu_…, msg_…) — vendor keys with prefixes have their own patterns above.
 */
function isHighEntropyToken(token: string): boolean {
  if (token.startsWith("/")) return false;
  if (token.split(/[/_-]+/).filter((part) => WORD.test(part)).length >= 2) return false;
  if (/^[A-Za-z]?[a-z]+(?:[A-Z][a-z]+)+\d{0,4}$/.test(token)) return false;
  const prefixed = /^[A-Za-z][A-Za-z0-9]*_(.+)$/.exec(token);
  const body = prefixed ? prefixed[1]! : token;
  if (prefixed && body.length < 32) return false;
  if (!/[A-Z]/.test(body) || !/[a-z]/.test(body) || !/\d/.test(body)) return false;
  return shannonEntropy(body) >= 4.0;
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`|)\]]+/gi;

/**
 * Candidate tokens, skipping URLs (Slack/GitHub links are full of random-looking ids;
 * credentials in URLs have their own patterns above) and hostname/file-name parts.
 */
function entropyCandidates(text: string): Array<{ index: number; token: string }> {
  const urls = [...text.matchAll(URL_RE)].map((m) => [m.index!, m.index! + m[0].length]);
  return [...text.matchAll(TOKEN_RE)]
    .map((m) => ({ index: m.index!, token: m[0] }))
    .filter(({ index, token }) => {
      const end = index + token.length;
      if (urls.some(([a, b]) => index >= a! && end <= b!)) return false;
      if (text[index - 1] === "." || /^\.[A-Za-z]/.test(text.slice(end, end + 2))) return false;
      return isHighEntropyToken(token);
    });
}

function highEntropyTokens(text: string): string[] {
  return entropyCandidates(text).map((c) => c.token);
}

export function looksLikeSecretValue(text: string): boolean {
  const t = String(text ?? "");
  return COMPILED.some((re) => re.test(t)) || highEntropyTokens(t).length > 0;
}

export const REDACTED = "[REDACTED]";

/** Replace every secret value with [REDACTED], keeping the surrounding text. */
export function redactSecrets(text: string): string {
  let out = String(text ?? "");
  for (const re of COMPILED_GLOBAL) out = out.replace(re, REDACTED);
  for (const { index, token } of entropyCandidates(out).reverse()) {
    out = `${out.slice(0, index)}${REDACTED}${out.slice(index + token.length)}`;
  }
  return out;
}

/** redactSecrets over every string inside a JSON-like value (drafts store whole proposals). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}
