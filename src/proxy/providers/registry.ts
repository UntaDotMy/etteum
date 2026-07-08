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
import { AlibabaProvider } from "./alibaba";
import { AntigravityProvider } from "./antigravity";
import { CursorProvider } from "./cursor/cursorProvider";
import { createOpenAICompatibleProviders } from "./openai-compatible";
import { compatibleNodeRegistry, ensureCompatibleNodesLoaded } from "./compatible-node";

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
const alibaba = new AlibabaProvider();
const antigravity = new AntigravityProvider();
const cursor = new CursorProvider();

// F13: API-key LLM catalog (openai, deepseek, groq, openrouter, …). Each is a
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
  gitlabDuo, canva, qoder, codex, kiroPro, youmind, antigravity, cursor,
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
  alibaba,
  antigravity,
  cursor,
  // F13: API-key catalog.
  ...Object.fromEntries(openaiCompatibleProviders.map((p) => [p.name, p])),
} as const;

export type ProviderName = keyof typeof providers;

/** Map a model id to the provider that handles it. */
export function getProviderForModel(model: string): ProviderName | null {
  for (const provider of PROVIDER_ORDER) {
    if (provider.ownsModel(model)) return provider.name as ProviderName;
  }
  // F13: dynamic compatible-node providers (user-defined, prefix-routed). These
  // are checked AFTER the static providers but BEFORE the kiro fallback, so a
  // user-defined node prefix wins over the catch-all but not over a built-in.
  try {
    const nodeProvider = compatibleNodeRegistry.getProviderForModel(model);
    if (nodeProvider) return nodeProvider.name as ProviderName;
  } catch { /* registry not loaded yet — fall through */ }
  const fallback = PROVIDER_ORDER.find((p) => p.isFallback);
  return (fallback?.name as ProviderName) ?? null;
}

/** All models across every registered provider. */
export function getAllModels(): ModelInfo[] {
  return PROVIDER_ORDER.flatMap((provider) => provider.getModels());
}

/** Iterable list of provider instances (priority order). */
export const providerList: readonly BaseProvider[] = PROVIDER_ORDER;

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

/** F13: refresh dynamic compatible-node providers from the DB (call at boot + after node CRUD). */
export async function refreshCompatibleNodes(): Promise<void> {
  await ensureCompatibleNodesLoaded();
  await compatibleNodeRegistry.refresh();
}

/** Get BYOK provider instance. */
export function getByokProvider(): ByokProvider {
  return byok;
}

/** Get GitLab Duo provider instance. */
export function getGitlabDuoProvider(): GitlabDuoProvider {
  return gitlabDuo;
}

