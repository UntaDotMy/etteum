/**
 * Cursor Connect-RPC protobuf codec.
 *
 * 1:1 with the reference proxy open-sse/utils/cursorProtobuf.js. Encodes an
 * OpenAI-shaped chat request into Cursor's Connect-RPC protobuf wire format
 * (StreamUnifiedChatRequestWithTools) and decodes the streamed response frames
 * back into text + thinking + tool-call deltas.
 */
import crypto from "node:crypto";

const WIRE_TYPE = { VARINT: 0, FIXED64: 1, LEN: 2, FIXED32: 5 } as const;
const ROLE = { USER: 1, ASSISTANT: 2 } as const;
const UNIFIED_MODE = { CHAT: 1, AGENT: 2 } as const;
const THINKING_LEVEL = { UNSPECIFIED: 0, MEDIUM: 1, HIGH: 2 } as const;
const CLIENT_SIDE_TOOL_V2_MCP = 19;

const FIELD = {
  REQUEST: 1,
  MESSAGES: 1, UNKNOWN_2: 2, INSTRUCTION: 3, UNKNOWN_4: 4, MODEL: 5, WEB_TOOL: 8,
  UNKNOWN_13: 13, CURSOR_SETTING: 15, UNKNOWN_19: 19, CONVERSATION_ID: 23, METADATA: 26,
  IS_AGENTIC: 27, SUPPORTED_TOOLS: 29, MESSAGE_IDS: 30, MCP_TOOLS: 34, LARGE_CONTEXT: 35,
  UNKNOWN_38: 38, UNIFIED_MODE: 46, UNKNOWN_47: 47, SHOULD_DISABLE_TOOLS: 48,
  THINKING_LEVEL: 49, UNKNOWN_51: 51, UNKNOWN_53: 53, UNIFIED_MODE_NAME: 54,
  MSG_CONTENT: 1, MSG_ROLE: 2, MSG_ID: 13, MSG_TOOL_RESULTS: 18, MSG_IS_AGENTIC: 29,
  MSG_SERVER_BUBBLE_ID: 32, MSG_UNIFIED_MODE: 47, MSG_SUPPORTED_TOOLS: 51,
  TOOL_RESULT_CALL_ID: 1, TOOL_RESULT_NAME: 2, TOOL_RESULT_INDEX: 3, TOOL_RESULT_RAW_ARGS: 5,
  TOOL_RESULT_RESULT: 8, TOOL_RESULT_TOOL_CALL: 11, TOOL_RESULT_MODEL_CALL_ID: 12,
  CV2R_TOOL: 1, CV2R_MCP_RESULT: 28, CV2R_CALL_ID: 35, CV2R_MODEL_CALL_ID: 48, CV2R_TOOL_INDEX: 49,
  CV2C_TOOL: 1, CV2C_MCP_PARAMS: 27, CV2C_CALL_ID: 3, CV2C_NAME: 9, CV2C_RAW_ARGS: 10, CV2C_TOOL_INDEX: 49, CV2C_MODEL_CALL_ID: 48,
  INSTRUCTION_TEXT: 1,
  MODEL_NAME: 1, MODEL_EMPTY: 2,
  SETTING_PATH: 1, SETTING_UNKNOWN_3: 3, SETTING_UNKNOWN_6: 6, SETTING_UNKNOWN_8: 8, SETTING_UNKNOWN_9: 9,
  SETTING6_FIELD_1: 1, SETTING6_FIELD_2: 2,
  META_PLATFORM: 1, META_ARCH: 2, META_VERSION: 3, META_CWD: 4, META_TIMESTAMP: 5,
  MSGID_ID: 1, MSGID_SUMMARY: 2, MSGID_ROLE: 3,
  MCP_TOOL_NAME: 1, MCP_TOOL_DESC: 2, MCP_TOOL_PARAMS: 3, MCP_TOOL_SERVER: 4,
  TOOL_CALL: 1, RESPONSE: 2,
  TOOL_ID: 3, TOOL_NAME: 9, TOOL_RAW_ARGS: 10, TOOL_IS_LAST: 11, TOOL_IS_LAST_ALT: 15, TOOL_MCP_PARAMS: 27,
  MCP_TOOLS_LIST: 1, MCP_NESTED_NAME: 1, MCP_NESTED_PARAMS: 3,
  RESPONSE_TEXT: 1, THINKING: 25, THINKING_TEXT: 1,
  MCPR_SELECTED_TOOL: 1, MCPR_RESULT: 2,
} as const;

// ── Primitive encoding ────────────────────────────────────────────────────

export function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) { bytes.push((v & 0x7F) | 0x80); v >>>= 7; }
  bytes.push(v & 0x7F);
  return new Uint8Array(bytes);
}

export function encodeField(fieldNum: number, wireType: number, value: unknown): Uint8Array {
  const tag = (fieldNum << 3) | wireType;
  const tagBytes = encodeVarint(tag);
  if (wireType === WIRE_TYPE.VARINT) return concatArrays(tagBytes, encodeVarint(Number(value)));
  if (wireType === WIRE_TYPE.LEN) {
    let dataBytes: Uint8Array;
    if (typeof value === "string") dataBytes = new TextEncoder().encode(value);
    else if (value instanceof Uint8Array) dataBytes = value;
    else dataBytes = new Uint8Array(0);
    return concatArrays(tagBytes, encodeVarint(dataBytes.length), dataBytes);
  }
  return new Uint8Array(0);
}

function concatArrays(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// ── Tool name helpers ─────────────────────────────────────────────────────

function formatToolName(name: unknown): string {
  const base = typeof name === "string" && name.length > 0 ? name : "tool";
  if (base.startsWith("mcp__")) {
    const rest = base.slice("mcp__".length);
    const idx = rest.indexOf("__");
    if (idx >= 0) {
      const server = rest.slice(0, idx) || "custom";
      const toolName = rest.slice(idx + 2) || "tool";
      return `mcp_${server}_${toolName}`;
    }
    return `mcp_custom_${rest || "tool"}`;
  }
  if (base.startsWith("mcp_")) return base;
  return `mcp_custom_${base}`;
}

function parseToolName(formattedName: string): { serverName: string; selectedTool: string } {
  if (typeof formattedName !== "string" || !formattedName.startsWith("mcp_")) {
    return { serverName: "custom", selectedTool: formattedName || "tool" };
  }
  const tail = formattedName.slice("mcp_".length);
  const idx = tail.indexOf("_");
  if (idx < 0) return { serverName: "custom", selectedTool: tail || "tool" };
  return { serverName: tail.slice(0, idx) || "custom", selectedTool: tail.slice(idx + 1) || "tool" };
}

function parseToolId(id: string): { toolCallId: string; modelCallId: string | null } {
  const delim = "\nmc_";
  const idx = id.indexOf(delim);
  if (idx >= 0) return { toolCallId: id.slice(0, idx), modelCallId: id.slice(idx + delim.length) };
  return { toolCallId: id, modelCallId: null };
}

// ── Message + sub-message encoders ─────────────────────────────────────────

function encodeMcpResult(selectedTool: string, resultContent: string): Uint8Array {
  return concatArrays(
    encodeField(FIELD.MCPR_SELECTED_TOOL, WIRE_TYPE.LEN, selectedTool),
    encodeField(FIELD.MCPR_RESULT, WIRE_TYPE.LEN, resultContent),
  );
}

function encodeClientSideToolV2Result(toolCallId: string, modelCallId: string | null, selectedTool: string, resultContent: string, toolIndex = 1): Uint8Array {
  return concatArrays(
    encodeField(FIELD.CV2R_TOOL, WIRE_TYPE.VARINT, CLIENT_SIDE_TOOL_V2_MCP),
    encodeField(FIELD.CV2R_MCP_RESULT, WIRE_TYPE.LEN, encodeMcpResult(selectedTool, resultContent)),
    encodeField(FIELD.CV2R_CALL_ID, WIRE_TYPE.LEN, toolCallId),
    ...(modelCallId ? [encodeField(FIELD.CV2R_MODEL_CALL_ID, WIRE_TYPE.LEN, modelCallId)] : []),
    encodeField(FIELD.CV2R_TOOL_INDEX, WIRE_TYPE.VARINT, toolIndex > 0 ? toolIndex : 1),
  );
}

function encodeMcpParamsForCall(toolName: string, rawArgs: string, serverName: string): Uint8Array {
  const tool = concatArrays(
    encodeField(FIELD.MCP_TOOL_NAME, WIRE_TYPE.LEN, toolName),
    encodeField(FIELD.MCP_TOOL_PARAMS, WIRE_TYPE.LEN, rawArgs),
    encodeField(FIELD.MCP_TOOL_SERVER, WIRE_TYPE.LEN, serverName),
  );
  return encodeField(FIELD.MCP_TOOLS_LIST, WIRE_TYPE.LEN, tool);
}

function encodeClientSideToolV2Call(toolCallId: string, toolName: string, selectedTool: string, serverName: string, rawArgs: string, modelCallId: string | null, toolIndex = 1): Uint8Array {
  return concatArrays(
    encodeField(FIELD.CV2C_TOOL, WIRE_TYPE.VARINT, CLIENT_SIDE_TOOL_V2_MCP),
    encodeField(FIELD.CV2C_MCP_PARAMS, WIRE_TYPE.LEN, encodeMcpParamsForCall(selectedTool, rawArgs, serverName)),
    encodeField(FIELD.CV2C_CALL_ID, WIRE_TYPE.LEN, toolCallId),
    encodeField(FIELD.CV2C_NAME, WIRE_TYPE.LEN, toolName),
    encodeField(FIELD.CV2C_RAW_ARGS, WIRE_TYPE.LEN, rawArgs),
    encodeField(FIELD.CV2C_TOOL_INDEX, WIRE_TYPE.VARINT, toolIndex > 0 ? toolIndex : 1),
    ...(modelCallId ? [encodeField(FIELD.CV2C_MODEL_CALL_ID, WIRE_TYPE.LEN, modelCallId)] : []),
  );
}

interface ToolResult { tool_call_id?: string; tool_name?: string; name?: string; raw_args?: string; result_content?: string; result?: string; tool_index?: number; index?: number; }

function encodeToolResult(toolResult: ToolResult): Uint8Array {
  const originalName = toolResult.tool_name || toolResult.name || "";
  const toolName = formatToolName(originalName);
  const rawArgs = toolResult.raw_args || "{}";
  const resultContent = toolResult.result_content || toolResult.result || "";
  const { toolCallId, modelCallId } = parseToolId(toolResult.tool_call_id || "");
  const toolIndex = toolResult.tool_index || toolResult.index || 1;
  const { serverName, selectedTool } = parseToolName(toolName);
  return concatArrays(
    encodeField(FIELD.TOOL_RESULT_CALL_ID, WIRE_TYPE.LEN, toolCallId),
    encodeField(FIELD.TOOL_RESULT_NAME, WIRE_TYPE.LEN, toolName),
    encodeField(FIELD.TOOL_RESULT_INDEX, WIRE_TYPE.VARINT, toolIndex > 0 ? toolIndex : 1),
    ...(modelCallId ? [encodeField(FIELD.TOOL_RESULT_MODEL_CALL_ID, WIRE_TYPE.LEN, modelCallId)] : []),
    encodeField(FIELD.TOOL_RESULT_RAW_ARGS, WIRE_TYPE.LEN, rawArgs),
    encodeField(FIELD.TOOL_RESULT_RESULT, WIRE_TYPE.LEN, encodeClientSideToolV2Result(toolCallId, modelCallId, selectedTool, resultContent, toolIndex)),
    encodeField(FIELD.TOOL_RESULT_TOOL_CALL, WIRE_TYPE.LEN, encodeClientSideToolV2Call(toolCallId, toolName, selectedTool, serverName, rawArgs, modelCallId, toolIndex)),
  );
}

export function encodeMessage(content: string, role: number, messageId: string, _chatModeEnum: number | null = null, isLast = false, hasTools = false, toolResults: ToolResult[] = [], serverBubbleId: string | null = null): Uint8Array {
  const hasToolResults = toolResults.length > 0;
  return concatArrays(
    encodeField(FIELD.MSG_CONTENT, WIRE_TYPE.LEN, content),
    encodeField(FIELD.MSG_ROLE, WIRE_TYPE.VARINT, role),
    encodeField(FIELD.MSG_ID, WIRE_TYPE.LEN, messageId),
    ...(serverBubbleId ? [encodeField(FIELD.MSG_SERVER_BUBBLE_ID, WIRE_TYPE.LEN, serverBubbleId)] : []),
    ...(hasToolResults ? toolResults.map((tr) => encodeField(FIELD.MSG_TOOL_RESULTS, WIRE_TYPE.LEN, encodeToolResult(tr))) : []),
    encodeField(FIELD.MSG_IS_AGENTIC, WIRE_TYPE.VARINT, hasTools ? 1 : 0),
    encodeField(FIELD.MSG_UNIFIED_MODE, WIRE_TYPE.VARINT, hasTools ? UNIFIED_MODE.AGENT : UNIFIED_MODE.CHAT),
    ...(isLast && hasTools ? [encodeField(FIELD.MSG_SUPPORTED_TOOLS, WIRE_TYPE.LEN, encodeVarint(1))] : []),
  );
}

export function encodeInstruction(text: string): Uint8Array {
  return text ? encodeField(FIELD.INSTRUCTION_TEXT, WIRE_TYPE.LEN, text) : new Uint8Array(0);
}

export function encodeModel(modelName: string): Uint8Array {
  return concatArrays(
    encodeField(FIELD.MODEL_NAME, WIRE_TYPE.LEN, modelName),
    encodeField(FIELD.MODEL_EMPTY, WIRE_TYPE.LEN, new Uint8Array(0)),
  );
}

export function encodeCursorSetting(): Uint8Array {
  const unknown6 = concatArrays(
    encodeField(FIELD.SETTING6_FIELD_1, WIRE_TYPE.LEN, new Uint8Array(0)),
    encodeField(FIELD.SETTING6_FIELD_2, WIRE_TYPE.LEN, new Uint8Array(0)),
  );
  return concatArrays(
    encodeField(FIELD.SETTING_PATH, WIRE_TYPE.LEN, "cursor\\aisettings"),
    encodeField(FIELD.SETTING_UNKNOWN_3, WIRE_TYPE.LEN, new Uint8Array(0)),
    encodeField(FIELD.SETTING_UNKNOWN_6, WIRE_TYPE.LEN, unknown6),
    encodeField(FIELD.SETTING_UNKNOWN_8, WIRE_TYPE.VARINT, 1),
    encodeField(FIELD.SETTING_UNKNOWN_9, WIRE_TYPE.VARINT, 1),
  );
}

export function encodeMetadata(): Uint8Array {
  return concatArrays(
    encodeField(FIELD.META_PLATFORM, WIRE_TYPE.LEN, process.platform || "linux"),
    encodeField(FIELD.META_ARCH, WIRE_TYPE.LEN, process.arch || "x64"),
    encodeField(FIELD.META_VERSION, WIRE_TYPE.LEN, process.version || "v20.0.0"),
    encodeField(FIELD.META_CWD, WIRE_TYPE.LEN, process.cwd?.() || "/"),
    encodeField(FIELD.META_TIMESTAMP, WIRE_TYPE.LEN, new Date().toISOString()),
  );
}

export function encodeMessageId(messageId: string, role: number, summaryId: string | null = null): Uint8Array {
  return concatArrays(
    encodeField(FIELD.MSGID_ID, WIRE_TYPE.LEN, messageId),
    ...(summaryId ? [encodeField(FIELD.MSGID_SUMMARY, WIRE_TYPE.LEN, summaryId)] : []),
    encodeField(FIELD.MSGID_ROLE, WIRE_TYPE.VARINT, role),
  );
}

export function encodeMcpTool(tool: any): Uint8Array {
  const toolName = tool?.function?.name || tool?.name || "";
  const toolDesc = tool?.function?.description || tool?.description || "";
  const inputSchema = tool?.function?.parameters || tool?.input_schema || {};
  return concatArrays(
    ...(toolName ? [encodeField(FIELD.MCP_TOOL_NAME, WIRE_TYPE.LEN, toolName)] : []),
    ...(toolDesc ? [encodeField(FIELD.MCP_TOOL_DESC, WIRE_TYPE.LEN, toolDesc)] : []),
    ...(Object.keys(inputSchema).length > 0 ? [encodeField(FIELD.MCP_TOOL_PARAMS, WIRE_TYPE.LEN, JSON.stringify(inputSchema))] : []),
    encodeField(FIELD.MCP_TOOL_SERVER, WIRE_TYPE.LEN, "custom"),
  );
}

// ── Request building ──────────────────────────────────────────────────────

export function encodeRequest(messages: any[], modelName: string, tools: any[] = [], reasoningEffort: string | null = null, forceAgentMode = false): Uint8Array {
  const hasTools = tools?.length > 0;
  const isAgentic = hasTools || forceAgentMode;
  const formattedMessages: any[] = [];
  const messageIds: { messageId: string; role: number }[] = [];
  const normalizedMessages: any[] = [];

  // Split mixed assistant tool_calls + tool_results into separate messages.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] || {};
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    const hasToolResults = Array.isArray(msg.tool_results) && msg.tool_results.length > 0;
    if (msg.role === "assistant" && hasToolCalls && hasToolResults) {
      normalizedMessages.push({ ...msg, tool_results: [] });
      const nextMsg = messages[i + 1];
      const nextHasToolResults = nextMsg?.role === "assistant" && Array.isArray(nextMsg?.tool_results) && nextMsg.tool_results.length > 0;
      const currentIds = new Set(msg.tool_results.map((tr: any) => tr?.tool_call_id).filter((id: any) => typeof id === "string"));
      const nextIds = new Set((nextMsg?.tool_results || []).map((tr: any) => tr?.tool_call_id).filter((id: any) => typeof id === "string"));
      let sameIds = currentIds.size > 0 && currentIds.size === nextIds.size;
      if (sameIds) for (const id of currentIds) if (!nextIds.has(id)) { sameIds = false; break; }
      if (!(nextHasToolResults && sameIds)) {
        normalizedMessages.push({ role: "assistant", content: "", tool_results: msg.tool_results });
      }
      continue;
    }
    normalizedMessages.push(msg);
  }

  for (let i = 0; i < normalizedMessages.length; i++) {
    const msg = normalizedMessages[i] || {};
    const role = msg.role === "user" ? ROLE.USER : ROLE.ASSISTANT;
    const messageId = crypto.randomUUID();
    const isLast = i === normalizedMessages.length - 1;
    formattedMessages.push({ content: msg.content ?? "", role, messageId, isLast, hasTools, toolResults: msg.tool_results || [] });
    messageIds.push({ messageId, role });
  }

  let thinkingLevel: number = THINKING_LEVEL.UNSPECIFIED;
  if (reasoningEffort === "medium") thinkingLevel = THINKING_LEVEL.MEDIUM;
  else if (reasoningEffort === "high") thinkingLevel = THINKING_LEVEL.HIGH;

  return concatArrays(
    ...formattedMessages.map((fm) => encodeField(FIELD.MESSAGES, WIRE_TYPE.LEN, encodeMessage(fm.content, fm.role, fm.messageId, null, fm.isLast, fm.hasTools, fm.toolResults))),
    encodeField(FIELD.UNKNOWN_2, WIRE_TYPE.VARINT, 1),
    encodeField(FIELD.INSTRUCTION, WIRE_TYPE.LEN, encodeInstruction("")),
    encodeField(FIELD.UNKNOWN_4, WIRE_TYPE.VARINT, 1),
    encodeField(FIELD.MODEL, WIRE_TYPE.LEN, encodeModel(modelName)),
    encodeField(FIELD.WEB_TOOL, WIRE_TYPE.LEN, ""),
    encodeField(FIELD.UNKNOWN_13, WIRE_TYPE.VARINT, 1),
    encodeField(FIELD.CURSOR_SETTING, WIRE_TYPE.LEN, encodeCursorSetting()),
    encodeField(FIELD.UNKNOWN_19, WIRE_TYPE.VARINT, 1),
    encodeField(FIELD.CONVERSATION_ID, WIRE_TYPE.LEN, crypto.randomUUID()),
    encodeField(FIELD.METADATA, WIRE_TYPE.LEN, encodeMetadata()),
    encodeField(FIELD.IS_AGENTIC, WIRE_TYPE.VARINT, isAgentic ? 1 : 0),
    ...(isAgentic ? [encodeField(FIELD.SUPPORTED_TOOLS, WIRE_TYPE.LEN, encodeVarint(1))] : []),
    ...messageIds.map((mid) => encodeField(FIELD.MESSAGE_IDS, WIRE_TYPE.LEN, encodeMessageId(mid.messageId, mid.role))),
    ...(tools?.length > 0 ? tools.map((tool) => encodeField(FIELD.MCP_TOOLS, WIRE_TYPE.LEN, encodeMcpTool(tool))) : []),
    encodeField(FIELD.LARGE_CONTEXT, WIRE_TYPE.VARINT, 0),
    encodeField(FIELD.UNKNOWN_38, WIRE_TYPE.VARINT, 0),
    encodeField(FIELD.UNIFIED_MODE, WIRE_TYPE.VARINT, isAgentic ? UNIFIED_MODE.AGENT : UNIFIED_MODE.CHAT),
    encodeField(FIELD.UNKNOWN_47, WIRE_TYPE.LEN, ""),
    encodeField(FIELD.SHOULD_DISABLE_TOOLS, WIRE_TYPE.VARINT, isAgentic ? 0 : 1),
    encodeField(FIELD.THINKING_LEVEL, WIRE_TYPE.VARINT, thinkingLevel),
    encodeField(FIELD.UNKNOWN_51, WIRE_TYPE.VARINT, 0),
    encodeField(FIELD.UNKNOWN_53, WIRE_TYPE.VARINT, 1),
    encodeField(FIELD.UNIFIED_MODE_NAME, WIRE_TYPE.LEN, isAgentic ? "Agent" : "Ask"),
  );
}

export function buildChatRequest(messages: any[], modelName: string, tools: any[] = [], reasoningEffort: string | null = null, forceAgentMode = false): Uint8Array {
  return encodeField(FIELD.REQUEST, WIRE_TYPE.LEN, encodeRequest(messages, modelName, tools, reasoningEffort, forceAgentMode));
}

/** Wrap a protobuf payload in a Connect-RPC frame (5-byte header: flags + length). */
export function wrapConnectRPCFrame(payload: Uint8Array, compress = false): Uint8Array {
  let finalPayload = payload;
  let flags = 0x00;
  if (compress) {
    // gzip compression intentionally omitted here — Cursor doesn't accept
    // compressed requests, so callers pass compress=false.
    flags = 0x01;
  }
  const frame = new Uint8Array(5 + finalPayload.length);
  frame[0] = flags;
  frame[1] = (finalPayload.length >> 24) & 0xFF;
  frame[2] = (finalPayload.length >> 16) & 0xFF;
  frame[3] = (finalPayload.length >> 8) & 0xFF;
  frame[4] = finalPayload.length & 0xFF;
  frame.set(finalPayload, 5);
  return frame;
}

/** Build the full Cursor request body (framed protobuf). */
export function generateCursorBody(messages: any[], modelName: string, tools: any[] = [], reasoningEffort: string | null = null, forceAgentMode = false): Uint8Array {
  const protobuf = buildChatRequest(messages, modelName, tools, reasoningEffort, forceAgentMode);
  return wrapConnectRPCFrame(protobuf, false);
}

// ── Primitive decoding ────────────────────────────────────────────────────

export function decodeVarint(buffer: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buffer.length) {
    const b = buffer[pos]!;
    result |= (b & 0x7F) << shift;
    pos++;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [result >>> 0, pos];
}

type FieldMap = Map<number, Array<{ value: any; wireType: number }>>;

export function decodeField(buffer: Uint8Array, offset: number): [number | null, number | null, any, number] {
  if (offset >= buffer.length) return [null, null, null, offset];
  const [tag, pos1] = decodeVarint(buffer, offset);
  const fieldNum = tag >> 3;
  const wireType = tag & 0x07;
  let value: any;
  let pos = pos1;
  if (wireType === WIRE_TYPE.VARINT) {
    [value, pos] = decodeVarint(buffer, pos);
  } else if (wireType === WIRE_TYPE.LEN) {
    const [len, pos2] = decodeVarint(buffer, pos);
    value = buffer.slice(pos2, pos2 + len);
    pos = pos2 + len;
  } else if (wireType === WIRE_TYPE.FIXED64) {
    value = buffer.slice(pos, pos + 8); pos += 8;
  } else if (wireType === WIRE_TYPE.FIXED32) {
    value = buffer.slice(pos, pos + 4); pos += 4;
  } else {
    return [null, null, null, offset];
  }
  return [fieldNum, wireType, value, pos];
}

export function decodeMessage(buffer: Uint8Array): FieldMap {
  const fields: FieldMap = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const [fieldNum, wireType, value, newOffset] = decodeField(buffer, offset);
    if (fieldNum === null || wireType === null || newOffset <= offset) break;
    if (!fields.has(fieldNum)) fields.set(fieldNum, []);
    fields.get(fieldNum)!.push({ value, wireType });
    offset = newOffset;
  }
  return fields;
}

/** Parse a single Connect-RPC frame: returns flags + payload + new offset. */
export function parseConnectRPCFrame(buffer: Uint8Array, offset: number): { status: "done" | "ok"; flags?: number; payload?: Uint8Array; newOffset?: number } {
  if (offset + 5 > buffer.length) return { status: "done" };
  const flags = buffer[offset]!;
  const length = ((buffer[offset + 1]! << 24) | (buffer[offset + 2]! << 16) | (buffer[offset + 3]! << 8) | buffer[offset + 4]!) >>> 0;
  if (offset + 5 + length > buffer.length) return { status: "done" };
  const payload = buffer.slice(offset + 5, offset + 5 + length);
  return { status: "ok", flags, payload, newOffset: offset + 5 + length };
}

function bytesToStr(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

/** First value (bytes) for a field in a decoded message, or null. */
function firstValue(fields: FieldMap, fieldNum: number): Uint8Array | null {
  const arr = fields.get(fieldNum);
  return arr && arr.length > 0 ? arr[0]!.value : null;
}

/** Extract { text, thinking } from a StreamUnifiedChatResponse payload. */
export function extractTextAndThinking(responseData: Uint8Array): { text: string | null; thinking: string | null } {
  const nested = decodeMessage(responseData);
  let text: string | null = null;
  let thinking: string | null = null;
  const textBytes = firstValue(nested, FIELD.RESPONSE_TEXT);
  if (textBytes) text = bytesToStr(textBytes);
  const thinkingBytes = firstValue(nested, FIELD.THINKING);
  if (thinkingBytes) {
    try {
      const thinkingMsg = decodeMessage(thinkingBytes);
      const t = firstValue(thinkingMsg, FIELD.THINKING_TEXT);
      if (t) thinking = bytesToStr(t);
    } catch { /* malformed thinking field */ }
  }
  return { text, thinking };
}

export interface CursorResponseChunk {
  text: string | null;
  error: string | null;
  toolCall: { id: string; name: string; arguments: string } | null;
  thinking: string | null;
}

/** Extract text/thinking/tool-call from a StreamUnifiedChatResponseWithTools payload. */
export function extractTextFromResponse(payload: Uint8Array): CursorResponseChunk {
  try {
    const fields = decodeMessage(payload);
    // Field 1: ClientSideToolV2Call (tool call).
    const toolCallBytes = firstValue(fields, FIELD.TOOL_CALL);
    if (toolCallBytes) {
      const toolCall = decodeMessage(toolCallBytes);
      let toolCallId = "";
      let toolName = "";
      let rawArgs = "";
      const idBytes = firstValue(toolCall, FIELD.TOOL_ID);
      if (idBytes) toolCallId = bytesToStr(idBytes);
      const nameBytes = firstValue(toolCall, FIELD.TOOL_NAME);
      if (nameBytes) toolName = bytesToStr(nameBytes);
      const mcpBytes = firstValue(toolCall, FIELD.TOOL_MCP_PARAMS);
      if (mcpBytes) {
        try {
          const mcpParams = decodeMessage(mcpBytes);
          const toolsListBytes = firstValue(mcpParams, FIELD.MCP_TOOLS_LIST);
          if (toolsListBytes) {
            const tool = decodeMessage(toolsListBytes);
            const nestedName = firstValue(tool, FIELD.MCP_NESTED_NAME);
            if (nestedName) toolName = bytesToStr(nestedName);
            const nestedParams = firstValue(tool, FIELD.MCP_NESTED_PARAMS);
            if (nestedParams) rawArgs = bytesToStr(nestedParams);
          }
        } catch { /* malformed mcp params */ }
      }
      const rawArgsBytes = firstValue(toolCall, FIELD.TOOL_RAW_ARGS);
      if (!rawArgs && rawArgsBytes) rawArgs = bytesToStr(rawArgsBytes);
      if (toolCallId && toolName) {
        return { text: null, error: null, toolCall: { id: toolCallId, name: toolName, arguments: rawArgs }, thinking: null };
      }
    }
    // Field 2: StreamUnifiedChatResponse (text/thinking).
    const responseBytes = firstValue(fields, FIELD.RESPONSE);
    if (responseBytes) {
      const { text, thinking } = extractTextAndThinking(responseBytes);
      if (text || thinking) return { text, error: null, toolCall: null, thinking };
    }
    return { text: null, error: null, toolCall: null, thinking: null };
  } catch (err: any) {
    return { text: null, error: err?.message || String(err), toolCall: null, thinking: null };
  }
}
