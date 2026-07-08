/**
 * Dynamic compatible-node provider system (F13).
 *
 * Ported from the reference proxy providerNodes + nodesRepo + the model.js prefix resolution.
 * Lets users add OpenAI/Anthropic-compatible endpoints at runtime via the
 * dashboard (stored in the `provider_nodes` table), resolved by model prefix —
 * no provider class needed per node.
 *
 * A `CompatibleNodeRegistry` loads all nodes from the DB, builds an
 * `OpenAICompatibleProvider` per node (reusing the F13 generic class), and
 * exposes them to the provider registry for routing. Refreshed on node CRUD.
 */
import { db } from "../../db/index";
import { providerNodes } from "../../db/schema";
import { OpenAICompatibleProvider, type OpenAICompatibleSpec } from "./openai-compatible";

export type CompatibleNodeType = "openai-compatible" | "anthropic-compatible" | "custom-embedding";

export interface CompatibleNodeData {
  prefix: string;
  baseUrl: string;
  apiType?: "openai" | "anthropic";
  models: string[];
  headers?: Record<string, string>;
}

/** A loaded compatible node + its provider instance. */
interface LoadedNode {
  node: typeof providerNodes.$inferSelect;
  provider: OpenAICompatibleProvider;
}

class CompatibleNodeRegistry {
  private nodes: LoadedNode[] = [];
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  /** Load (or reload) all compatible nodes from the DB. */
  async refresh(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      try {
        const rows = await db.select().from(providerNodes);
        this.nodes = rows.map((row) => {
          const data = (typeof row.data === "string" ? JSON.parse(row.data) : row.data) as CompatibleNodeData;
          const spec: OpenAICompatibleSpec = {
            id: row.id,
            displayName: row.name,
            baseUrl: data.baseUrl.replace(/\/$/, ""),
            models: data.models || [],
            prefix: data.prefix,
            extraHeaders: data.headers,
          };
          return { node: row, provider: new OpenAICompatibleProvider(spec) };
        });
        this.loaded = true;
      } catch (err) {
        console.error("[CompatibleNodes] refresh failed:", err);
      } finally {
        this.loadPromise = null;
      }
    })();
    return this.loadPromise;
  }

  /** All loaded node providers (for registry routing). */
  getProviders(): OpenAICompatibleProvider[] {
    return this.nodes.map((n) => n.provider);
  }

  /** Resolve a provider for a model id by prefix. Returns the matching provider or null. */
  getProviderForModel(model: string): OpenAICompatibleProvider | null {
    if (!model) return null;
    for (const n of this.nodes) {
      if (n.provider.ownsModel(model)) return n.provider;
    }
    return null;
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}

export const compatibleNodeRegistry = new CompatibleNodeRegistry();

/** Ensure the registry is loaded (call at boot + after node CRUD). */
export async function ensureCompatibleNodesLoaded(): Promise<void> {
  if (!compatibleNodeRegistry.isLoaded()) {
    await compatibleNodeRegistry.refresh();
  }
}
