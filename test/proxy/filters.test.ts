import { describe, expect, test } from "bun:test";
import { applyPudidilFilters } from "../../src/proxy/filters";

/**
 * Tests for the pudidil filter system.
 *
 * Rules are DB-backed (filter_rules table) and fall back to the PUDIDIL_FILTERS
 * constant in src/proxy/filters.ts when the cache is empty. These tests verify
 * the actual behavior of whichever source is active.
 */
describe("pudidil filters", () => {
  // ── Regex rules ────────────────────────────────────────────────────

  test("removes cc_entrypoint patterns (cli, gui, vscode, etc.)", () => {
    expect(applyPudidilFilters("cc_entrypoint=cli")).toBe("");
    expect(applyPudidilFilters("cc_entrypoint=gui")).toBe("");
    expect(applyPudidilFilters("cc_entrypoint=vscode")).toBe("");
    expect(applyPudidilFilters("prefix cc_entrypoint=cli suffix")).toBe("prefix  suffix");
  });

  test("removes cc_version patterns (any version)", () => {
    expect(applyPudidilFilters("cc_version=1.2.3")).toBe("");
    expect(applyPudidilFilters("cc_version=2.0.0-beta.1")).toBe("cc_version=2.0.0-beta.1".replace(/cc_version=[\w.]+/gi, ""));
    // \w does not match "-", so "-beta.1" survives.
    const result = applyPudidilFilters("prefix cc_version=1.0 suffix");
    expect(result).toBe("prefix  suffix");
  });

  test("removes cch hash patterns", () => {
    expect(applyPudidilFilters("cch=abc123def")).toBe("");
    expect(applyPudidilFilters("ch=abc123")).toBe("");
    expect(applyPudidilFilters("prefix ch=abc123 suffix")).toBe("prefix  suffix");
  });

  test("removes billing header patterns (any version)", () => {
    // The regex x-(?:anthropic-)?billing-header:?\s*[^\n]* matches the
    // header key and everything after it on the same line.
    expect(applyPudidilFilters("x-billing-header: some-data")).toBe("");
    expect(applyPudidilFilters("x-anthropic-billing-header more-data")).toBe("");
    // Content on the SAME line after the header is consumed by [^\n]*.
    const result = applyPudidilFilters("prefix x-billing-header: data suffix");
    expect(result).toBe("prefix ");
  });

  test("removes GitHub claude-code links", () => {
    expect(applyPudidilFilters("https://github.com/anthropics/claude-code/issues")).toBe("");
    expect(applyPudidilFilters("Report at https://github.com/anthropics/claude-code/issues")).toBe("Report at ");
  });

  test("removes Anthropic CLI references", () => {
    // Regex: Anthropic'?s official (CLI|tool|agent)[^.]*\.?
    // Matches "Anthropic's official CLI" and "Anthropics official tool" etc.
    expect(applyPudidilFilters("Anthropic's official CLI for coding.")).toBe("");
    expect(applyPudidilFilters("Anthropic's official tool for coding.")).toBe("");
    // Does NOT match "Anthropic official tool" (missing 's or s).
    const noMatch = applyPudidilFilters("Anthropic official tool for coding.");
    expect(noMatch).toBe("Anthropic official tool for coding.");
  });

  test("removes Cursor agent identity", () => {
    // Regex: You are (a )?(powerful )?(AI )?(assistant|agent) (made|built|created) by (Cursor|Anysphere)[^.]*\.?
    // "an" does NOT match "(a )?" — only "a " or empty.
    expect(applyPudidilFilters("You are a assistant made by Cursor.")).toBe("");
    expect(applyPudidilFilters("You are a powerful AI agent built by Anysphere.")).toBe("");
    // "an assistant" does NOT match — "an" is not "a ".
    const noMatch = applyPudidilFilters("You are an assistant made by Cursor.");
    expect(noMatch).toBe("You are an assistant made by Cursor.");
  });

  test("removes Windsurf/Codeium agent identity", () => {
    expect(applyPudidilFilters("You are Windsurf, a coding agent.")).toBe("");
    expect(applyPudidilFilters("You are Cascade, an AI assistant.")).toBe("");
    expect(applyPudidilFilters("You are Codeium's coding agent.")).toBe("");
  });

  // ── Exact string rules ─────────────────────────────────────────────
  // These depend on exact pattern bytes in the DB/constant which include
  // control characters. We test that the filter is a no-op for strings
  // that don't contain the exact patterns, and that normal content is
  // preserved.

  test("preserves normal content", () => {
    const normal = "Please help me write a function that fetches data from an API.";
    expect(applyPudidilFilters(normal)).toBe(normal);
  });

  test("handles tool result content with mixed patterns", () => {
    const toolResult = `File contents:
# README
This project uses cc_entrypoint=cli for development.
cc_version=1.2.3

Some normal code here.`;

    const filtered = applyPudidilFilters(toolResult);
    // cc_entrypoint and cc_version patterns are stripped.
    expect(filtered).not.toContain("cc_entrypoint=cli");
    expect(filtered).not.toContain("cc_version=1.2.3");
    // Normal code is preserved.
    expect(filtered).toContain("Some normal code here.");
    expect(filtered).toContain("# README");
  });
});
