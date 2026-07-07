import { describe, test, expect } from "bun:test";
import { injectSystemPrompt } from "./system-inject";
import { applyInjections, shouldSkipCavemanInjection } from "./injection";
import { CAVEMAN_INJECTION_PROMPTS, PONYTAIL_INJECTION_PROMPTS } from "./injection-prompts";
import type { ChatCompletionRequest } from "../providers/base";

describe("system-inject injectSystemPrompt", () => {
  test("appends to OpenAI string system message", () => {
    const body: any = { messages: [{ role: "system", content: "Be helpful." }] };
    injectSystemPrompt(body, "INJECTED");
    expect(body.messages[0].content).toContain("Be helpful.");
    expect(body.messages[0].content).toContain("INJECTED");
  });

  test("unshifts a new system message when none exists (OpenAI)", () => {
    const body: any = { messages: [{ role: "user", content: "hi" }] };
    injectSystemPrompt(body, "INJECTED");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe("INJECTED");
  });

  test("Claude string system: concatenates", () => {
    const body: any = { system: "You are Claude." };
    injectSystemPrompt(body, "INJECTED");
    expect(body.system).toBe("You are Claude.\n\nINJECTED");
  });

  test("Claude array system: splices BEFORE the last cache_control block (stays in cached prefix)", () => {
    const body: any = {
      system: [
        { type: "text", text: "block-A" },
        { type: "text", text: "block-B", cache_control: { type: "ephemeral" } },
      ],
    };
    injectSystemPrompt(body, "INJECTED");
    // INJECTED must be inserted at index 1 (before the cache_control block at index 2)
    expect(body.system).toHaveLength(3);
    expect(body.system[1].text).toBe("INJECTED");
    expect(body.system[2].text).toBe("block-B");
    expect(body.system[2].cache_control).toBeDefined();
  });

  test("Claude array system with no cache_control: appends at end", () => {
    const body: any = { system: [{ type: "text", text: "block-A" }] };
    injectSystemPrompt(body, "INJECTED");
    expect(body.system).toHaveLength(2);
    expect(body.system[1].text).toBe("INJECTED");
  });

  test("no-op on empty/null body", () => {
    injectSystemPrompt(null as any, "X");
    injectSystemPrompt({} as any, "");
    // no throw
    expect(true).toBe(true);
  });
});

describe("injection-prompts content", () => {
  test("caveman has all 6 levels with non-empty text", () => {
    const levels = ["lite", "full", "ultra", "wenyan-lite", "wenyan", "wenyan-ultra"] as const;
    for (const lvl of levels) {
      expect(CAVEMAN_INJECTION_PROMPTS[lvl].length, `caveman ${lvl}`).toBeGreaterThan(50);
    }
  });

  test("ponytail has all 3 levels with non-empty text", () => {
    for (const lvl of ["lite", "full", "ultra"] as const) {
      expect(PONYTAIL_INJECTION_PROMPTS[lvl].length, `ponytail ${lvl}`).toBeGreaterThan(50);
    }
  });

  test("wenyan level mentions the 80-90% reduction target", () => {
    expect(CAVEMAN_INJECTION_PROMPTS.wenyan).toContain("80-90%");
  });
});

describe("shouldSkipCavemanInjection (GLM-on-Responses guard)", () => {
  test("skips GLM model on Responses-shaped request", () => {
    const req = { model: "glm-4.6", input: [{ role: "user", content: "hi" }] } as any;
    expect(shouldSkipCavemanInjection(req)).toBe(true);
  });

  test("does NOT skip non-GLM models", () => {
    const req = { model: "claude-sonnet-4", input: [] } as any;
    expect(shouldSkipCavemanInjection(req)).toBe(false);
  });

  test("skips codebuddy-china provider (GLM) regardless of shape", () => {
    const req = { model: "cbc-glm", messages: [] } as any;
    expect(shouldSkipCavemanInjection(req, "codebuddy-china")).toBe(true);
  });

  test("does NOT skip GLM on a plain chat request from a non-GLM provider", () => {
    const req = { model: "glm-4.6", messages: [{ role: "user", content: "hi" }] } as any;
    expect(shouldSkipCavemanInjection(req, "kiro")).toBe(false);
  });
});

describe("applyInjections", () => {
  test("appends caveman + ponytail prompts when both enabled (OpenAI)", () => {
    const req: ChatCompletionRequest = {
      model: "claude-sonnet-4",
      messages: [{ role: "system", content: "Base." }],
    } as any;
    const r = applyInjections(req, { enabled: true, level: "full" }, { enabled: true, level: "lite" });
    const sysContent = String(r.request.messages[0]?.content ?? "");
    expect(sysContent).toContain("Base.");
    expect(sysContent).toContain("terse caveman");
    expect(sysContent).toContain("lazy senior developer");
    // saved reported as 0 (output-side technique)
    expect(r.saved).toBe(0);
  });

  test("no-op when both disabled", () => {
    const req: ChatCompletionRequest = {
      model: "claude-sonnet-4",
      messages: [{ role: "system", content: "Base." }],
    } as any;
    const before = JSON.stringify(req);
    applyInjections(req, { enabled: false, level: "full" }, { enabled: false, level: "full" });
    expect(JSON.stringify(req)).toBe(before);
  });

  test("skips caveman injection for GLM on Responses but still applies ponytail", () => {
    const req: ChatCompletionRequest = {
      model: "glm-4.6",
      input: [{ role: "user", content: "hi" }],
    } as any;
    const r = applyInjections(req, { enabled: true, level: "full" }, { enabled: true, level: "full" }, "codebuddy-china");
    // ponytail applied (input array gets a system entry), caveman skipped
    const sysMsg = (r.request as any).input.find((m: any) => m.role === "system");
    expect(sysMsg).toBeDefined();
    expect(sysMsg.content).toContain("lazy senior developer");
    expect(sysMsg.content).not.toContain("terse caveman");
  });
});
