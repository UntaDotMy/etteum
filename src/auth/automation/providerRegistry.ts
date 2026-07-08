/**
 * Provider-adapter registry — maps provider names to ProviderAdapter instances.
 * Drives runProvider() for the dashboard's automation + browser log.
 *
 * 1:1 with the reference login.py provider dispatch. Each adapter follows the
 * ProviderAdapter contract (parse_account → bootstrap → authenticate →
 * fetch_tokens → fetch_quota → cleanup).
 */
import type { ProviderAdapter } from "./providerAdapter";
import { KiroAdapter } from "./adapters/kiroAdapter";
import { CodexAdapter } from "./adapters/codexAdapter";
import { CodeBuddyAdapter } from "./adapters/codebuddyAdapter";

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
// Kiro + Codex + CodeBuddy ported 1:1 from the reference automation design.
// CodeBuddy was reconstructed from the readable companion files
// (_config.py/_api.py/_google_oauth.py/_page_helpers.py/_utils.py) since its
// _adapter.py is pyarmor-obfuscated (irreversible) — the protocol/endpoints/
// selectors are all in the companions.
registerAdapter("kiro", () => new KiroAdapter());
registerAdapter("codex", () => new CodexAdapter());
registerAdapter("codebuddy", () => new CodeBuddyAdapter());

// TODO (remaining adapters): canva, qoder — each implements the
// ProviderAdapter contract.
