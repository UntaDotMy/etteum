/**
 * Audit static provider model ids vs getPricingForModel.
 * Run: bun run scripts/audit-pricing-coverage.ts
 */
import { getPricingForModel, toCanonicalModelName } from "../src/proxy/pricing";
import { ALI_MODEL_MAP } from "../src/proxy/providers/alibaba/helpers";
import { QODER_MODELS } from "../src/proxy/providers/qoder/helpers";
import { YM_MODELS } from "../src/proxy/providers/youmind/helpers";
import { CodeBuddyProvider } from "../src/proxy/providers/codebuddy/provider";
import { CodeBuddyChinaProvider } from "../src/proxy/providers/codebuddy-china/provider";
import { CodexProvider } from "../src/proxy/providers/codex/provider";
import { KiroProvider } from "../src/proxy/providers/kiro/provider";
import { OPENAI_COMPATIBLE_CATALOG } from "../src/proxy/providers/openai-compatible";

/** Static lists not always exported as provider instances. */
const EXTRA: { source: string; id: string }[] = [
  // kiro-pro (same class, kp- catalog)
  ...[
    "kp-auto", "kp-opus-4.8", "kp-opus-4.8-thinking", "kp-opus-4.7", "kp-opus-4.7-thinking",
    "kp-opus-4.6", "kp-opus-4.6-thinking", "kp-opus-4.5", "kp-sonnet-4.6", "kp-sonnet-4.6-thinking",
    "kp-haiku-4.5", "kp-haiku-4.5-thinking",
  ].map((id) => ({ source: "kiro-pro", id })),
  // grok oauth surface (chat only)
  ...["grok-4.5", "grok-4.5-reasoning", "composer-2.5"].map((id) => ({ source: "grok", id })),
  // antigravity
  ...["ag-gemini-3-pro", "ag-gemini-3-pro-high", "ag-gemini-3-flash"].map((id) => ({ source: "antigravity", id })),
  // canva (image/video — token pricing may not apply)
  ...["canva-image", "canva-video"].map((id) => ({ source: "canva", id })),
  // cursor
  ...["cursor-fast", "cursor-small", "gpt-4", "gpt-4o", "claude-3.5-sonnet"].map((id) => ({ source: "cursor", id })),
  // vendor/ path forms users paste from OpenRouter-style lists
  ...[
    "openai/gpt-4o", "openai/gpt-4o-mini", "google/gemini-2.5-pro", "google/gemini-2.5-flash",
    "anthropic/claude-sonnet-4.6", "anthropic/claude-opus-4.8", "anthropic/claude-haiku-4.5",
    "x-ai/grok-4.5", "deepseek/deepseek-chat",
  ].map((id) => ({ source: "vendor-path", id })),
];

const rows: { source: string; id: string }[] = [
  ...Object.keys(ALI_MODEL_MAP).map((id) => ({ source: "alibaba", id })),
  ...QODER_MODELS.map((m) => ({ source: "qoder", id: m.id })),
  ...YM_MODELS.map((m) => ({ source: "youmind", id: m.id })),
  ...new CodeBuddyProvider().supportedModels.map((m) => ({ source: "codebuddy", id: m.id })),
  ...new CodeBuddyChinaProvider().supportedModels.map((m) => ({ source: "codebuddy-china", id: m.id })),
  ...new CodexProvider().supportedModels.map((m) => ({ source: "codex", id: m.id })),
  ...new KiroProvider().supportedModels.map((m) => ({ source: "kiro", id: m.id })),
  ...OPENAI_COMPATIBLE_CATALOG.flatMap((e) =>
    (e.models || []).map((id) => ({ source: `compat:${e.id}`, id })),
  ),
  ...EXTRA,
];

// Dedup
const seen = new Set<string>();
const unique = rows.filter((r) => {
  if (seen.has(r.id)) return false;
  seen.add(r.id);
  return true;
});

const missing: { source: string; id: string; canonical: string }[] = [];
const priced: string[] = [];

for (const row of unique) {
  const p = await getPricingForModel(row.id);
  const canonical = toCanonicalModelName(row.id);
  if (!p) missing.push({ ...row, canonical });
  else priced.push(row.id);
}

console.log(`TOTAL unique models: ${unique.length}`);
console.log(`PRICED: ${priced.length}`);
console.log(`MISSING: ${missing.length}`);
console.log("\n--- MISSING ---");
for (const m of missing) {
  console.log(`${m.source.padEnd(22)} ${m.id.padEnd(36)} → ${m.canonical}`);
}
