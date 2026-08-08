import type { BaseProvider, ModelInfo } from "./base";
import { KiroProvider } from "./kiro";
import { CodeBuddyProvider } from "./codebuddy";
import { CodeBuddyChinaProvider } from "./codebuddy-china";
import { CanvaProvider } from "./canva";
import { CodexProvider } from "./codex";
import { QoderProvider } from "./qoder";
import { ByokProvider } from "./byok";
import { GitlabDuoProvider } from "./gitlab-duo";
import { YouMindProvider } from "./youmind";
import { CommandCodeProvider } from "./commandcode";
import { GrokProvider } from "./grok";
import { AlibabaProvider } from "./alibaba";
import { AntigravityProvider } from "./antigravity";
import { CursorProvider } from "./cursor/cursorProvider";
import { createOpenAICompatibleProviders } from "./openai-compatible";
import { compatibleNodeRegistry, ensureCompatibleNodesLoaded } from "./compatible-node";
import {
  customModelsRegistry,
  ensureCustomModelsLoaded,
  getCustomModelProvider,
  applyCustomModelsToList,
} from "./custom-models";
import { resolveModelSpec } from "../model-specs";
import { toCanonicalModelName } from "../pricing";

/**
 * Single source of truth for the provider set.
 *
 * To add / remove / change a provider you touch exactly two things:
 *   1. that provider's own file (its models + ownsModel() pattern), and
 *   2. one line in PROVIDER_ORDER below.
 *
 * Routing (getProviderForModel) and model listing (getAllModels) iterate this
 * list — there is no per-provider logic anywhere else. Order matters only for
 * disambiguating overlapping patterns: more specific providers come first, and
 * the single isFallback provider (kiro standard) is consulted last.
 */
// kiro and kiro-pro are two variants of the SAME provider class — same upstream
// (AWS CodeWhisperer), different model catalog + account pool. They keep
// distinct provider names so DB/bot/dashboard treat them separately.
const kiro = new KiroProvider({ variant: "standard" });
const kiroPro = new KiroProvider({ variant: "pro" });
const codebuddy = new CodeBuddyProvider();
const codebuddyChina = new CodeBuddyChinaProvider();
const canva = new CanvaProvider();
const codex = new CodexProvider();
const qoder = new QoderProvider();
const byok = new ByokProvider();
const gitlabDuo = new GitlabDuoProvider();
const youmind = new YouMindProvider();
const commandcode = new CommandCodeProvider();
const alibaba = new AlibabaProvider();
const antigravity = new AntigravityProvider();
const cursor = new CursorProvider();
const grok = new GrokProvider();

// API-key LLM catalog (openai, deepseek, groq, openrouter, …). Each is a
// generic OpenAI-compatible relay instantiated from OPENAI_COMPATIBLE_CATALOG.
const openaiCompatibleProviders = createOpenAICompatibleProviders();

// Priority order. canva/qoder/codex/kiro-pro/youmind have unique prefixes; codex
// is listed before codebuddy so the literal "gpt-5-codex" resolves to codex
// while codebuddy keeps its own "gpt-5*"/"gpt-5.x-codex" models. byok checks
// dynamic prefixes from DB accounts. The F13 API-key catalog is slotted before
// byok/alibaba so their prefixes win; kiro is the fallback. gitlab-duo owns
// `claude_(haiku|sonnet|opus)_<digit>...` underscore-style identifiers — no
// overlap with any other provider, so position is not load-bearing. youmind
// owns the `ym-*` prefix exclusively — also position-independent, but slotted
// alongside the other prefix-based providers for readability.
const PROVIDER_ORDER = [
  gitlabDuo, canva, qoder, codex, kiroPro, youmind, commandcode, grok, antigravity, cursor,
  ...openaiCompatibleProviders,
  byok, alibaba, codebuddyChina, codebuddy, kiro,
] as const;

export const providers = {
  kiro,
  "kiro-pro": kiroPro,
  codebuddy,
  "codebuddy-china": codebuddyChina,
  canva,
  codex,
  qoder,
  byok,
  "gitlab-duo": gitlabDuo,
  youmind,
  commandcode,
  alibaba,
  antigravity,
  cursor,
  // API-key catalog (ids must not collide with first-party keys below).
  ...Object.fromEntries(openaiCompatibleProviders.map((p) => [p.name, p])),
  // First-party GrokProvider MUST win over any catalog id named "grok".
  // Historically OPENAI_COMPATIBLE_CATALOG had id:"grok", which overwrote this
  // entry and made OAuth/SSO accounts hit decrypt(password) as Bearer.
  grok,
} as const;

export type ProviderName = keyof typeof providers;

/** Map a model id to the provider that handles it. */
export function getProviderForModel(model: string): ProviderName | null {
  for (const provider of PROVIDER_ORDER) {
    if (provider.ownsModel(model)) return provider.name as ProviderName;
  }
  // dynamic compatible-node providers (user-defined, prefix-routed). These
  // are checked AFTER the static providers but BEFORE the kiro fallback, so a
  // user-defined node prefix wins over the catch-all but not over a built-in.
  try {
    const nodeProvider = compatibleNodeRegistry.getProviderForModel(model);
    if (nodeProvider) return nodeProvider.name as ProviderName;
  } catch { /* registry not loaded yet — fall through */ }
  // dashboard-added custom models. Checked after built-ins + compatible
  // nodes so a manually-added model routes to its assigned provider.
  try {
    const customProvider = getCustomModelProvider(model);
    if (customProvider) return customProvider as ProviderName;
  } catch { /* registry not loaded yet — fall through */ }
  // NO implicit kiro catch-all. If no provider genuinely owns the model
  // (not via ownsModel, not a compatible-node, not a custom entry), return null
  // so the edge surfaces a clean 404 model_not_found instead of silently routing
  // to kiro and failing upstream. Explicit cross-provider fallback is opt-in via
  // Combos (combo.ts). The isFallback flag is retained on the provider class
  // for documentation but is no longer consulted here.
  return null;
}

/** All models across every registered provider. */
export function getAllModels(): ModelInfo[] {
  // merge dashboard-added custom models + apply disabled-model filter.
  // Custom entries are layered on top of the hardcoded provider lists; disabled
  // models are removed so they don't appear in /v1/models or route.
  const base = PROVIDER_ORDER.flatMap((provider) => provider.getModels());
  // Dynamic compatible-node models (user-defined) — after static providers so
  // built-in ownership wins on id collision, matching getProviderForModel order.
  let nodeModels: ModelInfo[] = [];
  try {
    nodeModels = compatibleNodeRegistry.getProviders().flatMap((p) => p.getModels());
  } catch { /* registry not loaded yet */ }
  // Dedup by model id, keeping the FIRST occurrence. Some bare generic ids
  // (gpt-4, gpt-4o, gpt-4-turbo, gpt-3.5-turbo, claude-3.5-sonnet) are declared
  // by more than one provider (e.g. cursor AND the openai F13 catalog). Without
  // dedup, flatMap emits duplicate rows that leak into /v1/models + the
  // dashboard as "model X leaking to all providers". The first occurrence is
  // the routing winner (PROVIDER_ORDER priority), so the list matches routing.
  const seen = new Set<string>();
  const deduped = [...base, ...nodeModels].filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  const withCustom = applyCustomModelsToList(deduped);
  // why: attach per-model reasoning-effort levels so the dashboard selector only
  // offers levels the model accepts. Providers that set effort_levels win.
  return withCustom.map((m) => {
    if (m.effort_levels && m.effort_levels.length > 0) return m;
    const levels = resolveModelSpec(toCanonicalModelName(m.id))?.effortLevels;
    return levels && levels.length > 0 ? { ...m, effort_levels: levels } : m;
  });
}

/**
 * Resolve a live provider instance for a provider name.
 * Static map first; dynamic compatible-node registry second.
 */
export function resolveProviderInstance(name: string): BaseProvider | null {
  const staticProvider = (providers as Record<string, BaseProvider | undefined>)[name];
  if (staticProvider) return staticProvider;
  try {
    return compatibleNodeRegistry.getProviderByName(name);
  } catch {
    return null;
  }
}

/** Iterable list of provider instances (priority order). */
export const providerList: readonly BaseProvider[] = PROVIDER_ORDER;

/**
 * Every provider name that can own accounts: the static map (first-party +
 * the OpenAI-compatible catalog) plus dynamic compatible-nodes.
 *
 * why: config.providers is a hand-maintained `as const` covering only the 14
 * first-party providers. Consumers that mean "all providers" (warmup schedule,
 * warmup fan-out, per-provider stats) silently skipped the catalog and every
 * user-defined node.
 */
export function listProviderNames(): string[] {
  const names = new Set<string>(Object.keys(providers));
  try {
    for (const p of compatibleNodeRegistry.getProviders()) names.add(p.name);
  } catch {
    /* registry not loaded yet */
  }
  return [...names];
}

/** Refresh BYOK models from database. */
export async function refreshByokModels(): Promise<void> {
  await byok.refreshModelsCache();
}

/** Refresh GitLab Duo models from every active gitlab-duo account's metadata. */
export async function refreshGitlabDuoModels(): Promise<void> {
  await gitlabDuo.refreshModelsCache();
}

/** Refresh Alibaba's discovered model catalog from DashScope /v1/models. */
export async function refreshAlibabaModels(): Promise<void> {
  await alibaba.refreshModelsCache();
}

/** Refresh Grok's discovered model catalog from cli-chat-proxy /v1/models. */
export async function refreshGrokModels(): Promise<void> {
  await grok.refreshModelsCache();
}

/** Refresh Qoder's discovered model catalog from GET /algo/api/v2/model/list. */
export async function refreshQoderModels(): Promise<void> {
  await qoder.refreshModelsCache();
}

/** Refresh CodeBuddy's discovered model catalog from GET {base}/v2/models. */
export async function refreshCodebuddyModels(): Promise<void> {
  await codebuddy.refreshModelsCache();
}

/** Refresh CodeBuddy China's discovered model catalog from GET {base}/v2/models. */
export async function refreshCodebuddyChinaModels(): Promise<void> {
  await codebuddyChina.refreshModelsCache();
}

/** Refresh Codex's discovered model catalog from chatgpt.com /codex/models. */
export async function refreshCodexModels(): Promise<void> {
  await codex.refreshModelsCache();
}

/** Refresh Antigravity's discovered model catalog from fetchAvailableModels. */
export async function refreshAntigravityModels(): Promise<void> {
  await antigravity.refreshModelsCache();
}

/** Refresh YouMind's discovered model catalog from the anthropic /v1/models relay. */
export async function refreshYoumindModels(): Promise<void> {
  await youmind.refreshModelsCache();
}

/** F13: refresh dynamic compatible-node providers from the DB (call at boot + after node CRUD). */
export async function refreshCompatibleNodes(): Promise<void> {
  await ensureCompatibleNodesLoaded();
  await compatibleNodeRegistry.refresh();
}

/** F15: refresh dashboard-added custom + disabled models from the kv table (call at boot + after model CRUD). */
export async function refreshCustomModels(): Promise<void> {
  await ensureCustomModelsLoaded();
  await customModelsRegistry.refresh();
}

/**
 * Force-refresh (or warm) a provider's live model catalog by name.
 * Returns a status so the dashboard fetch button can report the outcome.
 */
export async function refreshProviderModels(name: string, force = true): Promise<{ ok: boolean; error?: string }> {
  const provider = resolveProviderInstance(name);
  if (!provider) return { ok: false, error: `Unknown provider: ${name}` };
  const refresh = (provider as unknown as { refreshModelsCache?: (force?: boolean) => Promise<void> }).refreshModelsCache;
  if (typeof refresh !== "function") return { ok: false, error: `${name} does not expose a model catalog` };
  try {
    await refresh.call(provider, force);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Get BYOK provider instance. */
export function getByokProvider(): ByokProvider {
  return byok;
}

/** Get GitLab Duo provider instance. */
export function getGitlabDuoProvider(): GitlabDuoProvider {
  return gitlabDuo;
}

