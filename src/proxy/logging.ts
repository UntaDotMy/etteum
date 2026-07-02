import { config } from "../config";

export interface TruncatedLogBody {
  truncated: true;
  originalBytes: number;
  maxBytes: number;
  preview: string;
}

export interface UnserializableLogBody {
  unserializable: true;
  reason: string;
  preview: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Keys whose values carry raw prompt/response text. Redacted before storage so
// request_logs never persists (and can never replay) client prompts/conversation.
const REDACT_KEYS = new Set([
  "content", "text", "system", "arguments",
  "reasoning_content", "thinking", "input", "partial_json", "description",
]);

function redactLogBody(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(redactLogBody);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.has(key)) {
        if (typeof val === "string") {
          out[key] = `[redacted ${val.length} chars]`;
        } else if (val == null) {
          out[key] = val;
        } else {
          const len = JSON.stringify(val)?.length ?? 0;
          out[key] = `[redacted ${len} chars]`;
        }
      } else {
        out[key] = redactLogBody(val);
      }
    }
    return out;
  }
  return value;
}

export function prepareLogBody(value: unknown): unknown {
  const { logBodyEnabled, logBodyFull, logBodyRedact, logBodyMaxBytes } = config;
  if (!logBodyEnabled) return null;
  if (logBodyFull) return value;

  const redacted = logBodyRedact ? redactLogBody(value) : value;

  const maxBytes = Math.max(0, logBodyMaxBytes);
  const serialized = serializeForLog(redacted);
  const bytes = encoder.encode(serialized).byteLength;

  if (bytes <= maxBytes) return redacted;

  return {
    truncated: true,
    originalBytes: bytes,
    maxBytes,
    preview: truncateUtf8(serialized, maxBytes),
  } satisfies TruncatedLogBody;
}

function serializeForLog(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      unserializable: true,
      reason,
      preview: String(value),
    } satisfies UnserializableLogBody);
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  return decoder.decode(bytes.slice(0, maxBytes));
}
