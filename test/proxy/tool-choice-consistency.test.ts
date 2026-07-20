/**
 * tool_choice-without-tools must never reach a strict upstream (xAI
 * cli-chat-proxy 400: "A tool_choice was set on the request but no tools
 * were specified"). Covers every client family:
 *  - Claude Code / Anthropic: tool_choice {type:auto|any|tool} sans tools
 *  - the web_search server-tool strip emptying the list mid-conversion
 *  - OpenCode / OpenAI chat: tool_choice "auto" / parallel_tool_calls sans tools
 *  - Codex / Responses: tool_choice sans tools
 *  - Grok Responses wire: guard + chat-shape → Responses-shape mapping
 */
import { describe, test, expect } from "bun:test";
import { normalizeToolChoiceConsistency } from "../../src/proxy/router";
import { anthropicToOpenAI } from "../../src/proxy/transforms/anthropic";
import { responsesRequestToChat } from "../../src/proxy/transforms/openai-responses";
import { stripWebSearchTools } from "../../src/proxy/built-in-tools/agent-loop";
import {
  chatToCliResponsesBody,
  normalizeToolChoiceForResponses,
} from "../../src/proxy/providers/grok/cli-proxy-wire";
import type { ChatCompletionRequest } from "../../src/proxy/providers/base";

const BASH_TOOL = {
  type: "function",
  function: {
    name: "Bash",
    description: "Run a shell command",
    parameters: { type: "object", properties: { command: { type: "string" } } },
  },
};
const READ_TOOL = {
  type: "function",
  function: { name: "Read", description: "Read a file", parameters: { type: "object" } },
};

function chatReq(extra: Record<string, unknown>): ChatCompletionRequest {
  return {
    model: "grok-4.5",
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  } as ChatCompletionRequest;
}

function anthropicReq(extra: Record<string, unknown>): any {
  return {
    model: "grok-4.5",
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  };
}

describe("normalizeToolChoiceConsistency", () => {
  test("drops tool_choice when no tools are present (OpenCode / OpenAI chat)", () => {
    const out = normalizeToolChoiceConsistency(chatReq({ tool_choice: "auto" }));
    expect((out as any).tool_choice).toBeUndefined();
  });

  test("drops parallel_tool_calls alongside tool_choice when tools are absent", () => {
    const out = normalizeToolChoiceConsistency(
      chatReq({ tool_choice: "required", parallel_tool_calls: true } as any),
    );
    expect((out as any).tool_choice).toBeUndefined();
    expect((out as any).parallel_tool_calls).toBeUndefined();
  });

  test("empty tools array counts as no tools", () => {
    const out = normalizeToolChoiceConsistency(chatReq({ tools: [], tool_choice: "auto" }));
    expect((out as any).tool_choice).toBeUndefined();
  });

  test("keeps tool_choice when tools exist", () => {
    const out = normalizeToolChoiceConsistency(
      chatReq({ tools: [BASH_TOOL], tool_choice: "required" }),
    );
    expect((out as any).tool_choice).toBe("required");
  });

  test("function choice naming a tool in the list is preserved", () => {
    const choice = { type: "function", function: { name: "Bash" } };
    const out = normalizeToolChoiceConsistency(
      chatReq({ tools: [BASH_TOOL, READ_TOOL], tool_choice: choice }),
    );
    expect((out as any).tool_choice).toEqual(choice);
  });

  test("function choice naming a MISSING tool degrades to auto (strict-upstream 400 class)", () => {
    const out = normalizeToolChoiceConsistency(
      chatReq({
        tools: [READ_TOOL],
        tool_choice: { type: "function", function: { name: "Bash" } },
      }),
    );
    expect((out as any).tool_choice).toBe("auto");
  });

  test("request without either knob is returned untouched", () => {
    const req = chatReq({ tools: [BASH_TOOL] });
    const out = normalizeToolChoiceConsistency(req);
    expect(out).toBe(req);
  });
});

describe("Claude Code / Anthropic conversion path", () => {
  test("anthropicToOpenAI stays faithful (tool_choice kept), normalizer drops it without tools", () => {
    // The transform must remain a faithful converter — consistency is enforced
    // by the router normalizer right before dispatch.
    const converted = anthropicToOpenAI(anthropicReq({ tool_choice: { type: "auto" } }));
    expect(converted.tool_choice).toBe("auto");
    expect(converted.tools).toBeUndefined();

    const out = normalizeToolChoiceConsistency(converted);
    expect((out as any).tool_choice).toBeUndefined();
  });

  test("{type:any} without tools is dropped after conversion", () => {
    const converted = anthropicToOpenAI(anthropicReq({ tool_choice: { type: "any" } }));
    expect(converted.tool_choice).toBe("required");
    expect((normalizeToolChoiceConsistency(converted) as any).tool_choice).toBeUndefined();
  });

  test("{type:tool, name} survives when the tool exists (Claude Code forced call)", () => {
    const converted = anthropicToOpenAI(
      anthropicReq({
        tools: [
          { name: "Bash", description: "Run a shell command", input_schema: { type: "object" } },
        ],
        tool_choice: { type: "tool", name: "Bash" },
      }),
    );
    const out = normalizeToolChoiceConsistency(converted);
    expect((out as any).tool_choice).toEqual({ type: "function", function: { name: "Bash" } });
  });

  test("web_search-only tool list: strip empties tools, tool_choice is dropped (user's scenario)", () => {
    const stripped = stripWebSearchTools([
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
    ] as any);
    expect(stripped).toBeUndefined();

    const converted = anthropicToOpenAI(
      anthropicReq({ tools: stripped, tool_choice: { type: "auto" } }),
    );
    expect(converted.tools).toBeUndefined();
    const out = normalizeToolChoiceConsistency(converted);
    expect((out as any).tool_choice).toBeUndefined();
  });
});

describe("Codex / Responses conversion path", () => {
  test("tool_choice without tools survives transform, dropped by normalizer", () => {
    const chat = responsesRequestToChat({
      model: "grok-4.5",
      input: "hi",
      tool_choice: "auto",
    } as any);
    expect((chat as any).tool_choice).toBe("auto");
    expect((chat as any).tools).toBeUndefined();

    const out = normalizeToolChoiceConsistency(chat);
    expect((out as any).tool_choice).toBeUndefined();
  });
});

describe("Grok cli-chat-proxy Responses wire", () => {
  test("no tool_choice key is emitted when tools are absent (the original 400)", () => {
    const body = chatToCliResponsesBody(
      chatReq({ tool_choice: "auto" }),
      "grok-4.5",
    );
    expect(body.tools).toBeUndefined();
    expect("tool_choice" in body).toBe(false);
  });

  test("chat-shaped function choice is flattened to Responses shape", () => {
    const body = chatToCliResponsesBody(
      chatReq({
        tools: [BASH_TOOL],
        tool_choice: { type: "function", function: { name: "Bash" } },
      }),
      "grok-4.5",
    );
    expect(body.tool_choice).toEqual({ type: "function", name: "Bash" });
  });

  test("string choices pass through when tools exist", () => {
    const body = chatToCliResponsesBody(
      chatReq({ tools: [BASH_TOOL], tool_choice: "auto" }),
      "grok-4.5",
    );
    expect(body.tool_choice).toBe("auto");
  });

  test("Anthropic remnant {type:tool, name} maps to flat function choice", () => {
    const body = chatToCliResponsesBody(
      chatReq({ tools: [BASH_TOOL], tool_choice: { type: "tool", name: "Bash" } }),
      "grok-4.5",
    );
    expect(body.tool_choice).toEqual({ type: "function", name: "Bash" });
  });
});

describe("normalizeToolChoiceForResponses", () => {
  test("shapes", () => {
    expect(normalizeToolChoiceForResponses("required")).toBe("required");
    expect(normalizeToolChoiceForResponses(null)).toBeUndefined();
    expect(
      normalizeToolChoiceForResponses({ type: "function", function: { name: "Read" } }),
    ).toEqual({ type: "function", name: "Read" });
    // function choice without a usable name is meaningless → auto
    expect(normalizeToolChoiceForResponses({ type: "function", function: {} })).toBe("auto");
  });
});
