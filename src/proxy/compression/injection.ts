/**
 * Output-reducing prompt-injection applicator (F11).
 *
 * Ported from 9router open-sse/rtk/caveman.js + ponytail.js + cavemanGuard.js.
 * Appends output-reducing instructions to the system prompt so the MODEL emits
 * fewer tokens. Distinct from the input-side compression/caveman.ts &
 * compression/ponytail.ts (which rewrite existing text); both coexist.
 */
import type { ChatCompletionRequest } from "../providers/base";
import { injectSystemPrompt } from "./system-inject";
import { CAVEMAN_INJECTION_PROMPTS, PONYTAIL_INJECTION_PROMPTS, type CavemanInjectionLevel, type PonytailInjectionLevel } from "./injection-prompts";

export interface CavemanInjectionConfig {
  enabled: boolean;
  level: CavemanInjectionLevel;
}

export interface PonytailInjectionConfig {
  enabled: boolean;
  level: PonytailInjectionLevel;
}

/**
 * Guard mirroring reference cavemanGuard.js: skip caveman injection for
 * GLM models on the Responses API (the terse-style injection degrades GLM
 * reasoning on the Responses wire format). Returns true when injection should
 * be SKIPPED.
 */
export function shouldSkipCavemanInjection(
  request: ChatCompletionRequest,
  providerName?: string,
): boolean {
  const model = (request.model || "").toLowerCase();
  const isGlm = model.includes("glm");
  // Responses API requests carry an `input` array or `instructions` string.
  const isResponses = Array.isArray((request as any).input) || typeof (request as any).instructions === "string";
  // Provider hint: codebuddy-china serves GLM.
  const isGlmProvider = providerName === "codebuddy-china";
  return isGlm && (isResponses || isGlmProvider);
}

export interface ApplyInjectionResult {
  request: ChatCompletionRequest;
  /** chars of prompt text appended (input-side estimate; real savings are on OUTPUT). */
  saved: number;
}

/**
 * Apply caveman + ponytail OUTPUT-reducing injections to the system prompt.
 * Each injection appends its prompt via the cache-aware system-inject helper.
 * `saved` is reported as 0 (these reduce OUTPUT tokens, not input; the value
 * is realized at the upstream provider, not measurable in the request body).
 */
export function applyInjections(
  request: ChatCompletionRequest,
  caveman: CavemanInjectionConfig,
  ponytail: PonytailInjectionConfig,
  providerName?: string,
): ApplyInjectionResult {
  let current = request;
  let appended = 0;

  if (caveman.enabled && !shouldSkipCavemanInjection(current, providerName)) {
    const prompt = CAVEMAN_INJECTION_PROMPTS[caveman.level] ?? CAVEMAN_INJECTION_PROMPTS.full;
    injectSystemPrompt(current, prompt);
    appended += prompt.length;
  }

  if (ponytail.enabled) {
    const prompt = PONYTAIL_INJECTION_PROMPTS[ponytail.level] ?? PONYTAIL_INJECTION_PROMPTS.full;
    injectSystemPrompt(current, prompt);
    appended += prompt.length;
  }

  // Injections ADD input chars but reduce OUTPUT tokens. Report saved=0 so the
  // stats don't falsely claim input reduction; the technique is tracked by
  // presence in byTechnique so the dashboard knows it ran.
  return { request: current, saved: 0 };
}
