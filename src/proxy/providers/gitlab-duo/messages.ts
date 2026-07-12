/**
 * WebSocket message parsing for Duo workflow turns.
 */
import type { ServerAction, ServerMessage, CheckpointStatus } from "./protocol";

// ─── Module-private helpers ──────────────────────────────────────────────────

export interface TurnResult {
  ws: WebSocket;
  workflowId: string;
  content: string;
  status: CheckpointStatus | undefined;
  toolCall?: { id: string; name: string; argsJson: string; requestID: string };
  /** Number of `agent` messages observed in `ui_chat_log` during THIS turn
   *  (= number of distinct LLM calls). Computed by `collectTurn` and used
   *  by toOneShotResult/toStreamResult to populate `creditsUsed`. */
  agentCalls: number;
  /** TOTAL agent message count in `ui_chat_log` at end of this turn.
   *  Legacy; cross-turn dedup uses `emittedAgentTexts` instead. */
  totalAgentCount: number;
  /** UNION of `priorEmittedTexts` and the agent contents this turn
   *  surfaced — i.e., the cumulative set of agent message contents
   *  streamed on this WS so far. Stored on the session so the next
   *  continuation turn can dedup history by content match. */
  emittedAgentTexts: Set<string>;
}

export function parseServerMessage(data: unknown): ServerMessage | null {
  let raw: string | null = null;
  if (typeof data === "string") raw = data;
  else if (data instanceof ArrayBuffer) raw = new TextDecoder().decode(new Uint8Array(data));
  else if (ArrayBuffer.isView(data)) raw = new TextDecoder().decode(data as Uint8Array);
  else if (data instanceof Blob) {
    // Bun's WebSocket gives strings by default; Blob path is for safety only.
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ServerMessage;
  } catch {
    return null;
  }
}

export const ACTION_KEYS = [
  "runCommand", "runShellCommand", "runReadFile", "runReadFiles",
  "runWriteFile", "runEditFile", "mkdir", "listDirectory", "findFiles",
  "grep", "runGrep", "scanDirectoryTree", "runGitCommand",
  "runReadOnlyGitCommand", "runHTTPRequest",
  // Web/file/MCP actions are defined in protocol.ts and bridgeable in
  // tools.ts — must appear here too so extractAction returns them rather
  // than null. Missing entries cause silent action drops, which cascade
  // into INPUT_REQUIRED-with-empty-content turn endings.
  "runWebSearch", "runFileSearch", "runMCPCall",
] as const;

export function extractAction(msg: ServerMessage): ServerAction | null {
  if (!msg || typeof msg !== "object") return null;
  if (!msg.requestID) return null;
  for (const key of ACTION_KEYS) {
    if (key in msg && msg[key] && typeof msg[key] === "object") {
      return { requestID: msg.requestID, [key]: msg[key] } as unknown as ServerAction;
    }
  }
  return null;
}
