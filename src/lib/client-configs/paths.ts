/**
 * Platform-aware config file paths for each supported AI client.
 * Adapted from kiro-unified frontend/src/main/lib/clientPaths.ts.
 */
import * as path from "node:path";
import * as os from "node:os";
import { existsSync } from "node:fs";
import type { ClientTarget } from "./types";

const homeDir = os.homedir();

/** Resolve ~ to the actual home directory on all platforms. */
function home(...segments: string[]): string {
  return path.join(homeDir, ...segments);
}

/**
 * Per-client config paths indexed by [clientTarget][platform].
 * Values are the PRIMARY config files to read/write; some clients have
 * secondary files handled inside their respective generators.
 */
const CLIENT_PRIMARY_PATHS: Record<ClientTarget, Partial<Record<NodeJS.Platform, string>>> = {
  opencode: {
    win32: home(".config", "opencode", "opencode.json"),
    darwin: home(".config", "opencode", "opencode.json"),
    linux: home(".config", "opencode", "opencode.json"),
  },
  codex: {
    win32: home(".codex", "config.toml"),
    darwin: home(".codex", "config.toml"),
    linux: home(".codex", "config.toml"),
  },
  hermes: {
    win32: home(".hermes", "config.yaml"),
    darwin: home(".hermes", "config.yaml"),
    linux: home(".hermes", "config.yaml"),
  },
  openclaw: {
    win32: home(".openclaw", "openclaw.json"),
    darwin: home(".openclaw", "openclaw.json"),
    linux: home(".openclaw", "openclaw.json"),
  },
  kilo: {
    win32: home(".config", "kilo", "kilo.jsonc"),
    darwin: home(".config", "kilo", "kilo.jsonc"),
    linux: home(".config", "kilo", "kilo.jsonc"),
  },
};

/**
 * Secondary paths per client (e.g., codex uses both auth.json + config.toml).
 * These are files that are also written during config application.
 */
const CLIENT_SECONDARY_PATHS: Record<string, Partial<Record<NodeJS.Platform, string>>> = {
  "codex.auth": {
    win32: home(".codex", "auth.json"),
    darwin: home(".codex", "auth.json"),
    linux: home(".codex", "auth.json"),
  },
};

/** Get the platform-specific primary config path for a client. */
export function getPrimaryConfigPath(clientId: ClientTarget, platform?: NodeJS.Platform): string {
  const plat = platform || os.platform();
  const paths = CLIENT_PRIMARY_PATHS[clientId];
  if (!paths) return "";
  return paths[plat] || paths.darwin || "";
}

/** Get ALL config paths that would be written for a client (primary + secondary). */
export function getAllConfigPaths(clientId: ClientTarget, platform?: NodeJS.Platform): string[] {
  const paths: string[] = [getPrimaryConfigPath(clientId, platform)].filter(Boolean);

  // Add secondary paths
  if (clientId === "codex") {
    const plat = platform || os.platform();
    const authPath = CLIENT_SECONDARY_PATHS["codex.auth"];
    if (authPath?.[plat]) paths.push(authPath[plat]);
  }

  return paths;
}

/** Check whether a client is installed by looking for its config directory or file. */
export function isClientDetected(clientId: ClientTarget, platform?: NodeJS.Platform): boolean {
  const primaryPath = getPrimaryConfigPath(clientId, platform);
  if (!primaryPath) return false;

  // Check if the config file itself exists, or if its parent directory exists
  if (existsSync(primaryPath)) return true;
  const dir = path.dirname(primaryPath);
  return existsSync(dir);
}

/**
 * Detect all installed clients. Returns a map of client ID → detected status.
 */
export function detectInstalledClients(platform?: NodeJS.Platform): Record<ClientTarget, boolean> {
  const result: Record<string, boolean> = {};
  for (const clientId of Object.keys(CLIENT_PRIMARY_PATHS) as ClientTarget[]) {
    result[clientId] = isClientDetected(clientId, platform);
  }
  return result as Record<ClientTarget, boolean>;
}

/**
 * Resolve the primary config path, preferring an existing file over a default.
 * Some clients have multiple possible config file names; this picks the right one.
 */
export function resolveExistingPath(clientId: ClientTarget, platform?: NodeJS.Platform): string {
  const plat = platform || os.platform();

  switch (clientId) {
    case "opencode": {
      const dir = home(".config", "opencode");
      const candidates = [path.join(dir, "opencode.json"), path.join(dir, "config.json")];
      return candidates.find((p) => existsSync(p)) || candidates[0]!;
    }
    case "kilo": {
      const dir = home(".config", "kilo");
      const candidates = [
        path.join(dir, "kilo.jsonc"),
        path.join(dir, "kilo.json"),
        path.join(dir, "config.json"),
      ];
      return candidates.find((p) => existsSync(p)) || candidates[1]!;
    }
    default:
      return getPrimaryConfigPath(clientId, plat);
  }
}
