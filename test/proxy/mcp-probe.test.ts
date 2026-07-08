import { describe, test, expect } from "bun:test";
import { probeMcp } from "../../src/proxy/mcp/probe";

/**
 * Hermetic probeMcp tests. The real probe hits a remote MCP server; here we
 * stub globalThis.fetch to simulate the JSON-RPC handshake (initialize →
 * notifications/initialized → tools/list) so the test never touches the network.
 */

interface MockCall {
  method: string;
  id: number | null;
}

function mockHandshake(opts: {
  initStatus?: number;
  initSessionId?: string;
  listStatus?: number;
  listContentType?: string;
  listBody?: any;
  listIsSse?: boolean;
}) {
  const calls: MockCall[] = [];
  const o = { initStatus: 200, listStatus: 200, listContentType: "application/json", ...opts };
  (globalThis as any).fetch = async (url: string, init: any) => {
    let parsed: any = {};
    try { parsed = JSON.parse(init.body); } catch { /* notification has no id */ }
    calls.push({ method: parsed.method, id: parsed.id ?? null });

    // Step 1: initialize
    if (parsed.method === "initialize") {
      const headers: Record<string, string> = {};
      if (o.initSessionId) headers["mcp-session-id"] = o.initSessionId;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: o.initStatus, headers,
      });
    }
    // Step 2: notifications/initialized (no response body needed)
    if (parsed.method === "notifications/initialized") {
      return new Response("", { status: 200 });
    }
    // Step 3: tools/list
    if (parsed.method === "tools/list") {
      const result = { jsonrpc: "2.0", id: 2, result: { tools: o.listBody ?? [] } };
      const body = o.listIsSse
        ? `event: message\ndata: ${JSON.stringify(result)}\n\n`
        : JSON.stringify(result);
      return new Response(body, {
        status: o.listStatus,
        headers: { "content-type": o.listContentType },
      });
    }
    return new Response("", { status: 404 });
  };
  return calls;
}

const origFetch = globalThis.fetch;

describe("probeMcp", () => {
  test("runs the 3-step handshake and returns the tool list (JSON)", async () => {
    const calls = mockHandshake({
      initSessionId: "sess-123",
      listBody: [
        { name: "web_search", description: "Search the web" },
        { name: "fetch", description: "" },
      ],
    });
    try {
      const res = await probeMcp("https://mcp.example.com/mcp");
      expect(res.tools).toEqual([
        { name: "web_search", description: "Search the web" },
        { name: "fetch", description: "" },
      ]);
      // The handshake ran in order: initialize, notifications/initialized, tools/list.
      expect(calls.map((c) => c.method)).toEqual([
        "initialize", "notifications/initialized", "tools/list",
      ]);
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });

  test("parses SSE responses for the tools/list result", async () => {
    mockHandshake({
      listIsSse: true,
      listContentType: "text/event-stream",
      listBody: [{ name: "search", description: "sse tool" }],
    });
    try {
      const res = await probeMcp("https://mcp.example.com/mcp");
      expect(res.tools).toEqual([{ name: "search", description: "sse tool" }]);
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });

  test("surfaces 401 as requiresAuth (OAuth server)", async () => {
    mockHandshake({ initStatus: 401 });
    try {
      const res = await probeMcp("https://oauth-mcp.example.com/mcp");
      expect(res.requiresAuth).toBe(true);
      expect(res.tools).toEqual([]);
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });

  test("surfaces a non-ok init as an error", async () => {
    mockHandshake({ initStatus: 500 });
    try {
      const res = await probeMcp("https://broken.example.com/mcp");
      expect(res.error).toBe("init 500");
      expect(res.tools).toEqual([]);
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });

  test("returns empty tools when the server lists none", async () => {
    mockHandshake({ listBody: [] });
    try {
      const res = await probeMcp("https://empty.example.com/mcp");
      expect(res.tools).toEqual([]);
      expect(res.error).toBeUndefined();
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });
});
