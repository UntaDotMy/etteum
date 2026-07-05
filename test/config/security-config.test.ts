/**
 * Tests for security config validation (audit fix C2).
 */
import { describe, test, expect, afterEach, afterAll } from "bun:test";

describe("config security validation (C2)", () => {
  const origEnc = process.env.ENCRYPTION_KEY;
  const origApi = process.env.API_KEY;

  afterEach(() => {
    if (origEnc !== undefined) process.env.ENCRYPTION_KEY = origEnc;
    else delete process.env.ENCRYPTION_KEY;
    if (origApi !== undefined) process.env.API_KEY = origApi;
    else delete process.env.API_KEY;
  });

  async function importConfig() {
    const mod = await import(`../../src/config.ts?t=${Date.now()}-${Math.random()}`);
    return mod;
  }

  test("flags missing ENCRYPTION_KEY", async () => {
    delete process.env.ENCRYPTION_KEY;
    delete process.env.API_KEY;
    const { validateSecurityConfig } = await importConfig();
    const problems = validateSecurityConfig();
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p: string) => p.includes("ENCRYPTION_KEY"))).toBe(true);
  });

  test("flags short ENCRYPTION_KEY", async () => {
    process.env.ENCRYPTION_KEY = "short";
    process.env.API_KEY = "a-strong-api-key-12345";
    const { validateSecurityConfig } = await importConfig();
    const problems = validateSecurityConfig();
    expect(problems.some((p: string) => p.includes("ENCRYPTION_KEY"))).toBe(true);
  });

  test("flags default ENCRYPTION_KEY from .env.example", async () => {
    process.env.ENCRYPTION_KEY = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    process.env.API_KEY = "a-strong-api-key-12345";
    const { validateSecurityConfig } = await importConfig();
    const problems = validateSecurityConfig();
    expect(problems.some((p: string) => p.includes("publicly documented default"))).toBe(true);
  });

  test("flags default API_KEY", async () => {
    process.env.ENCRYPTION_KEY = "a-strong-encryption-key-value-1234567890";
    process.env.API_KEY = "pool-proxy-secret-key";
    const { validateSecurityConfig } = await importConfig();
    const problems = validateSecurityConfig();
    expect(problems.some((p: string) => p.includes("pool-proxy-secret-key"))).toBe(true);
  });

  test("passes with strong unique keys", async () => {
    process.env.ENCRYPTION_KEY = "a-strong-unique-encryption-key-value-1234567890";
    process.env.API_KEY = "a-strong-unique-api-key-value-1234567890";
    const { validateSecurityConfig } = await importConfig();
    const problems = validateSecurityConfig();
    expect(problems).toEqual([]);
  });
});