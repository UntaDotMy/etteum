/**
 * AWS event-stream codec + Kiro/CodeWhisperer event extraction.
 *
 * Extracted verbatim from kiro.ts (No.2 modularization) — pure functions, no
 * provider state. The only class-bound input that remains is the model's
 * context window, which extractKiroContextTokens() now takes as a parameter
 * (callers pass getModelInfo(model)?.context_window).
 */

export interface KiroEvent {
  headers: Record<string, string>;
  payload: any;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function concatBytes(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export function decodeAwsEventStream(bytes: Uint8Array): KiroEvent[] {
  const events: KiroEvent[] = [];
  let offset = 0;
  const decoder = new TextDecoder();

  const readU32 = (pos: number) =>
    ((bytes[pos]! << 24) | (bytes[pos + 1]! << 16) | (bytes[pos + 2]! << 8) | bytes[pos + 3]!) >>> 0;
  const readU16 = (pos: number) => (bytes[pos]! << 8) | bytes[pos + 1]!;

  while (offset + 16 <= bytes.length) {
    const totalLen = readU32(offset);
    const headersLen = readU32(offset + 4);
    if (totalLen <= 16 || offset + totalLen > bytes.length) break;

    // Validate prelude CRC. Some runtimes prepend bytes before the first event;
    // if this offset is not a valid event, shift forward until one is found.
    const expectedPreludeCrc = readU32(offset + 8);
    const actualPreludeCrc = crc32(bytes.slice(offset, offset + 8));
    if (expectedPreludeCrc !== actualPreludeCrc) {
      offset++;
      continue;
    }

    const headers: Record<string, string> = {};
    let h = offset + 12;
    const headersEnd = h + headersLen;
    while (h < headersEnd) {
      const nameLen = bytes[h++]!;
      const name = decoder.decode(bytes.slice(h, h + nameLen));
      h += nameLen;
      const type = bytes[h++]!;
      if (type === 7) {
        const valueLen = readU16(h);
        h += 2;
        headers[name] = decoder.decode(bytes.slice(h, h + valueLen));
        h += valueLen;
      } else {
        break;
      }
    }

    const payloadStart = offset + 12 + headersLen;
    const payloadEnd = offset + totalLen - 4;
    const payloadText = decoder.decode(bytes.slice(payloadStart, payloadEnd));
    let payload: any = payloadText;
    try { payload = JSON.parse(payloadText); } catch { /* keep text */ }
    events.push({ headers, payload });
    offset += totalLen;
  }

  return events;
}

export function readEventStreamFrames(bytes: Uint8Array<ArrayBufferLike>): { events: KiroEvent[]; remaining: Uint8Array<ArrayBufferLike> } {
  let offset = 0;
  const events: KiroEvent[] = [];
  const readU32 = (pos: number) => ((bytes[pos]! << 24) | (bytes[pos + 1]! << 16) | (bytes[pos + 2]! << 8) | bytes[pos + 3]!) >>> 0;
  while (offset + 16 <= bytes.length) {
    const totalLen = readU32(offset);
    if (totalLen <= 16) { offset += 1; continue; }
    if (offset + totalLen > bytes.length) break;
    const frame = bytes.slice(offset, offset + totalLen);
    const decoded = decodeAwsEventStream(frame);
    events.push(...decoded);
    offset += totalLen;
  }
  return { events, remaining: new Uint8Array(bytes.slice(offset)) };
}

export function extractEventText(payload: any, eventType?: string): string {
  if (!payload || typeof payload !== "object") return "";
  if (eventType && /reason|thinking/i.test(eventType)) return "";
  if (eventType && !/assistant|response|text|content/i.test(eventType)) return "";
  return typeof payload.content === "string" ? payload.content : typeof payload.text === "string" ? payload.text : typeof payload.delta === "string" ? payload.delta : "";
}

export function extractReasoningText(payload: any, eventType?: string): string {
  if (!payload || typeof payload !== "object") return "";
  if (!eventType || !/reason|thinking/i.test(eventType)) return "";
  return typeof payload.text === "string" ? payload.text : typeof payload.content === "string" ? payload.content : typeof payload.delta === "string" ? payload.delta : "";
}

export function isCompleteJson(value: string): boolean {
  try { JSON.parse(value); return true; } catch { return false; }
}

export function completeJsonSuffix(value: string): string {
  const openBraces = (value.match(/\{/g) || []).length - (value.match(/\}/g) || []).length;
  const openBrackets = (value.match(/\[/g) || []).length - (value.match(/\]/g) || []).length;
  const quoteCount = (value.match(/(?<!\\)"/g) || []).length;
  return `${quoteCount % 2 === 1 ? '"' : ""}${"]".repeat(Math.max(0, openBrackets))}${"}".repeat(Math.max(0, openBraces))}`;
}

export function unwrapKiroEvent(payload: any, eventType?: string): any {
  if (!payload || typeof payload !== "object") return payload;
  if (eventType && payload[eventType]) return payload[eventType];
  for (const key of ["assistantResponseEvent", "toolUseEvent", "messageMetadataEvent", "metadataEvent", "meteringEvent"]) {
    if (payload[key]) return payload[key];
  }
  return payload;
}

export function extractKiroText(events: Array<{ payload: any }>): string {
  const parts: string[] = [];
  const visit = (value: any) => {
    if (!value) return;
    if (typeof value === "string") return;
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value !== "object") return;

    for (const key of ["content", "text", "delta"]) {
      if (typeof value[key] === "string") parts.push(value[key]);
    }
    for (const key of Object.keys(value)) visit(value[key]);
  };
  for (const event of events) visit(event.payload);
  return [...new Set(parts)].join("");
}

export function extractKiroToolCalls(events: Array<{ headers: Record<string, string>; payload: any }>): any[] {
  const calls = new Map<string, { id: string; name: string; arguments: string }>();
  const objectInputs = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    const payload = unwrapKiroEvent(event.payload, event.headers[":event-type"]);
    const tool = payload?.toolUseEvent || payload;
    if (!tool || typeof tool !== "object") continue;
    const id = tool.toolUseId || tool.id;
    if (!id) continue;
    const name = tool.name;
    // First event must have a name; subsequent events for same ID can omit it
    if (!name && !calls.has(id)) continue;
    const existing = calls.get(id) || { id, name: name || "", arguments: "" };
    if (name && !existing.name) existing.name = name;
    if (typeof tool.input === "string") {
      existing.arguments += tool.input;
    } else if (tool.input && typeof tool.input === "object") {
      const prev = objectInputs.get(id) || {};
      objectInputs.set(id, { ...prev, ...tool.input });
    }
    calls.set(id, existing);
  }
  return [...calls.values()].map((call) => {
    const objInput = objectInputs.get(call.id);
    const args = objInput && Object.keys(objInput).length > 0
      ? JSON.stringify(objInput)
      : call.arguments || "{}";
    return {
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: args },
    };
  });
}

export function extractKiroCredits(events: Array<{ payload: any }>): number {
  let credits = 0;
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.usage === "number" && (value.unit === "credit" || value.unitPlural === "credits")) {
      credits += value.usage;
    }
    if (typeof value.creditsUsed === "number") credits += value.creditsUsed;
    for (const key of Object.keys(value)) visit(value[key]);
  };
  for (const event of events) visit(event.payload);
  return credits;
}

/**
 * Extract total token count from Kiro's contextUsageEvent.
 * Kiro sends `contextUsagePercentage` which represents the % of context window used.
 * We convert this to an approximate token count using the model's context_window size
 * (passed in by the caller via getModelInfo(model)?.context_window).
 */
export function extractKiroContextTokens(events: Array<{ payload: any }>, contextWindow: number): number {
  let contextPercentage = 0;
  for (const event of events) {
    const payload = event.payload;
    if (!payload || typeof payload !== "object") continue;
    // Direct field
    if (typeof payload.contextUsagePercentage === "number") {
      contextPercentage = Math.max(contextPercentage, payload.contextUsagePercentage);
    }
    // Nested in contextUsageEvent
    if (payload.contextUsageEvent && typeof payload.contextUsageEvent.contextUsagePercentage === "number") {
      contextPercentage = Math.max(contextPercentage, payload.contextUsageEvent.contextUsagePercentage);
    }
  }
  if (contextPercentage <= 0) return 0;
  return Math.round((contextPercentage / 100) * (contextWindow || 200000));
}
