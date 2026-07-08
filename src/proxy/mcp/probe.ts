/**
 * MCP server probing — 1:1 with the reference proxy probeMcp.
 *
 * Runs the JSON-RPC handshake (initialize → notifications/initialized →
 * tools/list) against a remote MCP HTTP/SSE endpoint to discover the tools it
 * exposes. Authless servers return their tool list; OAuth servers return 401 on
 * initialize, which we surface as requiresAuth so the client can skip listing.
 *
 * Used by the /v1/mcp/probe route to let the dashboard preview a plugin's tools
 * before registering it.
 */

const PROBE_TIMEOUT_MS = 8000;
const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface ProbedTool {
  name: string;
  description: string;
}

export interface ProbeResult {
  /** Present (true) when the server returned 401/403 — it needs OAuth. */
  requiresAuth?: boolean;
  /** Present on failure (bad status, timeout, network error). */
  error?: string;
  tools: ProbedTool[];
}

/**
 * Probe an MCP server URL for its tool list. No auth header — works for
 * authless servers. OAuth servers return 401, signaling the caller to skip.
 */
export async function probeMcp(url: string): Promise<ProbeResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    // Step 1: initialize.
    const initRes = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "etteum", version: "1" },
        },
      }),
      signal: ac.signal,
    });
    if (initRes.status === 401 || initRes.status === 403) {
      return { requiresAuth: true, tools: [] };
    }
    if (!initRes.ok) {
      return { error: `init ${initRes.status}`, tools: [] };
    }
    const sessionId = initRes.headers.get("mcp-session-id") || "";
    await initRes.text().catch(() => {});

    const listHeaders: Record<string, string> = { ...headers };
    if (sessionId) listHeaders["mcp-session-id"] = sessionId;

    // Step 2: notifications/initialized (required by spec before tools/list).
    await fetch(url, {
      method: "POST",
      headers: listHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
      signal: ac.signal,
    }).catch(() => {});

    // Step 3: tools/list.
    const listRes = await fetch(url, {
      method: "POST",
      headers: listHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      signal: ac.signal,
    });
    if (listRes.status === 401 || listRes.status === 403) {
      return { requiresAuth: true, tools: [] };
    }
    const ct = listRes.headers.get("content-type") || "";
    let parsed: any;
    if (ct.includes("text/event-stream")) {
      // SSE: each "data: {...}" line is a JSON-RPC message.
      const text = await listRes.text();
      const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
      for (const line of dataLines) {
        try {
          const obj = JSON.parse(line.replace(/^data:\s*/, ""));
          if (obj?.id === 2 && obj.result) { parsed = obj; break; }
        } catch { /* skip malformed line */ }
      }
    } else {
      parsed = await listRes.json().catch(() => null);
    }
    const tools = parsed?.result?.tools || [];
    return {
      tools: tools.map((t: any) => ({ name: t.name, description: t.description || "" })),
    };
  } catch (e: any) {
    return { error: e?.name === "AbortError" ? "timeout" : (e?.message || String(e)), tools: [] };
  } finally {
    clearTimeout(timer);
  }
}
