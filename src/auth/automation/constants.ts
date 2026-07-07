/**
 * OAuth configuration constants — TS port of 9router's
 * src/lib/oauth/constants/oauth.js, 1:1.
 *
 * Inlines the client configs that 9router sourced from open-sse/providers
 * (shared.js + registry/*.js) so we have no dependency on that package.
 */
import { platform, arch } from "node:os";

/** OAuth flow types. */
export type OAuthFlow = "authorization_code" | "device_code" | "import_token" | "cookie";

export interface OAuthConfig {
  provider: string;
  flow: OAuthFlow;
  clientId?: string;
  clientSecret?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  scope?: string;
  scopes?: string[];
  codeChallengeMethod?: "S256" | "plain";
  redirectUri?: string;
  fixedPort?: number;
  callbackPath?: string;
  extraParams?: Record<string, string>;
  refreshLeadMs?: number;
  maxRefreshAgeMs?: number;
  // Provider-specific extras (e.g. codebuddy state URL, antigravity API endpoints)
  [key: string]: unknown;
}

/** Get the platform enum for Antigravity's ClientMetadata (1:1 with reference). */
export function getOAuthPlatformEnum(): number {
  const os = platform();
  const architecture = arch();
  if (os === "darwin") return architecture === "arm64" ? 2 : 1;
  if (os === "linux") return architecture === "arm64" ? 4 : 3;
  if (os === "win32") return 5;
  return 0;
}

export function getOAuthClientMetadata() {
  return { ideType: 9, platform: getOAuthPlatformEnum(), pluginType: 2 };
}

// --- Shared Google client configs ---
// Client secrets are sourced from env vars (never committed). Client IDs are
// public identifiers; secrets are the protected value.
export const ANTIGRAVITY_OAUTH_CLIENT = {
  clientId: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || "",
};
export const GOOGLE_OAUTH_CLIENT = {
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
};

// --- Per-provider OAuth configs (from open-sse/providers/registry/*.js) ---
export const PROVIDER_OAUTH: Record<string, OAuthConfig> = {
  codex: {
    provider: "codex",
    flow: "authorization_code",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access",
    codeChallengeMethod: "S256",
    fixedPort: 1455,
    callbackPath: "/auth/callback",
    extraParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    },
    refreshLeadMs: 432_000_000,
    maxRefreshAgeMs: 691_200_000,
  },
  antigravity: {
    provider: "antigravity",
    flow: "authorization_code",
    ...ANTIGRAVITY_OAUTH_CLIENT,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ],
    apiEndpoint: "https://cloudcode-pa.googleapis.com",
    apiVersion: "v1internal",
    loadCodeAssistEndpoint: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    onboardUserEndpoint: "https://cloudcode-pa.googleapis.com/v1internal:onboardUser",
    refreshLeadMs: 300_000,
  },
  "gemini-cli": {
    provider: "gemini-cli",
    flow: "authorization_code",
    ...GOOGLE_OAUTH_CLIENT,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
  },
  codebuddy: {
    provider: "codebuddy",
    flow: "device_code",
    baseUrl: "https://www.codebuddy.ai",
    stateUrl: "https://www.codebuddy.ai/v2/plugin/auth/state",
    tokenUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
    userAgent: "CLI/2.105.2 CodeBuddy/2.105.2",
    platform: "CLI",
    pollInterval: 5000,
  },
  "codebuddy-cn": {
    provider: "codebuddy-cn",
    flow: "device_code",
    baseUrl: "https://copilot.tencent.com",
    stateUrl: "https://copilot.tencent.com/v2/plugin/auth/state",
    tokenUrl: "https://copilot.tencent.com/v2/plugin/auth/token",
    refreshUrl: "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
    userAgent: "CLI/2.63.2 CodeBuddy/2.63.2",
    platform: "CLI",
    pollInterval: 5000,
  },
  qoder: {
    provider: "qoder",
    flow: "device_code",
    // Qoder device-token flow — refresh 403s upstream; we surface as re-login.
  },
  qwen: {
    provider: "qwen",
    flow: "device_code",
    // Qwen device-code flow with PKCE.
  },
  iflow: {
    provider: "iflow",
    flow: "authorization_code",
  },
  openai: {
    provider: "openai",
    flow: "authorization_code",
  },
  github: {
    provider: "github",
    flow: "device_code",
    clientId: "Iv1.b507a08c87ecfe98",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    deviceCodeUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "read:user",
  },
  kiro: {
    provider: "kiro",
    flow: "authorization_code",
    // Kiro multi-method: AWS Builder ID / IDC / Social / Import Token.
  },
  cursor: {
    provider: "cursor",
    flow: "import_token",
    tokenStoragePaths: {
      linux: "~/.config/Cursor/User/globalStorage/state.vscdb",
      macos: "/Users/<user>/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
      windows: "%APPDATA%\\Cursor\\User\\globalStorage\\state.vscdb",
    },
  },
  "kimi-coding": {
    provider: "kimi-coding",
    flow: "device_code",
    clientId: process.env.KIMI_CODING_OAUTH_CLIENT_ID || undefined,
  },
  kilocode: {
    provider: "kilocode",
    flow: "device_code",
  },
  cline: {
    provider: "cline",
    flow: "authorization_code",
    appBaseUrl: "https://app.cline.bot",
    apiBaseUrl: "https://api.cline.bot",
    authorizeUrl: "https://api.cline.bot/api/v1/auth/authorize",
    tokenUrl: "https://api.cline.bot/api/v1/auth/token",
    refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
  },
  gitlab: {
    provider: "gitlab",
    flow: "authorization_code",
    // GitLab Duo: authorization-code with PKCE.
  },
  claude: {
    provider: "claude",
    flow: "authorization_code",
    // Anthropic Claude: authorization-code with PKCE.
  },
};

// Re-exported consolidated configs (mirrors reference's CLAUDE_CONFIG etc.)
export const CODEX_CONFIG = PROVIDER_OAUTH.codex;
export const ANTIGRAVITY_CONFIG: OAuthConfig = {
  ...PROVIDER_OAUTH.antigravity,
  loadCodeAssistClientMetadata: JSON.stringify(getOAuthClientMetadata()),
} as OAuthConfig;
export const GEMINI_CONFIG = PROVIDER_OAUTH["gemini-cli"];
export const QWEN_CONFIG = PROVIDER_OAUTH.qwen;
export const QODER_CONFIG = PROVIDER_OAUTH.qoder;
export const IFLOW_CONFIG = PROVIDER_OAUTH.iflow;
export const OPENAI_CONFIG = PROVIDER_OAUTH.openai;
export const GITHUB_CONFIG = PROVIDER_OAUTH.github;
export const KIRO_CONFIG = PROVIDER_OAUTH.kiro;
export const CURSOR_CONFIG = PROVIDER_OAUTH.cursor;
export const CLINE_CONFIG = PROVIDER_OAUTH.cline;
export const GITLAB_CONFIG = PROVIDER_OAUTH.gitlab;
export const CLAUDE_CONFIG = PROVIDER_OAUTH.claude;
export const CODEBUDDY_CONFIG = PROVIDER_OAUTH.codebuddy;
export const CODEBUDDY_CN_CONFIG = PROVIDER_OAUTH["codebuddy-cn"];

// OAuth timeout (5 minutes) — 1:1 with reference.
export const OAUTH_TIMEOUT = 300_000;

// AWS region allowlist (SSRF guard from reference GHSA-6mwv-4mrm-5p3m).
export const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;
export function assertValidAwsRegion(region: string): string {
  if (typeof region !== "string" || !AWS_REGION_PATTERN.test(region)) {
    throw new Error("Invalid region");
  }
  return region;
}

// Provider id enum (1:1 with reference PROVIDERS).
export const PROVIDERS = {
  CLAUDE: "claude",
  CODEX: "codex",
  GEMINI: "gemini-cli",
  QWEN: "qwen",
  QODER: "qoder",
  IFLOW: "iflow",
  ANTIGRAVITY: "antigravity",
  OPENAI: "openai",
  GITHUB: "github",
  KIRO: "kiro",
  CURSOR: "cursor",
  KIMI_CODING: "kimi-coding",
  KILOCODE: "kilocode",
  CLINE: "cline",
  GITLAB: "gitlab",
  CODEBUDDY: "codebuddy",
  CODEBUDDY_CN: "codebuddy-cn",
} as const;
export type ProviderId = (typeof PROVIDERS)[keyof typeof PROVIDERS];
