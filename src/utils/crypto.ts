import { config } from "../config";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

/**
 * Secret-at-rest encryption/decryption.
 *
 * Historically this used a reversible XOR cipher (no integrity, trivially
 * reversible by anyone with the key — which was itself defaulted to a public
 * constant). It now uses **AES-256-GCM** (authenticated encryption).
 *
 * Backward compatibility: legacy XOR/base64 ciphertext (no `g1:` prefix) is
 * still readable via {@link decrypt}, so existing rows in the database decode
 * transparently without a migration script. New writes always use AES-256-GCM.
 */

const GCM_ALGO = "aes-256-gcm";
const VERSION_PREFIX = "g1:";
const IV_LEN = 12; // 96-bit IV (GCM standard)
const TAG_LEN = 16;
const MIN_PASSPHRASE_LEN = 16;

function requirePassphrase(passphrase: string | undefined, label = "ENCRYPTION_KEY"): string {
  if (!passphrase || passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new Error(
      `${label} must be set to a sufficiently long passphrase (>= 16 chars). ` +
        "Refusing to operate with a weak/missing encryption key.",
    );
  }
  return passphrase;
}

/** Derive a 32-byte AES-256 key from a passphrase via SHA-256. */
function keyFromPassphrase(passphrase: string): Buffer {
  return createHash("sha256").update(passphrase, "utf8").digest();
}

/** Derive a 32-byte AES-256 key from the configured passphrase via SHA-256. */
function getKey(): Buffer {
  // Read live from process.env first (test-resilient + supports key rotation
  // without restart), then fall back to the config-captured value.
  return keyFromPassphrase(
    requirePassphrase(process.env.ENCRYPTION_KEY || config.encryptionKey),
  );
}

/**
 * Encrypt a string using AES-256-GCM + base64 encoding.
 * Output format: `g1:<base64(iv || tag || ciphertext)>`
 */
export function encrypt(plaintext: string): string {
  return encryptWithPassphrase(
    plaintext,
    requirePassphrase(process.env.ENCRYPTION_KEY || config.encryptionKey),
  );
}

/**
 * Encrypt with an explicit passphrase (e.g. re-key during backup merge import).
 */
export function encryptWithPassphrase(plaintext: string, passphrase: string): string {
  const key = keyFromPassphrase(requirePassphrase(passphrase, "passphrase"));
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(GCM_ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, tag, encrypted]);
  return VERSION_PREFIX + packed.toString("base64");
}

/**
 * Decrypt a stored secret.
 *
 * Accepts both the current `g1:` AES-256-GCM format and the legacy plain
 * XOR/base64 format (no prefix) for transparent backward compatibility.
 */
export function decrypt(ciphertext: string): string {
  return decryptWithPassphrase(
    ciphertext,
    requirePassphrase(process.env.ENCRYPTION_KEY || config.encryptionKey),
  );
}

/**
 * Decrypt with an explicit passphrase (e.g. pack ENCRYPTION_KEY during merge).
 */
export function decryptWithPassphrase(ciphertext: string, passphrase: string): string {
  const p = requirePassphrase(passphrase, "passphrase");
  if (ciphertext.startsWith(VERSION_PREFIX)) {
    return decryptGcmWithKey(ciphertext.slice(VERSION_PREFIX.length), keyFromPassphrase(p));
  }
  return decryptLegacyXorWithPassphrase(ciphertext, p);
}

/**
 * Re-encrypt a stored password when moving rows between installs that may use
 * different ENCRYPTION_KEYs. If keys match, returns ciphertext unchanged.
 * On decrypt failure (corrupt/unknown format), returns the original ciphertext.
 */
export function reencryptSecret(
  ciphertext: string,
  sourcePassphrase: string,
  targetPassphrase: string,
): string {
  if (!ciphertext) return ciphertext;
  if (sourcePassphrase === targetPassphrase) return ciphertext;
  try {
    const plain = decryptWithPassphrase(ciphertext, sourcePassphrase);
    return encryptWithPassphrase(plain, targetPassphrase);
  } catch {
    return ciphertext;
  }
}

function decryptGcmWithKey(b64: string, key: Buffer): string {
  const packed = Buffer.from(b64, "base64");
  if (packed.length < IV_LEN + TAG_LEN) {
    throw new Error("decrypt: truncated AES-256-GCM payload");
  }
  const iv = packed.subarray(0, IV_LEN);
  const tag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = packed.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(GCM_ALGO, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Legacy XOR/base64 decoder — kept ONLY to read rows written by older builds.
 * New writes always go through {@link encrypt} (AES-256-GCM).
 */
function decryptLegacyXorWithPassphrase(ciphertext: string, passphrase: string): string {
  // Guard: a missing/empty passphrase would make `key[i % 0]` a NaN index and
  // produce garbage rather than throwing. Refuse instead of returning noise.
  if (!passphrase) {
    throw new Error("decrypt: legacy ciphertext encountered but ENCRYPTION_KEY is missing.");
  }
  const key = new TextEncoder().encode(passphrase);
  const data = new Uint8Array(Buffer.from(ciphertext, "base64"));
  const decrypted = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    decrypted[i] = data[i]! ^ key[i % key.length]!;
  }
  return new TextDecoder().decode(decrypted);
}

/** Is this ciphertext already in the new AES-256-GCM format? */
export function isGcm(ciphertext: string): boolean {
  return ciphertext.startsWith(VERSION_PREFIX);
}