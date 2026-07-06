/**
 * Fusion strategy for combo routing.
 *
 * Fires all models in a combo in parallel and returns the first successful
 * response. A future iteration can use a judge model to score and rank
 * responses rather than just returning the fastest to respond.
 *
 * Currently: "race" semantics — first to respond wins.
 * Future: judge-model scoring for quality-ranked selection.
 */

import type { ChatCompletionRequest } from "./providers/base";
import type { RouteResult } from "./router";
import { routeRequest } from "./router";
import { broadcast } from "../ws/index";

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

  // Race all models — first successful response wins
  const errors: Array<{ model: string; error: string }> = [];

  const results = await Promise.allSettled(
    models.map(async (modelSpec) => {
      return routeRequest({ ...request, model: modelSpec }, request.stream ?? false);
    })
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      const winner = models[i];
      broadcast({
        type: "combo_success",
        data: { comboName, model: winner, allModels: models, strategy: "fusion" },
      });
      return r.value;
    }
    errors.push({ model: models[i], error: String((r as PromiseRejectedResult).reason) });
  }

  broadcast({
    type: "combo_fusion_exhausted",
    data: { comboName, models, errors },
  });

  throw new Error(
    `Combo "${comboName}" all models failed: ${errors.map((e) => `${e.model}: ${e.error}`).join("; ")}`
  );
}

/**
 * Judge-model fusion (future).
 *
 * Runs all models in parallel, collects all responses, then uses a judge model
 * to score each response and return the best one by quality.
 *
 * Not yet implemented — requires a judge provider to be configured.
 */
export async function routeComboFusionWithJudge(
  _opts: FusionOptions
): Promise<never> {
  throw new Error(
    "Judge-model fusion is not yet implemented. Configure a judge provider to enable quality-ranked fusion."
  );
}
