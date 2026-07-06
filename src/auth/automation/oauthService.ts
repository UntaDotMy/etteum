/**
 * Base OAuth service — TS port of 9router's src/lib/oauth/services/oauth.js +
 * providerHelpers.js, 1:1 flow behavior.
 *
 * Provides the two generic flow engines every provider service builds on:
 *   - runAuthorizationCodeFlow: PKCE + local callback server + code exchange
 *   - runDeviceCodeFlow:        device-code grant + polling
 *
 * Plus shared JWT/email helpers and the token-refresh driver.
 */
import { open } from "node:fs/promises";
import type { OAuthConfig } from "./constants";
import { generatePkce } from "./pkce";
import { startCallbackServer, getFreePort } from "./server";
import { OAUTH_TIMEOUT } from "./constants";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number; // epoch ms
  scope?: string;
  tokenType?: string;
  [key: string]: unknown;
}

export interface OAuthFlowResult {
  tokens: TokenSet;
  email?: string;
  accountInfo?: Record<string, unknown>;
}

const BASE64_BLOCK_SIZE = 4;

/** Decode a JWT payload without verification (for extracting email/claims). */
export function decodeJwtPayload(jwt?: string): Record<string, any> | null {
  try {
    if (!jwt || typeof jwt !== "string") return null;
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const base64 = (parts[1] || "").replace(/-/g, "+").replace(/_/g, "/");
    const missingPadding = (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) % BASE64_BLOCK_SIZE;
    const padded = base64 + "=".repeat(missingPadding);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function extractEmailFromAccessToken(accessToken?: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;
  return payload.email || payload.preferred_username || payload.sub || undefined;
}

export function extractCodexAccountInfo(idToken?: string): Record<string, unknown> {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return {};
  const chatgpt = payload["https://api.openai.com/auth"] || {};
  return {
    email: payload.email,
    chatgptAccountId: chatgpt.chatgpt_account_id || payload.account_id,
    chatgptPlanType: chatgpt.chatgpt_plan_type || payload.plan_type,
  };
}

/** Open the user's browser to an authorization URL. */
async function openBrowser(url: string): Promise<void> {
  const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const { spawn } = await import("node:child_process");
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* headless environments: caller prints the URL */
  }
}

/**
 * Run a full authorization-code + PKCE flow:
 *   1. Generate PKCE + state
 *   2. Start local callback server
 *   3. Open browser to authorize URL
 *   4. Receive ?code on callback
 *   5. Exchange code for tokens
 */
export async function runAuthorizationCodeFlow(
  config: OAuthConfig,
  opts: { headless?: boolean; openBrowser?: (url: string) => Promise<void> } = {},
): Promise<OAuthFlowResult> {
  const { codeVerifier, codeChallenge, state } = generatePkce();
  const port = config.fixedPort ?? (await getFreePort());
  const callbackPath = config.callbackPath ?? "/callback";
  const redirectUri = `http://localhost:${port}${callbackPath}`;

  // Build the authorize URL
  const authorizeUrl = new URL(config.authorizeUrl!);
  authorizeUrl.searchParams.set("client_id", config.clientId!);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);
  if (config.codeChallengeMethod) {
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", config.codeChallengeMethod);
  }
  const scopes = config.scopes ?? (config.scope ? config.scope.split(" ") : []);
  if (scopes.length) authorizeUrl.searchParams.set("scope", scopes.join(" "));
  for (const [k, v] of Object.entries(config.extraParams || {})) {
    authorizeUrl.searchParams.set(k, v);
  }

  // Open browser + start callback server in parallel
  const openFn = opts.openBrowser ?? openBrowser;
  if (!opts.headless) void openFn(authorizeUrl.toString());
  else console.log(`[oauth] Open this URL to authorize: ${authorizeUrl.toString()}`);

  const { params } = await startCallbackServer({
    port,
    path: callbackPath,
    expectedState: state,
    timeoutMs: OAUTH_TIMEOUT,
  });

  if (params.error) {
    throw new Error(`OAuth error: ${params.error}${params.errorDescription ? ` — ${params.errorDescription}` : ""}`);
  }
  if (!params.code) throw new Error("OAuth callback returned no code");

  // Exchange the code for tokens
  const tokenRes = await fetch(config.tokenUrl!, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: redirectUri,
      client_id: config.clientId!,
      code_verifier: codeVerifier,
      ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
    }),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    throw new Error(`Token exchange failed (${tokenRes.status}): ${text.slice(0, 500)}`);
  }
  const tokens = (await tokenRes.json()) as TokenSet;
  if (tokens.expires_in) {
    tokens.expiresAt = Date.now() + Number(tokens.expires_in) * 1000;
  }

  const email = extractEmailFromAccessToken(tokens.accessToken) ||
    (tokens.idToken ? (decodeJwtPayload(tokens.idToken)?.email as string | undefined) : undefined);
  const accountInfo = config.provider === "codex" ? extractCodexAccountInfo(tokens.idToken) : {};

  return { tokens, email, accountInfo };
}

/**
 * Run a device-code flow:
 *   1. POST to device-authorize endpoint → get device_code + user_code + verification_uri
 *   2. Show the user the verification URI + code (browser opened if possible)
 *   3. Poll the token endpoint until authorized / expired / denied
 */
export async function runDeviceCodeFlow(
  config: OAuthConfig,
  opts: { pollIntervalMs?: number; onUserCode?: (info: { userCode: string; verificationUri: string }) => void; openBrowser?: (url: string) => Promise<void> } = {},
): Promise<OAuthFlowResult> {
  const pollInterval = opts.pollIntervalMs ?? (config.pollInterval as number) ?? 5000;
  const deviceUrl = config.authorizeUrl || (config as any).deviceUrl;
  if (!deviceUrl) throw new Error(`Device-code flow for ${config.provider} has no authorize/device URL`);

  const body = new URLSearchParams({ client_id: config.clientId || "" });
  if (config.scope) body.set("scope", config.scope);

  const deviceRes = await fetch(deviceUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!deviceRes.ok) {
    const text = await deviceRes.text().catch(() => "");
    throw new Error(`Device authorization failed (${deviceRes.status}): ${text.slice(0, 500)}`);
  }
  const device = (await deviceRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval?: number;
  };

  const verificationUri = device.verification_uri_complete || device.verification_uri;
  opts.onUserCode?.({ userCode: device.user_code, verificationUri });
  const openFn = opts.openBrowser ?? openBrowser;
  void openFn(verificationUri);

  // Poll for the token
  const deadline = Date.now() + (device.expires_in || 900) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, device.interval ? device.interval * 1000 : pollInterval));
    const tokenRes = await fetch(config.tokenUrl!, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: config.clientId || "",
      }),
    });
    const tokenJson = (await tokenRes.json()) as any;
    if (tokenRes.ok && tokenJson.access_token) {
      const tokens: TokenSet = {
        accessToken: tokenJson.access_token,
        refreshToken: tokenJson.refresh_token,
        idToken: tokenJson.id_token,
        expiresAt: tokenJson.expires_in ? Date.now() + tokenJson.expires_in * 1000 : undefined,
        scope: tokenJson.scope,
        tokenType: tokenJson.token_type,
      };
      const email = extractEmailFromAccessToken(tokens.accessToken) ||
        (tokens.idToken ? (decodeJwtPayload(tokens.idToken)?.email as string | undefined) : undefined);
      return { tokens, email };
    }
    if (tokenJson.error === "expired_token" || tokenJson.error === "access_denied") {
      throw new Error(`Device flow ${tokenJson.error}`);
    }
    // authorization_pending / slow_down → keep polling
  }
  throw new Error("Device-code flow timed out waiting for authorization");
}

/**
 * Refresh an access token using a refresh token. Returns the new token set or
 * throws. Mirrors the reference refresh driver.
 */
export async function refreshAccessToken(config: OAuthConfig, refreshToken: string): Promise<TokenSet> {
  const refreshUrl = config.refreshUrl || config.tokenUrl;
  if (!refreshUrl) throw new Error(`No refresh URL for ${config.provider}`);
  const res = await fetch(refreshUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId || "",
      ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Refresh failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const j = (await res.json()) as any;
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token || refreshToken,
    idToken: j.id_token,
    expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
    scope: j.scope,
    tokenType: j.token_type,
  };
}
