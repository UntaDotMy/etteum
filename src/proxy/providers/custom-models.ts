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
  /**
   * When set, this entry RENAMES a hardcoded catalog model: the model whose id
   * equals `renameFrom` is removed from the list and replaced by this entry
   * (keyed by the new id). Used when an upstream renames a model and the
   * operator wants to update the proxy's catalog id without code changes
   * (e.g. cbc-hy3-preview → cbc-hy3). Routing still resolves via the provider's
   * ownsModel()/resolveModel(), so the new id must match the provider's prefix
   * pattern; the provider translates it to the upstream name.
   */
  renameFrom?: string;
  /**
   * The upstream API model name to send to the provider (overrides the
   * provider's hardcoded resolveModel map). Used when an upstream renames a
   * model and the operator updates the catalog: e.g. rename cbc-hy3-preview →
   * cbc-hy3 with upstreamName 'hy3' → the proxy catalog shows cbc-hy3 and the
   * provider sends 'hy3' upstream. Looked up by BOTH the new id and the old
   * (renameFrom) id so already-deployed clients using either name still route.
   */
  upstreamName?: string;
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
   *
   * - A custom entry WITHOUT `renameFrom` is added if its id isn't already in
   *   the base list (avoids duplicates).
   * - A custom entry WITH `renameFrom` REPLACES the base model whose id equals
   *   `renameFrom` with this entry's id (catalog rename). The base entry is
   *   removed so only the new id remains.
   */
  applyCustomModelsToList(base: ModelInfo[]): ModelInfo[] {
    // Build the set of ids to remove (renamed-away ids).
    const renamedAway = new Set<string>();
    for (const entry of Object.values(this.custom)) {
      if (entry.renameFrom) renamedAway.add(entry.renameFrom);
    }
    // Start from base, minus renamed-away entries.
    let merged = base.filter((m) => !renamedAway.has(m.id));

    // Add custom entries that are either new ids OR renames (their new id
    // replaces the removed base entry). Skip pure-adds whose id already exists.
    const existingIds = new Set(merged.map((m) => m.id));
    const customModels = this.getCustomModels();
    for (const cm of customModels) {
      // Renames always go in (their new id replaced the old). Pure-adds only if
      // the id isn't already present.
      const isRename = !!this.findRenameEntry(cm.id);
      if (isRename || !existingIds.has(cm.id)) {
        merged.push(cm);
        existingIds.add(cm.id);
      }
    }
    return merged.filter((m) => !this.isModelDisabled(m.id));
  }

  /** Find the custom entry whose new id is `newId` AND has a renameFrom. */
  private findRenameEntry(newId: string): CustomModelEntry | undefined {
    const entry = this.custom[newId];
    return entry?.renameFrom ? entry : undefined;
  }

  /**
   * Look up a custom-model upstream-name override for `modelId`.
   * Checks the entry keyed by `modelId` AND any entry whose `renameFrom`
   * equals `modelId` (so a request for the OLD id still resolves to the new
   * upstream name). Returns the override or null.
   */
  getUpstreamNameOverride(modelId: string): string | null {
    if (!modelId) return null;
    // Direct key match.
    const direct = this.custom[modelId];
    if (direct?.upstreamName) return direct.upstreamName;
    // renameFrom match (request came in on the old id).
    for (const entry of Object.values(this.custom)) {
      if (entry.renameFrom === modelId && entry.upstreamName) return entry.upstreamName;
    }
    return null;
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

/**
 * Look up a custom-model upstream-name override for `modelId`.
 * Providers call this in their resolveModel() to honor operator-set upstream
 * names (from catalog renames). Returns null when no override is set.
 */
export function getUpstreamNameOverride(modelId: string): string | null {
  return customModelsRegistry.getUpstreamNameOverride(modelId);
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
