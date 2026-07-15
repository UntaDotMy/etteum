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
 *
 * Credentials: optional `apiKey` on node data is bound as staticApiKey so the
 * node can serve without a separate accounts row. Accounts with
 * provider=<node.id> still take priority when present.
 *
 * `custom-embedding` nodes are accepted in the API for storage but are NOT
 * registered as chat providers (media/embeddings path is separate).
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
  /** Optional node-level API key (bound as static credentials). */
  apiKey?: string;
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
        this.nodes = rows
          .filter((row) => row.type !== "custom-embedding")
          .map((row) => {
            const data = (typeof row.data === "string" ? JSON.parse(row.data) : row.data) as CompatibleNodeData;
            const apiType: "openai" | "anthropic" =
              row.type === "anthropic-compatible" || data.apiType === "anthropic"
                ? "anthropic"
                : "openai";
            const headers = { ...(data.headers || {}) };
            // Prefer explicit apiKey field; allow Authorization in headers too.
            const staticApiKey = data.apiKey
              || (typeof headers.Authorization === "string"
                ? headers.Authorization.replace(/^Bearer\s+/i, "")
                : typeof headers.authorization === "string"
                  ? headers.authorization.replace(/^Bearer\s+/i, "")
                  : undefined);
            if (staticApiKey) {
              delete headers.Authorization;
              delete headers.authorization;
            }
            const spec: OpenAICompatibleSpec = {
              id: row.id,
              displayName: row.name,
              baseUrl: data.baseUrl.replace(/\/$/, ""),
              models: data.models || [],
              prefix: data.prefix,
              extraHeaders: Object.keys(headers).length ? headers : undefined,
              apiType,
              staticApiKey,
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

  /** All loaded chat node providers (for registry routing + /v1/models). */
  getProviders(): OpenAICompatibleProvider[] {
    return this.nodes.map((n) => n.provider);
  }

  /** Resolve a provider instance by its registered name/id. */
  getProviderByName(name: string): OpenAICompatibleProvider | null {
    if (!name) return null;
    for (const n of this.nodes) {
      if (n.provider.name === name) return n.provider;
    }
    return null;
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
