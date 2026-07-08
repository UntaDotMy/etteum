/**
 * MCP HTTP router — TS port of the reference proxy's src/app/api/mcp/[plugin]/{sse,message}/route.js.
 *
 *   GET  /v1/mcp/:plugin/sse      — open an SSE stream; bridge spawns the plugin
 *                                   child and forwards its JSON-RPC stdout.
 *   POST /v1/mcp/:plugin/message  — send a JSON-RPC message to the plugin child.
 *   GET  /v1/mcp/plugins          — list available preset plugins + run state.
 *
 * Closes the MCP server-hosting HIGH gap (Wave 6).
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { registerSession, unregisterSession, sendToChild, findPlugin, listPlugins } from "./stdioSseBridge";
import { DEFAULT_REMOTE_PLUGINS, buildManagedMcpServers } from "./marketplace";

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
