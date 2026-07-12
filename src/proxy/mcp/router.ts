/**
 * MCP HTTP router — TS port of 9router's src/app/api/mcp/[plugin]/{sse,message}/route.js.
 *
 *   GET  /v1/mcp/:plugin/sse      — open an SSE stream; bridge spawns the plugin
 *                                   child and forwards its JSON-RPC stdout.
 *   POST /v1/mcp/:plugin/message  — send a JSON-RPC message to the plugin child.
 *   GET  /v1/mcp/plugins          — list available preset plugins + run state.
 *
 * Closes the MCP server-hosting HIGH gap .
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { registerSession, unregisterSession, sendToChild, findPlugin, listPlugins, hasSession } from "./stdioSseBridge";
import { DEFAULT_REMOTE_PLUGINS, buildManagedMcpServers } from "./marketplace";
import { probeMcp } from "./probe";

/**
 * SSRF guard for the probe endpoint: reject non-https, private/loopback IP
 * literals, and .local hostnames. Per OWASP SSRF Prevention Cheat Sheet.
 * (Full DNS-rebinding prevention would require pinning resolved IPs, but this
 * blocks the common vectors.)
 */
function isLikelyPrivateOrInvalidUrl(rawUrl: string): string | null {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return "invalid URL"; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "only http(s) URLs allowed";
  const host = u.hostname.toLowerCase();
  // Allow localhost for local dev/testing.
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return null;
  if (host.endsWith(".local")) return ".local hostnames not allowed";
  // Block private/loopback IP literals.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
      return "private/loopback/metadata IP not allowed";
    }
  }
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return "private IPv6 not allowed";
  return null;
}

export const mcpRouter = new Hono();

/** GET /v1/mcp/plugins — list preset MCP plugins and their run state. */
mcpRouter.get("/v1/mcp/plugins", (c) => {
  return c.json({ plugins: listPlugins() });
});

/** GET /v1/mcp/marketplace — list available remote + local MCP plugins. */
mcpRouter.get("/v1/mcp/marketplace", (c) => {
  return c.json({
    remote: DEFAULT_REMOTE_PLUGINS,
    local: listPlugins(),
  });
});

/** GET /v1/mcp/managed-servers — emit the managedMcpServers config for clients. */
mcpRouter.get("/v1/mcp/managed-servers", (c) => {
  return c.json({ managedMcpServers: buildManagedMcpServers() });
});

/** POST /v1/mcp/probe — probe a remote MCP server for its tool list.
 *  SSRF-guarded (https/http only, private/loopback IPs blocked). */
mcpRouter.post("/v1/mcp/probe", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { url?: string };
  if (typeof body.url !== "string" || !body.url) {
    return c.json({ error: { message: "url required", type: "invalid_request_error" } }, 400);
  }
  const ssrf = isLikelyPrivateOrInvalidUrl(body.url);
  if (ssrf) {
    return c.json({ error: { message: `URL rejected: ${ssrf}`, type: "invalid_request_error" } }, 400);
  }
  const result = await probeMcp(body.url);
  return c.json(result);
});

/** GET /v1/mcp/:plugin/sse — SSE stream bridging the plugin's JSON-RPC stdout. */
mcpRouter.get("/v1/mcp/:plugin/sse", (c) => {
  const plugin = c.req.param("plugin");
  if (!findPlugin(plugin)) {
    return c.json({ error: { message: `Unknown MCP plugin: ${plugin}`, type: "invalid_request_error" } }, 404);
  }
  return streamSSE(c, async (stream) => {
    let sid: string | null = null;
    let closed = false;
    const send = (chunk: string) => {
      if (closed) return;
      try { stream.writeln(chunk); } catch { /* client gone */ }
    };
    try {
      sid = registerSession(plugin, send);
      // Send an initial endpoint event so clients know where to POST messages.
      await stream.write(`event: endpoint\ndata: /v1/mcp/${encodeURIComponent(plugin)}/message?sid=${encodeURIComponent(sid)}\n\n`);
      // Keep the stream alive until the client disconnects.
      while (!closed) {
        await stream.sleep(15_000);
        if (!closed) await stream.write(`: keepalive\n\n`).catch(() => { closed = true; });
      }
    } catch (err) {
      // stream aborted by client
    } finally {
      closed = true;
      if (sid) unregisterSession(plugin, sid);
    }
  });
});

/** POST /v1/mcp/:plugin/message — forward a JSON-RPC message to the plugin child. */
mcpRouter.post("/v1/mcp/:plugin/message", async (c) => {
  const plugin = c.req.param("plugin");
  if (!findPlugin(plugin)) {
    return c.json({ error: { message: `Unknown MCP plugin: ${plugin}`, type: "invalid_request_error" } }, 404);
  }
  // Session validation: only a caller holding a valid `sid` (issued when they
  // opened the SSE stream for this plugin) may drive the child's stdin.
  // Without this, any authenticated caller could inject arbitrary JSON-RPC
  // into any plugin's stdin — driving tools they never subscribed to.
  const sid = c.req.query("sid");
  if (!hasSession(plugin, sid)) {
    return c.json({ error: { message: "Invalid or missing session (sid). Open the SSE stream first.", type: "invalid_request_error" } }, 403);
  }
  let jsonRpc: unknown;
  try {
    jsonRpc = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON-RPC body", type: "invalid_request_error" } }, 400);
  }
  try {
    sendToChild(plugin, jsonRpc);
    return c.json({ accepted: true });
  } catch (err: any) {
    return c.json({ error: { message: err.message, type: "server_error" } }, 503);
  }
});
