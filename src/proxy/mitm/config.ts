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

// NOTE: a former HOST_REWRITE map (cloudcode-pa → daily-cloudcode-pa, a 429
// dodge for direct upstream forwarding) was removed: it was never applied —
// the MITM server forwards intercepted requests to the LOCAL router, not to
// the upstream host, so rewriting the upstream host was dead code. Re-add +
// wire it into handlers.ts if direct-upstream forwarding is ever introduced.
