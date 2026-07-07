/**
 * Shared types for the client config generation library.
 * Adapted from kiro-unified's client integration system.
 */

export type ClientTarget =
  | "opencode"
  | "codex"
  | "hermes"
  | "openclaw"
  | "kilo"
  | "claude"
  | "cline"
  | "copilot"
  | "droid"
  | "deepseek-tui"
  | "jcode"
  | "cowork";

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
  claude: {
    id: "claude",
    name: "Claude Code",
    description: "Anthropic's CLI coding agent",
    cli: "claude",
    url: "https://github.com/anthropics/claude-code",
  },
  cline: {
    id: "cline",
    name: "Cline",
    description: "Autonomous coding agent for VS Code",
    cli: "cline",
    url: "https://github.com/cline/cline",
  },
  copilot: {
    id: "copilot",
    name: "GitHub Copilot Chat",
    description: "GitHub Copilot Chat custom model",
    cli: "copilot",
    url: "https://docs.github.com/copilot",
  },
  droid: {
    id: "droid",
    name: "Droid / Factory",
    description: "Factory Droid coding agent",
    cli: "droid",
    url: "https://docs.factory.ai",
  },
  "deepseek-tui": {
    id: "deepseek-tui",
    name: "DeepSeek TUI",
    description: "DeepSeek terminal UI",
    cli: "deepseek",
    url: "https://github.com/deepseek-ai/DeepSeek-Coder",
  },
  jcode: {
    id: "jcode",
    name: "Jcode",
    description: "Jcode coding agent",
    cli: "jcode",
    url: "https://github.com/jcode-dev/jcode",
  },
  cowork: {
    id: "cowork",
    name: "Cowork (Claude Desktop)",
    description: "Cowork MCP via Claude Desktop config",
    cli: "cowork",
    url: "https://github.com/cowork",
  },
};
