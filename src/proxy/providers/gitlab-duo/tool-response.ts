/**
 * Tool response clamping — upstream 4 MiB ClientEvent ceiling.
 */
import { serializeClientEvent } from "./protocol";

/**
 * Wire-protocol size limits, mirrored 1:1 from upstream
 * `lib_workflow_executor/src/executors/node/clients/constants.ts` and
 * `…/utils/response_truncation.ts`.
 *
 * The server-side cap (`@gitlab-org/duo-workflow-service`) is private so we
 * use the values upstream's own client enforces: a 4 MiB hard ceiling on
 * the JSON-encoded ClientEvent, and a 1 KiB suffix-budget when truncating
 * a `plainTextResponse.response` that would otherwise overflow.
 *
 * "Stop-stop" symptom we observed was the workflow-service silently closing
 * the WS with code 1000 the instant it received an oversized actionResponse
 * frame — verified empirically with a `cat <large file>` tool result. Once
 * we clamp at the upstream-documented limit the close stops.
 */
export const MAX_TOOL_RESPONSE_BYTES = 4 * 1024 * 1024; // 4 MiB
export const TOOL_RESPONSE_TRUNCATE_BUDGET = 1024;       // bytes kept on truncate
export const TOOL_RESPONSE_TRUNCATE_SUFFIX = "\n[Large response truncated...]";

/**
 * Sanitize a tool result string for safe JSON-over-WS transmission.
 *
 * - Strips ASCII control characters except TAB / LF / CR. `cat` on a binary,
 *   `find` traversing a node_modules with junk paths, or `grep --color=always`
 *   leaking ANSI escapes can all inject control chars that the workflow
 *   service silently drops the connection on.
 * - Forces valid UTF-8 by encoding then decoding via TextEncoder/Decoder
 *   with a replacement char — a surrogate-half left from a partial read of
 *   a UTF-8 file is enough for the upstream JSON parser to reject the frame.
 *
 * The sanitization is conservative: textual output is preserved verbatim
 * (LF, CR, TAB), only the bytes that have no business being in a string
 * are scrubbed.
 */
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });
const TEXT_ENCODER = new TextEncoder();

export function sanitizeToolResponse(s: string): string {
  if (!s) return s;
  // Round-trip through UTF-8 to drop unpaired surrogates / invalid sequences.
  const round = TEXT_DECODER.decode(TEXT_ENCODER.encode(s));
  // eslint-disable-next-line no-control-regex
  return round.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * Truncate a tool response string so its JSON-encoded UTF-8 length fits in
 * `MAX_TOOL_RESPONSE_BYTES`. Mirrors upstream lib_workflow_api's
 * `truncate_response` strategy: when over-budget, keep only the leading
 * `TOOL_RESPONSE_TRUNCATE_BUDGET` bytes plus a fixed suffix so the model
 * can tell it was clipped.
 */
export function truncateToolResponse(s: string): { text: string; truncated: boolean; originalBytes: number } {
  const bytes = TEXT_ENCODER.encode(s);
  if (bytes.length <= MAX_TOOL_RESPONSE_BYTES) {
    return { text: s, truncated: false, originalBytes: bytes.length };
  }
  // Keep the first `TOOL_RESPONSE_TRUNCATE_BUDGET` bytes — the head usually
  // contains the most diagnostic value (file headers, error preludes, etc).
  const head = TEXT_DECODER.decode(bytes.subarray(0, TOOL_RESPONSE_TRUNCATE_BUDGET));
  return { text: head + TOOL_RESPONSE_TRUNCATE_SUFFIX, truncated: true, originalBytes: bytes.length };
}

/**
 * Send a single actionResponse frame on the workflow WS.
 *
 * - Sanitizes control chars / invalid UTF-8 (would otherwise be silently
 *   dropped by the workflow service).
 * - Truncates to fit `MAX_TOOL_RESPONSE_BYTES` (oversized frames cause
 *   close 1000 with no error message).
 * - Routes the text into `error` instead of `response` when the tool
 *   reported failure (`is_error: true` in Anthropic, "Error:" prefix in
 *   OpenAI). Upstream agents key off the `error` field to decide whether
 *   to retry vs proceed; misrouting a failure into `response` is a known
 *   way to confuse the planner.
 *
 * Logs once per truncation so we have visibility when a real-world tool
 * call would have been clipped.
 */
export function sendActionResponse(
  ws: WebSocket,
  requestID: string,
  text: string,
  isError: boolean,
): void {
  const sanitized = sanitizeToolResponse(text);
  const { text: clamped, truncated, originalBytes } = truncateToolResponse(sanitized);
  if (truncated) {
    // eslint-disable-next-line no-console
    console.warn(
      `[gitlab-duo] tool response truncated requestID=${requestID} ` +
        `bytes=${originalBytes} → ${TOOL_RESPONSE_TRUNCATE_BUDGET}`,
    );
  }
  const plainTextResponse = isError
    ? { response: "", error: clamped || "Tool execution failed without output." }
    : { response: clamped, error: "" };
  ws.send(serializeClientEvent({
    actionResponse: { requestID, plainTextResponse },
  }));
}
