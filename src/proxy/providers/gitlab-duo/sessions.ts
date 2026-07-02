/**
 * GitLab Duo — per-tool-call session map.
 *
 * Anthropic & OpenAI agentic protocols are stateless across HTTP turns:
 * the client re-sends full history every request. Duo's workflow, by
 * contrast, is stateful — once we send `startRequest` the WS must stay
 * open and we feed an `actionResponse` back when the workflow emits an
 * Action.
 *
 * Bridge: when our provider emits a tool_use to the client, we keep the
 * underlying WS alive and remember it under the synthetic `tool_use.id`
 * we issued. On the next HTTP turn the client echoes that id inside a
 * tool_result (Anthropic) or `role:"tool"` (OpenAI) message; we look the
 * WS up, send the matching `actionResponse`, and re-attach the new
 * request's iterator callbacks.
 *
 * TTL: 5 minutes idle. After that the WS is closed and the session
 * dropped. If the client comes back later we fall back to a fresh
 * workflow with the full history re-encoded into `goal` — that is the
 * normal create-workflow path.
 *
 * Singleton via `globalThis` so a hot module reload during dev doesn't
 * orphan in-flight sessions.
 */

import { config } from "../../../config";
import type { CheckpointStatus } from "./protocol";

export interface DeltaEvent {
  delta: string;
  cumulativeContent: string;
  status: CheckpointStatus | undefined;
  done: boolean;
  toolCall?: { id: string; name: string; argsJson: string };
}

export interface SessionCallbacks {
  enqueue: (ev: DeltaEvent) => void;
  finish: () => void;
  fail: (err: Error) => void;
}

export interface DuoSession {
  ws: WebSocket;
  workflowId: string;
  /** requestID of the action that produced the tool_use we registered under. */
  pendingRequestID: string;
  /** Mutable so a continuation iterator can swap them in without re-binding. */
  callbacks: SessionCallbacks;
  /** Idle eviction timer — refreshed on every callback swap. */
  evictTimer: ReturnType<typeof setTimeout>;
  /** All tool_use ids that point at this same WS — when we evict one we evict
   *  the rest unless the caller is reusing the WS for a resume. */
  toolUseIds: Set<string>;
  /**
   * Maps a tool_use id we issued to the upstream `requestID` that produced
   * it. Populated when the workflow emits parallel actions in a single
   * checkpoint (each gets its own requestID); the client then echoes back
   * results in the same batch and we replay them as a sequence of
   * `actionResponse` frames. Falls back to `pendingRequestID` for legacy
   * single-action turns where this map was never populated.
   */
  toolCallIdToRequestId?: Map<string, string>;
  /**
   * Number of `message_type === "agent"` entries that existed in
   * `ui_chat_log` at the END of the most recent turn. Kept for legacy
   * callers / debugging; the real cross-turn dedup mechanism is
   * `emittedAgentTexts` below.
   */
  agentMessageCount: number;
  /**
   * Set of FINAL agent message contents we've already streamed to the
   * client on this WS. Duo's `ui_chat_log` is *inconsistently* scoped:
   * sometimes it carries only the in-progress agent message (scratch),
   * sometimes it carries the full prior history including completed
   * agent messages from earlier turns. Counting positions doesn't work
   * because the log shrinks/grows unpredictably between checkpoints.
   *
   * Content-based dedup IS robust: a completed agent message has a fixed
   * final string. If we see that exact string come back in a later
   * checkpoint, it's history — skip it. New in-progress messages have
   * unique evolving content, so they always slip through.
   */
  emittedAgentTexts: Set<string>;
  /**
   * Current working directory for this session. Tracked to resolve relative
   * paths to absolute paths before forwarding tool calls to the client.
   * Updated when we detect `cd` commands in shell actions.
   */
  workingDirectory: string;
}

interface SessionStore {
  byToolUseId: Map<string, DuoSession>;
}

const KEY = "__poolprox3_gitlab_duo_sessions__";
/** Idle TTL for paused sessions (waiting for tool_result). Configurable via
 *  `POOLPROX_GITLAB_DUO_SESSION_IDLE_MS` — default 15 min. Refreshed on every
 *  upstream WS message via `touchSessionByWs` so a long-running task that
 *  keeps the WS chatty stays alive past the static TTL. */
const idleMs = (): number => config.gitlabDuoSessionIdleMs;

function getStore(): SessionStore {
  const g = globalThis as unknown as { [KEY]?: SessionStore };
  if (!g[KEY]) g[KEY] = { byToolUseId: new Map() };
  return g[KEY]!;
}

/** Look up the session for a tool_use id (returned to the client earlier). */
export function lookupSession(toolUseId: string): DuoSession | undefined {
  return getStore().byToolUseId.get(toolUseId);
}

/** Register a session under one or more tool_use ids. Multiple ids can point
 *  at the same WS when the workflow emits parallel actions; on resume the
 *  caller picks one and the rest are dropped. */
export function registerSession(
  toolUseIds: string[],
  ws: WebSocket,
  workflowId: string,
  pendingRequestID: string,
  callbacks: SessionCallbacks,
  toolCallIdToRequestId?: Map<string, string>,
  /** Total agent message count in `ui_chat_log` at end of the turn that
   *  produced this session's tool_use. Legacy / debug; new dedup goes
   *  via `emittedAgentTexts`. */
  agentMessageCount = 0,
  /** Optional: agent message contents streamed so far on this WS. When
   *  provided, replaces what's on the session (and merges with any prior
   *  contents). Used so the next continuation turn can skip already-
   *  streamed agent messages by content match. */
  emittedAgentTexts?: Set<string>,
): DuoSession {
  const store = getStore();
  // Preserve emittedAgentTexts from any prior session under the SAME WS —
  // we want cumulative tracking across all tool-use registrations.
  const carriedTexts = new Set<string>();
  for (const id of toolUseIds) {
    const prior = store.byToolUseId.get(id);
    if (prior) {
      clearTimeout(prior.evictTimer);
      for (const t of prior.emittedAgentTexts) carriedTexts.add(t);
    }
  }
  if (emittedAgentTexts) for (const t of emittedAgentTexts) carriedTexts.add(t);

  const ids = new Set(toolUseIds);
  const session: DuoSession = {
    ws,
    workflowId,
    pendingRequestID,
    callbacks,
    toolUseIds: ids,
    evictTimer: setTimeout(() => evictByWs(ws, "idle_ttl"), idleMs()),
    ...(toolCallIdToRequestId ? { toolCallIdToRequestId } : {}),
    agentMessageCount,
    emittedAgentTexts: carriedTexts,
    workingDirectory: process.cwd(),
  };
  for (const id of toolUseIds) store.byToolUseId.set(id, session);
  return session;
}

/** Refresh the idle timer when a continuation iterator attaches. */
export function refreshSession(session: DuoSession, callbacks: SessionCallbacks): void {
  clearTimeout(session.evictTimer);
  session.callbacks = callbacks;
  session.evictTimer = setTimeout(() => evictByWs(session.ws, "idle_ttl"), idleMs());
}

/** Reset idle TTL for every session pointing at `ws`. Called whenever the
 *  upstream WS emits a message (any kind) so long-running turns whose tool
 *  output is delayed at the client side, but which keep producing upstream
 *  checkpoints, never get evicted mid-flight. Cheap no-op if no session
 *  exists for `ws` (fresh, non-tool turns never register one). */
export function touchSessionByWs(ws: WebSocket): void {
  const store = getStore();
  const seen = new Set<DuoSession>();
  for (const session of store.byToolUseId.values()) {
    if (session.ws === ws && !seen.has(session)) {
      seen.add(session);
      clearTimeout(session.evictTimer);
      session.evictTimer = setTimeout(() => evictByWs(session.ws, "idle_ttl"), idleMs());
    }
  }
}

/** Evict and close a session. `keepWsOpen=true` is for caller-managed lifetimes. */
export function evictSession(toolUseId: string, reason: string, keepWsOpen = false): void {
  const store = getStore();
  const session = store.byToolUseId.get(toolUseId);
  if (!session) return;
  clearTimeout(session.evictTimer);

  // Drop every sibling tool_use id that points at the same WS.
  for (const sib of session.toolUseIds) store.byToolUseId.delete(sib);

  if (!keepWsOpen) {
    try {
      session.ws.close(1000, reason);
    } catch {/* ignore */}
  }
}

/** Drop every session whose WS is `ws`. Called from WS `close` / `error`. */
export function evictByWs(ws: WebSocket, reason: string): void {
  const store = getStore();
  const ids: string[] = [];
  for (const [id, session] of store.byToolUseId) {
    if (session.ws === ws) ids.push(id);
  }
  for (const id of ids) {
    const s = store.byToolUseId.get(id);
    if (s) clearTimeout(s.evictTimer);
    store.byToolUseId.delete(id);
  }
  if (ids.length) {
    try { ws.close(1000, reason); } catch {/* ignore */}
  }
}

/** Look up by checking whether ANY of the given ids resolves to a session. */
export function findSessionByAnyId(ids: string[]): { id: string; session: DuoSession } | null {
  const store = getStore();
  for (const id of ids) {
    const s = store.byToolUseId.get(id);
    if (s) return { id, session: s };
  }
  return null;
}

/** Test/diagnostic helper. */
export function _sessionCount(): number {
  return getStore().byToolUseId.size;
}
