import { describe, test, expect } from "bun:test";
import { applyPudidilFilters } from "./filters";

describe("applyPudidilFilters scope gating", () => {
  // Use a payload that contains both a structural pattern (billing header) and
  // an identity-rewrite trigger (the word "Claude" + CLAUDE.md).
  const payload = "x-anthropic-billing-header: foo\nFix CLAUDE.md and the claudeHome var. Claude is great.";

  test("structural scope: strips billing header but does NOT rewrite Claude/CLAUDE.md", () => {
    const out = applyPudidilFilters(payload, "structural");
    // Structural rule removed the billing header line.
    expect(out).not.toContain("billing-header");
    // Identity rewrites did NOT run — user content is preserved verbatim.
    expect(out).toContain("CLAUDE.md");
    expect(out).toContain("claudeHome");
    expect(out).toContain("Claude is great");
  });

  test("undefined scope (China providers): runs ALL rules — rewrites Claude/CLAUDE.md", () => {
    const out = applyPudidilFilters(payload, undefined);
    expect(out).not.toContain("billing-header");
    // Identity tier ran: CLAUDE.md -> agents.md, \bClaude\b -> AI.
    expect(out).toContain("agents.md");
    expect(out).not.toMatch(/\bClaude\b/);
  });

  test("structural scope keeps camelCase identifiers intact (no agent$1 rewrite)", () => {
    const out = applyPudidilFilters("path = claudeHome + claudeMd", "structural");
    expect(out).toContain("claudeHome");
    expect(out).toContain("claudeMd");
    expect(out).not.toContain("agentHome");
  });

  test("structural scope still strips cc_entrypoint / cc_version / cch hashes", () => {
    const out = applyPudidilFilters("cc_entrypoint=cli cc_version=1.2.3 cch=abc123", "structural");
    expect(out).not.toContain("cc_entrypoint=cli");
    expect(out).not.toContain("cc_version=1.2.3");
    expect(out).not.toContain("cch=abc123");
  });
});
