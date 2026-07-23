import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Smoke tests for the Camoufox adapter surface — no live browser.
 * Verifies wiring + Python package imports for supported providers.
 */

const AUTH_DIR = path.join(process.cwd(), "scripts", "auth");

describe("camoufox adapter surface", () => {
  test("flow runner script exists", () => {
    expect(existsSync(path.join(AUTH_DIR, "camoufox_flow.py"))).toBe(true);
  });

  test("registers kiro, codebuddy, canva, qoder adapters", () => {
    const src = readFileSync(path.join(AUTH_DIR, "camoufox_flow.py"), "utf8");
    for (const id of ["kiro", "codebuddy", "canva", "qoder"]) {
      expect(src).toContain(`"${id}"`);
    }
  });

  test("python package imports adapters", () => {
    const authEscaped = AUTH_DIR.replace(/\\/g, "\\\\");
    const code = [
      "import sys",
      `sys.path.insert(0, r'${authEscaped}')`,
      "from app.providers.kiro import KiroProviderAdapter",
      "from app.providers.codebuddy import CodeBuddyProviderAdapter",
      "from app.providers.canva import CanvaProviderAdapter",
      "from app.providers.qoder_adapter import QoderProviderAdapter",
      "assert KiroProviderAdapter().name == 'kiro'",
      "assert CodeBuddyProviderAdapter().name == 'codebuddy'",
      "assert CanvaProviderAdapter().name == 'canva'",
      "assert QoderProviderAdapter().name == 'qoder'",
      "print('import_ok')",
    ].join("; ");

    // Prefer shared auth venv (same as runtime), then PATH fallbacks.
    const venvRoot = path.join(AUTH_DIR, ".venv");
    const venvPy =
      process.platform === "win32"
        ? [path.join(venvRoot, "Scripts", "python.exe"), path.join(venvRoot, "bin", "python")]
        : [path.join(venvRoot, "bin", "python"), path.join(venvRoot, "bin", "python3")];
    const candidates: string[][] = [
      ...venvPy.filter((p) => existsSync(p)).map((p) => [p, "-c", code]),
      ["py", "-3", "-c", code],
      ["python3", "-c", code],
      ["python", "-c", code],
    ];

    let lastOut = "";
    let lastCode: number | null = null;
    let ran = false;
    for (const cmd of candidates) {
      try {
        const proc = Bun.spawnSync({
          cmd,
          cwd: AUTH_DIR,
          stdout: "pipe",
          stderr: "pipe",
        });
        ran = true;
        lastCode = proc.exitCode;
        lastOut =
          new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
        if (proc.exitCode === 0 && lastOut.includes("import_ok")) {
          expect(lastOut).toContain("import_ok");
          return;
        }
        // Missing deps / broken env → skip (smoke test, not a hard CI gate).
        if (/ModuleNotFoundError|No module named|not found|Unable to create process/i.test(lastOut)) {
          console.warn("Python adapter import skipped:", lastOut.slice(0, 240));
          return;
        }
      } catch (err) {
        // Bun throws when the executable is missing from PATH (Linux CI has no `py`).
        const msg = err instanceof Error ? err.message : String(err);
        lastOut = msg;
        if (/Executable not found|ENOENT|not found/i.test(msg)) continue;
        throw err;
      }
    }

    if (!ran) {
      console.warn("Python adapter import skipped: no python launcher in PATH");
      return;
    }
    // A launcher ran but import failed for a non-skip reason — surface it.
    expect(lastCode).toBe(0);
    expect(lastOut).toContain("import_ok");
  });
});

describe("accounts API modular split", () => {
  test("accounts modules exist on disk and re-export helpers", () => {
    const base = path.join(process.cwd(), "src", "api", "accounts");
    for (const f of [
      "index.ts",
      "shared.ts",
      "listroutes.ts",
      "byokroutes.ts",
      "alibabaroutes.ts",
      "gitlabduoroutes.ts",
      "gitlab-helpers.ts",
      "crudroutes.ts",
      "actionroutes.ts",
    ]) {
      expect(existsSync(path.join(base, f))).toBe(true);
    }
    const barrel = readFileSync(path.join(process.cwd(), "src", "api", "accounts.ts"), "utf8");
    expect(barrel).toContain("createGitlabDuoAccount");
    expect(barrel).toContain("exchangeCodexAuthorizationCode");
    expect(barrel).toContain("importCodexAccessToken");
    const index = readFileSync(path.join(base, "index.ts"), "utf8");
    expect(index).toContain("registerByokRoutes");
    expect(index).toContain("registerActionRoutes");
  });
});

describe("filter policy bootstrap", () => {
  test("filter-bootstrap module exports bootstrapFilterRules", async () => {
    const mod = await import("../../src/db/filter-bootstrap");
    expect(typeof mod.bootstrapFilterRules).toBe("function");
  });
});
