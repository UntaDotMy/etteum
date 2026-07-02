/**
 * Kiro/CodeWhisperer request-builder helpers.
 *
 * Extracted verbatim from kiro.ts (No.2 modularization) — pure functions that
 * convert OpenAI/Anthropic-shaped messages into the CodeWhisperer `history` /
 * `toolSpecification` / tool-result shapes. No provider state.
 */
import type { ChatCompletionRequest } from "../base";

type Messages = ChatCompletionRequest["messages"];
type Content = Messages[number]["content"];

export function textFromContent(content: Content): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: any) => {
      if (block?.type === "text") return block.text || "";
      if (block?.type === "tool_result") return typeof block.content === "string" ? block.content : JSON.stringify(block.content || "");
      // Skip image blocks here — they are handled separately via contentBlocks
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Extract image blocks from OpenAI-format content array for Kiro API.
 *  Kiro expects: [{ format: "png", source: { bytes: "<base64>" } }]
 *  (flat list, no wrapping "image" key — matches native Kiro IDE format)
 */
export function extractImageBlocks(content: any): any[] {
  if (!Array.isArray(content)) return [];
  const images: any[] = [];
  for (const block of content) {
    if (block?.type === "image_url" && block.image_url?.url) {
      const url: string = block.image_url.url;
      // Handle base64 data URLs: data:image/png;base64,<data>
      const dataMatch = url.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
      if (dataMatch) {
        const format = dataMatch[1] === "jpg" ? "jpeg" : dataMatch[1];
        images.push({ format, source: { bytes: dataMatch[2] } });
      }
    }
    // Anthropic-style image block: { type: "image", source: { type: "base64", media_type, data } }
    if (block?.type === "image" && block.source?.data) {
      const format = (block.source.media_type || "image/png").replace("image/", "").replace("jpg", "jpeg");
      images.push({ format, source: { bytes: block.source.data } });
    }
  }
  return images;
}

/** Check if content array contains image blocks */
export function hasImages(content: any): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block: any) => block?.type === "image_url" || block?.type === "image");
}

export function mapTools(tools: any[] | undefined): any[] {
  return (tools || [])
    .map((tool) => {
      const fn = tool?.function || tool;
      const name = fn?.name || tool?.name || tool?.id;
      if (!name) return null;
      const schema = fn?.parameters || fn?.input_schema || fn?.schema || { type: "object", properties: {} };
      return {
        toolSpecification: {
          name: String(name).slice(0, 64),
          description: String(fn?.description || tool?.description || "").slice(0, 10000),
          inputSchema: { json: sanitizeJsonSchema(schema) },
        },
      };
    })
    .filter(Boolean);
}

export function sanitizeJsonSchema(schema: any): any {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { type: "object", properties: {} };
  const clone: any = { ...schema };
  for (const key of ["$schema", "$id", "$comment", "$defs", "definitions", "propertyNames"]) delete clone[key];
  if (!clone.type) clone.type = "object";
  if (clone.type === "object" && (!clone.properties || typeof clone.properties !== "object")) clone.properties = {};
  if (clone.required && !Array.isArray(clone.required)) delete clone.required;
  return clone;
}

export function extractToolResults(messages: Messages): any[] {
  const results: any[] = [];
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content as any[]) {
      if (block?.type !== "tool_result" || !block.tool_use_id) continue;
      results.push({
        toolUseId: block.tool_use_id,
        content: [{ text: typeof block.content === "string" ? block.content : JSON.stringify(block.content || "") }],
        status: block.is_error ? "error" : "success",
      });
    }
  }
  return results;
}

export function toolResultsFromContent(content: Content): any[] {
  if (!Array.isArray(content)) return [];
  return (content as any[])
    .filter((block) => block?.type === "tool_result" && block.tool_use_id)
    .map((block) => ({
      toolUseId: block.tool_use_id,
      content: [{ text: typeof block.content === "string" ? block.content : JSON.stringify(block.content || "") }],
      status: block.is_error ? "error" : "success",
    }));
}

export function toolUsesFromMessage(message: Messages[number]): any[] {
  const uses: any[] = [];
  if (Array.isArray(message.content)) {
    for (const block of message.content as any[]) {
      if (block?.type !== "tool_use" || !block.id || !block.name) continue;
      uses.push({ toolUseId: block.id, name: block.name, input: block.input || {} });
    }
  }
  for (const call of message.tool_calls || []) {
    let input = call?.function?.arguments || {};
    if (typeof input === "string") {
      try { input = JSON.parse(input); } catch { input = {}; }
    }
    if (call.id && call?.function?.name) uses.push({ toolUseId: call.id, name: call.function.name, input });
  }
  return uses;
}

/**
 * Normalize OpenAI-style `role:"tool"` messages into the Anthropic-style
 * `tool_result` content blocks the rest of the Kiro builder already handles.
 * Consecutive tool messages are merged into one synthesized user turn, mirroring
 * what the /v1/messages path produces. Without this, tool outputs are dropped and
 * the assistant's toolUses have no matching toolResults → Kiro 400 "Improperly formed request."
 */
export function normalizeMessages(messages: Messages): Messages {
  const out: Messages = [];
  let pending: any[] | null = null;

  const flush = () => {
    if (pending && pending.length > 0) out.push({ role: "user", content: pending });
    pending = null;
  };

  for (const message of messages) {
    if (message.role === "tool") {
      if (!pending) pending = [];
      pending.push({
        type: "tool_result",
        tool_use_id: (message as any).tool_call_id,
        content: typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content ?? ""),
        is_error: false,
      });
    } else {
      flush();
      out.push(message);
    }
  }
  flush();
  return mergeConsecutiveMessages(out);
}

/**
 * Kiro/CodeWhisperer requires the conversation to strictly alternate
 * user → assistant → user. Clients (and the Anthropic→OpenAI transform) can
 * emit consecutive same-role messages, which makes `history` end on a
 * userInputMessage right before the current user turn → Kiro 400
 * "Improperly formed request." Merge adjacent same-role messages so the
 * sequence always alternates.
 */
export function mergeConsecutiveMessages(messages: Messages): Messages {
  const out: Messages = [];
  for (const message of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === message.role && message.role !== "system") {
      out[out.length - 1] = mergeMessagePair(prev, message);
    } else {
      out.push({ ...message });
    }
  }
  return out;
}

export function mergeMessagePair(a: Messages[number], b: Messages[number]): Messages[number] {
  const toArray = (content: Content): any[] => {
    if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
    return Array.isArray(content) ? content : [];
  };

  const content = typeof a.content === "string" && typeof b.content === "string"
    ? [a.content, b.content].filter(Boolean).join("\n\n")
    : [...toArray(a.content), ...toArray(b.content)];

  const toolCalls = [...(a.tool_calls || []), ...(b.tool_calls || [])];

  return {
    role: a.role,
    content,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/**
 * Build Kiro `history` from the messages that PRECEDE the current turn.
 * Callers pass already-sliced prior messages (system messages stripped and
 * same-role runs merged upstream), so this maps them 1:1 without re-slicing.
 */
export function buildHistory(priorMessages: Messages, modelId: string): any[] {
  const history: any[] = [];
  for (const message of priorMessages) {
    if (message.role === "user") {
      const toolResults = toolResultsFromContent(message.content);
      history.push({
        userInputMessage: {
          content: textFromContent(message.content),
          modelId,
          origin: "AI_EDITOR",
          userInputMessageContext: toolResults.length > 0 ? { toolResults } : { tools: [] },
        },
      });
    } else if (message.role === "assistant") {
      const toolUses = toolUsesFromMessage(message);
      history.push({
        assistantResponseMessage: {
          content: textFromContent(message.content),
          ...(toolUses.length > 0 ? { toolUses } : {}),
        },
      });
    }
  }
  return history;
}
