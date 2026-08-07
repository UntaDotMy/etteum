/**
 * Unit tests for src/lib/client-configs/paths.ts:
 *   - resolveExistingPath
 *   - detectInstalledClients
 *   - getAllConfigPaths
 *
 * paths.ts caches the home dir at module-import time and every public
 * function derives paths from it. The suite points ETTEUM_HOME (a seam in
 * paths.ts — os.homedir() ignores $HOME on Linux, so env redirection alone
 * is not portable) at a per-test mkdtemp dir and re-imports the module
 * (with a cache-busting query) per test. That keeps the real home directory
 * untouched on both the Windows dev box and Linux CI.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLIENT_META, type ClientTarget } from "../../src/lib/client-configs/types";

type PathsModule = typeof import("../../src/lib/client-configs/paths");

let home = "";
let prevEtteumHome: string | undefined;
let importCounter = 0;

async function importPaths(): Promise<PathsModule> {
  // Query suffix defeats the ESM module cache so `homeDir` is re-captured
  // from the redirected ETTEUM_HOME for each test.
  return import(`../../src/lib/client-configs/paths.ts?case=${importCounter++}`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "client-config-paths-"));
  prevEtteumHome = process.env.ETTEUM_HOME;
  process.env.ETTEUM_HOME = home;
});

afterEach(() => {
  if (prevEtteumHome === undefined) delete process.env.ETTEUM_HOME;
  else process.env.ETTEUM_HOME = prevEtteumHome;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const ALL_CLIENTS = Object.keys(CLIENT_META) as ClientTarget[];

describe("resolveExistingPath", () => {
  test("opencode defaults to opencode.json when no config file exists", async () => {
    const paths = await importPaths();
    const resolved = paths.resolveExistingPath("opencode", "linux");
    expect(resolved).toBe(join(home, ".config", "opencode", "opencode.json"));
  });

  test("opencode prefers config.json when only config.json exists", async () => {
    const dir = join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{}");
    const paths = await importPaths();
    expect(paths.resolveExistingPath("opencode", "linux")).toBe(join(dir, "config.json"));
  });

  test("opencode prefers opencode.json when both candidates exist", async () => {
    const dir = join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencode.json"), "{}");
    writeFileSync(join(dir, "config.json"), "{}");
    const paths = await importPaths();
    expect(paths.resolveExistingPath("opencode", "linux")).toBe(join(dir, "opencode.json"));
  });

  test("kilo defaults to kilo.json (second candidate) when nothing exists", async () => {
    const paths = await importPaths();
    // Characterization: the source falls back to candidates[1] (kilo.json),
    // not candidates[0] (kilo.jsonc), when no candidate exists on disk.
    expect(paths.resolveExistingPath("kilo", "linux")).toBe(
      join(home, ".config", "kilo", "kilo.json")
    );
  });

  test("kilo prefers kilo.jsonc when it exists", async () => {
    const dir = join(home, ".config", "kilo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kilo.jsonc"), "{}");
    const paths = await importPaths();
    expect(paths.resolveExistingPath("kilo", "linux")).toBe(join(dir, "kilo.jsonc"));
  });

  test("kilo picks config.json when it is the only candidate on disk", async () => {
    const dir = join(home, ".config", "kilo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{}");
    const paths = await importPaths();
    expect(paths.resolveExistingPath("kilo", "linux")).toBe(join(dir, "config.json"));
  });

  test("clients without candidates resolve to their primary path", async () => {
    const paths = await importPaths();
    expect(paths.resolveExistingPath("codex", "linux")).toBe(
      join(home, ".codex", "config.toml")
    );
    expect(paths.resolveExistingPath("claude", "win32")).toBe(
      join(home, ".claude", "settings.json")
    );
  });

  test("explicit platform argument selects that platform's primary path", async () => {
    const paths = await importPaths();
    expect(paths.resolveExistingPath("copilot", "win32")).toBe(
      join(home, "AppData", "Roaming", "Code", "User", "chatLanguageModels.json")
    );
    expect(paths.resolveExistingPath("copilot", "darwin")).toBe(
      join(home, "Library", "Application Support", "Code", "User", "chatLanguageModels.json")
    );
    expect(paths.resolveExistingPath("copilot", "linux")).toBe(
      join(home, ".config", "Code", "User", "chatLanguageModels.json")
    );
  });
});

describe("detectInstalledClients", () => {
  test("returns a boolean for every ClientTarget in an empty home", async () => {
    const paths = await importPaths();
    const detected = paths.detectInstalledClients("linux");
    for (const client of ALL_CLIENTS) {
      expect(typeof detected[client]).toBe("boolean");
    }
  });

  test("detects a client only when its platform-specific marker exists", async () => {
    // codex marker: ~/.codex directory (exists on every platform branch).
    mkdirSync(join(home, ".codex"), { recursive: true });
    const paths = await importPaths();
    const detected = paths.detectInstalledClients("linux");
    expect(detected.codex).toBe(true);
    expect(detected.opencode).toBe(false);
    expect(detected.kilo).toBe(false);
  });

  test("detects copilot via the platform-correct config dir", async () => {
    // Linux marker: ~/.config/Code/User
    mkdirSync(join(home, ".config", "Code", "User"), { recursive: true });
    const paths = await importPaths();
    expect(paths.detectInstalledClients("linux").copilot).toBe(true);

    // The win32 marker path (~/AppData/Roaming/Code/User) must NOT count on linux.
    const paths2 = await importPaths();
    expect(paths2.detectInstalledClients("linux").copilot).toBe(true); // still via linux marker
    // And on win32 it should also be true only if the win32 dir exists; here it doesn't.
    expect(paths2.detectInstalledClients("win32").copilot).toBe(false);
  });

  test("detects claude via its config dir on a fresh import", async () => {
    const paths = await importPaths();
    expect(paths.detectInstalledClients("win32").claude).toBe(false);
    mkdirSync(join(home, ".claude"), { recursive: true });
    // Detection is a live existsSync check, so no re-import is needed after
    // creating the marker directory.
    expect(paths.detectInstalledClients("win32").claude).toBe(true);
  });
});

describe("getAllConfigPaths", () => {
  test("returns non-empty absolute paths under home for every client", async () => {
    const paths = await importPaths();
    for (const client of ALL_CLIENTS) {
      const all = paths.getAllConfigPaths(client, "linux");
      expect(all.length).toBeGreaterThan(0);
      for (const p of all) {
        expect(typeof p).toBe("string");
        expect(p.startsWith(home)).toBe(true);
      }
    }
  });

  test("codex includes its secondary auth.json path", async () => {
    const paths = await importPaths();
    const all = paths.getAllConfigPaths("codex", "linux");
    expect(all).toEqual([
      join(home, ".codex", "config.toml"),
      join(home, ".codex", "auth.json"),
    ]);
  });

  test("platform argument changes platform-specific paths", async () => {
    const paths = await importPaths();
    const win = paths.getAllConfigPaths("copilot", "win32");
    const dar = paths.getAllConfigPaths("copilot", "darwin");
    const lin = paths.getAllConfigPaths("copilot", "linux");
    expect(win[0]).toBe(
      join(home, "AppData", "Roaming", "Code", "User", "chatLanguageModels.json")
    );
    expect(dar[0]).toBe(
      join(home, "Library", "Application Support", "Code", "User", "chatLanguageModels.json")
    );
    expect(lin[0]).toBe(
      join(home, ".config", "Code", "User", "chatLanguageModels.json")
    );
    expect(win[0]).not.toBe(lin[0]);
  });

  test("default platform (no arg) returns paths without throwing", async () => {
    const paths = await importPaths();
    for (const client of ALL_CLIENTS) {
      const all = paths.getAllConfigPaths(client);
      expect(all.length).toBeGreaterThan(0);
    }
  });
});
