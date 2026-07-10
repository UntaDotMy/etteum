/**
 * Custom-models registry (F15: dashboard-driven model catalog).
 *
 * Lets the operator add / edit / disable / delete models per provider from the
 * dashboard, persisted in the `kv` table (scopes: customModels, disabledModels).
 *
 * Architecture mirrors the proven compatible-node registry (F13):
 *   - async refresh() loads custom/disabled entries from the DB into an
 *     in-memory cache (called at boot + after CRUD, exactly like
 *     compatibleNodeRegistry.refresh).
 *   - SYNC resolution functions read that cache on the hot routing/listing path
 *     (getAllModels / getProviderForModel are sync), so no per-request DB read.
 *
 * This is a LAYERED extension to the provider registry — it does not replace the
 * hardcoded supportedModels arrays. Custom models are merged into the list and
 * consulted for routing between the static providers and the kiro fallback,
 * exactly where compatible-nodes already sit (registry.ts getProviderForModel).
 *
 * Spec override: a custom entry MAY carry a `spec` (context_window / max_output
 * / thinking / vision). When present it overrides the model-specs.ts default;
 * when absent the canonical registry default applies (resolved by the caller).
 * The source model-specs.ts file is never mutated — overrides live only in kv.
 */
import { db } from "../../db/index";
import { kv } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { ModelInfo } from "./base";

/** A user-defined model spec override (all optional; absent = use defaults). */
export interface CustomModelSpec {
  context_window?: number;
  max_output?: number;
  thinking?: boolean;
  vision?: boolean;
}

/** A stored custom-model entry (value column of kv(customModels), keyed by model id). */
export interface CustomModelEntry {
  provider: string;
  displayName?: string;
  spec?: CustomModelSpec;
}

/** A stored disabled-model entry (keyed by `${provider}:${model}`). */
export interface DisabledModelEntry {
  provider: string;
  model: string;
  disabledAt?: number;
}

class CustomModelsRegistry {
  private custom: Record<string, CustomModelEntry> = {};
  private disabled: Record<string, DisabledModelEntry> = {};
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  /** Load (or reload) custom + disabled models from the kv table. */
  async refresh(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      try {
        const [customRows, disabledRows] = await Promise.all([
          db.select().from(kv).where(eq(kv.scope, "customModels")),
          db.select().from(kv).where(eq(kv.scope, "disabledModels")),
        ]);
        this.custom = {};
        for (const r of customRows) {
          try { this.custom[r.key] = JSON.parse(r.value); } catch { /* skip malformed */ }
        }
        this.disabled = {};
        for (const r of disabledRows) {
          try { this.disabled[r.key] = JSON.parse(r.value); } catch { /* skip malformed */ }
        }
        this.loaded = true;
      } catch (err) {
        console.error("[CustomModels] refresh failed:", err);
      } finally {
        this.loadPromise = null;
      }
    })();
    return this.loadPromise;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /** Resolve a custom model id → its assigned provider. Null if not custom. */
  getCustomModelProvider(model: string): string | null {
    if (!model) return null;
    const entry = this.custom[model];
    return entry?.provider ?? null;
  }

  /** All custom models as ModelInfo (for merging into /v1/models). */
  getCustomModels(): ModelInfo[] {
    return Object.entries(this.custom).map(([id, entry]) => ({
      id,
      object: "model" as const,
      created: Date.now(),
      owned_by: entry.provider,
      ...(entry.displayName ? { display_name: entry.displayName } : {}),
      ...(entry.spec?.context_window != null ? { context_window: entry.spec.context_window } : {}),
      ...(entry.spec?.max_output != null ? { max_output: entry.spec.max_output } : {}),
      ...(entry.spec?.thinking != null ? { thinking: entry.spec.thinking } : {}),
      ...(entry.spec?.vision != null ? { vision: entry.spec.vision } : {}),
    }));
  }

  /** Is this model id disabled (by any provider)? Disabled is model-scoped. */
  isModelDisabled(model: string): boolean {
    if (!model) return false;
    // Disabled entries are keyed provider:model; a model is disabled if ANY
    // provider disabled it (a model id is unique to one provider in practice).
    for (const key of Object.keys(this.disabled)) {
      if (key.endsWith(`:${model}`)) return true;
    }
    return false;
  }

  /**
   * Merge custom models into a base list AND filter out disabled models.
   * Used by getAllModels() to produce the final /v1/models catalog.
   * Custom models whose id already exists in the base list are NOT duplicated
   * (the hardcoded entry wins on id; this avoids duplicate rows).
   */
  applyCustomModelsToList(base: ModelInfo[]): ModelInfo[] {
    const existingIds = new Set(base.map((m) => m.id));
    const extras = this.getCustomModels().filter((m) => !existingIds.has(m.id));
    return [...base, ...extras].filter((m) => !this.isModelDisabled(m.id));
  }

  // --- Test-only injection hooks (the DB-backed refresh is exercised via the
  //     management API integration path; these let the pure resolution layer
  //     be unit-tested without a live database). ---
  /** @internal */
  __setCustomModelsForTest(c: Record<string, CustomModelEntry>): void {
    this.custom = c;
    this.loaded = true;
  }
  /** @internal */
  __setDisabledModelsForTest(d: Record<string, DisabledModelEntry>): void {
    this.disabled = d;
    this.loaded = true;
  }
  /** @internal */
  reset(): void {
    this.custom = {};
    this.disabled = {};
    this.loaded = false;
    this.loadPromise = null;
  }
}

export const customModelsRegistry = new CustomModelsRegistry();

/** Ensure the registry is loaded (call at boot + after model CRUD). */
export async function ensureCustomModelsLoaded(): Promise<void> {
  if (!customModelsRegistry.isLoaded()) {
    await customModelsRegistry.refresh();
  }
}

// --- Re-exported free functions for callers + tests ---
export function getCustomModelProvider(model: string): string | null {
  return customModelsRegistry.getCustomModelProvider(model);
}
export function getCustomModels(): ModelInfo[] {
  return customModelsRegistry.getCustomModels();
}
export function isModelDisabled(model: string): boolean {
  return customModelsRegistry.isModelDisabled(model);
}
export function applyCustomModelsToList(base: ModelInfo[]): ModelInfo[] {
  return customModelsRegistry.applyCustomModelsToList(base);
}

// --- Test-only exports (kept out of the public surface by the __ prefix) ---
export function resetCustomModelsRegistry(): void {
  customModelsRegistry.reset();
}
export function __setCustomModelsForTest(c: Record<string, CustomModelEntry>): void {
  customModelsRegistry.__setCustomModelsForTest(c);
}
export function __setDisabledModelsForTest(d: Record<string, DisabledModelEntry>): void {
  customModelsRegistry.__setDisabledModelsForTest(d);
}
