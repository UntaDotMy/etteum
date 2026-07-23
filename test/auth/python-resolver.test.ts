import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  authVenvPythonCandidates,
  findAuthVenvPython,
  resolveAuthPython,
} from "../../src/utils/python";

const ROOT = process.cwd();

describe("shared auth Python resolver", () => {
  test("prefers scripts/auth/.venv over PATH when venv exists", () => {
    const venv = findAuthVenvPython(ROOT);
    if (!venv) {
      console.warn("no auth venv on this machine — skip prefer-venv assertion");
      return;
    }
    const resolved = resolveAuthPython(ROOT, {
      ...process.env,
      ETTEUM_PYTHON: "",
      BATCHER_PYTHON: "",
      PYTHON_PATH: "",
    });
    expect(resolved).toBe(venv);
  });

  test("ETTEUM_PYTHON override wins when path exists", () => {
    const venv = findAuthVenvPython(ROOT);
    if (!venv) return;
    // Point override at the venv itself — must still resolve to that path.
    const resolved = resolveAuthPython(ROOT, {
      ...process.env,
      ETTEUM_PYTHON: venv,
      BATCHER_PYTHON: "",
      PYTHON_PATH: "",
    });
    expect(resolved).toBe(venv);
  });

  test("authVenvPythonCandidates are platform-shaped absolute paths", () => {
    const c = authVenvPythonCandidates(ROOT);
    expect(c.length).toBeGreaterThan(0);
    for (const p of c) {
      expect(path.isAbsolute(p)).toBe(true);
      expect(p.includes(`${path.sep}scripts${path.sep}auth${path.sep}.venv`)).toBe(true);
    }
  });

  test("candidates include a path that exists when venv is present", () => {
    const venv = findAuthVenvPython(ROOT);
    if (!venv) return;
    expect(existsSync(venv)).toBe(true);
    expect(authVenvPythonCandidates(ROOT).some((p) => p === venv)).toBe(true);
  });
});
