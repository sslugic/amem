import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { amemHome, dbPath } from "./paths.js";

const ENC_SUFFIX = ".enc";
const SALT_FILE = "crypto.salt";

export function encryptedDbPath(): string {
  return `${dbPath()}${ENC_SUFFIX}`;
}

export function saltPath(): string {
  return join(amemHome(), SALT_FILE);
}

export function isDbEncryptedAtRest(): boolean {
  return existsSync(encryptedDbPath()) && !existsSync(dbPath());
}

export function encryptionConfigured(): boolean {
  return existsSync(encryptedDbPath()) || existsSync(saltPath());
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}

function loadOrCreateSalt(): Buffer {
  const path = saltPath();
  if (existsSync(path)) return readFileSync(path);
  mkdirSync(amemHome(), { recursive: true, mode: 0o700 });
  const salt = randomBytes(16);
  writeFileSync(path, salt, { mode: 0o600 });
  return salt;
}

/** AES-256-GCM encrypt bytes → salt||iv||tag||ciphertext layout for files. */
export function encryptBytes(plain: Buffer, passphrase: string, salt?: Buffer): Buffer {
  const useSalt = salt ?? loadOrCreateSalt();
  const key = deriveKey(passphrase, useSalt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from("AMEM1"), useSalt, iv, tag, ciphertext]);
}

export function decryptBytes(blob: Buffer, passphrase: string): Buffer {
  if (blob.length < 5 + 16 + 12 + 16 || blob.subarray(0, 5).toString() !== "AMEM1") {
    throw new Error("Not an amem encrypted blob");
  }
  const salt = blob.subarray(5, 21);
  const iv = blob.subarray(21, 33);
  const tag = blob.subarray(33, 49);
  const ciphertext = blob.subarray(49);
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function resolvePassphrase(explicit?: string): string {
  const p = explicit || process.env.AMEM_PASSPHRASE || "";
  if (!p.trim()) {
    throw new Error(
      "Passphrase required. Pass --passphrase or set AMEM_PASSPHRASE (never commit it).",
    );
  }
  return p;
}

/** Encrypt plaintext DB to graph.db.enc and remove plaintext. */
export function lockDatabase(passphrase: string): { encPath: string } {
  const plain = dbPath();
  if (!existsSync(plain)) throw new Error(`No database at ${plain}`);
  const enc = encryptedDbPath();
  const blob = encryptBytes(readFileSync(plain), passphrase);
  writeFileSync(enc, blob, { mode: 0o600 });
  unlinkSync(plain);
  // also clear WAL/SHM if present
  for (const side of [`${plain}-wal`, `${plain}-shm`]) {
    if (existsSync(side)) unlinkSync(side);
  }
  return { encPath: enc };
}

/** Decrypt graph.db.enc to plaintext graph.db for this machine session. */
export function unlockDatabase(passphrase: string): { dbPath: string } {
  const enc = encryptedDbPath();
  if (!existsSync(enc)) throw new Error(`No encrypted database at ${enc}`);
  const plain = dbPath();
  const data = decryptBytes(readFileSync(enc), passphrase);
  writeFileSync(plain, data, { mode: 0o600 });
  return { dbPath: plain };
}

/** Re-encrypt after unlock (keeps enc in sync) without deleting plaintext — for backups. */
export function encryptFileTo(path: string, outPath: string, passphrase: string): void {
  const blob = encryptBytes(readFileSync(path), passphrase);
  mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
  writeFileSync(outPath, blob, { mode: 0o600 });
}

export function decryptFileTo(path: string, outPath: string, passphrase: string): void {
  const data = decryptBytes(readFileSync(path), passphrase);
  mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
  writeFileSync(outPath, data, { mode: 0o600 });
}

export function fingerprintPassphrase(passphrase: string): string {
  return createHash("sha256").update(passphrase).digest("hex").slice(0, 12);
}

export function defaultBackupDir(): string {
  return join(amemHome(), "backups");
}

export function createBackup(opts: {
  outDir?: string;
  passphrase?: string;
  label?: string;
}): { path: string; encrypted: boolean } {
  const plain = dbPath();
  const enc = encryptedDbPath();
  const source = existsSync(plain) ? plain : existsSync(enc) ? enc : null;
  if (!source) throw new Error("Nothing to back up — no local amem database found");

  const dir = opts.outDir || defaultBackupDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const label = (opts.label || "amem").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40);
  const encrypted = Boolean(opts.passphrase) || source.endsWith(ENC_SUFFIX);

  if (opts.passphrase) {
    const out = join(dir, `${label}-${stamp}.db.enc`);
    if (source.endsWith(ENC_SUFFIX)) {
      // already encrypted — copy as-is (cannot re-wrap without unlock)
      copyFileSync(source, out);
    } else {
      encryptFileTo(source, out, opts.passphrase);
    }
    return { path: out, encrypted: true };
  }

  if (source.endsWith(ENC_SUFFIX)) {
    const out = join(dir, `${label}-${stamp}.db.enc`);
    copyFileSync(source, out);
    return { path: out, encrypted: true };
  }
  const out = join(dir, `${label}-${stamp}.db`);
  copyFileSync(source, out);
  return { path: out, encrypted: false };
}

/** Replace graph.db from a local backup (plaintext .db or AMEM1 .enc). Caller must closeDb(). */
export function restoreBackup(opts: {
  file: string;
  passphrase?: string;
}): { dbPath: string; from: string; safetyCopy: string | null; encrypted: boolean } {
  const from = opts.file;
  if (!existsSync(from)) throw new Error(`Backup not found: ${from}`);
  const blob = readFileSync(from);
  const looksEnc = blob.subarray(0, 5).toString() === "AMEM1" || from.endsWith(ENC_SUFFIX);
  let plain: Buffer;
  if (looksEnc) {
    const passphrase = opts.passphrase || process.env.AMEM_PASSPHRASE || "";
    if (!passphrase.trim()) {
      throw new Error("Encrypted backup — pass --passphrase or set AMEM_PASSPHRASE");
    }
    plain = decryptBytes(blob, passphrase);
  } else {
    plain = blob;
  }
  if (plain.length < 16) throw new Error("Backup file is empty or not a database");

  const target = dbPath();
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  let safetyCopy: string | null = null;
  if (existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    safetyCopy = join(defaultBackupDir(), `pre-restore-${stamp}.db`);
    mkdirSync(defaultBackupDir(), { recursive: true, mode: 0o700 });
    copyFileSync(target, safetyCopy);
  }
  writeFileSync(target, plain, { mode: 0o600 });
  return { dbPath: target, from, safetyCopy, encrypted: looksEnc };
}
