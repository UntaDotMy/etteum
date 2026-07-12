import { describe, expect, test } from "bun:test";
import { validateFilterRule } from "./filter-safety";

describe("validateFilterRule", () => {
  test("allows strip-only telemetry / identity patterns", () => {
    expect(validateFilterRule({ pattern: "cc_entrypoint=\\w+", replacement: "", isRegex: true }).ok).toBe(true);
    expect(
      validateFilterRule({
        pattern: "You are Claude Code, Anxthxropic's official CLI for Claude.",
        replacement: "",
        isRegex: false,
      }).ok,
    ).toBe(true);
    expect(
      validateFilterRule({
        pattern: "https?://github\\.com/anthropics/claude-code[^\\s]*",
        replacement: "",
        isRegex: true,
      }).ok,
    ).toBe(true);
  });

  test("rejects non-empty replacement (word / brand rewrite)", () => {
    const r = validateFilterRule({
      pattern: "Claude Code",
      replacement: "[AI-ASSISTANT]",
      isRegex: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/strip-only|empty/i);
  });

  test("rejects bare short tokens that would mangle tool args", () => {
    const r = validateFilterRule({ pattern: "kill", replacement: "", isRegex: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too broad|bare/i);
  });

  test("rejects invalid regex", () => {
    const r = validateFilterRule({ pattern: "(unclosed", replacement: "", isRegex: true });
    expect(r.ok).toBe(false);
  });

  test("requires pattern", () => {
    expect(validateFilterRule({ pattern: "  ", replacement: "" }).ok).toBe(false);
  });
});
