import { describe, test, expect } from "bun:test";
import {
  anthropicToOpenAI,
  normalizeMessagesToOpenAI,
  normalizeRequestToOpenAI as normalizeRequest,
  normalizeToolsToOpenAI,
  type AnthropicMessagesRequest,
} from "./anthropic";
import type { ChatCompletionRequest, ChatMessage } from "../providers/base";

// Helper: create an AnthropicMessagesRequest
function anthropicReq(messages: any[], opts: any = {}): AnthropicMessagesRequest {
  return { model: "test-model", messages, ...opts };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Anthropic → OpenAI conversion (anthropicToOpenAI)
//    Tests the /v1/messages endpoint path (Claude Code, Anthropic CLI).
// ─────────────────────────────────────────────────────────────────────────────

test("anthropicToOpenAI: tool_use → assistant.tool_calls, tool_result → role:tool", () => {
  const req = anthropicReq([
    { role: "user", content: "List files" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I'll list files." },
        { type: "tool_use", id: "toolu_01A", name: "Bash", input: { command: "ls -la" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_01A", content: "file1.txt\nfile2.ts" },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "Found 2 files." }] },
  ]);

  const result = anthropicToOpenAI(req);
  console.log("Result messages:", JSON.stringify(result.messages, null, 2));

  // Should produce: user, assistant(with tool_calls), tool, assistant
  expect(result.messages.length).toBe(4);

  expect(result.messages[0]!.role).toBe("user");
  expect(result.messages[0]!.content).toBe("List files");

  expect(result.messages[1]!.role).toBe("assistant");
  expect((result.messages[1] as any).tool_calls).toBeDefined();
  expect((result.messages[1] as any).tool_calls.length).toBe(1);
  expect((result.messages[1] as any).tool_calls[0].id).toBe("toolu_01A");
  expect((result.messages[1] as any).tool_calls[0].function.name).toBe("Bash");
  expect((result.messages[1] as any).tool_calls[0].function.arguments).toBe(
    JSON.stringify({ command: "ls -la" })
  );

  expect(result.messages[2]!.role).toBe("tool");
  expect((result.messages[2] as any).tool_call_id).toBe("toolu_01A");
  expect(result.messages[2]!.content).toBe("file1.txt\nfile2.ts");

  expect(result.messages[3]!.role).toBe("assistant");
  expect(result.messages[3]!.content).toBe("Found 2 files.");
});

test("anthropicToOpenAI: multiple tool_results in one user message → multiple role:tool messages", () => {
  const req = anthropicReq([
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_1", name: "Read", input: { path: "a.ts" } },
        { type: "tool_use", id: "call_2", name: "Read", input: { path: "b.ts" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "contents of a" },
        { type: "tool_result", tool_use_id: "call_2", content: "contents of b" },
        { type: "text", text: "Now summarize." },
      ],
    },
  ]);

  const result = anthropicToOpenAI(req);
  console.log("Multi tool_result:", JSON.stringify(result.messages, null, 2));

  // assistant(tool_calls), tool, tool, user
  expect(result.messages.length).toBe(4);
  expect(result.messages[0]!.role).toBe("assistant");
  expect((result.messages[0] as any).tool_calls.length).toBe(2);

  expect(result.messages[1]!.role).toBe("tool");
  expect((result.messages[1] as any).tool_call_id).toBe("call_1");
  expect(result.messages[1]!.content).toBe("contents of a");

  expect(result.messages[2]!.role).toBe("tool");
  expect((result.messages[2] as any).tool_call_id).toBe("call_2");
  expect(result.messages[2]!.content).toBe("contents of b");

  expect(result.messages[3]!.role).toBe("user");
  expect(result.messages[3]!.content).toBe("Now summarize.");
});

test("anthropicToOpenAI: user message with ONLY tool_results → no empty user message", () => {
  const req = anthropicReq([
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "Bash", input: { command: "pwd" } }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "/home/user" },
      ],
    },
  ]);

  const result = anthropicToOpenAI(req);
  console.log("Only tool_results:", JSON.stringify(result.messages, null, 2));

  // assistant(tool_calls), tool — NO empty user message
  expect(result.messages.length).toBe(2);
  expect(result.messages[0]!.role).toBe("assistant");
  expect(result.messages[1]!.role).toBe("tool");
});

test("anthropicToOpenAI: image block → image_url data URL", () => {
  const req = anthropicReq([
    {
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
        },
      ],
    },
  ]);

  const result = anthropicToOpenAI(req);
  console.log("Image:", JSON.stringify(result.messages, null, 2));

  expect(result.messages.length).toBe(1);
  expect(result.messages[0]!.role).toBe("user");
  expect(Array.isArray(result.messages[0]!.content)).toBe(true);
  const blocks = result.messages[0]!.content as any[];
  expect(blocks[0]!.type).toBe("text");
  expect(blocks[1]!.type).toBe("image_url");
  expect(blocks[1]!.image_url.url).toBe("data:image/png;base64,iVBORw0KGgo=");
});

test("anthropicToOpenAI: thinking blocks are dropped", () => {
  const req = anthropicReq([
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Let me think...", signature: "sig" },
        { type: "text", text: "Here's my answer." },
      ],
    },
  ]);

  const result = anthropicToOpenAI(req);
  console.log("Thinking:", JSON.stringify(result.messages, null, 2));

  expect(result.messages.length).toBe(1);
  expect(result.messages[0]!.content).toBe("Here's my answer.");
});

test("anthropicToOpenAI: assistant with only tool_use → null content + tool_calls", () => {
  const req = anthropicReq([
    {
      role: "user",
      content: "Read the file.",
    },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_1", name: "Read", input: { path: "test.ts" } },
      ],
    },
  ]);

  const result = anthropicToOpenAI(req);
  console.log("Only tool_use:", JSON.stringify(result.messages, null, 2));

  expect(result.messages.length).toBe(2);
  expect(result.messages[1]!.role).toBe("assistant");
  expect((result.messages[1] as any).tool_calls).toBeDefined();
  expect((result.messages[1] as any).tool_calls.length).toBe(1);
  // Content should be null or empty (no text block)
  expect((result.messages[1] as any).content === null || (result.messages[1] as any).content === "").toBe(true);
});

test("anthropicToOpenAI: tools converted from Anthropic to OpenAI format", () => {
  const req = anthropicReq(
    [{ role: "user", content: "test" }],
    {
      tools: [
        {
          name: "Bash",
          description: "Run a command",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    }
  );

  const result = anthropicToOpenAI(req);
  console.log("Tools:", JSON.stringify(result.tools, null, 2));

  expect(result.tools).toBeDefined();
  expect(result.tools!.length).toBe(1);
  expect(result.tools![0]!.type).toBe("function");
  expect(result.tools![0]!.function.name).toBe("Bash");
  expect(result.tools![0]!.function.parameters).toBeDefined();
  expect(result.tools![0]!.function.parameters.properties.command).toBeDefined();
});

test("anthropicToOpenAI: tool_choice converted", () => {
  const req = anthropicReq(
    [{ role: "user", content: "test" }],
    { tool_choice: { type: "auto" } }
  );
  const result = anthropicToOpenAI(req);
  expect(result.tool_choice).toBe("auto");

  const req2 = anthropicReq(
    [{ role: "user", content: "test" }],
    { tool_choice: { type: "any" } }
  );
  expect(anthropicToOpenAI(req2).tool_choice).toBe("required");

  const req3 = anthropicReq(
    [{ role: "user", content: "test" }],
    { tool_choice: { type: "tool", name: "Bash" } }
  );
  const tc3 = anthropicToOpenAI(req3).tool_choice;
  expect(tc3.type).toBe("function");
  expect(tc3.function.name).toBe("Bash");
});

test("anthropicToOpenAI: tool_result with array content (nested text blocks)", () => {
  const req = anthropicReq([
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "Read", input: {} }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: [
            { type: "text", text: "line 1" },
            { type: "text", text: "line 2" },
          ],
        },
      ],
    },
  ]);

  const result = anthropicToOpenAI(req);
  console.log("Array content tool_result:", JSON.stringify(result.messages, null, 2));

  expect(result.messages[1]!.role).toBe("tool");
  expect(result.messages[1]!.content).toBe("line 1\nline 2");
});

test("anthropicToOpenAI: tool_result with is_error flag", () => {
  const req = anthropicReq([
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "Bash", input: {} }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "Command failed",
          is_error: true,
        },
      ],
    },
  ]);

  const result = anthropicToOpenAI(req);
  console.log("is_error tool_result:", JSON.stringify(result.messages, null, 2));

  expect(result.messages[1]!.role).toBe("tool");
  expect(result.messages[1]!.content).toBe("Command failed");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. normalizeMessagesToOpenAI — OpenAI CLI path
//    Tests the /v1/chat/completions endpoint path (OpenAI CLI, Cursor, etc.)
// ─────────────────────────────────────────────────────────────────────────────

test("normalizeMessagesToOpenAI: clean OpenAI messages pass through unchanged", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there!" },
  ];

  const result = normalizeMessagesToOpenAI(messages);
  expect(result.length).toBe(3);
  expect(result[0]!.role).toBe("system");
  expect(result[0]!.content).toBe("You are helpful.");
  expect(result[1]!.role).toBe("user");
  expect(result[1]!.content).toBe("Hello");
  expect(result[2]!.role).toBe("assistant");
  expect(result[2]!.content).toBe("Hi there!");
});

test("normalizeMessagesToOpenAI: OpenAI tool_calls preserved", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "Read file" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "Read", arguments: '{"path":"test.ts"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "file contents" },
    { role: "assistant", content: "Here's the file." },
  ];

  const result = normalizeMessagesToOpenAI(messages);
  console.log("OpenAI tool_calls:", JSON.stringify(result, null, 2));

  expect(result.length).toBe(4);
  expect(result[1]!.role).toBe("assistant");
  expect((result[1] as any).tool_calls).toBeDefined();
  expect((result[1] as any).tool_calls.length).toBe(1);
  expect((result[1] as any).tool_calls[0].function.name).toBe("Read");

  expect(result[2]!.role).toBe("tool");
  expect((result[2] as any).tool_call_id).toBe("call_1");
  expect(result[2]!.content).toBe("file contents");
});

test("normalizeMessagesToOpenAI: mixed Anthropic+OpenAI blocks in same request", () => {
  // Some clients send mixed format — e.g. Anthropic tool_use block in an
  // assistant message AND OpenAI role:tool message in the same request.
  const messages: any[] = [
    { role: "user", content: "Do something" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me run a command." },
        { type: "tool_use", id: "call_1", name: "Bash", input: { command: "echo hi" } },
      ],
    },
    // OpenAI-style tool result
    { role: "tool", tool_call_id: "call_1", content: "hi" },
    {
      role: "user",
      content: [
        { type: "text", text: "Now read a file." },
        { type: "tool_use", id: "call_2", name: "Read", input: { path: "a.ts" } },
      ],
    },
    // Wait — tool_use in a user message is wrong, but let's test Anthropic format
  ];

  const result = normalizeMessagesToOpenAI(messages);
  console.log("Mixed:", JSON.stringify(result, null, 2));

  // The assistant's tool_use should become tool_calls
  const assistantMsg = result.find((m) => m.role === "assistant");
  expect(assistantMsg).toBeDefined();
  expect((assistantMsg as any).tool_calls).toBeDefined();
  expect((assistantMsg as any).tool_calls.length).toBe(1);
  expect((assistantMsg as any).tool_calls[0].id).toBe("call_1");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Nothing-dropped verification
//    Comprehensive test ensuring NO tool calls, tool results, text, or images
//    are silently lost during normalization.
// ─────────────────────────────────────────────────────────────────────────────

test("NOTHING DROPPED: full agentic conversation round-trip", () => {
  // Simulate a real Claude Code conversation:
  // 1. User asks to fix a bug
  // 2. Assistant calls Bash to investigate
  // 3. Tool returns output
  // 4. Assistant calls Read on a file
  // 5. Tool returns file content
  // 6. Assistant calls Edit to fix the bug
  // 7. Tool returns success
  // 8. Assistant calls Bash to verify
  // 9. Tool returns output
  // 10. Assistant explains the fix

  const req = anthropicReq([
    { role: "user", content: "Fix the bug in auth.ts" },

    // Turn 1: Bash
    {
      role: "assistant",
      content: [
        { type: "text", text: "I'll investigate the issue." },
        { type: "tool_use", id: "call_1", name: "Bash", input: { command: "grep -n 'bug' auth.ts" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "10:  // bug: this doesn't work" },
      ],
    },

    // Turn 2: Read
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_2", name: "Read", input: { file_path: "auth.ts" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_2", content: "1: import { auth } from 'lib';\n10: // bug here\n20: export default auth;" },
      ],
    },

    // Turn 3: Edit
    {
      role: "assistant",
      content: [
        { type: "text", text: "I see the bug. Let me fix it." },
        { type: "tool_use", id: "call_3", name: "Edit", input: { file_path: "auth.ts", old_text: "bug", new_text: "fix" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_3", content: "Edit applied successfully." },
      ],
    },

    // Turn 4: Bash to verify
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_4", name: "Bash", input: { command: "npm test" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_4", content: "All tests passed." },
      ],
    },

    // Final answer
    { role: "assistant", content: [{ type: "text", text: "The bug is fixed. All tests pass." }] },
  ]);

  const result = anthropicToOpenAI(req);
  console.log("Full conversation:", JSON.stringify(result.messages, null, 2));

  // Count expected messages:
  // user, assistant(text+tool_call_1), tool(call_1),
  // assistant(tool_call_2), tool(call_2),
  // assistant(text+tool_call_3), tool(call_3),
  // assistant(tool_call_4), tool(call_4),
  // assistant(text)

  const toolMessages = result.messages.filter((m) => m.role === "tool");
  const assistantMessages = result.messages.filter((m) => m.role === "assistant");
  const userMessages = result.messages.filter((m) => m.role === "user");

  // 4 tool results → 4 tool messages
  expect(toolMessages.length).toBe(4);

  // Verify each tool result is preserved with correct id and content
  expect((toolMessages[0] as any).tool_call_id).toBe("call_1");
  expect(toolMessages[0]!.content).toBe("10:  // bug: this doesn't work");

  expect((toolMessages[1] as any).tool_call_id).toBe("call_2");
  expect(toolMessages[1]!.content).toContain("import { auth }");

  expect((toolMessages[2] as any).tool_call_id).toBe("call_3");
  expect(toolMessages[2]!.content).toBe("Edit applied successfully.");

  expect((toolMessages[3] as any).tool_call_id).toBe("call_4");
  expect(toolMessages[3]!.content).toBe("All tests passed.");

  // 5 assistant messages (4 with tool calls + 1 final text)
  expect(assistantMessages.length).toBe(5);

  // Verify tool_calls are preserved
  const allToolCalls = assistantMessages
    .flatMap((m) => (m as any).tool_calls || []);
  expect(allToolCalls.length).toBe(4);
  expect(allToolCalls[0]!.id).toBe("call_1");
  expect(allToolCalls[0]!.function.name).toBe("Bash");
  expect(allToolCalls[1]!.id).toBe("call_2");
  expect(allToolCalls[1]!.function.name).toBe("Read");
  expect(allToolCalls[2]!.id).toBe("call_3");
  expect(allToolCalls[2]!.function.name).toBe("Edit");
  expect(allToolCalls[3]!.id).toBe("call_4");
  expect(allToolCalls[3]!.function.name).toBe("Bash");

  // Verify tool call arguments are preserved
  const call1Args = JSON.parse(allToolCalls[0]!.function.arguments);
  expect(call1Args.command).toBe("grep -n 'bug' auth.ts");

  const call2Args = JSON.parse(allToolCalls[1]!.function.arguments);
  expect(call2Args.file_path).toBe("auth.ts");

  const call3Args = JSON.parse(allToolCalls[2]!.function.arguments);
  expect(call3Args.old_text).toBe("bug");
  expect(call3Args.new_text).toBe("fix");

  const call4Args = JSON.parse(allToolCalls[3]!.function.arguments);
  expect(call4Args.command).toBe("npm test");

  // Verify assistant text content is preserved
  expect(assistantMessages[0]!.content).toBe("I'll investigate the issue.");
  expect(assistantMessages[2]!.content).toBe("I see the bug. Let me fix it.");
  expect(assistantMessages[4]!.content).toBe("The bug is fixed. All tests pass.");

  // 1 user message (the initial one)
  expect(userMessages.length).toBe(1);
  expect(userMessages[0]!.content).toBe("Fix the bug in auth.ts");
});

test("NOTHING DROPPED: system prompt preserved", () => {
  const req = anthropicReq(
    [{ role: "user", content: "Hello" }],
    { system: "You are a helpful assistant. Use tools when needed." }
  );

  const result = anthropicToOpenAI(req);
  console.log("System:", JSON.stringify(result.messages[0], null, 2));

  expect(result.messages[0]!.role).toBe("system");
  expect(result.messages[0]!.content).toBe("You are a helpful assistant. Use tools when needed.");
});

test("NOTHING DROPPED: tools array fully preserved", () => {
  const req = anthropicReq(
    [{ role: "user", content: "test" }],
    {
      tools: [
        {
          name: "Bash",
          description: "Execute a bash command",
          input_schema: {
            type: "object",
            properties: {
              command: { type: "string", description: "The command to execute" },
              timeout: { type: "number", description: "Timeout in seconds" },
            },
            required: ["command"],
          },
        },
        {
          name: "Read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: {
              file_path: { type: "string" },
              offset: { type: "number" },
              limit: { type: "number" },
            },
            required: ["file_path"],
          },
        },
        {
          name: "Edit",
          description: "Edit a file",
          input_schema: {
            type: "object",
            properties: {
              file_path: { type: "string" },
              old_text: { type: "string" },
              new_text: { type: "string" },
            },
            required: ["file_path", "old_text", "new_text"],
          },
        },
      ],
    }
  );

  const result = anthropicToOpenAI(req);
  console.log("All tools:", JSON.stringify(result.tools, null, 2));

  expect(result.tools!.length).toBe(3);

  // Verify each tool is properly converted
  for (const tool of result.tools!) {
    expect(tool.type).toBe("function");
    expect(tool.function.name).toBeDefined();
    expect(tool.function.description).toBeDefined();
    expect(tool.function.parameters).toBeDefined();
  }

  // Verify specific tool properties
  const bashTool = result.tools!.find((t) => t.function.name === "Bash");
  expect(bashTool).toBeDefined();
  expect(bashTool!.function.parameters.properties.command.type).toBe("string");
  expect(bashTool!.function.parameters.properties.timeout.type).toBe("number");
  expect(bashTool!.function.parameters.required).toContain("command");

  const readTool = result.tools!.find((t) => t.function.name === "Read");
  expect(readTool).toBeDefined();
  expect(readTool!.function.parameters.properties.file_path.type).toBe("string");
  expect(readTool!.function.parameters.required).toContain("file_path");

  const editTool = result.tools!.find((t) => t.function.name === "Edit");
  expect(editTool).toBeDefined();
  expect(editTool!.function.parameters.properties.old_text.type).toBe("string");
  expect(editTool!.function.parameters.properties.new_text.type).toBe("string");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. normalizeRequest — full request normalization
// ─────────────────────────────────────────────────────────────────────────────

test("normalizeRequest: normalizes messages + tools together", () => {
  const request: ChatCompletionRequest = {
    model: "test",
    messages: [
      { role: "user", content: "Read the file" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "Read", input: { path: "test.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "file contents" },
        ],
      },
    ] as any,
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ] as any,
  };

  const result = normalizeRequest(request);
  console.log("Normalized request:", JSON.stringify(result, null, 2));

  // Messages normalized
  expect(result.messages[1]!.role).toBe("assistant");
  expect((result.messages[1] as any).tool_calls).toBeDefined();
  expect(result.messages[2]!.role).toBe("tool");
  expect((result.messages[2] as any).tool_call_id).toBe("call_1");

  // Tools normalized
  expect(result.tools!.length).toBe(1);
  expect(result.tools![0]!.type).toBe("function");
  expect(result.tools![0]!.function.name).toBe("Read");
  expect(result.tools![0]!.function.parameters.properties.path).toBeDefined();
});

test("normalizeRequest: already-OpenAI tools pass through", () => {
  const request: ChatCompletionRequest = {
    model: "test",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "Bash",
          description: "Run command",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      },
    ],
  };

  const result = normalizeRequest(request);
  expect(result.tools!.length).toBe(1);
  expect(result.tools![0]!.type).toBe("function");
  expect(result.tools![0]!.function.name).toBe("Bash");
  // Verify it wasn't double-wrapped
  expect(result.tools![0]!.function.function).toBeUndefined();
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Edge cases
// ─────────────────────────────────────────────────────────────────────────────

test("EDGE: empty content array", () => {
  const messages: any[] = [
    { role: "user", content: [] },
  ];
  const result = normalizeMessagesToOpenAI(messages);
  console.log("Empty array:", JSON.stringify(result, null, 2));
  // Should produce a user message with empty string (not dropped)
  expect(result.length).toBe(1);
  expect(result[0]!.role).toBe("user");
});

test("EDGE: unknown content block type coerced to text", () => {
  const messages: any[] = [
    {
      role: "user",
      content: [
        { type: "unknown_type", text: "some text" },
      ],
    },
  ];
  const result = normalizeMessagesToOpenAI(messages);
  console.log("Unknown block:", JSON.stringify(result, null, 2));
  expect(result.length).toBe(1);
  expect(result[0]!.content).toBe("some text");
});

test("EDGE: null content in tool_result", () => {
  const messages: any[] = [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "Bash", input: {} }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: null },
      ],
    },
  ];
  const result = normalizeMessagesToOpenAI(messages);
  console.log("Null content:", JSON.stringify(result, null, 2));
  expect(result[1]!.role).toBe("tool");
  expect(result[1]!.content).toBe("");
});

test("EDGE: assistant with text + tool_use + image in same message", () => {
  const messages: any[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me look at this image." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        { type: "tool_use", id: "call_1", name: "Analyze", input: {} },
      ],
    },
  ];
  const result = normalizeMessagesToOpenAI(messages);
  console.log("Mixed assistant:", JSON.stringify(result, null, 2));
  expect(result[0]!.role).toBe("assistant");
  expect((result[0] as any).tool_calls).toBeDefined();
  expect((result[0] as any).tool_calls.length).toBe(1);
  // Text should be preserved
  expect(result[0]!.content).toBe("Let me look at this image.");
});

test("EDGE: consecutive tool messages (OpenAI format)", () => {
  const messages: any[] = [
    { role: "user", content: "Read two files" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "Read", arguments: '{"path":"a.ts"}' } },
        { id: "call_2", type: "function", function: { name: "Read", arguments: '{"path":"b.ts"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "contents of a" },
    { role: "tool", tool_call_id: "call_2", content: "contents of b" },
    { role: "assistant", content: "Done reading." },
  ];
  const result = normalizeMessagesToOpenAI(messages);
  console.log("Consecutive tools:", JSON.stringify(result, null, 2));
  expect(result.length).toBe(5);
  expect(result[2]!.role).toBe("tool");
  expect((result[2] as any).tool_call_id).toBe("call_1");
  expect(result[3]!.role).toBe("tool");
  expect((result[3] as any).tool_call_id).toBe("call_2");
  expect(result[4]!.content).toBe("Done reading.");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. BYOK reverse conversion (OpenAI → Anthropic)
//    Verify that the BYOK Anthropic path properly converts back.
//    (This tests the format, not the actual BYOK provider method which is private.)
// ─────────────────────────────────────────────────────────────────────────────

test("BYOK reverse: OpenAI tool_calls → Anthropic tool_use", () => {
  // After normalization, an assistant message has tool_calls.
  // The BYOK Anthropic path should convert it back to tool_use blocks.
  // We simulate the conversion logic here to verify the concept.
  const openAIMsg: ChatMessage = {
    role: "assistant",
    content: "Let me read the file.",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "Read", arguments: '{"path":"test.ts"}' },
      },
    ],
  };

  // Simulate BYOK's toAnthropicRequest conversion for this message
  const contentBlocks: any[] = [];
  const text = typeof openAIMsg.content === "string" ? openAIMsg.content : "";
  if (text) contentBlocks.push({ type: "text", text });
  if (Array.isArray(openAIMsg.tool_calls)) {
    for (const tc of openAIMsg.tool_calls) {
      let input: any;
      try {
        input = typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments;
      } catch { input = {}; }
      contentBlocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  console.log("BYOK Anthropic contentBlocks:", JSON.stringify(contentBlocks, null, 2));
  expect(contentBlocks.length).toBe(2);
  expect(contentBlocks[0]!.type).toBe("text");
  expect(contentBlocks[0]!.text).toBe("Let me read the file.");
  expect(contentBlocks[1]!.type).toBe("tool_use");
  expect(contentBlocks[1]!.id).toBe("call_1");
  expect(contentBlocks[1]!.name).toBe("Read");
  expect(contentBlocks[1]!.input.path).toBe("test.ts");
});

test("BYOK reverse: OpenAI role:tool → Anthropic tool_result", () => {
  const openAIMsg: ChatMessage = {
    role: "tool",
    tool_call_id: "call_1",
    content: "file contents here",
  };

  // Simulate BYOK's conversion
  const toolResultBlock = {
    type: "tool_result",
    tool_use_id: openAIMsg.tool_call_id,
    content: typeof openAIMsg.content === "string" ? openAIMsg.content : JSON.stringify(openAIMsg.content),
  };

  console.log("BYOK tool_result:", JSON.stringify(toolResultBlock, null, 2));
  expect(toolResultBlock.type).toBe("tool_result");
  expect(toolResultBlock.tool_use_id).toBe("call_1");
  expect(toolResultBlock.content).toBe("file contents here");
});

console.log("\n✅ All anthropic transform tests loaded!");
