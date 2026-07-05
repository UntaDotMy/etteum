import { describe, test, expect } from "bun:test";
import {
  responsesRequestToChat,
  chatResponseToResponses,
  chatStreamToResponsesStream,
  newResponsesResponseMeta,
  type ResponsesApiRequest,
} from "./openai-responses";
import type { ChatCompletionResponse } from "../providers/base";

/* ---------- helpers ---------- */

function makeChatResponse(
  overrides: Partial<ChatCompletionResponse> = {}
): ChatCompletionResponse {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-5",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello!" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    ...overrides,
  };
}

/** Decode a Responses SSE byte stream into ordered {event, data} pairs. */
async function decodeResponsesSse(
  stream: ReadableStream<Uint8Array>
): Promise<{ event: string; data: any }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  // Proper async read loop — drain the whole stream before parsing.
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode(); // flush

  const events: { event: string; data: any }[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (event) events.push({ event, data: data ? JSON.parse(data) : null });
  }
  return events;
}

/** Encode chat.completion.chunk objects as an SSE byte stream (input to the converter). */
function chatChunksToStream(chunks: any[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const body = chunks
    .map((c) => `data: ${JSON.stringify(c)}\n\n`)
    .join("") + "data: [DONE]\n\n";
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

/* ---------- responsesRequestToChat ---------- */

describe("responsesRequestToChat", () => {
  test("string input → single user message", () => {
    const req: ResponsesApiRequest = { model: "gpt-5", input: "Hello!" };
    const chat = responsesRequestToChat(req);
    expect(chat.model).toBe("gpt-5");
    expect(chat.messages).toEqual([{ role: "user", content: "Hello!" }]);
  });

  test("instructions → leading system message", () => {
    const chat = responsesRequestToChat({
      model: "gpt-5",
      instructions: "Be brief.",
      input: "Hi",
    });
    expect(chat.messages[0]).toEqual({ role: "system", content: "Be brief." });
    expect(chat.messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  test("system message item → system message; developer → system", () => {
    const chat = responsesRequestToChat({
      model: "gpt-5",
      input: [
        { role: "system", content: "sys" },
        { role: "developer", content: "dev" },
        { role: "user", content: "u" },
      ],
    });
    expect(chat.messages.map((m) => m.role)).toEqual(["system", "system", "user"]);
    expect(chat.messages.map((m) => m.content)).toEqual(["sys", "dev", "u"]);
  });

  test("message content blocks (input_text / input_image) map to chat blocks", () => {
    const chat = responsesRequestToChat({
      model: "gpt-5",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "describe" },
            { type: "input_image", image_url: "https://x/y.png" },
          ],
        },
      ],
    });
    const content = chat.messages[0].content as any[];
    expect(content[0]).toEqual({ type: "text", text: "describe" });
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "https://x/y.png" } });
  });

  test("function_call + function_call_output round-trip into tool_calls + tool message", () => {
    const chat = responsesRequestToChat({
      model: "gpt-5",
      input: [
        { role: "user", content: "weather?" },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"q":"sf"}' },
        { type: "function_call_output", call_id: "call_1", output: "sunny" },
      ],
    });
    // user, assistant w/ tool_calls, tool
    expect(chat.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    const asst = chat.messages[1];
    expect(asst.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"q":"sf"}' } },
    ]);
    expect(chat.messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "sunny" });
  });

  test("assistant phase (commentary/final_answer) is preserved on assistant messages", () => {
    const chat = responsesRequestToChat({
      model: "gpt-5",
      input: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Let me check.", phase: "commentary" },
        { role: "assistant", content: "Done.", phase: "final_answer" },
      ],
    });
    expect((chat.messages[1] as any).phase).toBe("commentary");
    expect((chat.messages[2] as any).phase).toBe("final_answer");
    // phase is NOT set on user messages
    expect((chat.messages[0] as any).phase).toBeUndefined();
  });

  test("reasoning input item (replay) is NOT dropped — summary carried as reasoning_content", () => {
    const chat = responsesRequestToChat({
      model: "gpt-5",
      input: [
        { role: "user", content: "hi" },
        { type: "reasoning", id: "rs_abc", summary: [{ type: "summary_text", text: "thinking..." }] },
        { role: "assistant", content: "answer" },
      ],
    });
    // reasoning item must not be silently dropped. Its summary text is carried
    // onto the preceding assistant message as reasoning_content (or a new one).
    const hasReasoning = chat.messages.some(
      (m) => (m as any).reasoning_content === "thinking..."
    );
    expect(hasReasoning).toBe(true);
  });

  test("tools (flat/internally-tagged) → wrapped .function chat tools", () => {
    const chat = responsesRequestToChat({
      model: "gpt-5",
      input: "hi",
      tools: [
        { type: "function", name: "get_weather", description: "w", parameters: { type: "object" }, strict: true },
      ],
    });
    expect(chat.tools).toEqual([
      {
        type: "function",
        function: { name: "get_weather", description: "w", parameters: { type: "object" }, strict: true },
      },
    ]);
  });

  test("max_output_tokens → max_tokens; reasoning.effort → reasoning_effort + thinking", () => {
    const chat = responsesRequestToChat({
      model: "gpt-5",
      input: "hi",
      max_output_tokens: 123,
      reasoning: { effort: "high" },
    });
    expect(chat.max_tokens).toBe(123);
    expect(chat.reasoning_effort).toBe("high");
    expect(chat.thinking).toEqual({ type: "enabled", effort: "high" });
  });

  test("reasoning.effort none → disabled thinking (not enabled)", () => {
    const chat = responsesRequestToChat({
      model: "gpt-5",
      input: "hi",
      reasoning: { effort: "none" },
    });
    expect(chat.reasoning_effort).toBe("none");
    expect(chat.thinking).toEqual({ type: "disabled" });
  });

  test("reasoning.summary passes through to thinking.summary", () => {
    const chat = responsesRequestToChat({
      model: "gpt-5",
      input: "hi",
      reasoning: { effort: "medium", summary: "detailed" },
    });
    expect(chat.thinking).toEqual({ type: "enabled", effort: "medium", summary: "detailed" });
  });

  test("text.format json_schema → response_format json_schema", () => {
    const chat = responsesRequestToChat({
      model: "gpt-5",
      input: "hi",
      text: { type: "json_schema", name: "Out", schema: { type: "object" }, strict: true },
    } as any);
    expect((chat as any).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "Out", schema: { type: "object" }, strict: true },
    });
  });

  test("stream/temperature/top_p/tool_choice pass through", () => {
    const chat = responsesRequestToChat({
      model: "gpt-5",
      input: "hi",
      stream: true,
      temperature: 0.5,
      top_p: 0.9,
      tool_choice: "auto",
    });
    expect(chat.stream).toBe(true);
    expect(chat.temperature).toBe(0.5);
    expect(chat.top_p).toBe(0.9);
    expect(chat.tool_choice).toBe("auto");
  });
});

/* ---------- chatResponseToResponses ---------- */

describe("chatResponseToResponses", () => {
  test("text-only response → message output with output_text", () => {
    const r = chatResponseToResponses(makeChatResponse(), "gpt-5");
    expect(r.object).toBe("response");
    expect(r.status).toBe("completed");
    expect(r.output).toHaveLength(1);
    expect(r.output[0].type).toBe("message");
    const msg = r.output[0] as any;
    expect(msg.content).toEqual([{ type: "output_text", text: "Hello!", annotations: [] }]);
    expect(r.usage).toEqual({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 12,
    });
  });

  test("reasoning_content → reasoning output item BEFORE message (non-streaming)", () => {
    const r = chatResponseToResponses(
      makeChatResponse({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The answer is 42.",
              reasoning_content: "Let me think about this question carefully...",
            } as any,
            finish_reason: "stop",
          },
        ],
      }),
      "gpt-5"
    );
    // reasoning item precedes the message item (output order: reasoning -> message)
    expect(r.output).toHaveLength(2);
    expect(r.output[0].type).toBe("reasoning");
    const rs = r.output[0] as any;
    expect(rs.id.startsWith("rs_")).toBe(true);
    expect(rs.status).toBe("completed");
    expect(rs.summary).toEqual([
      { type: "summary_text", text: "Let me think about this question carefully..." },
    ]);
    expect(r.output[1].type).toBe("message");
  });

  test("tool_calls → function_call output items (and no empty message)", () => {
    const r = chatResponseToResponses(
      makeChatResponse({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"q":"sf"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      "gpt-5"
    );
    expect(r.output).toHaveLength(1);
    expect(r.output[0].type).toBe("function_call");
    const fc = r.output[0] as any;
    expect(fc.call_id).toBe("call_1");
    expect(fc.name).toBe("get_weather");
    expect(fc.arguments).toBe('{"q":"sf"}');
    expect(r.status).toBe("completed");
  });

  test("finish_reason length → status incomplete", () => {
    const r = chatResponseToResponses(
      makeChatResponse({
        choices: [{ index: 0, message: { role: "assistant", content: "..." }, finish_reason: "length" }],
      }),
      "gpt-5"
    );
    expect(r.status).toBe("incomplete");
  });

  test("usage reasoning/cached token details pass through when present", () => {
    const r = chatResponseToResponses(
      makeChatResponse({
        usage: {
          prompt_tokens: 5,
          completion_tokens: 3,
          total_tokens: 8,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 1 },
        } as any,
      }),
      "gpt-5"
    );
    expect(r.usage.input_tokens_details).toEqual({ cached_tokens: 2 });
    expect(r.usage.output_tokens_details).toEqual({ reasoning_tokens: 1 });
  });
});

/* ---------- chatStreamToResponsesStream ---------- */

describe("chatStreamToResponsesStream", () => {
  test("emits full response.* lifecycle for a text stream", async () => {
    const chunks = [
      { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] },
      { id: "c2", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { content: "lo!" }, finish_reason: null }] },
      { id: "c3", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
    ];
    const meta = newResponsesResponseMeta();
    const stream = chatStreamToResponsesStream(chatChunksToStream(chunks), "gpt-5", meta.id, meta.createdAt);
    const events = await decodeResponsesSse(stream);
    const names = events.map((e) => e.event);

    expect(names[0]).toBe("response.created");
    expect(names[1]).toBe("response.in_progress");
    expect(names).toContain("response.output_item.added");
    expect(names).toContain("response.content_part.added");
    expect(names.filter((n) => n === "response.output_text.delta")).toHaveLength(2);
    expect(names).toContain("response.output_text.done");
    expect(names).toContain("response.content_part.done");
    expect(names).toContain("response.output_item.done");
    expect(names[names.length - 1]).toBe("response.completed");

    const completed = events[events.length - 1].data;
    // Canonical shape: data.type == event name, data.response wraps the object.
    expect(completed.type).toBe("response.completed");
    expect(completed.response.status).toBe("completed");
    expect(completed.response.output[0].content[0].text).toBe("Hello!");
    expect(completed.response.usage.total_tokens).toBe(6);
    // Every event must carry a monotonic sequence_number (the OpenAI SDK parser
    // requires it; missing it causes "stream closed before response.completed").
    const seqs = events.map((e) => e.data.sequence_number);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i));
    // Every event's data.type matches its SSE event: field.
    for (const e of events) expect(e.data.type).toBe(e.event);
    // response.created wraps the response object too.
    expect(events[0].data.type).toBe("response.created");
    expect(events[0].data.response.id).toBe(meta.id);
  });

  test("emits function_call argument deltas + done for tool-call stream", async () => {
    const chunks = [
      { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"q":' } }] }, finish_reason: null }] },
      { id: "c2", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"sf"}' } }] }, finish_reason: null }] },
      { id: "c3", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
    ];
    const meta = newResponsesResponseMeta();
    const stream = chatStreamToResponsesStream(chatChunksToStream(chunks), "gpt-5", meta.id, meta.createdAt);
    const events = await decodeResponsesSse(stream);
    const names = events.map((e) => e.event);

    expect(names.filter((n) => n === "response.function_call_arguments.delta")).toHaveLength(2);
    expect(names).toContain("response.function_call_arguments.done");
    expect(names).toContain("response.output_item.done");
    const completed = events[events.length - 1].data;
    expect(completed.type).toBe("response.completed");
    expect(completed.response.status).toBe("completed");
    expect(completed.response.output[0].type).toBe("function_call");
    expect(completed.response.output[0].arguments).toBe('{"q":"sf"}');
  });

  test("handles [DONE] sentinel without error", async () => {
    const chunks = [
      { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] },
    ];
    const meta = newResponsesResponseMeta();
    const stream = chatStreamToResponsesStream(chatChunksToStream(chunks), "gpt-5", meta.id, meta.createdAt);
    const events = await decodeResponsesSse(stream);
    expect(events[events.length - 1].event).toBe("response.completed");
    expect(events[events.length - 1].data.response.output[0].content[0].text).toBe("x");
  });

  test("source errors mid-stream → emits response.failed as terminal event and closes cleanly", async () => {
    // A stream that emits one delta then errors on the next read.
    const errorStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(
          "data: " + JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { content: "par" }, finish_reason: null }] }) + "\n\n"
        ));
        // Error on the next read.
        setTimeout(() => controller.error(new Error("upstream blew up")), 0);
      },
    });
    const meta = newResponsesResponseMeta();
    const stream = chatStreamToResponsesStream(errorStream, "gpt-5", meta.id, meta.createdAt);
    const events = await decodeResponsesSse(stream);
    const names = events.map((e) => e.event);

    // The delta we did get is surfaced.
    expect(names).toContain("response.output_text.delta");
    // Terminal event is response.failed (NOT response.completed), and it is last.
    expect(names[names.length - 1]).toBe("response.failed");
    expect(names).not.toContain("response.completed");
    const failed = events[events.length - 1].data;
    expect(failed.type).toBe("response.failed");
    expect(failed.response.status).toBe("failed");
    expect(failed.response.error.type).toBe("api_error");
    expect(failed.response.error.message).toContain("upstream blew up");
  });

  test("terminal event is always last — completed never followed by another event", async () => {
    const chunks = [
      { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] },
      { id: "c2", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    const meta = newResponsesResponseMeta();
    const stream = chatStreamToResponsesStream(chatChunksToStream(chunks), "gpt-5", meta.id, meta.createdAt);
    const events = await decodeResponsesSse(stream);
    const completedIdx = events.findIndex((e) => e.event === "response.completed");
    expect(completedIdx).toBe(events.length - 1);
  });

  test("reasoning (delta.reasoning_content) → reasoning item at output_index 0, before message", async () => {
    const chunks = [
      { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { reasoning_content: "Thinking" }, finish_reason: null }] },
      { id: "c2", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { content: "Answer" }, finish_reason: null }] },
      { id: "c3", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    const meta = newResponsesResponseMeta();
    const stream = chatStreamToResponsesStream(chatChunksToStream(chunks), "gpt-5", meta.id, meta.createdAt);
    const events = await decodeResponsesSse(stream);
    const names = events.map((e) => e.event);

    // Reasoning lifecycle present.
    expect(names).toContain("response.reasoning_summary_text.delta");
    expect(names).toContain("response.reasoning_summary_text.done");
    // Reasoning output item at index 0, message at index 1.
    const reasonAdded = events.find((e) => e.event === "response.output_item.added" && e.data.item.type === "reasoning")!;
    expect(reasonAdded.data.output_index).toBe(0);
    const msgAdded = events.find((e) => e.event === "response.output_item.added" && e.data.item.type === "message")!;
    expect(msgAdded.data.output_index).toBe(1);
    // Reasoning text accumulated in the .done event.
    const reasonDone = events.find((e) => e.event === "response.reasoning_summary_text.done")!;
    expect(reasonDone.data.text).toBe("Thinking");
    // Final completed output has reasoning first, then message.
    const completed = events[events.length - 1].data;
    expect(completed.response.output[0].type).toBe("reasoning");
    expect(completed.response.output[0].summary[0].text).toBe("Thinking");
    expect(completed.response.output[1].type).toBe("message");
    // Sequence still monotonic.
    const seqs = events.map((e) => e.data.sequence_number);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i));
  });

  test("tool calls get correct output_index after reasoning + message", async () => {
    const chunks = [
      { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { reasoning_content: "hmm" }, finish_reason: null }] },
      { id: "c2", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
      { id: "c3", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    const meta = newResponsesResponseMeta();
    const stream = chatStreamToResponsesStream(chatChunksToStream(chunks), "gpt-5", meta.id, meta.createdAt);
    const events = await decodeResponsesSse(stream);
    // reasoning=0, message=1, function_call=2 — and the delta/done for the
    // function call must all agree on output_index 2.
    const fcAdded = events.find((e) => e.event === "response.output_item.added" && e.data.item.type === "function_call")!;
    expect(fcAdded.data.output_index).toBe(2);
    const fcDelta = events.find((e) => e.event === "response.function_call_arguments.delta")!;
    expect(fcDelta.data.output_index).toBe(2);
    const fcDone = events.find((e) => e.event === "response.output_item.done" && e.data.item.type === "function_call")!;
    expect(fcDone.data.output_index).toBe(2);
  });
});
