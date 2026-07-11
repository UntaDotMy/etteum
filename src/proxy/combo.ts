/**
 * Combo system: multi-model fallback chains.
 *
 * Clients send a model string like "premium/claude-sonnet" and the router
 * expands it to a chain of (provider, model) pairs from the matching combo.
 * If no combo matches, the model is routed normally.
 *
 * Combo strategies (stored per-combo in settings as comboStrategies JSON):
 *   fallback  — try first model; on error/rate-limit, fall through to next
 *   fusion    — parallel inference across all models; a judge model picks the best
 *                response (advanced — see fusion.ts)
 *
 * NOTE: a "sticky" strategy value appears in the ComboStrategy type for
 * back-compat, but it is NOT implemented — routeCombo throws if selected.
 *
 * Account exclusion is tracked per combo: if account-1 fails on model-1, it is
 * excluded when retrying model-2 within the same combo.
 */

import { db } from "../db/index";
import { combos } from "../db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { pool } from "./pool";
import type { ProviderName } from "./providers/registry";
import type { RouteResult } from "./router";
import { routeRequest } from "./router";
import type { ChatCompletionRequest } from "./providers/base";
import { getProviderForModel } from "./providers/registry";
import { routeComboFusion, routeComboFusionWithJudge } from "./fusion";

// ─── Settings helpers ──────────────────────────────────────────────────────────

interface ComboStrategy {
  fallbackStrategy?: "fallback" | "sticky" | "fusion";
  judgeModel?: string;
  fusionTuning?: Record<string, unknown>;
}

const _strategyCache: Map<string, { strategies: Record<string, ComboStrategy>; expiresAt: number }> = new Map();

async function getComboStrategies(): Promise<Record<string, ComboStrategy>> {
  const now = Date.now();
  const cached = _strategyCache.get("global");
  if (cached && cached.expiresAt > now) return cached.strategies;

  const { settings } = await import("../db/index");
  const { eq } = await import("drizzle-orm");
  const { default: schema } = await import("../db/schema");

  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "combo_strategies"))
    .limit(1);

  let strategies: Record<string, ComboStrategy> = {};
  if (rows[0]?.value) {
    try { strategies = JSON.parse(rows[0].value); } catch { /* ignore */ }
  }

  _strategyCache.set("global", { strategies, expiresAt: now + 10_000 });
  return strategies;
}

// ─── Combo CRUD ────────────────────────────────────────────────────────────────

export async function getAllCombos() {
  return db.select().from(combos).where(eq(combos.enabled, true));
}

export async function getComboByName(name: string) {
  const [row] = await db.select().from(combos).where(eq(combos.name, name)).limit(1);
  return row ?? null;
}

export async function createCombo(name: string, modelList: string[]) {
  const now = new Date();
  const [row] = await db.insert(combos).values({ name, models: modelList, enabled: true, createdAt: now, updatedAt: now }).returning();
  return row;
}

export async function updateCombo(id: number, modelList: string[]) {
  const [row] = await db.update(combos).set({ models: modelList, updatedAt: new Date() }).where(eq(combos.id, id)).returning();
  return row;
}

export async function deleteCombo(id: number) {
  await db.delete(combos).where(eq(combos.id, id));
}

export async function toggleCombo(id: number, enabled: boolean) {
  await db.update(combos).set({ enabled, updatedAt: new Date() }).where(eq(combos.id, id));
}

// ─── Model → Combo resolution ──────────────────────────────────────────────────

// Format: "combo-name/model-alias" or "combo-name" alone
// Examples: "premium/claude-sonnet", "zero-cost"
// The combo name is everything before the first "/". If there's no "/",
// the whole string is both combo name and the default model.
function parseComboModel(model: string): { comboName: string | null; alias: string } {
  const slash = model.indexOf("/");
  if (slash < 0) return { comboName: null, alias: model };
  const comboName = model.slice(0, slash);
  const alias = model.slice(slash + 1);
  return { comboName, alias };
}

export async function resolveCombo(model: string): Promise<string[] | null> {
  const { comboName } = parseComboModel(model);
  if (!comboName) return null;

  const combo = await getComboByName(comboName);
  if (!combo || !combo.enabled) return null;

  return combo.models as string[];
}

// ─── Reorder combo models by capability fit ────────────────────────────────────

function reorderByCapabilitiesLocal(models: string[], messages: { role: string; content: string | any[] | null }[]): string[] {
  if (models.length <= 1) return models;

  // Only import if capabilities module exists (it may not always be available)
  try {
    const { reorderByCapabilities, detectRequiredCapabilities } = require("./capabilities");
    // TODO: requires populated messages — when called before messages are
    // attached this is a clean no-op (detectRequiredCapabilities returns an
    // empty set and we return models unchanged), never a wrong reorder.
    const required = detectRequiredCapabilities(messages);
    if (!required.size) return models;

    return reorderByCapabilities(models, required, (m) => {
      const slash = m.indexOf("/");
      const provider = slash < 0 ? "" : m.slice(0, slash);
      const model = slash < 0 ? m : m.slice(slash + 1);
      return { provider, model };
    });
  } catch {
    return models;
  }
}

// ─── Combo routing ─────────────────────────────────────────────────────────────

export interface ComboRoutingOptions {
  request: ChatCompletionRequest;
  comboName: string;
  models: string[];
  onAccountFailed?: (accountId: number, model: string, error: string) => void;
}

export async function routeCombo(options: ComboRoutingOptions): Promise<RouteResult> {
  const { request, comboName, models } = options;
  const strategies = await getComboStrategies();
  const strategy = strategies[comboName]?.fallbackStrategy ?? "fallback";

  // "sticky" is documented but not implemented — fail loudly rather than
  // silently degrading to "fallback", which would mislead operators who
  // configured it expecting account-pinned semantics.
  if (strategy === "sticky") {
    throw new Error(
      `Combo "${comboName}" uses the "sticky" strategy, which is not implemented. ` +
      `Use "fallback" or "fusion" instead.`
    );
  }

  // Capability-based reordering for fallback strategies
  const orderedModels = strategy === "fusion"
    ? models // fusion tries all in parallel, no reordering needed
    : reorderByCapabilitiesLocal(models, request.messages ?? []);

  if (strategy === "fusion") {
    const judgeModel = strategies[comboName]?.judgeModel;
    // F12: when a judge model is configured, use judge-fusion (collect all
    // responses, judge picks the best). Otherwise race semantics (first wins).
    if (judgeModel) {
      return routeComboFusionWithJudge({ request, comboName, models: orderedModels, judgeModel });
    }
    return routeComboFusion({ request, comboName, models: orderedModels });
  }

  return routeComboFallback({ request, comboName, models: orderedModels, options });
}

interface ComboFallbackOptions {
  request: ChatCompletionRequest;
  comboName: string;
  models: string[];
  options: ComboRoutingOptions;
}

async function routeComboFallback(opts: ComboFallbackOptions): Promise<RouteResult> {
  const { request, comboName, models, options } = opts;

  const excludedAccounts = new Set<number>();
  let lastError = "";
  let lastErrorModel = "";

  for (const modelSpec of models) {
    // Try up to 3 accounts per model in the combo
    for (let attempt = 0; attempt < 3; attempt++) {
      const slash = modelSpec.indexOf("/");
      const providerName = slash < 0 ? getProviderForModel(modelSpec) : modelSpec.slice(0, slash);
      const modelName = slash < 0 ? modelSpec : modelSpec.slice(slash + 1);

      if (!providerName) {
        lastError = `No provider found for model: ${modelSpec}`;
        lastErrorModel = modelSpec;
        continue;
      }

      // Mirror routeRequest's account selection: BYOK uses the generic
      // getAccountForModel (prefix-based, also surfaces error/exhausted
      // accounts for retry) with exclusion; other providers use the
      // model-aware getNextAccountForModel so e.g. Alibaba accounts are
      // filtered to those that can actually query this model.
      // NOTE: getNextAccountForModel does not support excludeAccountIds, so
      // excluded accounts may be re-selected; routeRequest has the same
      // limitation for non-BYOK providers. Excluded set is still maintained
      // for the BYOK path below.
      let account;
      if (providerName === "byok") {
        account = (await pool.getAccountForModel(modelName, { excludeAccountIds: excludedAccounts }))?.account ?? null;
      } else {
        account = await pool.getNextAccountForModel(providerName, modelName);
        if (account && excludedAccounts.has(account.id)) {
          // Skip already-tried accounts; loop will fetch the next round.
          account = null;
        }
      }

      if (!account) {
        lastError = `No active accounts for ${modelSpec}`;
        lastErrorModel = modelSpec;
        break; // move to next model in combo
      }

      excludedAccounts.add(account.id);

      try {
        // Pass the SPLIT model name (after the slash) — not the full
        // "provider/model" spec — so routeRequest's getProviderForModel
        // matches the bare model id. Prefixed combo entries like
        // "gitlab-duo/claude-sonnet-4" would otherwise fail routing.
        const result = await routeRequest({ ...request, model: modelName }, request.stream ?? false);
        broadcast({
          type: "combo_success",
          data: { comboName, model: modelSpec, accountId: account.id },
        });
        return result;
      } catch (err: any) {
        lastError = err?.message ?? String(err);
        lastErrorModel = modelSpec;
        options.onAccountFailed?.(account.id, modelSpec, lastError);
        broadcast({
          type: "combo_fallback",
          data: { comboName, fromModel: modelSpec, error: lastError },
        });
        // Don't break — try next account for this model
      }
    }
  }

  // All models exhausted
  throw new Error(`Combo "${comboName}" exhausted: last error from ${lastErrorModel}: ${lastError}`);
}

// ─── Combo middleware ─────────────────────────────────────────────────────────

/**
 * Intercept a request and expand combo model names before routing.
 * Returns null if no combo matches (caller should route normally).
 */
export async function expandComboRequest(request: ChatCompletionRequest): Promise<{
  expanded: boolean;
  request: ChatCompletionRequest;
  comboName?: string;
  models?: string[];
} | null> {
  const modelStr = request.model ?? "";
  const { comboName, alias } = parseComboModel(modelStr);

  if (!comboName) return null;

  const chain = await resolveCombo(modelStr);
  if (!chain) return null;

  // Replace the combo/model request with just the alias (first model in chain)
  const firstModel = alias || chain[0];
  return {
    expanded: true,
    comboName,
    models: chain,
    request: { ...request, model: firstModel },
  };
}
