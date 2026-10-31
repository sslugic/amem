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

/** Stand-in values from example configs and docs: `PASSWORD=changeme`, `KEY=your-key-here`. */
const PLACEHOLDER = String.raw`(?!["']?(?:change[-_]?me|changeit|password\d*|passw0rd|example\w*|sample\w*|placeholder|dummy\w*|secret|redacted|replace[-_]?me|your[-_]\S*|xxx+|\*{3,}|todo|tbd|none|null|empty|test\d*|default)(?![A-Za-z0-9_-]))`;

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
  String.raw`(?<=\b${SECRET_NAME}${ASSIGN})(?!["']?${REFERENCE})${PLACEHOLDER}${NOT_PROSE}(?=${VALUE_CHARS}*\d)${VALUE_CHARS}{8,}`,
  String.raw`(?<=\b${SECRET_NAME}${ASSIGN})(?!["']?${REFERENCE})${PLACEHOLDER}[A-Za-z+/=]{16,}(?!${VALUE_CHARS})`,
  String.raw`(?<=\bpass(?:word|wd)?${ASSIGN})(?!["']?${REFERENCE})${PLACEHOLDER}${NOT_PROSE}${VALUE_CHARS}{6,}`,
  // "the passwd is Tr0ub4dor&3" — prose form needs a digit or symbol to count
  String.raw`(?<=\bpass(?:wd)?\s+is\s+)(?!${REFERENCE})(?=\S*[\d&!@#^*~])${VALUE_CHARS}{6,}`,
  // Credentials inside URLs: scheme://user:password@host
  String.raw`(?<=\b[a-z][a-z0-9+.-]*://[^\s:/@]*:)[^\s@/]+(?=@)`,
  String.raw`(?<=hooks\.slack\.com/services/)[A-Za-z0-9/_-]{12,}`,
  // Well-known token formats
  String.raw`\bAKIA[0-9A-Z]{16}\b`,
  String.raw`\bAIza[0-9A-Za-z_-]{35}`,
  String.raw`\bnpm_[A-Za-z0-9]{36}`,
  String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}`,
  String.raw`\bgh[pousr]_[A-Za-z0-9]{30,}`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
  String.raw`\bsk-(?:live|test|proj|ant)?[A-Za-z0-9_-]{20,}`,
  // pk_live_/pk_test_ are Stripe publishable keys: public by design, so not here
  String.raw`\b(?:sk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{3,}`,
  String.raw`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+`,
  String.raw`(?<=\bBearer\s+)[A-Za-z0-9._~+/-]{20,}`,
  String.raw`(?<=\bBasic\s+)[A-Za-z0-9+/=]{16,}`,
  String.raw`\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}`,
  String.raw`\bkey-[a-z0-9]{32}\b`,
  String.raw`\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}`,
  String.raw`\bglpat-[A-Za-z0-9_-]{20,}`,
  // Vendor token prefixes
  String.raw`\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}`,
  String.raw`\bdo[pro]_v1_[a-f0-9]{64}`,
  String.raw`\bhf_[A-Za-z0-9]{30,}`,
  String.raw`\br8_[A-Za-z0-9]{30,}`,
  String.raw`\blin_(?:api|oauth)_[A-Za-z0-9]{30,}`,
  String.raw`\bsecret_[A-Za-z0-9]{40,}`,
  String.raw`\bntn_[A-Za-z0-9]{40,}`,
  String.raw`\bATATT[A-Za-z0-9_=-]{30,}`,
  String.raw`\bNRAK-[A-Z0-9]{27}`,
  String.raw`\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}`,
  String.raw`\bhv[sb]\.[A-Za-z0-9_-]{24,}`,
  String.raw`\bdp\.(?:st|ct|sa|scim|audit)\.[A-Za-z0-9_.-]{20,}`,
  String.raw`\bpypi-AgE[A-Za-z0-9_-]{30,}`,
  String.raw`\brubygems_[a-f0-9]{48}`,
  String.raw`\bdckr_pat_[A-Za-z0-9_-]{20,}`,
  String.raw`\bsq0(?:atp|csp)-[A-Za-z0-9_-]{22,}`,
  String.raw`\bEAAA[A-Za-z0-9_-]{40,}`,
  String.raw`\baccess_token\$production\$[a-z0-9]{16}\$[a-f0-9]{32}`,
  String.raw`(?<!\d)\d{8,10}:AA[A-Za-z0-9_-]{30,}`,
  // Password hashes (htpasswd, shadow, bcrypt): $apr1$salt$hash, $2y$10$…, $6$salt$hash
  String.raw`\$(?:apr1|2[abxy]|1|5|6)\$[./A-Za-z0-9]{2,}\$[./A-Za-z0-9]{8,}`,
  // Passwords passed on a command line
  String.raw`(?<=\bcurl\b[^\n]*?\s(?:-u|--user)\s+["']?[^\s:"']+:)[^\s"'@]{4,}`,
  String.raw`(?<=\bmysql(?:dump|admin)?\b[^\n]*?\s-p)(?!${REFERENCE})[^\s-][^\s]{5,}`,
  String.raw`(?<=\s--password[= ]["']?)(?!${REFERENCE})${PLACEHOLDER}[^\s"']{6,}`,
  String.raw`(?<=\b(?:docker|podman|helm) (?:login|registry login)\b[^\n]*?\s-p\s+["']?)(?!${REFERENCE})[^\s"']{6,}`,
  String.raw`\bSK[a-f0-9]{32}\b`,
  // Azure connection strings and SAS signatures
  String.raw`(?<=\b(?:AccountKey|SharedAccessKey|sig)=)[A-Za-z0-9+/%]{20,}={0,2}`,
  // Sentry DSN key: https://<key>@o123.ingest.sentry.io
  String.raw`(?<=https://)[a-f0-9]{32}(?=(?::[a-f0-9]{32})?@[^\s/]*sentry)`,
  // GCP service-account JSON
  String.raw`(?<="private_key"\s*:\s*")[^"]{20,}`,
  // Passwords in prose, a few words allowed before "is": "the password for staging is …",
  // "Das Passwort für den Server ist …", "la contraseña de root es …", "le mot de passe … est …"
  String.raw`(?<=\b(?:password|passwort|kennwort|contrase(?:ñ|n)a|mot de passe|senha|wachtwoord|parola d'ordine|has(?:ł|l)o)(?:\s+[^\s.;:]+){0,8}?\s+(?:is|ist|es|est|é|jest|è|lautet)\s*[:=]?\s*["']?)(?!${REFERENCE})${PLACEHOLDER}(?=\S*[\d&!@#^*~])${VALUE_CHARS}{6,}`,
  String.raw`(?<=\b(?:passwort|kennwort|contrase(?:ñ|n)a|mot de passe|senha|wachtwoord|has(?:ł|l)o)\s*[:=]\s*["']?)(?!${REFERENCE})${PLACEHOLDER}${VALUE_CHARS}{6,}`,
  // OpenSSH private key body ("openssh-key-v1" in base64), with or without its header
  String.raw`\bb3BlbnNzaC1rZXktdjE[A-Za-z0-9+/=]{16,}`,
];

const COMPILED_GLOBAL = SECRET_VALUE_PATTERNS.map((p) => new RegExp(p, "gi"));

/** SSH public key bodies (`ssh-ed25519 AAAAC3…`) are public. */
const SSH_PUBLIC_KEY = /\b(?:ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com)\s+AAAA[A-Za-z0-9+/]+={0,3}/g;

/**
 * Shapes that look random but are public by design: subresource-integrity / npm lockfile
 * hashes (sha512-…==) and inline data: URIs. They are blanked out before any pattern or
 * entropy check, so the threshold itself never has to loosen for them.
 */
const BENIGN_SHAPES = [
  SSH_PUBLIC_KEY,
  // AWS ARNs name a resource (even a secret); they never contain its value
  /\barn:aws[\w-]*:[\w-]+:[\w-]*:\d{0,12}:\S+/g,
  /-----BEGIN (?:RSA |EC )?(?:PUBLIC KEY|CERTIFICATE)-----[\s\S]*?-----END (?:RSA |EC )?(?:PUBLIC KEY|CERTIFICATE)-----/g,
  /\bpk_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bsha(?:1|256|384|512)-[A-Za-z0-9+/]{20,}={0,2}/g,
  /\bdata:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*;base64,[A-Za-z0-9+/]+={0,2}/gi,
];

function maskBenign(text: string): string {
  let out = text;
  for (const re of BENIGN_SHAPES) out = out.replace(re, (m) => " ".repeat(m.length));
  return out;
}

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
/**
 * Base64 that decodes to ordinary words ("aGVsbG8gd29ybGQ=" → "hello world") is quoted
 * text, not a key. Only used for unlabelled tokens: a value named as a key stays a key.
 */
function decodesToProse(token: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token) || token.length % 4 !== 0) return false;
  const text = Buffer.from(token, "base64").toString("latin1");
  if (!/^[\x20-\x7e]+$/.test(text)) return false;
  const words = text.split(/\s+/).filter((w) => /^[A-Za-z][a-z']*[.,!?]?$/.test(w));
  return words.length >= 3 && words.join("").length >= text.replace(/\s/g, "").length * 0.8;
}

function isHighEntropyToken(token: string): boolean {
  if (token.startsWith("/")) return false;
  if (decodesToProse(token)) return false;
  if (token.split(/[/_-]+/).filter((part) => WORD.test(part)).length >= 2) return false;
  if (/^[A-Za-z]?[a-z]+(?:[A-Z][a-z]+)+\d{0,4}$/.test(token)) return false;
  const prefixed = /^[A-Za-z][A-Za-z0-9]*_(.+)$/.exec(token);
  const body = prefixed ? prefixed[1]! : token;
  if (prefixed && body.length < 32) return false;
  if (!/[A-Z]/.test(body) || !/[a-z]/.test(body) || !/\d/.test(body)) return false;
  return shannonEntropy(body) >= 4.0;
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`|)\]]+/gi;

/** A credential word right before the value: `KEY=`, `SIGNING_KEY: "`, "auth token ", "secret is ". */
const KEYED_BEFORE = /(?:\b|_)(?:key|token|secret|password|passwd|credential|auth)s?["']?\s*(?:[:=]|\bis\b)?\s*["']?$/i;

/**
 * A value named as a key gets a lower bar than an unlabelled token: 16+ characters, and
 * either 32+ hex digits or a mixed run with letters and digits at 3.3 bits per char. Words,
 * paths, references and dashed names still pass.
 */
function isKeyedSecret(token: string): boolean {
  if (token.length < 16 || token.startsWith("/")) return false;
  if (/^[0-9a-f]{32,}$/i.test(token)) return true;
  if (token.split(/[/_.-]+/).filter((part) => WORD.test(part)).length >= 2) return false;
  if (/^[A-Za-z]?[a-z]+(?:[A-Z][a-z]+)+\d{0,4}$/.test(token)) return false;
  if (!/[A-Za-z]/.test(token) || !/\d/.test(token)) return false;
  return shannonEntropy(token) >= 3.3;
}

/** A token introduced as an identifier ("KSUID of the event:", "trace id") is an id, not a key. */
const ID_BEFORE =
  /\b(?:k?suid|ulid|uuid|guid|(?:trace|request|correlation|span|event|message|run|job|build|session|object|record|row)[ _-]?ids?)\b[^.!?\n]{0,16}$/i;

const KEYED_TOKEN_RE = /[A-Za-z0-9+/_-]{16,}={0,2}/g;

/**
 * Candidate tokens, skipping URLs (Slack/GitHub links are full of random-looking ids;
 * credentials in URLs have their own patterns above) and hostname/file-name parts.
 */
function entropyCandidates(text: string): Array<{ index: number; token: string }> {
  const urls = [...text.matchAll(URL_RE)].map((m) => [m.index!, m.index! + m[0].length]);
  const inUrlOrName = (index: number, token: string): boolean => {
    const end = index + token.length;
    if (urls.some(([a, b]) => index >= a! && end <= b!)) return true;
    return text[index - 1] === "." || /^\.[A-Za-z]/.test(text.slice(end, end + 2));
  };
  const unlabelled = [...text.matchAll(TOKEN_RE)]
    .map((m) => ({ index: m.index!, token: m[0] }))
    .filter(
      ({ index, token }) =>
        !inUrlOrName(index, token) &&
        !ID_BEFORE.test(text.slice(Math.max(0, index - 32), index)) &&
        isHighEntropyToken(token),
    );
  const keyed = [...text.matchAll(KEYED_TOKEN_RE)]
    .map((m) => ({ index: m.index!, token: m[0] }))
    .filter(
      ({ index, token }) =>
        KEYED_BEFORE.test(text.slice(Math.max(0, index - 24), index)) &&
        !inUrlOrName(index, token) &&
        isKeyedSecret(token),
    );
  const seen = new Set(unlabelled.map((c) => c.index));
  return [...unlabelled, ...keyed.filter((c) => !seen.has(c.index))].sort((a, b) => a.index - b.index);
}

/** Every secret span in `text` (merged, in order), found on the text with benign shapes blanked. */
function secretSpans(text: string): Array<[number, number]> {
  const masked = maskBenign(text);
  const spans: Array<[number, number]> = [];
  for (const re of COMPILED_GLOBAL) {
    re.lastIndex = 0;
    for (const m of masked.matchAll(re)) if (m[0].length > 0) spans.push([m.index!, m.index! + m[0].length]);
  }
  for (const { index, token } of entropyCandidates(masked)) spans.push([index, index + token.length]);
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

export function looksLikeSecretValue(text: string): boolean {
  return secretSpans(String(text ?? "")).length > 0;
}

export const REDACTED = "[REDACTED]";

/** Replace every secret value with [REDACTED], keeping the surrounding text. */
export function redactSecrets(text: string): string {
  let out = String(text ?? "");
  for (const [a, b] of secretSpans(out).reverse()) out = `${out.slice(0, a)}${REDACTED}${out.slice(b)}`;
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
