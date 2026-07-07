/**
 * enowxai adapter registry — maps provider names to ProviderAdapter instances.
 * Drives runProvider() for the dashboard's automation + browser log.
 *
 * 1:1 with enowxai's login.py provider dispatch. Each adapter follows the
 * ProviderAdapter contract (parse_account → bootstrap → authenticate →
 * fetch_tokens → fetch_quota → cleanup).
 */
import type { ProviderAdapter } from "./enowxaiAdapter";
import { KiroAdapter } from "./adapters/kiroAdapter";

const REGISTRY = new Map<string, () => ProviderAdapter>();

export function registerAdapter(name: string, factory: () => ProviderAdapter): void {
  REGISTRY.set(name, factory);
}

export function getAdapter(name: string): ProviderAdapter | null {
  const factory = REGISTRY.get(name);
  return factory ? factory() : null;
}

export function listAdapters(): string[] {
  return [...REGISTRY.keys()];
}

// --- Built-in adapter registrations ---
registerAdapter("kiro", () => new KiroAdapter());

// TODO (remaining enowxai adapters): codebuddy, canva, codex, qoder — each
// implements the ProviderAdapter contract. The Kiro adapter above is the
// reference implementation; the others follow the same shape with their
// provider-specific authenticate/fetchTokens/fetchQuota logic.
