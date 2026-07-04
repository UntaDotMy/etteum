import { describe, test, expect } from "bun:test";
import { applyPudidilFilters } from "./filters";

describe("applyPudidilFilters (general, sanitization only)", () => {
  test("strips vendor telemetry: billing header, cc_entrypoint, cc_version, cch hash", () => {
    const payload =
      "x-billing-header: anthropic-billing-account=abc\n" +
      "cc_entrypoint=cli cc_version=1.2.3 cch=deadbeef\n" +
      "https://github.com/anthropics/claude-code/issues/1\n" +
      "keep this line intact";
    const out = applyPudidilFilters(payload);
    expect(out).not.toContain("billing-header");
    expect(out).not.toContain("cc_entrypoint=");
    expect(out).not.toContain("cc_version=");
    expect(out).not.toContain("cch=deadbeef");
    expect(out).not.toContain("github.com/anthropics/claude-code");
    expect(out).toContain("keep this line intact");
  });

  test("brand names pass through VERBATIM (no neutralization)", () => {
    // The brand-neutralization tier was removed per user request. The bare
    // vendor word must reach the upstream provider unchanged.
    const word = "Claude Code";
    const token = "[AI-ASSISTANT]";
    const sentence = "I am " + word + ", an assistant.";
    const out = applyPudidilFilters(sentence);
    expect(out).toBe(sentence);       // unchanged
    expect(out).toContain(word);      // brand word still present
    expect(out).not.toContain(token); // no bracket-token rewrite
  });

  test("does NOT rewrite technical words (tool-call safety)", () => {
    const payload =
      "Run the shell tool to kill process 1234.\n" +
      "modify config.yaml to attack the device.\n" +
      "threat model: exploit the political rules; no violence, no suicide.";
    const out = applyPudidilFilters(payload);
    expect(out).toBe(payload);
  });

  test("preserves camelCase identifiers and file paths", () => {
    const payload = "path = claudeHome + claudeMd; open CLAUDE.md";
    const out = applyPudidilFilters(payload);
    expect(out).toContain("claudeHome");
    expect(out).toContain("claudeMd");
    expect(out).toContain("CLAUDE.md");
    expect(out).not.toContain("agentHome");
    expect(out).not.toContain("agents.md");
  });

  test("tool-call-shaped JSON passes through unmodified", () => {
    const payload =
      '{"name":"shell","arguments":{"command":"kill --pid 1234","target":"device"}}';
    const out = applyPudidilFilters(payload);
    expect(out).toBe(payload);
  });

  test("keeps instruction / system-prompt / harness text intact", () => {
    const payload =
      "You are a coding agent. Use the provided tools. Follow CLAUDE.md harness.\n" +
      "Rules: do not modify user data without access consent. Exploit the tool device safely.";
    const out = applyPudidilFilters(payload);
    expect(out).toContain("CLAUDE.md");
    expect(out).toContain("modify user data");
    expect(out).toContain("coding agent");
    expect(out).toContain("Exploit the tool device safely");
  });
});
