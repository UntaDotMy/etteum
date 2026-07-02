/**
 * GitLab Duo workflow protocol — wire types & helpers.
 *
 * Verified against `@gitlab/duo-cli@8.104.0/dist/index.js` (decompiled). Line
 * references in comments point into that bundle.
 *
 * Wire format: JSON-encoded `ClientEvent` / server actions over WebSocket
 * `wss://<host>/api/v4/ai/duo_workflows/ws?…`.
 *
 * Auth header: `Private-Token: <pat>` (NOT `Authorization: Bearer …` —
 * that branch is OAuth-only; see bundle @7796913).
 */

// ─── Constants pulled from the bundle ────────────────────────────────────────

/** clientCapabilities @8239799 — the seven flags the official CLI advertises.
 *  We include ALL capabilities so the agent knows it has full access.
 *  Even if a capability isn't actually used, advertising it prevents the
 *  agent from self-limiting ("I don't have web search access" etc). */
export const CLIENT_CAPABILITIES: readonly string[] = [
  "shell_command",
  "read_file_chunked",
  "tool_call_approval",
  "tool_call_pattern_approval",
  "command_timeout",
  "web_search",
  "incremental_streaming",
  "file_modifications",
  "git_operations",
  "mcp_tools",
] as const;

/**
 * workflow_definition for the namespace-level agentic chat flow.
 *
 * GitLab exposes two flavours:
 *
 *   - `"software_development"` — full agentic flow. **Requires a project_id**;
 *     responds with "This feature is only available at the project level"
 *     when called with namespace-only context (verified empirically against
 *     gitlab.com on 2026-06-14).
 *
 *   - `"chat"` — namespace-level chat workflow. With
 *     `experiment_features_enabled=true` on the group AND
 *     `agent_privileges=[1..6]`, this flavour DOES emit typed Actions
 *     (`runCommand`, `listDirectory`, `runReadFile`, …) — so it behaves
 *     identically to the agentic flow from the proxy's perspective. We use
 *     this one because etteum is project-agnostic.
 */
export const WORKFLOW_DEFINITION_AGENTIC = "chat";

/** Agent privileges — see plans/gitlab-duo-tool-bridge.md.
 *  1 = read_write_files, 2 = read_only_gitlab, 3 = read_write_gitlab,
 *  4 = run_commands, 5 = run_mcp_tools, 6 = use_git.
 *  We include ALL privileges (1-6) so the agent knows it has full access.
 *  MCP (5) is included even though we don't register MCP servers — the
 *  agent will just see "no MCP tools available" but won't self-limit other
 *  capabilities. Omitting it makes the agent overly restrictive. */
export const AGENT_PRIVILEGES: readonly number[] = [1, 2, 3, 4, 5, 6] as const;

export const CLIENT_VERSION = "1.0";

// ─── Outgoing (client → server) ──────────────────────────────────────────────

export interface StartRequest {
  workflowID: string;
  clientVersion: string;          // CLIENT_VERSION
  workflowDefinition: string;     // WORKFLOW_DEFINITION_AGENTIC
  goal: string;
  workflowMetadata: string;       // JSON.stringify({ extended_logging: false, … })
  additional_context: AdditionalContextEntry[];
  clientCapabilities: readonly string[];   // CLIENT_CAPABILITIES
  mcpTools: unknown[];            // []
  preapproved_tools: string[];    // []
  flowConfig?: undefined;
  flowConfigSchemaVersion?: undefined;
  flowConfigId?: undefined;
  flowVersion?: undefined;
  approval?: undefined;
}

/** Continuation frame: feed a tool's output back to the workflow.
 *
 *  IMPORTANT: `plainTextResponse` is an OBJECT, not a string — verified
 *  against the CLI bundle (`od8` factory at @8235278):
 *    plainTextResponse: { response: <string>, error: <string> }
 *  Sending a bare string makes the workflow silently stall (server waits
 *  for a frame that never validates).
 *
 *  HTTP-shaped tool results would use `httpResponse: {headers,statusCode,body,error}`
 *  instead — we currently never need that branch because we forward HTTP
 *  actions back to the client as plain tool_use rounds. */
export interface ActionResponse {
  requestID: string;
  plainTextResponse?: { response: string; error: string };
  httpResponse?: {
    headers?: Record<string, string>;
    statusCode?: number;
    body?: string;
    error?: string;
  };
}

export interface StopWorkflow {
  reason: string;                 // "USER_ACTION_TRIGGERED_STOP"
}

/** Tool approval frame — verified against
 *  `lib_workflow_api/src/workflow_message_types.ts:ToolApproval`.
 *
 *  Three approval scopes:
 *    - approve_once             — this single invocation only
 *    - approve-for-session      — every future call w/ matching toolArgs
 *    - approve-pattern-for-session — glob pattern (e.g. "git checkout *")
 *  poolprox3 always uses `approve_once` because we are a stateless proxy. */
export type ToolApprovalType =
  | "approve_once"
  | "approve-for-session"
  | "approve-pattern-for-session";

export interface ToolApprovalApprovedOnce {
  userApproved: true;
  type: "approve_once";
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}
export interface ToolApprovalRejected {
  userApproved: false;
  message?: string;
}
export type ToolApproval = ToolApprovalApprovedOnce | ToolApprovalRejected;

export type ClientEvent =
  | { startRequest: StartRequest }
  | { actionResponse: ActionResponse }
  | { stopWorkflow: StopWorkflow }
  /** Sent when upstream emits PLAN_APPROVAL_REQUIRED or
   *  TOOL_CALL_APPROVAL_REQUIRED. The `requestID` field is required when
   *  approving a specific tool action; optional for plan-level approval. */
  | { approval: ToolApproval & { requestID?: string } };

// ─── additional_context entry shape (CLI @8784337) ───────────────────────────

export type Category =
  | "file"
  | "snippet"
  | "terminal"
  | "issue"
  | "merge_request"
  | "dependency"
  | "local_git"
  | "user_rule"
  | "repository"
  | "directory"
  | "agent_user_environment"
  | "os_information";

export interface AdditionalContextEntry {
  category: Category;
  id: string;
  content: string;
  /** Object — the bundle JSON-stringifies this just before sending (`#y` at
   *  @8248513). Our serializer in `index.ts` does the same so callers can pass
   *  a plain object here. */
  metadata: Record<string, unknown>;
}

// ─── Incoming (server → client) ──────────────────────────────────────────────

/**
 * Workflow status — verified against gitlab-lsp 8.104.0 source-of-truth at
 * `lib_workflow_api/src/workflow_message_types.ts:DuoWorkflowStatus`.
 *
 * Kept as a const-enum-style object literal (not `enum`) so it tree-shakes
 * cleanly under Bun and stays comparable as plain string. The exported
 * `CheckpointStatus` type union below is a structural alias used everywhere
 * the rest of the codebase used to import `CheckpointStatus` — no churn.
 */
export const DuoWorkflowStatus = {
  CREATED: "CREATED",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
  INPUT_REQUIRED: "INPUT_REQUIRED",
  /** Plan-mode workflow waiting for human approval before executing the plan.
   *  We auto-approve via the `approval` ClientEvent unless
   *  `POOLPROX_GITLAB_DUO_AUTO_APPROVE=false`. */
  PLAN_APPROVAL_REQUIRED: "PLAN_APPROVAL_REQUIRED",
  /** A specific tool call needs approval (e.g. `rm -rf` shell). Same auto-
   *  approve policy as PLAN_APPROVAL_REQUIRED. */
  TOOL_CALL_APPROVAL_REQUIRED: "TOOL_CALL_APPROVAL_REQUIRED",
  FINISHED: "FINISHED",
  FAILED: "FAILED",
  STOPPED: "STOPPED",
} as const;
export type DuoWorkflowStatus = typeof DuoWorkflowStatus[keyof typeof DuoWorkflowStatus];

/** Backwards-compat alias — was the original public type name in this
 *  module. New code should prefer `DuoWorkflowStatus`. */
export type CheckpointStatus = DuoWorkflowStatus;

/** Status helpers — mirror upstream `isTerminated` / `isAwaitingUserInput`
 *  from `lib_workflow_api/src/workflow_message_types.ts`. */
export const isTerminated = (s: DuoWorkflowStatus | undefined): boolean =>
  s === DuoWorkflowStatus.FINISHED ||
  s === DuoWorkflowStatus.FAILED ||
  s === DuoWorkflowStatus.STOPPED;

export const isAwaitingUserInput = (s: DuoWorkflowStatus | undefined): boolean =>
  s === DuoWorkflowStatus.INPUT_REQUIRED ||
  s === DuoWorkflowStatus.PLAN_APPROVAL_REQUIRED;

export const isAwaitingApproval = (s: DuoWorkflowStatus | undefined): boolean =>
  s === DuoWorkflowStatus.PLAN_APPROVAL_REQUIRED ||
  s === DuoWorkflowStatus.TOOL_CALL_APPROVAL_REQUIRED;

/**
 * Workflow status code — full enum from upstream. Used to deterministically
 * classify executor errors instead of regex-matching error messages.
 *
 * Source: `lib_workflow_api/src/workflow_message_types.ts:WorkflowStatusCode`.
 */
export const WorkflowStatusCode = {
  GENERAL_FAILURE: 1,
  FAILED_TO_START: 2,
  AUTH_TOKEN_ERROR: 3,
  CREATION_FAILED: 4,
  FAILED_TO_START_ALT: 5,
  SERVICE_CONNECTION_FAILED: 6,
  // Node-executor-specific codes (50+).
  AUTH_TOKEN_FETCH_ERROR: 50,
  INVALID_API_CONFIGURATION: 51,
  MISSING_CERTIFICATE_SETTINGS: 53,
  SERVICE_CONNECTION_DROPPED: 54,
  SERVICE_CONNECTION_CLOSED_MESSAGE_TOO_BIG: 55,
  SERVICE_CONNECTION_INTERNAL_ERROR: 56,
  SERVICE_CONNECTION_BAD_GATEWAY: 57,
  SERVICE_CONNECTION_TLS_HANDSHAKE: 58,
  SERVICE_CONNECTION_UNSUPPORTED_DATA_TYPE: 59,
  LOCKED_SOCKET: 60,
  USAGE_QUOTA_EXCEEDED: 62,
} as const;
export type WorkflowStatusCode = typeof WorkflowStatusCode[keyof typeof WorkflowStatusCode];

export interface NewCheckpointMessage {
  status: CheckpointStatus;
  checkpoint: string;             // serialized JSON LangGraph state
  goal?: string;
  errors?: string[];
}

/** ServerAction — every typed action the workflow can request from the client.
 *
 *  Field names are verified against the actual `outgoing action proto shapes`
 *  in `@gitlab/duo-cli@8.104.0/dist/index.js` — DON'T change them based on
 *  intuition or the public-but-stale `contract.proto`. The CLI's own MCP
 *  bridge (around line @9435159) reveals the wire-real names:
 *    - mkdir.directory_path        (NOT `directory` like the public proto says)
 *    - runReadFile.filepath        (NOT `filename`)
 *    - runWriteFile.filepath       (NOT `filename`)
 *    - runEditFile.filepath / oldString / newString
 *  We carry a `requestID` on each so the bridge can echo it on actionResponse. */
export type ServerAction =
  | { requestID: string; runCommand: { program: string; arguments?: string[]; flags?: string[] } }
  | { requestID: string; runShellCommand: { command: string } }
  | { requestID: string; runReadFile: { filepath: string; lineOffset?: number; byteOffset?: number; chunkSize?: number } }
  | { requestID: string; runReadFiles: { filepaths: string[] } }
  | { requestID: string; runWriteFile: { filepath: string; contents: string } }
  | { requestID: string; runEditFile: { filepath: string; oldString: string; newString: string } }
  | { requestID: string; mkdir: { directory_path: string } }
  | { requestID: string; listDirectory: { directory: string } }
  | { requestID: string; findFiles: { name_pattern: string; search_directory?: string } }
  | { requestID: string; grep: { pattern: string; search_directory?: string; case_insensitive?: boolean } }
  | { requestID: string; runGrep: { pattern: string; search_directory?: string; case_insensitive?: boolean } }
  | { requestID: string; scanDirectoryTree: { directory: string; max_depth?: number } }
  | { requestID: string; runGitCommand: { command: string; arguments?: string[] } }
  | { requestID: string; runReadOnlyGitCommand: { command: string; arguments?: string[] } }
  | {
      requestID: string;
      runHTTPRequest: {
        method: string;
        url: string;
        headers?: Record<string, string>;
        body?: string;
      };
    }
  /**
   * Web search action — emitted when the workflow has the `web_search`
   * client capability and asks the agent to search the web. Field name
   * verified against gitlab-lsp `lib_workflow_api/src/web_search_action.ts`.
   */
  | { requestID: string; runWebSearch: { query: string; max_results?: number } }
  /**
   * Semantic file search — emitted by the workflow's RAG/embeddings agent.
   * Schema mirrors the upstream `file_search` tool registry entry.
   */
  | { requestID: string; runFileSearch: { query: string; search_directory?: string; max_results?: number } }
  /**
   * MCP tool call — Duo Workflow 17.6+ forwards calls to MCP tools the
   * client registered via `mcpTools[]` on the StartRequest. We currently
   * advertise an empty mcpTools list so this branch is rarely hit, but
   * defining it lets the bridge route gracefully if a self-hosted GitLab
   * has MCP enabled and the agent picks an MCP tool anyway.
   */
  | {
      requestID: string;
      runMCPCall: {
        server: string;
        tool: string;
        arguments?: Record<string, unknown>;
      };
    };

/** Server message envelope. Either a checkpoint update or a typed Action. */
export interface ServerMessage {
  newCheckpoint?: NewCheckpointMessage;
  // Action shapes are flattened onto the message itself (e.g. `{requestID, runCommand: …}`)
  requestID?: string;
  [k: string]: unknown;
}

// ─── Checkpoint (LangGraph state) ────────────────────────────────────────────

export interface UiChatLogMessage {
  message_type?: "agent" | "user" | "tool" | string;
  content?: string;
  tool_info?: unknown;
  status?: string;
  [k: string]: unknown;
}

export interface CheckpointState {
  channel_values?: {
    ui_chat_log?: UiChatLogMessage[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function parseCheckpoint(json: string | undefined | null): CheckpointState | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as CheckpointState;
  } catch {
    return null;
  }
}

/** Last `message_type === "agent"` entry in the checkpoint, or null. */
export function lastAgentMessage(state: CheckpointState | null): UiChatLogMessage | null {
  const log = state?.channel_values?.ui_chat_log;
  if (!Array.isArray(log)) return null;
  for (let i = log.length - 1; i >= 0; i--) {
    const m = log[i];
    if (m && m.message_type === "agent") return m;
  }
  return null;
}

/** A turn is done when the server signals it expects no further automatic
 *  progress without user input.
 *
 *  NOTE: PLAN_APPROVAL_REQUIRED and TOOL_CALL_APPROVAL_REQUIRED are NOT
 *  terminal here — when auto-approve is on we send an `approval` frame and
 *  keep listening. Only when auto-approve is off should the caller treat
 *  these as turn-end (and surface to the client). The collectTurn loop
 *  handles that distinction; this helper conservatively returns true for
 *  approval states so legacy callers don't hang. */
export function isTurnDone(status: CheckpointStatus | undefined): boolean {
  if (!status) return false;
  return (
    isTerminated(status) ||
    isAwaitingUserInput(status) ||
    status === DuoWorkflowStatus.TOOL_CALL_APPROVAL_REQUIRED
  );
}

/** Build the body for `POST /api/v4/ai/duo_workflows/workflows`.
 *
 *  `allow_agent_to_request_user` controls whether the agent can pause the
 *  workflow mid-task with `INPUT_REQUIRED` to ask the user a clarifying
 *  question. The CLI defaults to `true` because there's a human at a TTY,
 *  but for chat-style clients (Cline, Claude Code) `INPUT_REQUIRED` becomes
 *  `finish_reason: "stop"` — the user has to manually type "lanjut" /
 *  "continue" to keep the agent going. Default in the proxy is `false` so
 *  the agent drives the workflow to FINISHED/FAILED on its own.
 *
 *  Pass `allowAgentPrompts: true` to opt back into the original CLI
 *  behavior (e.g. for users who want the model to ask clarifying questions). */
export function buildCreateWorkflowBody(
  goal: string,
  allowAgentPrompts = false,
): {
  goal: string;
  workflow_definition: string;
  environment: string;
  allow_agent_to_request_user: boolean;
  agent_privileges: readonly number[];
  pre_approved_agent_privileges: readonly number[];
} {
  return {
    goal,
    workflow_definition: WORKFLOW_DEFINITION_AGENTIC,
    // gitlab-lsp uses "ide"; the CLI uses "cli". From the proxy's perspective
    // we are an IDE-equivalent client (no terminal UI, no local FS access).
    environment: "ide",
    allow_agent_to_request_user: allowAgentPrompts,
    agent_privileges: AGENT_PRIVILEGES,
    pre_approved_agent_privileges: AGENT_PRIVILEGES,
  };
}

/** Build the WS URL with the right query string. The CLI bundle (line
 *  8233056) appends BOTH `namespace_id` and `root_namespace_id` when
 *  operating at namespace level (no project_id) — the WS auth layer reads
 *  whichever is present. */
export function buildWebSocketUrl(
  gitlabBaseUrl: string,
  namespaceId: number | string,
  modelRef: string,
): string {
  const base = gitlabBaseUrl.replace(/^http(s?):\/\//, "ws$1://").replace(/\/$/, "");
  const u = new URL(`${base}/api/v4/ai/duo_workflows/ws`);
  u.searchParams.set("namespace_id", String(namespaceId));
  u.searchParams.set("root_namespace_id", String(namespaceId));
  u.searchParams.set("user_selected_model_identifier", modelRef);
  u.searchParams.set("workflow_definition", WORKFLOW_DEFINITION_AGENTIC);
  return u.toString();
}

/** Serialize one ClientEvent for the wire. Handles the
 *  `additional_context[].metadata` JSON-stringify dance the CLI does in `#y`. */
export function serializeClientEvent(ev: ClientEvent): string {
  if ("startRequest" in ev) {
    const sr = ev.startRequest;
    return JSON.stringify({
      startRequest: {
        ...sr,
        additional_context: sr.additional_context.map((c) => ({
          ...c,
          metadata: JSON.stringify(c.metadata ?? {}),
        })),
      },
    });
  }
  return JSON.stringify(ev);
}
