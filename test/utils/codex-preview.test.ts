/**
 * Regression test: configureCodex must honor info.preview (dry-run) and NOT
 * write ~/.codex/auth.json or config.toml. Previously it wrote unconditionally
 * (codex.ts:48,51), so a dry-run would clobber a real codex config.
 *
 * HOME/USERPROFILE are pointed at a temp dir so the test exercises the real
 * write path safely and can assert on the resulting files.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configureCodex } from "../../src/lib/client-configs/generators/codex";
import type { ProxyConnectionInfo } from "../../src/lib/client-configs/types";

let home = "";
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function makeInfo(preview: boolean): ProxyConnectionInfo {
  return {
    proxyOrigin: "http://localhost:1930",
    openaiBaseUrl: "http://localhost:1930/v1",
    apiKey: "test-pool-key",
    modelId: "gpt-5-codex",
    models: [],
    preview,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codex-preview-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("configureCodex preview guard", () => {
  test("preview=true writes neither auth.json nor config.toml", async () => {
    const res = await configureCodex(makeInfo(true));
    expect(res.success).toBe(true);
    expect(res.backupPaths).toEqual([]); // nothing written → no backups
    expect(res.preview?.toml).toContain("[model_providers.etteum]");
    expect(existsSync(join(home, ".codex", "auth.json"))).toBe(false);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
  });

  test("preview=true does not clobber an existing config.toml", async () => {
    const dir = join(home, ".codex");
    mkdirSync(dir, { recursive: true });
    const existing = 'model = "do-not-touch"\n';
    writeFileSync(join(dir, "config.toml"), existing);

    const res = await configureCodex(makeInfo(true));
    expect(res.success).toBe(true);
    expect(readFileSync(join(dir, "config.toml"), "utf-8")).toBe(existing);
  });

  test("preview=false still writes both files", async () => {
    const res = await configureCodex(makeInfo(false));
    expect(res.success).toBe(true);
    expect(existsSync(join(home, ".codex", "auth.json"))).toBe(true);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(true);
    const auth = JSON.parse(readFileSync(join(home, ".codex", "auth.json"), "utf-8"));
    expect(auth.OPENAI_API_KEY).toBe("test-pool-key");
  });
});
