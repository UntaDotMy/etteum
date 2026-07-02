/**
 * Shared types for the client config generation library.
 * Adapted from kiro-unified's client integration system.
 */

export type ClientTarget =
  | "opencode"
  | "codex"
  | "hermes"
  | "openclaw"
  | "kilo";

export interface ProxyClientModel {
  id: string;
  name?: string;
  inputTypes?: string[];
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
}

/** Core connection info passed to every generator. */
export interface ProxyConnectionInfo {
  /** Origin used for Anthropic-native clients (no /v1 suffix), e.g. http://localhost:1930 */
  proxyOrigin: string;
  /** Full OpenAI-compatible base URL, e.g. http://localhost:1930/v1 */
  openaiBaseUrl: string;
  /** API key (Bearer token) for authentication */
  apiKey: string;
  /** Default model ID to use */
  modelId: string;
  /** Available models from the pool (for model registry import) */
  models: ProxyClientModel[];
  /** If true, only generate config without writing to disk */
  preview?: boolean;
}

/** Result of generating or applying config for a single client. */
export interface ClientConfigResult {
  client: ClientTarget;
  success: boolean;
  /** JSON-serializable config content (for preview / dry-run) */
  preview?: Record<string, unknown>;
  /** Paths that would be or were written to */
  paths: string[];
  /** Backup paths created */
  backupPaths: string[];
  /** Error message if success is false */
  error?: string;
}

/** Metadata about a supported client (for dashboard display). */
export interface ClientMeta {
  id: ClientTarget;
  name: string;
  description: string;
  /** CLI tool name (e.g. "claude", "opencode") */
  cli: string;
  /** Homepage or docs URL */
  url: string;
  /** Whether the client is detected on this machine */
  detected: boolean;
  /** Config file paths that would be modified */
  configPaths: string[];
}

/** Map of all supported client metadata. */
export const CLIENT_META: Record<ClientTarget, Omit<ClientMeta, "detected" | "configPaths">> = {
  opencode: {
    id: "opencode",
    name: "OpenCode",
    description: "Open-source AI coding agent",
    cli: "opencode",
    url: "https://github.com/opencode-ai/opencode",
  },
  codex: {
    id: "codex",
    name: "Codex",
    description: "OpenAI's CLI coding agent",
    cli: "codex",
    url: "https://github.com/openai/codex",
  },
  hermes: {
    id: "hermes",
    name: "Hermes",
    description: "Multi-provider AI agent framework",
    cli: "hermes",
    url: "https://github.com/nousresearch/hermes-agent",
  },
  openclaw: {
    id: "openclaw",
    name: "OpenClaw",
    description: "AI coding agent with multi-model support",
    cli: "openclaw",
    url: "https://github.com/openclaw/openclaw",
  },
  kilo: {
    id: "kilo",
    name: "Kilo Code",
    description: "AI coding extension for VS Code",
    cli: "kilo",
    url: "https://github.com/Kilo-Org/kilocode",
  },
};
