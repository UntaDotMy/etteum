/**
 * Web search endpoint — TS port of 9router's /v1/search (searchViaChat pattern).
 *
 *   POST /v1/search  { query, model?, max_results? }
 *
 * Routes a web-search query through a chat model that has search capability
 * (searchViaChat). The result is normalized into a search-results object.
 *
 * LOW severity (Wave 9): closes the "web search as first-class service" gap.
 */
import { Hono } from "hono";
import { routeRequest } from "../router";
import { broadcast } from "../../ws/index";

export const searchRouter = new Hono();

searchRouter.post("/v1/search", async (c) => {
  const body = await c.req.json<{ query?: string; model?: string; max_results?: number }>().catch(() => ({}) as any);
  const query = body.query;
  if (!query) return c.json({ error: { message: "query is required", type: "invalid_request_error" } }, 400);

  // Build a chat request that asks the model to search the web and return
  // structured results. Prefer a model with native web-search capability.
  const model = body.model || "claude-sonnet-4";
  const chatRequest = {
    model,
    messages: [
      {
        role: "user",
        content: `Search the web for: "${query}". Return up to ${body.max_results || 5} results as a JSON array of { title, url, snippet }. Use any available web search tool. Return ONLY the JSON array, no prose.`,
      },
    ],
    stream: false,
    max_tokens: 2000,
  };

  try {
    const routed = await routeRequest(chatRequest as any, false);
    if (!routed?.result?.success || !routed.result.response) {
      return c.json({ error: { message: routed?.result?.error || "Search failed", type: "upstream_error" } }, 503);
    }

    // Extract the text content and attempt to parse the JSON results array.
    const content = extractText(routed.result.response);
    let results: any[] = [];
    try {
      // The model may wrap JSON in prose or code fences; extract the array.
      const match = content.match(/\[[\s\S]*\]/);
      results = match ? JSON.parse(match[0]) : [];
    } catch {
      results = [];
    }

    broadcast({ type: "media_request", data: { modality: "search", model, accountId: routed.account?.id } });
    return c.json({ query, results, model });
  } catch (err: any) {
    return c.json({ error: { message: err.message, type: "server_error" } }, 500);
  }
});

function extractText(response: any): string {
  const choices = response?.choices || [];
  if (!choices.length) return "";
  const msg = choices[0]?.message;
  if (typeof msg?.content === "string") return msg.content;
  if (Array.isArray(msg?.content)) {
    return msg.content.map((p: any) => p?.text || "").join("\n");
  }
  return "";
}
