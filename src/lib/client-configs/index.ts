/**
 * Client config generation library — orchestrator.
 *
 * Detects installed AI coding clients, generates proxy configs for each,
 * and writes them to disk with backup support.
 *
 * Adapted from kiro-unified frontend/src/main/proxy/clients/.
 */
import type {
  ClientTarget,
  ProxyConnectionInfo,
  ClientConfigResult,
  ClientMeta,
} from "./types";
import { CLIENT_META } from "./types";
import { detectInstalledClients, getAllConfigPaths } from "./paths";
import { configureOpenCode } from "./generators/opencode";
import { configureCodex } from "./generators/codex";
import { configureHermes } from "./generators/hermes";
import { configureOpenClaw } from "./generators/openclaw";
import { configureKilo } from "./generators/kilo";

// ── Generator registry ──────────────────────────────────────────

const GENERATORS: Record<
  ClientTarget,
  (info: ProxyConnectionInfo) => Promise<Omit<ClientConfigResult, "client">>
> = {
  opencode: configureOpenCode,
  codex: configureCodex,
  hermes: configureHermes,
  openclaw: configureOpenClaw,
  kilo: configureKilo,
};

// ── Public API ──────────────────────────────────────────────────

/** Get metadata for all supported clients, including detection status. */
export function getClientList(): ClientMeta[] {
  const detected = detectInstalledClients();
  return (Object.keys(CLIENT_META) as ClientTarget[]).map((id) => ({
    ...CLIENT_META[id],
    detected: detected[id] ?? false,
    configPaths: getAllConfigPaths(id),
  }));
}

/** Check if a specific client is installed. */
export { isClientDetected } from "./paths";
/** Get all detected clients. */
export { detectInstalledClients } from "./paths";
/** Get config paths for a client. */
export { getAllConfigPaths, getPrimaryConfigPath, resolveExistingPath } from "./paths";

/**
 * Generate config for a single client.
 * Set info.preview = true to skip writing to disk (dry-run).
 */
export async function generateClientConfig(
  clientId: ClientTarget,
  info: ProxyConnectionInfo
): Promise<ClientConfigResult> {
  const gen = GENERATORS[clientId];
  if (!gen) {
    return {
      client: clientId,
      success: false,
      paths: [],
      backupPaths: [],
      error: `Unknown client: ${clientId}`,
    };
  }
  return { client: clientId, ...(await gen({ ...info })) };
}

/**
 * Generate configs for all detected clients (preview only).
 */
export async function generateAllConfigs(
  info: ProxyConnectionInfo
): Promise<ClientConfigResult[]> {
  const detected = detectInstalledClients();
  const targets = (Object.keys(detected) as ClientTarget[]).filter((id) => detected[id]);
  return Promise.all(targets.map((id) => generateClientConfig(id, info)));
}

/**
 * Apply config (generate + write to disk) for a single client.
 */
export async function applyClientConfig(
  clientId: ClientTarget,
  info: ProxyConnectionInfo
): Promise<ClientConfigResult> {
  // The generator already writes to disk, so we just delegate.
  // To support dry-run, use generateClientConfig() which doesn't write.
  return generateClientConfig(clientId, info);
}

/**
 * Apply configs to all detected clients.
 */
export async function applyAllClients(
  info: ProxyConnectionInfo
): Promise<ClientConfigResult[]> {
  const detected = detectInstalledClients();
  const targets = (Object.keys(detected) as ClientTarget[]).filter((id) => detected[id]);
  return Promise.all(targets.map((id) => applyClientConfig(id, info)));
}

// Re-export types for consumers
export type { ClientTarget, ProxyConnectionInfo, ClientConfigResult, ClientMeta };
export { CLIENT_META };
