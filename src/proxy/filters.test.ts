import { describe, test, expect } from "bun:test";
import { applyPudidilFilters } from "./filters";

describe("applyPudidilFilters (general)", () => {
  test("strips vendor telemetry: billing header, cc_entrypoint, cc_version, cch hash", () => {
    const payload =
      "x-billing-header: anthropic-billing-account=abc\n" +
      "cc_entrypoint=cli cc_version=1.2.3 cch=deadbeef\n" +
      "keep this line intact";
    const out = applyPudidilFilters(payload);
    expect(out).not.toContain("billing-header");
    expect(out).not.toContain("cc_entrypoint=");
    expect(out).not.toContain("cc_version=");
    expect(out).not.toContain("cch=deadbeef");
    expect(out).toContain("keep this line intact");
  });

  test("neutralizes the vendor brand word to a bracketed token", () => {
    // pattern is the real brand word; replacement is the bracketed token.
    const word = "Claude Code";
    const token = "[AI-ASSISTANT]";
    const out = applyPudidilFilters("I am " + word + ", an assistant.");
    expect(out).toContain(token);
    expect(out).not.toContain(word);
  });

  test("does NOT rewrite technical words (tool-call safety)", () => {
    // These are the words the old word-rewrite tier mangled. They must pass
    // through verbatim so tool calls, commands, file paths, and tool results
    // are not corrupted.
    const payload =
      "Run the shell tool to terminate process 1234.\n" +
      "modify config.yaml to access the device.\n" +
      "threat model: utilize the governance rules; no aggression, no self-harm.";
    const out = applyPudidilFilters(payload);
    expect(out).toBe(payload);
  });

  test("preserves camelCase identifiers and file paths (no agent$1 rewrite)", () => {
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
      '{"name":"shell","arguments":{"command":"terminate --pid 1234","access":"device"}}';
    const out = applyPudidilFilters(payload);
    expect(out).toBe(payload);
    expect(out).toContain("terminate");
    expect(out).toContain("device");
  });

  test("keeps instruction / system-prompt / harness text intact", () => {
    const payload =
      "You are a coding agent. Use the provided tools. Follow CLAUDE.md harness.\n" +
      "Rules: do not modify user data without access consent. Utilize the tool device safely.";
    const out = applyPudidilFilters(payload);
    // Technical content is preserved; only the bare brand word would be
    // neutralized. "CLAUDE.md" stays because only the bare word rule exists,
    // not a CLAUDE.md->agents.md rule (that old identity tier is gone).
    expect(out).toContain("CLAUDE.md");
    expect(out).toContain("modify user data");
    expect(out).toContain("Utilize the tool device safely");
    expect(out).toContain("coding agent");
  });
});
