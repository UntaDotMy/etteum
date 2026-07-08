/**
 * MITM config: which hosts map to which tool + model-alias/synonym tables (F10).
 * Ported from the reference proxy src/mitm/config.js + src/shared/constants/mitmToolHosts.js.
 *
 * When the TLS server receives a request on a given SNI host, it looks up the
 * tool here, runs that tool's handler (which rewrites body.model via the alias
 * DB + synonyms), and forwards to the local router.
 */
import { TOOL_HOSTS } from "./paths";

/** Reverse map: vendor host → tool id. */
export const HOST_TO_TOOL: Record<string, string> = {};
for (const [tool, hosts] of Object.entries(TOOL_HOSTS)) {
  for (const h of hosts) HOST_TO_TOOL[h] = tool;
}

/** Resolve which tool owns a given SNI host. */
export function getToolForHost(host: string): string | null {
  // Strip port.
  const h = host.split(":")[0] ?? host;
  return HOST_TO_TOOL[h] ?? null;
}

/**
 * Model synonyms/patterns: when an intercepted request carries one of these
 * model ids (the vendor's advertised id), rewrite it to the target before
 * forwarding to the router. The router then resolves the alias to a real
 * in-pool model. Mirrors reference config.js MODEL_SYNONYMS.
 */
export const MODEL_SYNONYMS: Record<string, string> = {
  // Antigravity / Gemini Code
  "gemini-2.5-pro": "gemini-2.5-pro",
  "gemini-2.5-flash": "gemini-2.5-flash",
  // Copilot
  "gpt-4o": "gpt-4o",
  "gpt-4o-mini": "gpt-4o-mini",
  "claude-3.5-sonnet": "claude-3-5-sonnet-20241022",
  // Cursor
  "cursor-fast": "auto",
  "gpt-4": "gpt-4o",
};

/** Models that should NOT be remapped (passthrough as-is). */
export const MODEL_NO_MAP = new Set<string>(["auto", "cursor-small"]);

/**
 * Host rewrite for the upstream forward. The PROD cloudcode-pa endpoint is
 * rate-limited (429); the daily- (dev) endpoint accepts the same body+token.
 * Same trick as open-sse. Mirrors reference HOST_REWRITE.
 */
export const HOST_REWRITE: Record<string, string> = {
  "cloudcode-pa.googleapis.com": "daily-cloudcode-pa.googleapis.com",
};
