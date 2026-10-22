/**
 * Secret detection for memory text. Blocks secret *values* (keys, tokens, passwords
 * written out), not mentions of secret *names*: "set SUMSUB_MOCK_WEBHOOK_SECRET from
 * GCP" or `TOKEN="$(gcloud …)"` are durable facts worth keeping, while
 * `API_KEY=sk-live-…` is not.
 */

/** A value that is a reference, not a literal: $VAR, $(cmd), ${VAR}, {{tpl}}, <placeholder>, env lookups. */
const REFERENCE = String.raw`(?:\$|\{\{|<|%|process\.env|env\.|os\.environ|getenv|secrets\.|vault:|op://)`;

/** Names that hold credentials, e.g. password, DB_PASSWORD, client_secret, apiKey, X_TOKEN. */
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|credential)[A-Za-z0-9_]*`;

/**
 * Regex sources shared with the claim deny-list (policy.ts), so remember, capture and
 * skill writes agree on what a secret looks like.
 */
export const SECRET_VALUE_PATTERNS: string[] = [
  // PEM private keys
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
  // name = literal value (quoted or not); the value must not be a reference and must
  // look like a credential: 12+ chars with a digit, or 6+ chars for a password.
  String.raw`\b${SECRET_NAME}["']?\s*[:=]\s*["']?(?!["']?${REFERENCE})(?=[^\s"'\x60,;]*\d)[^\s"'\x60,;]{8,}`,
  String.raw`\bpass(?:word|wd)?["']?\s*[:=]\s*["']?(?!["']?${REFERENCE})[^\s"'\x60,;]{6,}`,
  // Well-known token formats
  String.raw`\bAKIA[0-9A-Z]{16}\b`,
  String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}`,
  String.raw`\bgh[pousr]_[A-Za-z0-9]{30,}`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
  String.raw`\bsk-(?:live|test|proj|ant)?[A-Za-z0-9_-]{20,}`,
  String.raw`\b(?:sk|pk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{3,}`,
  String.raw`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+`,
  String.raw`\bBearer\s+[A-Za-z0-9._~+/-]{20,}`,
];

const COMPILED = SECRET_VALUE_PATTERNS.map((p) => new RegExp(p, "i"));

export function looksLikeSecretValue(text: string): boolean {
  const t = String(text ?? "");
  return COMPILED.some((re) => re.test(t));
}
