import { describe, expect, test } from "bun:test";
import { applyPudidilFilters } from "../../src/proxy/filters";

/**
 * Tests for the pudidil filter system.
 *
 * Rules are DB-backed (filter_rules table) and fall back to the PUDIDIL_FILTERS
 * constant in src/proxy/filters.ts when the cache is empty.
 *
 * Scope contract (2026-07): sanitize ONLY vendor telemetry + identity boilerplate.
 * remove_cch_hash was DELETED — it stripped legitimate tool-call arguments and
 * tool_result content (any `ch=<hex>` token: Grep/Glob patterns, git hashes),
 * silently corrupting tool calls. These tests pin the new behavior:
 *   - vendor telemetry is still stripped
 *   - hex-suffixed tokens and tool-call JSON are preserved verbatim
 */
describe("pudidil filters", () => {
  // ── Telemetry stripping (kept) ────────────────────────────────────────

  test("removes cc_entrypoint telemetry", () => {
    expect(applyPudidilFilters("cc_entrypoint=cli")).toBe("");
    expect(applyPudidilFilters("prefix cc_entrypoint=vscode suffix")).toBe("prefix  suffix");
  });

  test("removes cc_version telemetry", () => {
    expect(applyPudidilFilters("cc_version=1.2.3")).toBe("");
    expect(applyPudidilFilters("prefix cc_version=2.0.0-beta.1 suffix")).toBe("prefix -beta.1 suffix");
  });

  test("removes billing header line", () => {
    expect(applyPudidilFilters("x-billing-header: abc123")).toBe("");
    expect(applyPudidilFilters("x-anthropic-billing-header: abc123")).toBe("");
  });

  test("removes GitHub claude-code links", () => {
    expect(applyPudidilFilters("see https://github.com/anthropics/claude-code/issues")).toBe("see ");
  });

  // ── Tool-call / hex preservation (the fix) ────────────────────────────

  test("PRESERVES ch=<hex> tokens in tool-call arguments (remove_cch_hash deleted)", () => {
    // This was the corruption: a Grep/Glob pattern or git hash containing
    // ch=<hex> was being stripped, making the model act on a broken argument.
    const grepArg = '{"pattern":"ch=abc123","path":"src"}';
    expect(applyPudidilFilters(grepArg)).toBe(grepArg);

    const gitHash = "commit ch=deadbeef1234 on main";
    expect(applyPudidilFilters(gitHash)).toBe(gitHash);

    const batch = "run batch=deadbeef now";
    expect(applyPudidilFilters(batch)).toBe(batch);
  });

  test("PRESERVES ordinary hex-suffixed words", () => {
    expect(applyPudidilFilters("attach epoch batch")).toBe("attach epoch batch");
  });

  test("PRESERVES normal tool_result content", () => {
    const toolResult = "File contents:\n# README\nconst x = ch=99ff;\nSome normal code here.";
    const filtered = applyPudidilFilters(toolResult);
    expect(filtered).toContain("Some normal code here.");
    expect(filtered).toContain("# README");
    expect(filtered).toContain("ch=99ff");
  });

  test("preserves normal content", () => {
    const normal = "Please help me write a function that fetches data from an API.";
    expect(applyPudidilFilters(normal)).toBe(normal);
  });
});
