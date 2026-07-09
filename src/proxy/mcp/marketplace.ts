/**
 * MCP plugin marketplace — TS port of 9router's
 * src/shared/constants/coworkPlugins.js + buildManagedMcpServers.
 *
 * Closes the MCP marketplace/registry HIGH gap:
 *   - Default remote HTTPS MCP plugins (Exa, Tavily) alongside local stdio
 *   - buildManagedMcpServers: emits the managedMcpServers config clients consume
 *   - toolPolicy: per-plugin allow-list of tool names
 *
 * Remote plugins speak HTTPS (http or sse transport) — distinct from the local
 * stdio bridge in stdioSseBridge.ts.
 */

export interface RemoteMcpPlugin {
  name: string;
  title: string;
  description: string;
  url: string;
  transport: "http" | "sse";
  oauth?: boolean;
  toolNames?: string[];
}

export interface LocalStdioPlugin {
  name: string;
  title: string;
  description: string;
  command: string;
  args: string[];
  toolNames?: string[];
  extensionUrl?: string;
}

// Default remote plugins (3p managedMcpServers, HTTPS only).
export const DEFAULT_REMOTE_PLUGINS: RemoteMcpPlugin[] = [
  {
    name: "exa", title: "Exa", description: "Real-time web search and code documentation",
    url: "https://mcp.exa.ai/mcp", transport: "http", oauth: false,
    toolNames: ["web_search_exa", "web_fetch_exa"],
  },
  {
    name: "tavily", title: "Tavily", description: "Real-time web search optimized for LLM agents",
    url: "https://mcp.tavily.com/mcp", transport: "http", oauth: true,
    toolNames: ["tavily_search", "tavily_extract", "tavily_crawl", "tavily_map"],
  },
  {
    name: "perplexity", title: "Perplexity", description: "Ask questions with real-time web-grounded answers",
    url: "https://mcp.perplexity.ai/mcp", transport: "http", oauth: true,
    toolNames: ["perplexity_search"],
  },
];

/**
 * Build the managedMcpServers config (1:1 with 9router buildManagedMcpServers).
 * Emits the list a client consumes to register remote MCP servers. Dedupes by
 * name, infers transport from URL if missing, and includes toolPolicy allow-
 * lists where declared.
 */
export function buildManagedMcpServers(plugins: RemoteMcpPlugin[] = DEFAULT_REMOTE_PLUGINS): any[] {
  const list = Array.isArray(plugins) ? plugins : [];
  const out: any[] = [];
  const seen = new Set<string>();
  for (const p of list) {
    if (!p?.name || !p?.url || seen.has(p.name)) continue;
    seen.add(p.name);
    const entry: any = {
      name: p.name,
      url: p.url,
      transport: p.transport || (/\/sse(\b|\/)/i.test(p.url) ? "sse" : "http"),
    };
    if (p.oauth) entry.oauth = true;
    if (Array.isArray(p.toolNames) && p.toolNames.length > 0) {
      entry.toolPolicy = { type: "allow", names: p.toolNames };
    }
    out.push(entry);
  }
  return out;
}

/** Get a remote plugin by name. */
export function getRemotePlugin(name: string): RemoteMcpPlugin | null {
  return DEFAULT_REMOTE_PLUGINS.find((p) => p.name === name) || null;
}
