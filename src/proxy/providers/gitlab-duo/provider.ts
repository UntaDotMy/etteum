/**
 * GitLab Duo provider — agentic software_development workflow over WebSocket.
 */
import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type ModelInfo,
  type ProviderResult,
  type StreamChunk,
} from "../base";
import type { Account } from "../../../db/schema";
import { db } from "../../../db/index";
import { accounts } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { decrypt } from "../../../utils/crypto";
import {
  AGENT_PRIVILEGES,
  CLIENT_CAPABILITIES,
  CLIENT_VERSION,
  DuoWorkflowStatus,
  WORKFLOW_DEFINITION_AGENTIC,
  WorkflowStatusCode,
  buildCreateWorkflowBody,
  buildWebSocketUrl,
  isAwaitingApproval,
  isTerminated,
  isTurnDone,
  parseCheckpoint,
  serializeClientEvent,
  type AdditionalContextEntry,
  type CheckpointStatus,
  type ServerAction,
  type ServerMessage,
} from "./protocol";
import { ToolBridge, detectCwdCommand, resolveToolPaths } from "./tools";
import { creditsPerCall } from "./credits";
import { config } from "../../../config";
import { safeJsonParse } from "../../../utils/safe-json";
import {
  type DeltaEvent,
  type SessionCallbacks,
  evictByWs,
  evictSession,
  findSessionByAnyId,
  refreshSession,
  registerSession,
  touchSessionByWs,
} from "./sessions";
import {
  type DuoStoredTokens,
  type DuoStoredMetadata,
  FALLBACK_MODEL_REFS,
  describeModel,
} from "./models";
import { sendActionResponse } from "./tool-response";
import {
  WorkflowExecutorError,
  statusCodeForHttp,
  statusCodeForWsClose,
  errMsg,
  cryptoRandom,
} from "./errors";
import {
  type TurnResult,
  parseServerMessage,
  extractAction,
} from "./messages";

const NOW_S = () => Math.floor(Date.now() / 1000);

export class GitlabDuoProvider extends BaseProvider {
  name = "gitlab-duo";
  override supportedModels: ModelInfo[] = FALLBACK_MODEL_REFS.map((ref) => this.buildModelInfo(ref));
  override isFallback = false;
  override nativeFormat: "openai" | "anthropic" = "openai";

  /** Union of every active account's `metadata.availableModels`, lazily refreshed. */
  private cachedRefs = new Set<string>();
  private cachedModels: ModelInfo[] = [];

  // ─── /v1/models surface ─────────────────────────────────────────────────

  private buildModelInfo(ref: string): ModelInfo {
    const meta = describeModel(ref);
    return {
      id: ref,
      object: "model",
      created: NOW_S(),
      owned_by: "gitlab-duo",
      context_window: meta.context_window,
      max_output: meta.max_output,
      thinking: meta.thinking,
      vision: meta.vision,
      creditUnit: "request",
      creditRate: 1,
      creditSource: "fixed",
    };
  }

  async refreshModelsCache(): Promise<void> {
    try {
      const rows = await db.select().from(accounts).where(eq(accounts.provider, "gitlab-duo"));
      const refs = new Set<string>();
      for (const row of rows) {
        if (!row.enabled) continue;
        const meta = this.getStoredMetadata(row);
        for (const m of meta.availableModels ?? []) {
          if (m?.ref) refs.add(m.ref);
        }
      }
      for (const ref of FALLBACK_MODEL_REFS) refs.add(ref);
      this.cachedRefs = refs;
      this.cachedModels = [...refs].sort().map((r) => this.buildModelInfo(r));
    } catch (e) {
      console.error("[gitlab-duo] refreshModelsCache failed:", e);
    }
  }

  override ownsModel(model: string): boolean {
    if (!model) return false;
    if (model.startsWith("gitlab-duo:")) return true;
    if (this.cachedRefs.has(model)) return true;
    // Underscore-style id heuristic: `claude_sonnet_4_6`, `gpt_5`, `gemini_2_0_flash` …
    return /^(claude|gemini|gpt)_/i.test(model) && /_/.test(model);
  }

  override getModels(): ModelInfo[] {
    return this.cachedModels.length > 0 ? this.cachedModels : this.supportedModels;
  }

  // ─── BaseProvider implementation ────────────────────────────────────────

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    return this.run(account, request, /* stream */ false);
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    return this.run(account, request, /* stream */ true);
  }

  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> {
    // PATs are static — there is no rotation we can do automatically. If the
    // upstream just returned 401, the PAT is revoked or the user changed scopes
    // and the only fix is human intervention via
    // /api/accounts/gitlab-duo/:id/refresh (or a fresh login).
    //
    // We return success:false so the central router skips its "retry after
    // refresh" branch and falls through to the error-classification path,
    // which (combined with our error message containing "401") will mark the
    // account as a transient failure first; a follow-up warmup tick will
    // re-validate the PAT and flip the account to `error` if still revoked.
    return { success: false, error: "PAT cannot be auto-refreshed" };
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getStoredTokens(account);
    if (!tokens?.gitlabBaseUrl || !tokens?.namespaceId || !account.password) return false;
    try {
      const r = await fetch(`${tokens.gitlabBaseUrl}/api/v4/personal_access_tokens/self`, {
        headers: this.authHeaders(account),
      });
      if (!r.ok) return false;
      const j = (await r.json()) as { revoked?: boolean; scopes?: string[] };
      return !j.revoked && Array.isArray(j.scopes) && j.scopes.includes("api");
    } catch {
      return false;
    }
  }

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    // GitLab Credits — the trial wallet shown in
    //   /groups/:path/-/settings/gitlab_credits_dashboard
    // is exposed as `trialUsage.usersUsage.users.nodes[].usage.{creditsUsed,totalCredits}`.
    // Each trial user gets 24.0 credits over the 30-day window. We resolve the
    // current PAT user's row and use their per-user numbers (not the group sum,
    // which over-counts when there are multiple seats).
    //
    // If the namespace is not on a trial / the field is unavailable, fall back
    // to the unlimited sentinel so the account stays routable.
    const tokens = this.getStoredTokens(account);
    if (!tokens) return { success: false, error: "Missing namespace metadata" };
    try {
      const body = {
        operationName: "getTrialUsage",
        query: `query getTrialUsage($namespacePath: ID) {
          trialUsage(namespacePath: $namespacePath) {
            activeTrial { startDate endDate }
            usersUsage {
              creditsUsed
              totalUsersUsingCredits
              users(first: 50) {
                nodes {
                  id
                  username
                  usage { creditsUsed totalCredits }
                }
              }
            }
          }
        }`,
        variables: { namespacePath: tokens.namespacePath },
      };
      const r = await fetch(`${tokens.gitlabBaseUrl}/api/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders(account) },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        return { success: true, quota: { limit: -1, remaining: -1, used: 0 } };
      }
      const j = (await r.json()) as {
        data?: {
          trialUsage?: {
            activeTrial?: { startDate?: string; endDate?: string } | null;
            usersUsage?: {
              creditsUsed?: number;
              users?: { nodes?: Array<{ id?: string; username?: string; usage?: { creditsUsed?: number; totalCredits?: number } }> };
            };
          };
        };
      };
      const trial = j?.data?.trialUsage;
      if (!trial) return { success: true, quota: { limit: -1, remaining: -1, used: 0 } };

      // Trial expired — the namespace was on a trial that ended.
      // `activeTrial` flips to null once the 30-day window lapses, but the
      // underlying group stays on the `free` plan with NO Duo entitlements,
      // so the account is effectively exhausted (every workflow request will
      // return 403). Surface that explicitly via remaining=0.
      if (!trial.activeTrial) {
        return {
          success: true,
          quota: { limit: 24, used: 24, remaining: 0, resetAt: null },
        };
      }

      // Match the row that belongs to *our* PAT user — by gid suffix or username.
      const ourUserId = tokens.userId ? `gid://gitlab/User/${tokens.userId}` : null;
      const nodes = trial.usersUsage?.users?.nodes ?? [];
      const me =
        nodes.find((n) => ourUserId && n.id === ourUserId) ??
        nodes.find((n) => n.username && account.email.toLowerCase().includes(n.username.toLowerCase())) ??
        nodes[0];
      const used = me?.usage?.creditsUsed;
      const total = me?.usage?.totalCredits;
      if (typeof used !== "number" || typeof total !== "number") {
        return { success: true, quota: { limit: -1, remaining: -1, used: 0 } };
      }

      // Reset = trial end date (when the wallet wipes out, not refills — but the
      // semantics that match how every other provider's `resetAt` is consumed).
      const endDate = trial.activeTrial?.endDate ? new Date(trial.activeTrial.endDate) : null;
      return {
        success: true,
        quota: {
          limit: total,
          used,
          remaining: Math.max(0, total - used),
          resetAt: endDate && !isNaN(endDate.getTime()) ? endDate : null,
        },
      };
    } catch {
      return { success: true, quota: { limit: -1, remaining: -1, used: 0 } };
    }
  }

  /**
   * Override BaseProvider.healthCheck to layer in the authoritative
   * `direct_access` preflight on top of the trial-wallet `fetchQuota`.
   *
   * The base implementation flips an account to `exhausted` whenever
   * `quota.limit > 0 && quota.remaining <= 0`, which is correct for the
   * trial wallet view but lags the real-time per-flow gate. By calling
   * `preflightQuotaCheck` here, warmup ticks immediately reflect a
   * USAGE_QUOTA_EXCEEDED outcome — even mid-trial — instead of waiting
   * for the wallet's `creditsUsed` to catch up.
   *
   * If preflight is unavailable (older instance, network blip), we fall
   * back cleanly to the wallet-based decision.
   */
  override async healthCheck(account: Account) {
    // Run the base check first. It already handles validateAccount + the
    // wallet-based exhaustion call.
    const base = await super.healthCheck(account);

    // Only augment when the base says we're healthy. If it already flagged
    // exhausted/auth_error/transient_error, that decision sticks — we don't
    // want preflight to RESTORE an account the wallet says is dead.
    if (base.kind !== "healthy") return base;

    const tokens = this.getStoredTokens(account);
    if (!tokens?.gitlabBaseUrl || !tokens?.namespaceId) return base;

    const pf = await this.preflightQuotaCheck(account, tokens);
    if (pf?.exhausted) {
      // Authoritative — direct_access told us the namespace can't run this
      // workflow right now, regardless of what the trial wallet says. Mirror
      // base.healthCheck's exhausted shape so warmup-runner handles uniformly.
      return {
        kind: "exhausted" as const,
        success: true,
        quota: base.quota,
      };
    }

    return base;
  }

  // ─── Preflight quota check ───────────────────────────────────────────────

  /** Per-process cache of the most recent direct_access result per account.
   *  Keyed by account.id; each entry has a TTL of `gitlabDuoPreflightCacheMs`. */
  private preflightCache = new Map<number, { ts: number; exhausted: boolean }>();

  /**
   * Real-time per-request quota gate. Mirrors upstream's
   * `DefaultUsageQuotaService.checkUsageCreditsExceeded` (from
   * `lib_workflow_api/src/default_usage_quota_service.ts`):
   *
   *   POST /api/v4/ai/duo_workflows/direct_access
   *   { root_namespace_id, workflow_definition, project_id? }
   *
   * Failures return `null` (treated as OK by callers) so a flaky preflight
   * never blocks a healthy request. The body string `USAGE_QUOTA_EXCEEDED`
   * inside an error response is the deterministic exhaustion signal.
   *
   * `direct_access` returns 404 on instances older than v18.1.0 — handled
   * as "feature unsupported, treat as OK" so older self-hosted GitLab works
   * without configuration.
   */
  private async preflightQuotaCheck(
    account: Account,
    tokens: DuoStoredTokens,
  ): Promise<{ exhausted: boolean } | null> {
    if (!config.gitlabDuoPreflightCacheMs) return null;

    const cached = this.preflightCache.get(account.id);
    if (cached && Date.now() - cached.ts < config.gitlabDuoPreflightCacheMs) {
      return { exhausted: cached.exhausted };
    }

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), config.gitlabDuoPreflightTimeoutMs);
    try {
      const r = await fetch(`${tokens.gitlabBaseUrl}/api/v4/ai/duo_workflows/direct_access`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders(account) },
        body: JSON.stringify({
          root_namespace_id: String(tokens.namespaceId),
          workflow_definition: WORKFLOW_DEFINITION_AGENTIC,
        }),
        signal: ctl.signal,
      });
      // 404 = endpoint not on this instance (< v18.1.0) → treat as OK.
      if (r.status === 404) {
        this.preflightCache.set(account.id, { ts: Date.now(), exhausted: false });
        return { exhausted: false };
      }
      if (r.ok) {
        this.preflightCache.set(account.id, { ts: Date.now(), exhausted: false });
        return { exhausted: false };
      }
      const text = await r.text().catch(() => "");
      const exhausted = text.includes("USAGE_QUOTA_EXCEEDED");
      // Only cache deterministic exhaustion. Other 4xx/5xx are likely transient
      // — re-check next request.
      if (exhausted) {
        this.preflightCache.set(account.id, { ts: Date.now(), exhausted: true });
      }
      return { exhausted };
    } catch {
      // Network blip / abort — return null so caller skips the gate.
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  /** Drop the cached preflight result for an account. Called after a
   *  successful turn so the next request always re-validates if more than
   *  one cache TTL passes. */
  private invalidatePreflight(accountId: number): void {
    this.preflightCache.delete(accountId);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private getStoredTokens(account: Account): DuoStoredTokens | null {
    if (!account.tokens) return null;
    try {
      return typeof account.tokens === "string"
        ? (JSON.parse(account.tokens) as DuoStoredTokens)
        : (account.tokens as DuoStoredTokens);
    } catch { return null; }
  }

  private getStoredMetadata(account: Account): DuoStoredMetadata {
    if (!account.metadata) return {};
    try {
      return typeof account.metadata === "string"
        ? (JSON.parse(account.metadata) as DuoStoredMetadata)
        : (account.metadata as DuoStoredMetadata);
    } catch { return {}; }
  }

  private getPat(account: Account): string {
    return decrypt(account.password);
  }

  private authHeaders(account: Account): Record<string, string> {
    return {
      // PAT branch — `Private-Token` matches the official duo-cli
      // (bundle @7796913). Don't switch this to `Authorization: Bearer …`.
      "Private-Token": this.getPat(account),
      "User-Agent": "etteum-pool/gitlab-duo",
      "X-Gitlab-Client-Name": "Duo CLI",
      "X-Gitlab-Client-Version": "8.104.0",
    };
  }

  /** Resolve `request.model` to the real GitLab model ref. Strips the
   *  optional `gitlab-duo:` prefix; otherwise passes through. */
  private resolveModelRef(model: string): string {
    if (model.startsWith("gitlab-duo:")) return model.slice("gitlab-duo:".length);
    return model;
  }

  // ─── Core run loop ───────────────────────────────────────────────────────

  /**
   * Drive one HTTP turn against the workflow.
   *
   * - Brand new conversation: create workflow + open WS + send `startRequest`.
   * - Continuation (last message contains a tool_result we registered): reuse
   *   the existing WS, send `actionResponse`, attach a fresh iterator.
   *
   * Returns either:
   *   - text completion (ProviderResult.response with `finish_reason:"stop"`),
   *   - tool_use response (ProviderResult.response with `finish_reason:"tool_calls"`
   *     and a `tool_calls[]` we registered in `sessions`),
   *   - or, when stream=true, a ReadableStream of SSE chunks shaped the same
   *     way (delta tokens until the action arrives, then a final tool_calls
   *     chunk, OR a final `[DONE]` after a clean text close).
   */
  private async run(
    account: Account,
    request: ChatCompletionRequest,
    stream: boolean,
  ): Promise<ProviderResult> {
    const tokens = this.getStoredTokens(account);
    if (!tokens?.gitlabBaseUrl || !tokens?.namespaceId) {
      return { success: false, error: "GitLab Duo account is not bootstrapped — re-run /api/accounts/gitlab-duo/:id/refresh." };
    }

    const modelRef = this.resolveModelRef(request.model);
    const continuation = this.findContinuation(request.messages);

    // Preflight quota gate. We skip it on continuations because the WS is
    // already open — by definition the namespace was OK seconds ago and
    // upstream will surface USAGE_QUOTA_EXCEEDED on the next checkpoint
    // anyway. For fresh workflows, this catches exhaustion before we waste
    // a createWorkflow + WS-open round-trip.
    if (!continuation) {
      const pf = await this.preflightQuotaCheck(account, tokens);
      if (pf?.exhausted) {
        return {
          success: false,
          error: "Quota exhausted (preflight: direct_access)",
          quotaExhausted: true,
        };
      }
    }

    if (continuation) {
      return stream
        ? this.runContinuationStream(account, request, modelRef, continuation)
        : this.runContinuationOneShot(account, request, modelRef, continuation);
    }

    return stream
      ? this.runFreshStream(account, tokens, request, modelRef)
      : this.runFreshOneShot(account, tokens, request, modelRef);
  }

  // ─── Fresh workflow path ─────────────────────────────────────────────────

  /**
   * Translate an upstream error into the flag fields the central router
   * understands (ProviderResult). The router then applies the right action:
   *
   *  - 401/PAT revoked        → mark account `error` (auth) — no flag, plain failure
   *  - 402 / 403 + quota text → quotaExhausted: true → pool.markExhausted()
   *  - 403 forbidden (other)  → no flag — logged as transient by router
   *  - 429                    → rateLimited: true   → don't poison, retry next account
   *  - 5xx / network          → no flag — transient, retry next
   *
   *  GitLab Duo does not yet have a stable "PAYG" answer; when credits hit zero
   *  the workflow endpoint returns 402 (Payment Required) on most plans and 403
   *  on trial — we accept either as exhaustion.
   */
  private classifyError(e: unknown): { quotaExhausted?: boolean; rateLimited?: boolean; authError?: boolean } {
    // Preferred path — structured WorkflowStatusCode mapping. Mirrors how
    // upstream (`lib_workflow_api`) classifies executor outcomes; gives us
    // deterministic behavior instead of regex fragility.
    if (e instanceof WorkflowExecutorError) {
      switch (e.statusCode) {
        case WorkflowStatusCode.USAGE_QUOTA_EXCEEDED:
          return { quotaExhausted: true };
        case WorkflowStatusCode.AUTH_TOKEN_ERROR:
        case WorkflowStatusCode.AUTH_TOKEN_FETCH_ERROR:
        case WorkflowStatusCode.INVALID_API_CONFIGURATION:
        case WorkflowStatusCode.MISSING_CERTIFICATE_SETTINGS:
          return { authError: true };
        case WorkflowStatusCode.LOCKED_SOCKET:
          // "Another tab is responding" — try a different account, but don't
          // mark this one bad. rateLimited is the right pool signal.
          return { rateLimited: true };
        case WorkflowStatusCode.SERVICE_CONNECTION_DROPPED:
        case WorkflowStatusCode.SERVICE_CONNECTION_BAD_GATEWAY:
        case WorkflowStatusCode.SERVICE_CONNECTION_FAILED:
        case WorkflowStatusCode.SERVICE_CONNECTION_INTERNAL_ERROR:
        case WorkflowStatusCode.SERVICE_CONNECTION_TLS_HANDSHAKE:
        case WorkflowStatusCode.SERVICE_CONNECTION_CLOSED_MESSAGE_TOO_BIG:
        case WorkflowStatusCode.SERVICE_CONNECTION_UNSUPPORTED_DATA_TYPE:
          // Transient infra — let pool fail-over via markTransientFailure.
          return {};
        default:
          // GENERAL_FAILURE / FAILED_TO_START / CREATION_FAILED — let caller
          // handle as transient.
          return {};
      }
    }
    // Fallback: legacy HTTP-status + regex heuristic for callers that throw
    // plain `Error & { httpStatus? }`. Kept so we don't regress old paths.
    const status = (e as { httpStatus?: number } | null | undefined)?.httpStatus ?? 0;
    const msg = errMsg(e).toLowerCase();
    if (status === 429 || /rate.?limit|too many requests/.test(msg)) {
      return { rateLimited: true };
    }
    if (status === 401 || /unauthorized|invalid token|revoked/.test(msg)) {
      return { authError: true };
    }
    if (status === 402 || /payment required|insufficient credits|quota|exhausted|wallet/.test(msg)) {
      return { quotaExhausted: true };
    }
    if (status === 403 && /credits|quota|usage cap|trial.*expired|wallet|exhausted/.test(msg)) {
      return { quotaExhausted: true };
    }
    return {};
  }

  private async runFreshOneShot(
    account: Account,
    tokens: DuoStoredTokens,
    request: ChatCompletionRequest,
    modelRef: string,
  ): Promise<ProviderResult> {
    let workflowId: string;
    try {
      workflowId = await this.createWorkflow(account, tokens, this.buildGoal(request));
    } catch (e) {
      return { success: false, error: `createWorkflow: ${errMsg(e)}`, ...this.classifyError(e) };
    }

    let ws: WebSocket;
    try {
      ws = await this.openSocket(account, tokens, workflowId, modelRef);
    } catch (e) {
      return { success: false, error: `openSocket: ${errMsg(e)}`, ...this.classifyError(e) };
    }

    const promise = this.collectTurn(ws, workflowId, request, /* sendStart */ true, undefined, undefined, undefined, 0, new Set(), undefined);
    return this.toOneShotResult(promise, request, modelRef);
  }

  private async runFreshStream(
    account: Account,
    tokens: DuoStoredTokens,
    request: ChatCompletionRequest,
    modelRef: string,
  ): Promise<ProviderResult> {
    let workflowId: string;
    try {
      workflowId = await this.createWorkflow(account, tokens, this.buildGoal(request));
    } catch (e) {
      return { success: false, error: `createWorkflow: ${errMsg(e)}`, ...this.classifyError(e) };
    }

    let ws: WebSocket;
    try {
      ws = await this.openSocket(account, tokens, workflowId, modelRef);
    } catch (e) {
      return { success: false, error: `openSocket: ${errMsg(e)}`, ...this.classifyError(e) };
    }

    return this.toStreamResult(ws, workflowId, request, modelRef, /* sendStart */ true, undefined, undefined, 0, new Set(), undefined);
  }

  // ─── Continuation path (tool_result echo) ───────────────────────────────

  /** A "continuation" is when the most recent user/tool message echoes a
   *  tool_use_id we registered earlier — the WS is still alive and we should
   *  feed the tool's output back as `actionResponse`. */
  private findContinuation(messages: ChatMessage[] | undefined): {
    session: ReturnType<typeof findSessionByAnyId>;
    /**
     * Per-block result. Multiple entries when the client batched several
     * tool_results in one user message; we replay them as a sequence of
     * `actionResponse` frames in `collectTurn`. `isError` mirrors the
     * Anthropic `is_error` flag — when true we route the text into the
     * `error` field of `plainTextResponse` instead of `response`, which is
     * how upstream lib_workflow_api signals a failed tool to the agent.
     */
    results: Array<{ requestID: string; text: string; isError: boolean }>;
  } | null {
    if (!Array.isArray(messages) || messages.length === 0) return null;

    // Walk from the end looking for the most recent tool_result / role:"tool".
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m) continue;

      // OpenAI shape: { role: "tool", tool_call_id, content }
      if (m.role === "tool" && (m as any).tool_call_id) {
        const id = String((m as any).tool_call_id);
        const found = findSessionByAnyId([id]);
        if (found) {
          // OpenAI doesn't propagate is_error on tool messages — best we can
          // do is sniff for the conventional "Error:" prefix many CLIs use
          // when stderr was captured. False negatives are fine: at worst the
          // agent just reads the error text in `response` instead of `error`.
          const raw = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
          const isError = /^Error\s*:|^Tool execution failed/i.test(raw);
          // Prefer the registered requestID for THIS specific tool_use_id.
          // Falls back to the session's pending one if we registered it
          // under a different id (Anthropic vs OpenAI id formats).
          const reqId = found.session.toolCallIdToRequestId?.get(id) ?? found.session.pendingRequestID;
          return { session: found, results: [{ requestID: reqId, text: raw, isError }] };
        }
      }

      // Anthropic shape leaked through: content blocks with type:"tool_result".
      if (Array.isArray(m.content)) {
        const ids: string[] = [];
        const blocks: Array<{ id: string; text: string; isError: boolean }> = [];
        for (const block of m.content) {
          if (block && (block as any).type === "tool_result") {
            const id = (block as any).tool_use_id;
            if (!id) continue;
            ids.push(String(id));
            const c = (block as any).content;
            // Anthropic content can be a string OR an array of `{type, text}`
            // sub-blocks. JSON-stringify is wrong for the latter — extract
            // the `text` chunks so the agent sees clean output.
            let text: string;
            if (typeof c === "string") text = c;
            else if (Array.isArray(c)) {
              text = c
                .map((sb: any) => (sb?.type === "text" ? String(sb.text ?? "") : JSON.stringify(sb)))
                .join("\n");
            } else text = c == null ? "" : JSON.stringify(c);
            blocks.push({
              id: String(id),
              text,
              isError: (block as any).is_error === true,
            });
          }
        }
        if (ids.length) {
          const found = findSessionByAnyId(ids);
          if (!found) continue;
          // Map each block back to the requestID upstream gave us. If we
          // can't find a per-id mapping, fall back to the pending one (the
          // last tool_use we registered) — better than dropping the result.
          const map = found.session.toolCallIdToRequestId;
          const results = blocks.map((b) => ({
            requestID: map?.get(b.id) ?? found.session.pendingRequestID,
            text: b.text,
            isError: b.isError,
          }));
          return { session: found, results };
        }
      }
    }
    return null;
  }

  private async runContinuationOneShot(
    account: Account,
    request: ChatCompletionRequest,
    modelRef: string,
    cont: NonNullable<ReturnType<typeof this.findContinuation>>,
  ): Promise<ProviderResult> {
    if (!cont.session) {
      // The lookup returned null somehow — fall back to a fresh workflow.
      const tokens = this.getStoredTokens(account);
      if (!tokens) return { success: false, error: "Missing namespace metadata" };
      return this.runFreshOneShot(account, tokens, request, modelRef);
    }

    const { ws, workflowId } = cont.session.session;
    const priorAgentCount = cont.session.session.agentMessageCount ?? 0;
    // Cross-turn dedup: pass forward the set of agent message contents
    // we've already streamed on this WS so collectTurn can skip them
    // if Duo re-includes them in the new checkpoint's `ui_chat_log`.
    const priorEmittedTexts = cont.session.session.emittedAgentTexts ?? new Set<string>();
    const promise = this.collectTurn(
      ws, workflowId, request, /* sendStart */ false, /* actionResponse */ undefined,
      /* onDelta */ undefined, /* actionResponses */ cont.results,
      priorAgentCount, priorEmittedTexts, cont.session.session,
    );
    // The tool_use we previously registered is now "consumed" — caller is free
    // to drop it; new tool_calls (if any) will be re-registered in toOneShotResult.
    evictSession(cont.session.id, "consumed", /* keepWsOpen */ true);
    return this.toOneShotResult(promise, request, modelRef);
  }

  private async runContinuationStream(
    account: Account,
    request: ChatCompletionRequest,
    modelRef: string,
    cont: NonNullable<ReturnType<typeof this.findContinuation>>,
  ): Promise<ProviderResult> {
    if (!cont.session) {
      const tokens = this.getStoredTokens(account);
      if (!tokens) return { success: false, error: "Missing namespace metadata" };
      return this.runFreshStream(account, tokens, request, modelRef);
    }

    const { ws, workflowId } = cont.session.session;
    const priorAgentCount = cont.session.session.agentMessageCount ?? 0;
    const priorEmittedTexts = cont.session.session.emittedAgentTexts ?? new Set<string>();
    evictSession(cont.session.id, "consumed", /* keepWsOpen */ true);
    return this.toStreamResult(
      ws, workflowId, request, modelRef, /* sendStart */ false,
      /* actionResponse */ undefined, /* actionResponses */ cont.results,
      priorAgentCount, priorEmittedTexts, cont.session.session,
    );
  }

  // ─── REST: createWorkflow ────────────────────────────────────────────────

  private async createWorkflow(
    account: Account,
    tokens: DuoStoredTokens,
    goal: string,
  ): Promise<string> {
    const url = `${tokens.gitlabBaseUrl}/api/v4/ai/duo_workflows/workflows`;
    const body = buildCreateWorkflowBody(goal, config.gitlabDuoAllowAgentPrompts);
    // Hard timeout — without this, a stuck POST sits inside Bun's 255s socket
    // idleTimeout and the *client's* HTTP request gets force-closed by Bun
    // before we even get to retry. AbortController surfaces it as a normal
    // throw we can classify and fail over.
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), config.gitlabDuoCreateWorkflowTimeoutMs);
    let r: Response;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders(account) },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") {
        throw new WorkflowExecutorError(
          `createWorkflow timed out after ${config.gitlabDuoCreateWorkflowTimeoutMs}ms`,
          WorkflowStatusCode.SERVICE_CONNECTION_FAILED,
          { httpStatus: 504 },
        );
      }
      // Network blip / DNS / TLS — wrap so caller can classify uniformly.
      throw new WorkflowExecutorError(
        `createWorkflow network error: ${errMsg(e)}`,
        WorkflowStatusCode.SERVICE_CONNECTION_FAILED,
        { cause: e },
      );
    } finally {
      clearTimeout(t);
    }
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new WorkflowExecutorError(
        `HTTP ${r.status}: ${text.slice(0, 200)}`,
        statusCodeForHttp(r.status, text),
        { httpStatus: r.status },
      );
    }
    const j = (await r.json()) as { id?: number | string };
    if (!j?.id) {
      throw new WorkflowExecutorError(
        "response missing id",
        WorkflowStatusCode.CREATION_FAILED,
      );
    }
    return String(j.id);
  }

  // ─── WebSocket ───────────────────────────────────────────────────────────

  private openSocket(
    account: Account,
    tokens: DuoStoredTokens,
    workflowId: string,
    modelRef: string,
  ): Promise<WebSocket> {
    const url = buildWebSocketUrl(tokens.gitlabBaseUrl, tokens.namespaceId, modelRef);
    const ws = new WebSocket(url, {
      headers: this.authHeaders(account),
    } as any);

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        ws.removeEventListener("open", onOpen as any);
        ws.removeEventListener("error", onError as any);
        clearTimeout(handshakeTimer);
      };
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(ws);
      };
      const onError = (ev: Event) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { ws.close(1011, "open_error"); } catch {/* ignore */}
        reject(new WorkflowExecutorError(
          `WS error opening ${workflowId}: ${(ev as any)?.message ?? "unknown"}`,
          WorkflowStatusCode.SERVICE_CONNECTION_FAILED,
        ));
      };
      // Bun's WebSocket has no built-in handshake timeout — without this a
      // network black hole stalls forever inside the open() Promise.
      const handshakeTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        try { ws.close(1011, "open_timeout"); } catch {/* ignore */}
        reject(new WorkflowExecutorError(
          `WS open timed out after ${config.gitlabDuoWsOpenTimeoutMs}ms (workflow=${workflowId})`,
          WorkflowStatusCode.SERVICE_CONNECTION_FAILED,
          { httpStatus: 504 },
        ));
      }, config.gitlabDuoWsOpenTimeoutMs);
      ws.addEventListener("open", onOpen as any);
      ws.addEventListener("error", onError as any);
    });
  }

  /**
   * Run one turn against an open WS. Iterator-driven: enqueues delta events
   * as they arrive, finishes when the workflow signals a terminal status, OR
   * yields a tool action and pauses (the WS stays open for the next turn).
   */
  private collectTurn(
    ws: WebSocket,
    workflowId: string,
    request: ChatCompletionRequest,
    sendStart: boolean,
    /** Legacy single-response continuation. Kept for backward compatibility
     *  with callers that haven't migrated to `actionResponses`. */
    actionResponse?: { requestID: string; response: string },
    /** Optional: invoked with newly-appended text every time `cumulative`
     *  grows. Used by `toStreamResult` to do real incremental SSE streaming
     *  instead of waiting for the whole turn to finish. */
    onDelta?: (delta: string) => void,
    /** Multi-result continuation: replay every echoed tool_result as its
     *  own `actionResponse` frame. Each entry's `isError` decides whether
     *  the text lands in the `error` or `response` field of
     *  `plainTextResponse`. */
    actionResponses?: Array<{ requestID: string; text: string; isError: boolean }>,
    /** Legacy / debug only; positional baseline is no longer used.
     *  See `priorEmittedTexts` for the actual cross-turn dedup mechanism. */
    priorAgentCount = 0,
    /** Set of agent message contents already streamed to the client on
     *  this WS in prior turns. When an agent message in `ui_chat_log`
     *  has content matching one in this set, we skip it as history.
     *
     *  This is the correct cross-turn dedup: Duo's `ui_chat_log` is
     *  inconsistently scoped (sometimes scratch-only with just the new
     *  agent message, sometimes cumulative including completed agent
     *  messages from earlier turns), so position-based baselines are
     *  unreliable. Content-based dedup is robust because a completed
     *  agent message has a fixed final string. */
    priorEmittedTexts: Set<string> = new Set(),
    /** Session object for working directory tracking. */
    session?: any,
  ): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve, reject) => {
      let cumulative = "";
      // Exactly what we've already forwarded to the SSE consumer via onDelta.
      // Tracked separately from `cumulative` so the delta logic stays strictly
      // append-only and can never replay text the client already rendered.
      let emitted = "";
      let lastStatus: CheckpointStatus | undefined;
      let toolCall: { id: string; name: string; argsJson: string; requestID: string } | undefined;
      let resolved = false;
      // Cross-turn agent-message dedup via CONTENT comparison.
      //
      // BACKGROUND: Duo's `ui_chat_log` is inconsistently scoped across
      // checkpoints — sometimes it carries ONLY the current in-progress
      // agent message (scratch view), sometimes it carries the FULL
      // history including completed agent messages from prior turns.
      // Position-based baselines fail because the log shrinks/grows
      // unpredictably between checkpoints (verified empirically — see
      // scripts/repro-creative-multi.ts).
      //
      // Content-based dedup is robust: a completed agent message has a
      // fixed final string. If we see that exact string come back in a
      // later checkpoint, it's history — skip it. New in-progress
      // messages have unique evolving content (the partial prefix won't
      // match a finalized prior text), so they always slip through.
      //
      // `priorEmittedTexts` arrives from the session: every agent
      // message we've finalized on this WS in prior turns. We grow this
      // set with each new finalized agent message during this turn and
      // ship the merged set back via TurnResult.
      void priorAgentCount;
      const seenAgentTextsThisTurn = new Set<string>();
      // Track agent messages observed this turn (for credit accounting and
      // session-state continuity).
      let totalAgentCount = 0;
      // Number of agent messages added to ui_chat_log during THIS turn — the
      // canonical count of distinct LLM calls. Updated whenever we recompute
      // `cumulative`. Used by toOneShotResult / toStreamResult to populate
      // ProviderResult.creditsUsed via the GitLab credit-rate table.
      let turnAgentCalls = 0;
      // Whether we already auto-sent a synthetic "continue" nudge for an
      // INPUT_REQUIRED-with-empty-content situation. Once per turn only.
      let autoNudged = false;

      // Per-turn idle watchdog: if the upstream WS goes silent for longer
      // than `gitlabDuoTurnIdleMs` ms while we're still waiting on this turn,
      // surface as a transient error so the router can fail over instead of
      // hanging the SSE consumer forever. Disabled when set to 0.
      const turnIdleMs = config.gitlabDuoTurnIdleMs;
      let turnIdleTimer: ReturnType<typeof setTimeout> | null = null;
      const armTurnIdle = () => {
        if (!turnIdleMs) return;
        if (turnIdleTimer) clearTimeout(turnIdleTimer);
        turnIdleTimer = setTimeout(() => {
          if (resolved) return;
          // eslint-disable-next-line no-console
          console.warn(
            `[gitlab-duo] turn idle ${turnIdleMs}ms — aborting workflow=${workflowId} ` +
              `lastStatus=${lastStatus ?? "<none>"} cumulative.len=${cumulative.length}`,
          );
          finish("error", new Error(`workflow idle ${turnIdleMs}ms (workflow=${workflowId})`));
        }, turnIdleMs);
      };
      // Empty-INPUT_REQUIRED watchdog handle, so finish() can clear it.
      let emptyInputTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = (kind: "done" | "tool" | "error", err?: Error) => {
        if (resolved) return;
        resolved = true;
        if (turnIdleTimer) { clearTimeout(turnIdleTimer); turnIdleTimer = null; }
        if (emptyInputTimer) { clearTimeout(emptyInputTimer); emptyInputTimer = null; }
        cleanup();
        if (kind === "error") return reject(err ?? new Error("workflow failed"));
        // Floor at 1 — every successful turn (`done` or `tool`) made at least
        // one LLM call by definition, even if we somehow missed counting it.
        const agentCalls = Math.max(1, turnAgentCalls);
        // Merge prior set + texts surfaced this turn. The merged set is
        // what the session carries to the next continuation turn.
        const emittedAgentTexts = new Set<string>(priorEmittedTexts);
        for (const t of seenAgentTextsThisTurn) emittedAgentTexts.add(t);
        resolve({
          ws, workflowId,
          content: cumulative,
          status: lastStatus,
          toolCall, agentCalls,
          totalAgentCount,
          emittedAgentTexts,
        });
      };

      const onMessage = (ev: MessageEvent) => {
        // Any upstream activity counts as liveness — re-arm both watchdogs and
        // refresh any tool_use session pinned to this WS. Cheap; runs per frame.
        armTurnIdle();
        touchSessionByWs(ws);
        const msg = parseServerMessage(ev.data);
        if (!msg) return;

        // 1. Action frames pause the run and yield a tool_use to the client.
        const action = extractAction(msg);
        if (action) {
          const matched = ToolBridge.match(action, request.tools);
          if (config.gitlabDuoLogToolBridge) {
            const kind = Object.keys(action).find((k) => k !== "requestID");
            const declared = (request.tools ?? [])
              .map((t) => (t as any)?.function?.name ?? (t as any)?.name)
              .filter(Boolean);
            // eslint-disable-next-line no-console
            console.warn(
              `[gitlab-duo] tool-bridge action=${kind} → ${matched ? matched.name : "(unmatched)"} ` +
                `| client tools: [${declared.join(", ") || "none"}]`,
            );
          }
          if (matched) {
            // Resolve paths and track working directory changes
            let argsJson = matched.argsJson;
            
            // Check if this is a shell command and detect cd
            if (matched.name.toLowerCase().includes("bash") || 
                matched.name.toLowerCase().includes("shell") ||
                matched.name.toLowerCase().includes("terminal")) {
              const args = safeJsonParse(argsJson, {}) ?? {};
              const command = args.command || args.cmd || "";
              
              // Detect cd command and update session working directory
              const newCwd = detectCwdCommand(command, session?.workingDirectory || process.cwd());
              if (newCwd && session) {
                session.workingDirectory = newCwd;
                if (config.gitlabDuoLogToolBridge) {
                  console.warn(`[gitlab-duo] working directory changed to: ${newCwd}`);
                }
              }
            }
            
            // Resolve relative paths to absolute paths
            argsJson = resolveToolPaths(argsJson, matched.name, session?.workingDirectory || process.cwd());
            
            toolCall = {
              // OpenAI-native ID prefix. The OpenAI tool-calling spec treats
              // `tool_calls[].id` as an opaque string, but several strict
              // client accumulators (and some proxies) validate the shape and
              // silently drop a tool call whose id doesn't look like an OpenAI
              // id. `toolu_` is the Anthropic convention and was the source of
              // OpenAI-compatible clients quietly ignoring the tool round.
              // Lookup is by exact string everywhere (registerSession /
              // findSessionByAnyId / tool_call_id read-back), so the prefix is
              // free to change — round-trip stays intact.
              id: `call_${cryptoRandom()}`,
              name: matched.name,
              argsJson: argsJson,
              requestID: matched.requestID,
            };
            return finish("tool");
          }
          // Unknown action — best effort: tell the workflow we cannot run it,
          // so it can recover or fail gracefully.
          try {
            ws.send(serializeClientEvent({
              actionResponse: {
                requestID: action.requestID,
                plainTextResponse: { response: "Tool not available in this client session.", error: "" },
              },
            }));
          } catch {/* ignore */}
          return;
        }

        // 2. Checkpoint updates carry streaming text and the workflow status.
        const ckpt = msg.newCheckpoint;
        if (!ckpt) return;
        lastStatus = ckpt.status;

        const state = parseCheckpoint(ckpt.checkpoint);
        const log = state?.channel_values?.ui_chat_log;
        if (Array.isArray(log)) {
          // Optional diagnostic: dump raw ui_chat_log structure per checkpoint.
          // Enabled by `POOLPROX_DUO_DEBUG_LOG=1`. Useful when investigating
          // upstream protocol changes (e.g. did Duo flip the log to be
          // cumulative across turns?). Off by default — every checkpoint
          // emits otherwise, which floods the log on long turns.
          if (config.gitlabDuoDebugLog) {
            const summary = log.map((m: any, i: number) => ({
              i, t: m?.message_type, len: typeof m?.content === "string" ? m.content.length : -1,
              p: typeof m?.content === "string" ? m.content.slice(0, 50) : null,
            }));
            // eslint-disable-next-line no-console
            console.warn(`[duo:debug] ckpt=${ckpt.status} sendStart=${sendStart} log=${JSON.stringify(summary)}`);
          }
          // Walk every agent message in the log. Skip any whose CONTENT
          // matches one we already streamed in a prior turn on this WS —
          // those are history (Duo re-includes finalized messages in
          // later cumulative checkpoints). Track unique contents we see
          // this turn so the session can extend the prior set at finish.
          let inTurnCalls = 0;
          let agentsInLog = 0;
          const parts: string[] = [];
          for (const m of log) {
            if (!m || m.message_type !== "agent") continue;
            agentsInLog++;
            if (typeof m.content !== "string") continue;
            // Cross-turn history check: exact-match against texts already
            // emitted on this WS in prior turns.
            if (priorEmittedTexts.has(m.content)) continue;
            inTurnCalls++;
            seenAgentTextsThisTurn.add(m.content);
            parts.push(m.content);
          }
          if (agentsInLog > totalAgentCount) totalAgentCount = agentsInLog;
          // Monotonic: never undercount agent calls (used for credit metering).
          if (inTurnCalls > turnAgentCalls) turnAgentCalls = inTurnCalls;
          if (parts.length > 0) {
            const next = parts.join("\n");
            // Real streaming, APPEND-ONLY. GitLab Duo re-sends the *cumulative*
            // text of each agent message on every checkpoint, so the only
            // correct delta is the suffix that extends what we've already
            // emitted. The previous implementation fell back to `onDelta(next)`
            // (replaying the WHOLE string) whenever `next` wasn't a strict
            // prefix-extension of `cumulative` — which happens routinely when
            // an earlier agent message is still growing while a new one
            // appears, or when upstream lightly reformats prior text. That
            // replay is exactly the "stop-stop / text jumps and repeats"
            // symptom: the client renders the full answer again mid-stream.
            //
            // Fix: never replay. Track the longest common prefix between what
            // we've sent (`emitted`) and the new cumulative string, and emit
            // only the genuinely-new tail. If `next` diverged from `emitted`
            // (rare reformat), we keep what the client already saw and only
            // forward the new suffix beyond the common prefix — monotonic, no
            // duplicate bursts, no resets.
            if (next !== cumulative) {
              if (onDelta) {
                if (next.startsWith(emitted)) {
                  // Happy path: monotonic extension. Stream only the new suffix.
                  const delta = next.slice(emitted.length);
                  if (delta) { onDelta(delta); emitted = next; }
                } else if (next.length > emitted.length) {
                  // Divergence + growth. Duo lightly reformatted earlier text
                  // (rare). Two failure modes to avoid:
                  //   (1) re-emitting the whole `next` → user sees doubled
                  //       text (the "Saya buat landing page... Saya buat
                  //       landing page..." bubbles in the user's screenshot).
                  //   (2) using `next.slice(emitted.length)` directly → may
                  //       cut mid-word ("Sekarang" → "ekarang") because
                  //       `next` no longer aligns with `emitted` at that
                  //       offset.
                  //
                  // Strategy: emit ONLY the suffix that's strictly beyond
                  // the longest-common-prefix AND beyond what we already
                  // streamed. If those two anchors overlap (common case),
                  // we send a small "patch" tail. We accept that the
                  // client's view of the message may diverge a bit from
                  // the canonical `cumulative` — that's fine; SSE is
                  // append-only. NEVER re-stream a prefix.
                  let i = 0;
                  const max = Math.min(emitted.length, next.length);
                  while (i < max && emitted[i] === next[i]) i++;
                  // The tail past the common prefix is the model's intended
                  // continuation. Clip to past what we already streamed so
                  // we never re-emit characters the client has seen.
                  const startFrom = Math.max(i, emitted.length);
                  const delta = next.slice(startFrom);
                  if (delta) {
                    onDelta(delta);
                    // emitted now mirrors what the CLIENT actually has:
                    // the original prefix we streamed + the new tail we
                    // just sent. NOT equal to `next` — it's a chimera, but
                    // it's exactly what's on the wire.
                    emitted = emitted.slice(0, startFrom) + delta;
                  }
                }
                // else: next is shorter or equal — server reformat rewinds
                // text we already streamed. We can't unsend; skip entirely.
                // `emitted` stays as-is (never shrinks).
              }
              cumulative = next;
            }
          }
        }

        // Auto-approval intercept — runs BEFORE isTurnDone() so we keep the
        // turn alive when upstream is just asking for plan/tool consent.
        // Mirrors how the official `gitlab-lsp` Duo client handles approval
        // frames in agentic mode (it surfaces a UI prompt; we can't, so we
        // approve transparently when configured).
        if (
          config.gitlabDuoAutoApprove &&
          isAwaitingApproval(ckpt.status as DuoWorkflowStatus)
        ) {
          // Tool-level approval needs the requestID of the pending action.
          // Plan-level approval has no requestID. We extract the pending
          // requestID from the ServerMessage if present.
          const pendingRequestID = (msg as { requestID?: string }).requestID;
          try {
            ws.send(serializeClientEvent({
              approval: {
                userApproved: true,
                type: "approve_once",
                ...(pendingRequestID ? { requestID: pendingRequestID } : {}),
              },
            }));
            // eslint-disable-next-line no-console
            console.warn(
              `[gitlab-duo] auto-approved status=${ckpt.status} workflow=${workflowId}` +
                (pendingRequestID ? ` requestID=${pendingRequestID}` : ""),
            );
          } catch (e) {
            // If we can't send approval, fall through to the legacy
            // turn-done path so the client at least sees a clean stop.
            // eslint-disable-next-line no-console
            console.warn(
              `[gitlab-duo] failed to send approval: ${errMsg(e)} — surfacing as turn end`,
            );
          }
          // DON'T finish — wait for the next checkpoint after upstream
          // continues processing.
          return;
        }

        if (isTurnDone(ckpt.status)) {
          if (ckpt.status === "FAILED") {
            const errs = (ckpt.errors ?? []).join("; ") || "workflow FAILED";
            return finish("error", new Error(errs));
          }

          // DIAGNOSTIC: when a turn ends with INPUT_REQUIRED but no content +
          // no tool action, the client ("Claude Code") sees an empty stop and
          // the user has to manually type "continue" — the "ngadat after shell
          // command" symptom. Log enough context so we can reproduce + fix.
          if (
            !cumulative &&
            !toolCall &&
            (ckpt.status === "INPUT_REQUIRED" || ckpt.status === "PAUSED")
          ) {
            try {
              const log = state?.channel_values?.ui_chat_log;
              const tail = Array.isArray(log)
                ? log.slice(-3).map((m) => ({
                  type: m?.message_type,
                  contentPreview: typeof m?.content === "string"
                    ? m.content.slice(0, 80)
                    : undefined,
                }))
                : [];
              // eslint-disable-next-line no-console
              console.warn(
                `[gitlab-duo] turn ended empty status=${ckpt.status} workflow=${workflowId} ` +
                  `totalAgentCount=${totalAgentCount} sendStart=${sendStart} ` +
                  `priorEmittedTexts=${priorEmittedTexts.size} ` +
                  `tail=${JSON.stringify(tail)}`,
              );
            } catch {/* ignore */}
          }

          // Auto-recover: when a turn ends with EMPTY content + INPUT_REQUIRED
          // there's a known upstream race where the terminal status arrives
          // before the corresponding text chunk. Wait briefly for the
          // follow-up RUNNING-with-text checkpoint before forcing turn done.
          //
          // We DON'T extend the watchdog when content is already present —
          // with the new agentBaseline-from-session logic, content tracking
          // is correct, and an INPUT_REQUIRED-with-content turn has already
          // surfaced the model's full reply. Waiting longer just adds latency
          // for no information gain.
          if (
            ckpt.status === "INPUT_REQUIRED" &&
            !cumulative &&
            !toolCall &&
            !autoNudged
          ) {
            autoNudged = true;
            const stale: CheckpointStatus = "INPUT_REQUIRED";
            // Treat as still-running for now; watchdog forces a finish if
            // nothing useful follows.
            lastStatus = "RUNNING";
            emptyInputTimer = setTimeout(() => {
              emptyInputTimer = null;
              if (resolved) return;
              if (!cumulative && !toolCall) {
                lastStatus = stale;
                finish("done");
              }
            }, config.gitlabDuoEmptyInputWatchdogMs);
            return;
          }

          return finish("done");
        }
      };

      const onClose = (ev: CloseEvent) => {
        if (resolved) return;
        // Server already signaled the turn is over — clean exit.
        if (lastStatus && isTurnDone(lastStatus)) return finish("done");

        // RFC 6455 close code semantics:
        //   1000 = Normal Closure ("purpose has been fulfilled") — by definition
        //          NOT an error. GitLab Duo routinely closes the WS with 1000
        //          right after a turn completes (especially on continuation
        //          turns after a tool result), even before we receive a
        //          FINISHED checkpoint. Treat as success if we have anything
        //          useful to return; otherwise still success-with-empty rather
        //          than surfacing a scary banner to the client.
        //   1001 = Going Away (server shutdown / nav) — also benign for us.
        //   Anything else = real abnormal close, surface it.
        if (ev.code === 1000 || ev.code === 1001) {
          // We have content OR a tool call OR an explicit terminal status →
          // truly done.
          if (cumulative || toolCall) return finish("done");

          // Continuation turn (post-tool-result) with no extra content: this
          // is Duo's idiomatic "workflow is finished, nothing more to add"
          // signal. After the client returned the tool_result for the last
          // tool the agent emitted, Duo often skips a final FINISHED
          // checkpoint and just closes 1000. The previous turn's assistant
          // message (the one carrying the tool_use) has already been
          // streamed to the user, so closing empty here is a legitimate
          // end-of-conversation, NOT the "Stop-stop" symptom.
          //
          // Heuristic: only treat empty 1000 as transient on a *fresh* turn
          // (sendStart=true) — there, an empty close with no checkpoint is
          // a genuine flap (server restart, idle reaper) worth retrying.
          if (!sendStart) {
            // Routine end-of-conversation signal from Duo on a continuation
            // turn — the previous turn's assistant message already streamed.
            // Log at debug level only; the test runner pipes warn → UI as
            // "[gitlab-duo error]" which scares users for what is not an
            // error. Set POOLPROX_GITLAB_DUO_LOG_TOOL_BRIDGE=true to see.
            if (config.gitlabDuoLogToolBridge) {
              // eslint-disable-next-line no-console
              console.warn(
                `[gitlab-duo:debug] WS closed code=${ev.code} after tool ` +
                  `result with no further content — treating as turn-end ` +
                  `workflow=${workflowId} lastStatus=${lastStatus ?? "<none>"}`,
              );
            }
            return finish("done");
          }

          // Fresh turn, graceful close mid-turn with NO content and NO
          // terminal status: this is GitLab flapping (server restart, idle
          // reaper, mid-stream disconnect). Treating it as "done" leaves
          // the user staring at an empty assistant bubble — the exact
          // "Stop-stop" symptom. Surface as a transient error so the pool
          // can retry on a different account.
          if (!isTerminated(lastStatus as DuoWorkflowStatus | undefined)) {
            // eslint-disable-next-line no-console
            console.warn(
              `[gitlab-duo] WS closed code=${ev.code} reason="${ev.reason}" with empty turn — ` +
                `treating as transient workflow=${workflowId} lastStatus=${lastStatus ?? "<none>"}`,
            );
            return finish(
              "error",
              new WorkflowExecutorError(
                `WS closed empty (code ${ev.code}, reason="${ev.reason}")`,
                statusCodeForWsClose(ev.code),
                { wsCloseCode: ev.code, httpStatus: 503 },
              ),
            );
          }
          // Terminal status was already FINISHED — close is just confirming it.
          return finish("done");
        }

        // eslint-disable-next-line no-console
        console.warn(
          `[gitlab-duo] WS closed early code=${ev.code} reason="${ev.reason}" ` +
            `workflow=${workflowId} lastStatus=${lastStatus ?? "<none>"} ` +
            `cumulative.len=${cumulative.length} toolCall=${toolCall ? "yes" : "no"}`,
        );
        finish(
          "error",
          new WorkflowExecutorError(
            `WS closed early (code ${ev.code}, reason="${ev.reason}")`,
            statusCodeForWsClose(ev.code),
            {
              wsCloseCode: ev.code,
              // Map abnormal close → transient HTTP-ish status for legacy
              // pool fail-over signaling.
              httpStatus: (ev.code === 1006 || ev.code === 1011 ||
                           ev.code === 1012 || ev.code === 1013) ? 503 : undefined,
            },
          ),
        );
      };

      const onError = (ev: Event) => {
        if (resolved) return;
        const detail = (ev as any)?.message ?? (ev as any)?.error?.message ?? "";
        // eslint-disable-next-line no-console
        console.warn(
          `[gitlab-duo] WS error workflow=${workflowId} lastStatus=${lastStatus ?? "<none>"} ` +
            `detail=${JSON.stringify(detail)}`,
        );
        finish(
          "error",
          new WorkflowExecutorError(
            `WS error: ${detail || "unknown"}`,
            WorkflowStatusCode.SERVICE_CONNECTION_FAILED,
          ),
        );
      };

      const cleanup = () => {
        ws.removeEventListener("message", onMessage as any);
        ws.removeEventListener("close", onClose as any);
        ws.removeEventListener("error", onError as any);
      };

      ws.addEventListener("message", onMessage as any);
      ws.addEventListener("close", onClose as any);
      ws.addEventListener("error", onError as any);

      // Arm turn-idle watchdog from the moment we attach. If upstream never
      // emits a single message after we send startRequest/actionResponse,
      // we'll surface the timeout instead of hanging the SSE forever.
      armTurnIdle();

      // Extract MCP tools from client's tool list (format: server__tool)
      const mcpTools = this.extractMcpTools(request);

      // Send the kickoff frame.
      try {
        if (sendStart) {
          ws.send(serializeClientEvent({
            startRequest: {
              workflowID: workflowId,
              clientVersion: CLIENT_VERSION,
              workflowDefinition: WORKFLOW_DEFINITION_AGENTIC,
              goal: this.buildGoal(request),
              workflowMetadata: JSON.stringify({ extended_logging: false }),
              additional_context: this.buildAdditionalContext(request),
              clientCapabilities: CLIENT_CAPABILITIES,
              mcpTools: mcpTools,
              preapproved_tools: [],
              flowConfig: undefined,
              flowConfigSchemaVersion: undefined,
              flowConfigId: undefined,
              flowVersion: undefined,
              approval: undefined,
            },
          }));
        } else if (actionResponses && actionResponses.length > 0) {
          // Multi-result continuation: replay each tool_result as its own
          // actionResponse frame, in order. Upstream lib_workflow_api
          // expects exactly one frame per requestID — combining them into
          // a single response field is what causes the "WS closed empty"
          // close-1000 we saw with parallel-tool turns.
          for (const r of actionResponses) {
            sendActionResponse(ws, r.requestID, r.text, r.isError);
          }
        } else if (actionResponse) {
          // Legacy single-response path — equivalent to one entry in the
          // multi-result list above with isError=false.
          sendActionResponse(ws, actionResponse.requestID, actionResponse.response, false);
        } else {
          finish("error", new Error("collectTurn called without sendStart or actionResponse"));
        }
      } catch (e) {
        finish("error", e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  // ─── Goal & additional_context construction ──────────────────────────────

  /** Convert the OpenAI/Anthropic-style `messages[]` into a single `goal`
   *  string for the workflow. The agentic flow runs each new workflow from
   *  scratch — without explicit framing the model can mistake conversation
   *  history for fresh instructions and *replay* prior steps. So we render
   *  history with a clear header and end with "now do <latest user request>".
   *
   *  Tool calls/results are flattened to short narrative lines (e.g.
   *  `Bash(mkdir -p foo) → ok`) rather than verbose `[ToolUse toolu_xxx]`
   *  blocks the model has to parse. */
  private buildGoal(request: ChatCompletionRequest): string {
    // Extract system messages — integrate into goal as user instructions,
    // NOT as additional_context user_rule (which makes agent restrictive).
    const systemMessages = (request.messages ?? []).filter((m) => m.role === "system");
    const systemText = systemMessages.map((m) => this.extractText(m)).filter(Boolean).join("\n\n");

    const messages = (request.messages ?? []).filter((m) => m.role !== "system");
    if (messages.length === 0 && !systemText) return "Continue.";

    // Find the *latest* user message — that's the actual goal. Everything
    // before it is history.
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        // A pure tool_result message also has role:"user" in Anthropic format —
        // skip those and find the most recent message that has actual text.
        const m = messages[i] as any;
        const hasText = typeof m.content === "string"
          ? m.content.trim().length > 0
          : Array.isArray(m.content)
            ? m.content.some((b: any) => b?.type === "text" && (b.text ?? "").trim().length > 0)
            : false;
        if (hasText) { lastUserIdx = i; break; }
      }
    }
    if (lastUserIdx === -1) lastUserIdx = messages.length - 1;

    const history = messages.slice(0, lastUserIdx);
    const latest = messages[lastUserIdx];
    const latestText = latest ? this.extractText(latest) : "";

    // Build goal with system prompt integrated as instructions (not restrictions)
    const goalParts: string[] = [];

    if (systemText) {
      goalParts.push("IMPORTANT INSTRUCTIONS:");
      goalParts.push(systemText);
      goalParts.push("");
    }

    if (history.length === 0) {
      goalParts.push(latestText || "Continue.");
      return goalParts.join("\n");
    }

    const historyLines: string[] = [];
    // Track tool_use id → name so we can pair tool_result with its call.
    const toolNameById = new Map<string, string>();

    for (const m of history) {
      const role = m.role === "assistant" ? "Assistant" : "User";

      if (typeof m.content === "string") {
        if (m.content.trim()) historyLines.push(`${role}: ${m.content.trim()}`);
      } else if (Array.isArray(m.content)) {
        for (const b of m.content as any[]) {
          if (!b) continue;
          if (b.type === "text" && (b.text ?? "").trim()) {
            historyLines.push(`${role}: ${b.text.trim()}`);
          } else if (b.type === "tool_use") {
            const args = typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {});
            const argsShort = args.length > 200 ? args.slice(0, 197) + "..." : args;
            toolNameById.set(b.id, b.name);
            historyLines.push(`Assistant called ${b.name}(${argsShort})`);
          } else if (b.type === "tool_result") {
            const name = toolNameById.get(b.tool_use_id) ?? "tool";
            const c = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
            const short = c.length > 300 ? c.slice(0, 297) + "..." : c;
            historyLines.push(`└ ${name} returned: ${short}`);
          }
        }
      }

      // OpenAI tool_calls (assistant) and role:"tool" results.
      if (Array.isArray((m as any).tool_calls)) {
        for (const tc of (m as any).tool_calls) {
          const fn = tc?.function ?? {};
          const args = fn.arguments ?? "";
          const short = args.length > 200 ? args.slice(0, 197) + "..." : args;
          toolNameById.set(tc.id, fn.name ?? "tool");
          historyLines.push(`Assistant called ${fn.name ?? "tool"}(${short})`);
        }
      }
      if (m.role === "tool") {
        const id = (m as any).tool_call_id ?? "";
        const name = toolNameById.get(id) ?? "tool";
        const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
        const short = c.length > 300 ? c.slice(0, 297) + "..." : c;
        historyLines.push(`└ ${name} returned: ${short}`);
      }
    }

    if (historyLines.length === 0) {
      goalParts.push(latestText || "Continue.");
      return goalParts.join("\n");
    }

    // GitLab caps `goal` at 16384 characters server-side. We reserve ~2KB for
    // the latest message + framing and trim the *oldest* history lines first
    // (the most recent context matters most). When we drop lines we leave a
    // breadcrumb so the model knows it didn't get the full history.
    const HARD_CAP = 16000;             // safety margin under server's 16384
    const RESERVE = 2000;               // for latest text + headers + footer
    const HISTORY_BUDGET = HARD_CAP - RESERVE - (latestText.length || 0) - goalParts.join("\n").length;

    let totalLen = 0;
    const kept: string[] = [];
    let dropped = 0;
    // Walk newest → oldest, keep until we hit the budget.
    for (let i = historyLines.length - 1; i >= 0; i--) {
      const line = historyLines[i]!;
      if (totalLen + line.length + 1 > HISTORY_BUDGET) {
        dropped = i + 1;
        break;
      }
      kept.unshift(line);
      totalLen += line.length + 1;
    }
    if (dropped > 0) {
      kept.unshift(`(${dropped} earlier turn${dropped === 1 ? "" : "s"} omitted to fit the goal length limit)`);
    }

    goalParts.push("--- CONVERSATION HISTORY (already executed; do NOT redo these steps, do NOT repeat earlier text) ---");
    goalParts.push(...kept);
    goalParts.push("--- END HISTORY ---");
    goalParts.push("");
    goalParts.push(`Continue from where the conversation left off. The user's latest message:`);
    goalParts.push(latestText || "(continue)");

    return goalParts.join("\n");
  }

  /** Extract a flat text body from one message (string or content blocks). */
  private extractText(m: ChatMessage): string {
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return (m.content as any[])
        .map((b) => {
          if (!b) return "";
          if (typeof b === "string") return b;
          if (b.type === "text") return b.text ?? "";
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  /** Forward the `system` message (if any) — but NOT as `user_rule` context.
   *
   *  WHY: GitLab Duo interprets `user_rule` as "restrictions that limit what
   *  I can do", making the agent overly cautious, self-identify as "GitLab Duo",
   *  and refuse tasks. gitlab2api sends `additional_context: []` (empty) and
   *  merges system messages into the `goal` string instead.
   *
   *  Strategy: integrate system prompt into `goal` via `buildGoal()`, NOT as
   *  `additional_context`. This makes the agent treat it as user instructions,
   *  not restrictions.
   */
  private buildAdditionalContext(_request: ChatCompletionRequest): AdditionalContextEntry[] {
    // Return empty array — system messages are integrated into goal, not sent
    // as user_rule context (which makes the agent restrictive/self-limiting).
    return [];
  }

  /** Extract MCP tools from client's tool list and format for GitLab Duo.
   *
   *  MCP tools follow the naming convention: `server__tool` (double underscore).
   *  GitLab Duo expects mcpTools in this format:
   *    { server: string, tool: string, inputSchema?: object }
   *
   *  By advertising these tools, the GitLab Duo agent knows they exist and
   *  can emit `runMCPCall` actions that ToolBridge will forward to the client.
   */
  private extractMcpTools(request: ChatCompletionRequest): unknown[] {
    if (!request.tools || !Array.isArray(request.tools)) return [];

    const mcpTools: unknown[] = [];

    for (const tool of request.tools) {
      // OpenAI format: { type: "function", function: { name, description, parameters } }
      // Anthropic format: { name, description, input_schema }
      const fn = (tool as any)?.function ?? tool;
      const name = fn?.name;

      // MCP tools use double underscore: server__tool
      if (!name || !name.includes("__")) continue;

      const parts = name.split("__");
      if (parts.length < 2) continue;

      const server = parts[0];
      const toolName = parts.slice(1).join("__"); // tool name might have __

      mcpTools.push({
        server,
        tool: toolName,
        inputSchema: fn?.parameters ?? fn?.input_schema ?? { type: "object", properties: {} },
      });
    }

    if (mcpTools.length > 0) {
      console.log(
        `[gitlab-duo] Registered ${mcpTools.length} MCP tools:`,
        mcpTools.map((t: any) => `${t.server}__${t.tool}`),
      );
    }

    return mcpTools;
  }

  // ─── Result shaping ──────────────────────────────────────────────────────

  private async toOneShotResult(
    turn: Promise<TurnResult>,
    request: ChatCompletionRequest,
    modelRef: string,
  ): Promise<ProviderResult> {
    let result: TurnResult;
    try {
      result = await turn;
    } catch (e) {
      return { success: false, error: errMsg(e), ...this.classifyError(e) };
    }

    const id = this.generateId();
    const created = NOW_S();

    if (result.toolCall) {
      // Register the WS so the next turn (which will carry a tool_result) can
      // find it and resume via actionResponse.
      //
      // DRY NOTE: this session-registration + token/credit computation block is
      // duplicated in toStreamResult's final-usage path (search for the other
      // registerSession([tc.id], ...) call). The two intentionally diverge in
      // how they SHAPE output (ChatCompletionResponse vs SSE StreamChunk) but
      // share the registration + estimateMessagesTokens + creditsPerCall logic.
      // A future refactor should extract a private registerTurnAndComputeCredits()
      // helper so the credit formula has one authoritative home; until then,
      // changes here must be mirrored in the streaming path.
      const tc = result.toolCall;
      const cb: SessionCallbacks = {
        // Continuation iterators will replace these — keep them as no-ops here
        // so a WS message before re-attach doesn't blow up.
        enqueue: () => {},
        finish: () => {},
        fail: () => {},
      };
      registerSession(
        [tc.id], result.ws, result.workflowId, tc.requestID, cb,
        new Map([[tc.id, tc.requestID]]),
        result.totalAgentCount,
        result.emittedAgentTexts,
      );

      const toolCalls = [{
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.argsJson },
      }];
      const message: any = { role: "assistant", content: result.content || null, tool_calls: toolCalls };
      const promptTokens = this.estimateMessagesTokens(request.messages ?? []);
      const completionTokens = this.estimateTokens(result.content) + this.estimateTokens(tc.argsJson);
      // Credit accounting — see ./credits.ts. Each `agent` message in this
      // turn = 1 LLM call; rate depends on the model and (for some) input
      // context size. Tool-yield turns count too because reaching the tool
      // decision required ≥1 LLM call.
      const creditsUsed = result.agentCalls * creditsPerCall(modelRef, promptTokens);

      const resp: ChatCompletionResponse = {
        id,
        object: "chat.completion",
        created,
        model: request.model,
        choices: [{ index: 0, message, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      };
      return {
        success: true, response: resp,
        promptTokens, completionTokens,
        tokensUsed: promptTokens + completionTokens,
        creditsUsed, creditSource: "estimated",
      };
    }

    // Plain text close.
    try { result.ws.close(1000, "turn_done"); } catch {/* ignore */}
    evictByWs(result.ws, "turn_done");

    const promptTokens = this.estimateMessagesTokens(request.messages ?? []);
    const completionTokens = this.estimateTokens(result.content);
    const creditsUsed = result.agentCalls * creditsPerCall(modelRef, promptTokens);
    const resp: ChatCompletionResponse = {
      id,
      object: "chat.completion",
      created,
      model: request.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: result.content || "" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    };
    return {
      success: true, response: resp,
      promptTokens, completionTokens,
      tokensUsed: promptTokens + completionTokens,
      creditsUsed, creditSource: "estimated",
    };
  }

  /**
   * Streaming variant. We don't get incremental deltas from the proto in a
   * way that's cheap to map (the `content` is a cumulative string, not
   * per-chunk), so we publish a single text chunk after the turn completes
   * and let the SSE framing do its job. Tool calls are emitted as a final
   * tool_calls chunk before [DONE].
   *
   * If we need true token-level streaming later, hook into the cumulative
   * diff (cumulative.slice(prev.length)) inside `collectTurn` and bridge it
   * through the ReadableStream below.
   */
  private async toStreamResult(
    ws: WebSocket,
    workflowId: string,
    request: ChatCompletionRequest,
    modelRef: string,
    sendStart: boolean,
    actionResponse?: { requestID: string; response: string },
    actionResponses?: Array<{ requestID: string; text: string; isError: boolean }>,
    priorAgentCount = 0,
    priorEmittedTexts: Set<string> = new Set(),
    session?: any,
  ): Promise<ProviderResult> {
    const id = this.generateId();
    const created = NOW_S();
    const provider = this;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        // Track whether the controller is still writable. If the client
        // disconnects, `enqueue` throws and we must stop pumping — including
        // the heartbeat below.
        let closed = false;
        const safeEnqueue = (bytes: Uint8Array) => {
          if (closed) return;
          try { controller.enqueue(bytes); }
          catch { closed = true; }
        };
        const send = (chunk: StreamChunk) =>
          safeEnqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));

        // SSE keepalive — periodic comment line keeps the TCP socket from
        // going idle, so neither Bun's `idleTimeout` nor any intermediate
        // proxy/load-balancer cuts the response while a long upstream turn
        // is "thinking". Comment lines are ignored by every spec-compliant
        // SSE parser, so they're invisible to the client model. Configurable
        // via `POOLPROX_GITLAB_DUO_SSE_HEARTBEAT_MS` (default 15s).
        const heartbeatMs = config.gitlabDuoSseHeartbeatMs;
        const lastWriteRef = { ts: Date.now() };
        const heartbeatTimer = setInterval(() => {
          if (closed) return;
          // Only emit when we've actually been quiet — saves bandwidth on
          // chatty turns and avoids interleaving comments between rapid
          // delta chunks.
          if (Date.now() - lastWriteRef.ts >= heartbeatMs) {
            safeEnqueue(enc.encode(`: keepalive ${Date.now()}\n\n`));
            lastWriteRef.ts = Date.now();
          }
        }, Math.max(1000, Math.floor(heartbeatMs / 2)));

        // Emit role first, BEFORE collectTurn awaits anything — so the client
        // sees the assistant role immediately and incremental content deltas
        // can flow through as the workflow generates them.
        send({
          id, object: "chat.completion.chunk", created, model: request.model,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        });
        lastWriteRef.ts = Date.now();

        // Real-streaming wiring: every text delta from collectTurn becomes its
        // own SSE chunk. Critical for the "ngadat after shell" UX — without
        // this the user stares at a blank screen until the whole turn ends.
        // We accumulate everything we've forwarded so the terminal safety-net
        // below can emit ONLY the missing tail (never the whole answer again,
        // which is what produced the stop-stop / duplicate-text symptom).
        let emittedText = "";
        const onDelta = (delta: string) => {
          if (!delta || closed) return;
          emittedText += delta;
          send({
            id, object: "chat.completion.chunk", created, model: request.model,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          });
          lastWriteRef.ts = Date.now();
        };

        try {
          const turn = await provider.collectTurn(
            ws, workflowId, request, sendStart, actionResponse, onDelta, actionResponses,
            priorAgentCount, priorEmittedTexts, session,
          );

          // Safety net: the final `turn.content` is the authoritative full
          // text. If anything is still un-emitted (onDelta missed a chunk,
          // or a terminal frame carried text past what we streamed),
          // forward ONLY the missing suffix.
          //
          // CRITICAL: never emit the full `turn.content` on prefix-mismatch.
          // That was the "doubled text" bug — when Duo lightly reformatted
          // earlier text mid-stream, `turn.content` no longer started with
          // `emittedText`, and the old "emit full" fallback caused the whole
          // answer to be sent again on top of what was already streamed.
          // The user-visible symptom: same paragraph appears twice in chat.
          //
          // Now: only the strict suffix past `emittedText.length` (which is
          // an exact byte count of what's on the wire). If `turn.content`
          // diverged from `emittedText`, we accept that the wire view differs
          // slightly from the canonical text — better than doubling.
          if (turn.content && turn.content.length > emittedText.length) {
            const tail = turn.content.slice(emittedText.length);
            if (tail) {
              send({
                id, object: "chat.completion.chunk", created, model: request.model,
                choices: [{ index: 0, delta: { content: tail }, finish_reason: null }],
              });
            }
          }

          // Compute final credits for THIS turn now that we know how many
          // LLM calls happened. Emit them as a synthetic usage chunk before
          // [DONE] — proxy/index.ts:extractUsageFromSsePayload picks it up
          // and the request-log finalizer records the real number instead
          // of the conservative pre-stream estimate.
          const promptTokensFinal = provider.estimateMessagesTokens(request.messages ?? []);
          const completionTokensFinal = provider.estimateTokens(turn.content) +
            (turn.toolCall ? provider.estimateTokens(turn.toolCall.argsJson) : 0);
          const totalTokensFinal = promptTokensFinal + completionTokensFinal;
          const creditsUsedFinal = turn.agentCalls * creditsPerCall(modelRef, promptTokensFinal);

          if (turn.toolCall) {
            const tc = turn.toolCall;
            registerSession(
              [tc.id], turn.ws, turn.workflowId, tc.requestID,
              { enqueue: () => {}, finish: () => {}, fail: () => {} },
              new Map([[tc.id, tc.requestID]]),
              turn.totalAgentCount,
              turn.emittedAgentTexts,
            );
            send({
              id, object: "chat.completion.chunk", created, model: request.model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: tc.id,
                    type: "function",
                    function: { name: tc.name, arguments: tc.argsJson },
                  }] as any,
                },
                finish_reason: null,
              }],
            });
            send({
              id, object: "chat.completion.chunk", created, model: request.model,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              // Tail usage chunk — picked up by extractUsageFromSsePayload.
              // OpenAI-compatible: top-level `usage` is the standard place;
              // `credits_used` is our extension that computeCredits respects.
              usage: {
                prompt_tokens: promptTokensFinal,
                completion_tokens: completionTokensFinal,
                total_tokens: totalTokensFinal,
                credits_used: creditsUsedFinal,
              },
            } as StreamChunk & { usage: unknown });
          } else {
            try { turn.ws.close(1000, "stream_done"); } catch {/* ignore */}
            evictByWs(turn.ws, "stream_done");
            send({
              id, object: "chat.completion.chunk", created, model: request.model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: promptTokensFinal,
                completion_tokens: completionTokensFinal,
                total_tokens: totalTokensFinal,
                credits_used: creditsUsedFinal,
              },
            } as StreamChunk & { usage: unknown });
          }

          safeEnqueue(enc.encode("data: [DONE]\n\n"));
          if (!closed) { try { controller.close(); } catch {/* ignore */} closed = true; }
        } catch (e) {
          try { ws.close(1011, "stream_error"); } catch {/* ignore */}
          evictByWs(ws, "stream_error");
          const msg = errMsg(e);
          safeEnqueue(enc.encode(`data: ${JSON.stringify({
            id, object: "chat.completion.chunk", created, model: request.model,
            choices: [{ index: 0, delta: { content: `\n[gitlab-duo error] ${msg}` }, finish_reason: "stop" }],
          })}\n\n`));
          safeEnqueue(enc.encode("data: [DONE]\n\n"));
          if (!closed) { try { controller.close(); } catch {/* ignore */} closed = true; }
        } finally {
          // Always tear down the heartbeat — leaking it pins the stream and
          // the controller in memory, and on client disconnect it would loop
          // forever calling enqueue on a dead controller.
          clearInterval(heartbeatTimer);
        }
      },
      cancel() {
        // Client closed the connection (e.g. user hit ESC). Best-effort: drop
        // the upstream WS so we don't keep the workflow running for nobody.
        try { ws.close(1000, "client_cancel"); } catch {/* ignore */}
        evictByWs(ws, "client_cancel");
      },
    });

    // Conservative initial estimate. The final value is sent as a synthetic
    // SSE `usage` chunk just before `[DONE]` (see above) and the proxy-level
    // finalizer (extractUsageFromSsePayload) overrides this with the real
    // number once the turn completes.
    const promptTokensEst = this.estimateMessagesTokens(request.messages ?? []);
    const creditsUsedEst = creditsPerCall(modelRef, promptTokensEst);
    return {
      success: true, stream,
      promptTokens: promptTokensEst,
      creditsUsed: creditsUsedEst,
      creditSource: "estimated",
    };
  }
}
