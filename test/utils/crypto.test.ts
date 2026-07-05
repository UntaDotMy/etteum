/**
 * Tests for the AES-256-GCM crypto migration (audit fix C1).
 *
 * The config module reads ENCRYPTION_KEY at import time, so we set a strong
 * key before any import of config/crypto. These env vars are set at the top
 * of the module so they apply before the static imports below are resolved.
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
// Allow insecure config path (DB may point nowhere) for unit tests.
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { encrypt, decrypt, isGcm } from "../../src/utils/crypto";
import { config } from "../../src/config";

// Ensure a valid key is in effect for every test. The config module reads
// ENCRYPTION_KEY at import time; if another test file mutated process.env
// before this file's imports resolved, config.encryptionKey may be empty.
// We restore a strong key here (runs before test bodies, after imports).
const STRONG_KEY =
  process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length >= 16
    ? process.env.ENCRYPTION_KEY
    : "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = STRONG_KEY;
});

// beforeEach ensures env is correct even if another test file mutated it.
beforeEach(() => {
  process.env.ENCRYPTION_KEY = STRONG_KEY;
});

const ACTIVE_KEY = STRONG_KEY;

describe("crypto: AES-256-GCM (C1)", () => {
  test("encrypt produces a g1:-prefixed token", () => {
    const ct = encrypt("hello world");
    expect(ct.startsWith("g1:")).toBe(true);
    expect(ct.length).toBeGreaterThan(20);
  });

  test("decrypt round-trips: decrypt(encrypt(pt)) === pt", () => {
    const cases = ["", "a", "hello world", "🔐 unicode test", "a".repeat(10_000)];
    for (const pt of cases) {
      expect(decrypt(encrypt(pt))).toBe(pt);
    }
  });

  test("encrypt is non-deterministic (random IV): same plaintext → different ciphertext", () => {
    const a = encrypt("secret");
    const b = encrypt("secret");
    expect(a).not.toBe(b);
  });

  test("decrypt detects tampering (GCM auth tag): modified ciphertext throws", () => {
    const ct = encrypt("secret");
    const b64 = ct.slice(3);
    const buf = Buffer.from(b64, "base64");
    buf[buf.length - 1]! ^= 0x01;
    const tampered = "g1:" + buf.toString("base64");
    expect(() => decrypt(tampered)).toThrow();
  });

  test("isGcm identifies the new format", () => {
    expect(isGcm(encrypt("x"))).toBe(true);
    expect(isGcm("notgcm")).toBe(false);
    expect(isGcm("")).toBe(false);
  });

  test("decrypt reads legacy XOR/base64 ciphertext (backward compat)", () => {
    // Set a known key via env; getKey() reads process.env.ENCRYPTION_KEY live.
    const KNOWN_KEY = "known-test-key-0123456789abcdef";
    process.env.ENCRYPTION_KEY = KNOWN_KEY;
    // Manually produce a legacy XOR/base64 ciphertext with the SAME key.
    const key = new TextEncoder().encode(KNOWN_KEY);
    const plaintext = "legacy-secret-token";
    const data = new TextEncoder().encode(plaintext);
    const xored = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      xored[i] = data[i]! ^ key[i % key.length]!;
    }
    const legacy = Buffer.from(xored).toString("base64");
    // Verify decrypt() — which calls getKey() reading the same env var — matches.
    // We read the key the exact same way getKey() does to be 100% certain.
    const keyUsedByDecrypt = process.env.ENCRYPTION_KEY || config.encryptionKey;
    expect(keyUsedByDecrypt).toBe(KNOWN_KEY);
    expect(decrypt(legacy)).toBe(plaintext);
  });

  test("decrypt rejects truncated GCM payload", () => {
    expect(() => decrypt("g1:" + Buffer.from("short").toString("base64"))).toThrow();
  });
});