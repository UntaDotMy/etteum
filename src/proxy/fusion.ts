/**
 * Fusion strategy for combo routing.
 *
 * Fans out to all models in a combo in parallel and returns the first
 * successful (fulfilled) response. A future iteration can use a judge model
 * to score and rank responses rather than just returning the first to succeed.
 *
 * SEMANTICS NOTE: this uses Promise.allSettled — it waits for ALL models to
 * settle, then returns the first fulfilled result. It is NOT a true race
 * (which would cancel losing requests via AbortController before they finish).
 * Consequence: every model's request is issued and billed even after one has
 * succeeded, and latency = the slowest model, not the fastest. Losing STREAMS
 * are cancelled and their pool tracking released once a winner is picked (see
 * releaseLosingResults); a true race would additionally abort them in flight,
 * which needs an AbortSignal threaded through routeRequest → provider fetches.
 */

import type { ChatCompletionRequest } from "./providers/base";
import type { RouteResult } from "./router";
import { routeRequest } from "./router";
import { pool } from "./pool";
import { broadcast } from "../ws/index";

/**
 * Release every fulfilled fan-out result except the winner.
 *
 * why: routeRequest hands a SUCCESSFUL stream to the caller and deliberately
 * skips pool.trackRequestEnd; the stream finalizer owns that release. Only the
 * winner reaches a finalizer, so an abandoned loser's in-flight count never
 * returns to zero and the least-in-flight balancer stops picking that account
 * for the life of the process. Cancelling also frees the upstream socket.
 */
export function releaseLosingResults(
  results: PromiseSettledResult<RouteResult>[],
  winnerIndex: number,
): void {
  for (let i = 0; i < results.length; i++) {
    if (i === winnerIndex) continue;
    const r = results[i];
    if (!r || r.status !== "fulfilled") continue;
    const loser = r.value;
    if (!loser.result?.stream) continue; // non-stream results already released
    try {
      void loser.result.stream.cancel();
    } catch {
      /* already closed */
    }
    if (loser.account?.id > 0) pool.trackRequestEnd(loser.account.id);
  }
}

export interface FusionOptions {
  request: ChatCompletionRequest;
  comboName: string;
  models: string[];
  judgeModel?: string;
}

export interface FusionResult {
  result: RouteResult;
  model: string;
  /** All models that were tried and failed */
  errors: Array<{ model: string; error: string }>;
}

export async function routeComboFusion(opts: FusionOptions): Promise<RouteResult> {
  const { request, comboName, models, judgeModel } = opts;

  // Fan out to all models (collect-all via allSettled); return first fulfilled.
  const errors: Array<{ model: string; error: string }> = [];

  const results = await Promise.allSettled(
    models.map(async (modelSpec) => {
      return routeRequest({ ...request, model: modelSpec }, request.stream ?? false, { _skipComboExpansion: true });
    })
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r) continue;
    if (r.status === "fulfilled") {
      const winner = models[i] ?? `model-${i}`;
      releaseLosingResults(results, i);
      broadcast({
        type: "combo_success",
        data: { comboName, model: winner, allModels: models, strategy: "fusion" },
      });
      return r.value;
    }
    errors.push({ model: models[i] ?? `model-${i}`, error: String((r as PromiseRejectedResult).reason) });
  }
  // Nothing won; release any fulfilled-but-unused stream before throwing.
  releaseLosingResults(results, -1);

  broadcast({
    type: "combo_fusion_exhausted",
    data: { comboName, models, errors },
  });

  throw new Error(
    `Combo "${comboName}" all models failed: ${errors.map((e) => `${e.model}: ${e.error}`).join("; ")}`
  );
}

/**
 * Flatten tool turns into prose so panel/judge models that can't handle tool
 * calls still get the conversation context. Ported from the reference proxy
 * open-sse/services/combo.js flattenToolHistory (~line 21-55).
 *
 * Converts each tool_call + tool_result pair into a user/assistant text
 * exchange describing what was called and what came back (truncated).
 */
export function flattenToolHistory(messages: any[]): any[] {
  const out: any[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      // Describe the tool calls the assistant made.
      const calls = m.tool_calls.map((tc: any) => {
        const fn = tc?.function?.name || "tool";
        let args = "";
        try { args = tc?.function?.arguments ? String(tc.function.arguments).slice(0, 200) : ""; } catch { /* ignore */ }
        return `${fn}(${args})`;
      }).join("; ");
      out.push({ role: "assistant", content: `[called tools: ${calls}]` });
    } else if (m.role === "tool") {
      // Summarize the tool result.
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      out.push({ role: "user", content: `[tool result: ${content.slice(0, 500)}]` });
    } else if (m.role === "assistant" && m.tool_calls == null) {
      // Plain assistant message — keep (but coerce content to string).
      out.push({ role: "assistant", content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") });
    } else {
      // user / system / other — keep as-is.
      out.push(m);
    }
  }
  return out;
}

/**
 * Judge-model fusion. Runs all models in parallel, collects successful
 * responses, then asks a judge model to pick the best one. Ported from
 * the reference proxy open-sse/services/combo.js handleFusionChat (~line 440-571):
 *   - 1 success  → return it directly (no judge needed)
 *   - 0 success  → throw (all exhausted)
 *   - 2+ success → judge picks
 */
export async function routeComboFusionWithJudge(opts: FusionOptions): Promise<RouteResult> {
  const { request, comboName, models, judgeModel } = opts;
  if (!judgeModel) {
    // No judge configured → fall back to race semantics.
    return routeComboFusion(opts);
  }

  const errors: Array<{ model: string; error: string }> = [];
  const successes: Array<{ model: string; result: RouteResult }> = [];

  const results = await Promise.allSettled(
    models.map(async (modelSpec) => routeRequest({ ...request, model: modelSpec }, false, { _skipComboExpansion: true }))
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r) continue;
    if (r.status === "fulfilled") {
      successes.push({ model: models[i] ?? `model-${i}`, result: r.value });
    } else {
      errors.push({ model: models[i] ?? `model-${i}`, error: String((r as PromiseRejectedResult).reason) });
    }
  }

  // Degrade path: 1 success → return directly (no judge needed).
  if (successes.length === 1) {
    broadcast({ type: "combo_success", data: { comboName, model: successes[0]!.model, allModels: models, strategy: "fusion-judge-degraded" } });
    return successes[0]!.result;
  }
  // 0 successes → exhausted.
  if (successes.length === 0) {
    broadcast({ type: "combo_fusion_exhausted", data: { comboName, models, errors } });
    throw new Error(`Combo "${comboName}" all models failed: ${errors.map((e) => `${e.model}: ${e.error}`).join("; ")}`);
  }

  // 2+ successes → judge picks. Build a judge prompt with each candidate answer.
  const candidates = successes.map((s, idx) => {
    const text = typeof s.result.result?.response === "string"
      ? s.result.result.response
      : JSON.stringify(s.result.result?.response ?? "");
    return `--- Candidate ${idx + 1} (model: ${s.model}) ---\n${text}`;
  }).join("\n\n");

  const judgeMessages = [
    { role: "system", content: "You are a fusion judge. Multiple AI assistants answered the same user request. Pick the SINGLE best answer based on correctness, completeness, and conciseness. Reply with ONLY the best answer's text, verbatim — no preamble, no 'Candidate N' label." },
    ...flattenToolHistory(request.messages || []),
    { role: "user", content: `The user's original request is in the conversation above. Here are ${successes.length} candidate answers:\n\n${candidates}\n\nReply with only the best answer, verbatim.` },
  ];

  const judgeResult = await routeRequest(
    { ...request, model: judgeModel, messages: judgeMessages as any, stream: false, tools: undefined },
    false,
    { _skipComboExpansion: true },
  );

  broadcast({ type: "combo_success", data: { comboName, model: judgeModel, allModels: models, strategy: "fusion-judge", judgedFrom: successes.map((s) => s.model) } });
  return judgeResult;
}
