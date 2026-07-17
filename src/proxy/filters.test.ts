import { describe, test, expect } from "bun:test";
import { applyPudidilFilters } from "./filters";

describe("applyPudidilFilters (general, sanitization only)", () => {
  test("strips vendor telemetry: billing header, cc_entrypoint, cc_version", () => {
    const payload =
      "x-billing-header: secret\n" +
      "cc_entrypoint=cli cc_version=1.2.3\n" +
      "keep this line intact";
    const out = applyPudidilFilters(payload);
    expect(out).not.toContain("billing-header");
    expect(out).not.toContain("cc_entrypoint=");
    expect(out).not.toContain("cc_version=");
    expect(out).toContain("keep this line intact");
  });

  test("PRESERVES hex-suffixed tokens in tool-call args (remove_cch_hash deleted)", () => {
    // remove_cch_hash was removed because it stripped `ch=<hex>` (Grep/Glob
    // patterns, git hashes) from tool-call arguments — the "model goes dumb"
    // corruption. These must now survive verbatim.
    expect(applyPudidilFilters('{"pattern":"ch=abc123"}')).toBe('{"pattern":"ch=abc123"}');
    expect(applyPudidilFilters("git ch=deadbeef")).toBe("git ch=deadbeef");
  });

  test("brand names pass through VERBATIM (no neutralization)", () => {
    const sentence = "This uses the anthropic and openai SDKs.";
    const out = applyPudidilFilters(sentence);
    expect(out).toBe(sentence);
  });

  test("does not rewrite ordinary words (word-rewrite tier removed)", () => {
    const payload = "Terminate access to modify the tool device threat.";
    expect(applyPudidilFilters(payload)).toBe(payload);
  });
});
