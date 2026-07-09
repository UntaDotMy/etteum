/**
 * DCP — Context Deduplication.
 *
 * Walks the message list looking for repeated read-only tool calls
 * (Read, Glob, Grep, LS, WebFetch by default). When the same
 * (tool_name, normalized_input) hash appears twice with success, the EARLIER
 * tool_result block is replaced with a stub:
 *   `[deduplicated: see message #N for identical Read(/path/foo.ts)]`
 *
 * This is lossless from the model's perspective: the most recent result is
 * the freshest and is preserved, and the earlier reference still tells the
 * model the call happened.
 *
 * Side-effecting tools (Bash, Edit, Write, etc.) are NEVER deduped because
 * their outputs aren't replayable.
 */

import type { ChatCompletionRequest, ChatMessage } from "../providers/base";
import type { DCPConfig } from "./types";
import { safeJsonParse } from "../../utils/safe-json";

interface ToolUseRef {
  /** Index of the message that contains the tool_use. */
  msgIdx: number;
  /** Block index inside that message's content array (or -1 for OpenAI tool_calls). */
  blockIdx: number;
  /** Index into msg.tool_calls for OpenAI format (or -1 for Anthropic blocks). */
  toolCallIdx: number;
  toolUseId: string;
  toolName: string;
  /** Stable hash of (toolName, normalized input). */
  hashKey: string;
}

interface ToolResultRef {
  msgIdx: number;
  blockIdx: number;
  toolUseId: string;
  /** Whether this result is_error=true (we never dedup errors — model needs to see the failure). */
  isError: boolean;
  /** True if the result is an OpenAI role:"tool" message (string content) vs an Anthropic block. */
  isToolMessage: boolean;
}

function stableStringify(v: any): string {
  if (v == null) return String(v);
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

function hashKey(toolName: string, input: any): string {
  return toolName + "::" + stableStringify(input || {});
}

function collectToolUses(messages: ChatMessage[]): ToolUseRef[] {
  const out: ToolUseRef[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    // OpenAI format: assistant.tool_calls[]
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (let j = 0; j < msg.tool_calls.length; j++) {
        const tc = msg.tool_calls[j];
        if (tc?.id && tc?.function?.name) {
          const input = typeof tc.function.arguments === "string"
            ? (safeJsonParse(tc.function.arguments, {}) ?? {})
            : tc.function.arguments ?? {};
          out.push({
            msgIdx: i,
            blockIdx: -1,
            toolCallIdx: j,
            toolUseId: tc.id,
            toolName: tc.function.name,
            hashKey: hashKey(tc.function.name, input),
          });
        }
      }
    }

    // Anthropic format: tool_use blocks inside content array
    if (!Array.isArray(msg.content)) continue;
    const content = msg.content as any[];
    for (let j = 0; j < content.length; j++) {
      const b = content[j];
      if (b?.type === "tool_use" && b.id && b.name) {
        out.push({
          msgIdx: i,
          blockIdx: j,
          toolCallIdx: -1,
          toolUseId: b.id,
          toolName: b.name,
          hashKey: hashKey(b.name, b.input),
        });
      }
    }
  }
  return out;
}

function collectToolResults(messages: ChatMessage[]): Map<string, ToolResultRef> {
  // toolUseId -> ref (assumes one result per id, which is true for Anthropic + OpenAI)
  const out = new Map<string, ToolResultRef>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    // OpenAI format: role:"tool" messages with tool_call_id
    if (msg.role === "tool" && (msg as any).tool_call_id && typeof msg.content === "string") {
      out.set((msg as any).tool_call_id, {
        msgIdx: i,
        blockIdx: -1,
        toolUseId: (msg as any).tool_call_id,
        isError: false, // OpenAI tool messages don't carry an is_error flag
        isToolMessage: true,
      });
      continue;
    }

    // Anthropic format: tool_result blocks inside content array
    if (!Array.isArray(msg.content)) continue;
    const content = msg.content as any[];
    for (let j = 0; j < content.length; j++) {
      const b = content[j];
      if (b?.type === "tool_result" && b.tool_use_id) {
        out.set(b.tool_use_id, {
          msgIdx: i,
          blockIdx: j,
          toolUseId: b.tool_use_id,
          isError: Boolean(b.is_error),
          isToolMessage: false,
        });
      }
    }
  }
  return out;
}

function blockTextSize(block: any): number {
  if (typeof block?.content === "string") return block.content.length;
  if (Array.isArray(block?.content)) {
    let n = 0;
    for (const inner of block.content) {
      if (inner?.type === "text" && typeof inner.text === "string") n += inner.text.length;
    }
    return n;
  }
  return 0;
}

function makeStub(toolName: string, input: any, refMsgIdx: number): string {
  const inputPreview = stableStringify(input || {});
  const compactInput = inputPreview.length > 80 ? inputPreview.slice(0, 77) + "…" : inputPreview;
  // Use 1-based message numbering for human readability.
  return `[deduplicated: identical ${toolName}(${compactInput}) — see message #${refMsgIdx + 1}]`;
}

export function applyDCP(
  request: ChatCompletionRequest,
  cfg: DCPConfig
): { request: ChatCompletionRequest; saved: number } {
  if (!cfg.enabled) return { request, saved: 0 };
  if (!Array.isArray(request.messages) || request.messages.length < 4) {
    // Need at least 2 user+assistant pairs to dedup.
    return { request, saved: 0 };
  }
  const whitelistSet = new Set(cfg.whitelist);
  if (whitelistSet.size === 0) return { request, saved: 0 };

  const uses = collectToolUses(request.messages).filter((u) => whitelistSet.has(u.toolName));
  if (uses.length < 2) return { request, saved: 0 };

  const results = collectToolResults(request.messages);

  // Group by hashKey, find duplicates: every-but-last gets stubbed.
  const byKey = new Map<string, ToolUseRef[]>();
  for (const u of uses) {
    const arr = byKey.get(u.hashKey) ?? [];
    arr.push(u);
    byKey.set(u.hashKey, arr);
  }

  // Build a "to-stub" index: msgIdx -> blockIdx -> stub-string
  type StubPlan = { stub: string; charsBefore: number };
  const stubs: Map<number, Map<number, StubPlan>> = new Map();

  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    // Sort by message order; keep last result intact, stub all earlier ones.
    group.sort((a, b) => a.msgIdx - b.msgIdx);
    const keeper = group[group.length - 1]!;
    for (let k = 0; k < group.length - 1; k++) {
      const earlier = group[k]!;
      const result = results.get(earlier.toolUseId);
      if (!result) continue;
      if (result.isError) continue; // never dedup errors

      // Need to look up original block to compute savings.
      if (result.isToolMessage) {
        // OpenAI format: role:"tool" message with string content
        const msg = request.messages[result.msgIdx];
        if (!msg || typeof msg.content !== "string") continue;
        const charsBefore = msg.content.length;
        if (charsBefore < 200) continue;
        const stubText = makeStub(earlier.toolName, getToolInput(request.messages, earlier), keeper.msgIdx);
        let blockMap = stubs.get(result.msgIdx);
        if (!blockMap) {
          blockMap = new Map();
          stubs.set(result.msgIdx, blockMap);
        }
        blockMap.set(-1, { stub: stubText, charsBefore });
        continue;
      }

      // Anthropic format: tool_result block inside content array
      const msg = request.messages[result.msgIdx];
      if (!msg || !Array.isArray(msg.content)) continue;
      const content = msg.content as any[];
      const block = content[result.blockIdx];
      if (!block || block.type !== "tool_result") continue;

      const charsBefore = blockTextSize(block);
      // Skip stubbing tiny blocks — savings are negative once you include the stub text.
      if (charsBefore < 200) continue;

      // Get tool input from the matching tool_use to make a useful stub.
      const stubText = makeStub(earlier.toolName, getToolInput(request.messages, earlier), keeper.msgIdx);
      let blockMap = stubs.get(result.msgIdx);
      if (!blockMap) {
        blockMap = new Map();
        stubs.set(result.msgIdx, blockMap);
      }
      blockMap.set(result.blockIdx, { stub: stubText, charsBefore });
    }
  }

  if (stubs.size === 0) return { request, saved: 0 };

  let savedChars = 0;
  const newMessages = request.messages.map((msg, i) => {
    const blockMap = stubs.get(i);
    if (!blockMap) return msg;

    // OpenAI format: role:"tool" message — replace string content with stub.
    if (msg.role === "tool" && typeof msg.content === "string") {
      const plan = blockMap.get(-1);
      if (!plan) return msg;
      savedChars += Math.max(0, plan.charsBefore - plan.stub.length);
      return { ...msg, content: plan.stub };
    }

    if (!Array.isArray(msg.content)) return msg;
    const newContent = (msg.content as any[]).map((b, j) => {
      const plan = blockMap.get(j);
      if (!plan) return b;
      savedChars += Math.max(0, plan.charsBefore - plan.stub.length);
      return { ...b, content: plan.stub };
    });
    return { ...msg, content: newContent };
  });

  return {
    request: { ...request, messages: newMessages },
    saved: savedChars,
  };
}

function getToolInput(messages: ChatMessage[], use: ToolUseRef): any {
  const msg = messages[use.msgIdx];
  if (!msg) return {};

  // OpenAI format: tool_calls[]
  if (use.toolCallIdx >= 0 && Array.isArray(msg.tool_calls)) {
    const tc = msg.tool_calls[use.toolCallIdx];
    if (!tc) return {};
    try {
      return typeof tc.function?.arguments === "string"
    ? (safeJsonParse(tc.function.arguments, {}) ?? {})
    : tc.function?.arguments ?? {};
    } catch {
      return {};
    }
  }

  // Anthropic format: content block
  if (!Array.isArray(msg.content)) return {};
  const block = (msg.content as any[])[use.blockIdx];
  return block?.input ?? {};
}
