import { Hono } from "hono";
import { createHash, randomBytes } from "crypto";
import { exchangeCodexAuthorizationCode, exchangeCodexRefreshTokens, importCodexAccessToken } from "./accounts";
import {
  consumeCodexOAuthSession,
  createCodexOAuthSession,
  deleteCodexOAuthSession,
  getCodexOAuthSession,
  updateCodexOAuthSession,
} from "./oauth-codex-session";

const CODEX_ISSUER = "https://auth.openai.com";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_FIXED_PORT = 1455;
const CODEX_CALLBACK_PATH = "/auth/callback";
const CODEX_SCOPE = "openid profile email offline_access";
const CODEX_PROXY_TIMEOUT_MS = 300000;

let codexLoopbackServer: Bun.Server<unknown> | null = null;
let codexLoopbackTimeout: ReturnType<typeof setTimeout> | null = null;

function generateCodeVerifier(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function generateCodeChallenge(codeVerifier: string) {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function generateState() {
  return randomBytes(32).toString("base64url");
}

export const oauthRouter = new Hono();

async function completeCodexOAuth(code: string, state: string) {
  const session = getCodexOAuthSession(state);
  if (!session) {
    throw new Error("OAuth session expired or not found");
  }

  updateCodexOAuthSession(state, { status: "exchanging", error: undefined });

  try {
    const connection = await exchangeCodexAuthorizationCode({
      code,
      codeVerifier: session.codeVerifier,
      redirectUri: session.redirectUri,
    });

    updateCodexOAuthSession(state, {
      status: "done",
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        displayName: connection.name,
        workspace: connection.workspace,
        plan: connection.plan,
      },
    });

    return {
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        displayName: connection.name,
        workspace: connection.workspace,
        plan: connection.plan,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateCodexOAuthSession(state, { status: "error", error: message });
    throw error;
  }
}

function buildCodexAuthorizeUrl(redirectUri: string, codeChallenge: string, state: string) {
  const params = {
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: CODEX_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
    state,
  };
  const queryString = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `${CODEX_ISSUER}/oauth/authorize?${queryString}`;
}

function callbackHtml(title: string, message: string, closeWindow = false) {
  const closeScript = closeWindow
    ? `<script>setTimeout(() => window.close(), 1200)</script>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8" /><title>${title}</title></head><body style="font-family:system-ui,sans-serif;padding:24px;background:#0b0f14;color:#e5e7eb"><div style="max-width:520px;margin:40px auto;padding:24px;border:1px solid #334155;border-radius:12px;background:#111827"><h1 style="margin:0 0 12px;font-size:20px">${title}</h1><p style="margin:0;color:#cbd5e1">${message}</p></div>${closeScript}</body></html>`;
}

function scheduleCodexLoopbackStop() {
  setTimeout(() => stopCodexLoopbackServer(), 0);
}

async function handleCodexLoopbackCallback(url: URL) {
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error") || "";
  const errorDescription = url.searchParams.get("error_description") || error;

  if (!state) {
    scheduleCodexLoopbackStop();
    return new Response(callbackHtml("Codex login failed", "Missing OAuth state."), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (error) {
    updateCodexOAuthSession(state, { status: "error", error: errorDescription || error });
    scheduleCodexLoopbackStop();
    return new Response(callbackHtml("Codex login failed", errorDescription || error, true), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (!code) {
    updateCodexOAuthSession(state, { status: "error", error: "Missing authorization code" });
    scheduleCodexLoopbackStop();
    return new Response(callbackHtml("Codex login failed", "Missing authorization code.", true), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  try {
    await completeCodexOAuth(code, state);
    scheduleCodexLoopbackStop();
    return new Response(callbackHtml("Codex connected", "You can close this window and return to the dashboard.", true), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (oauthError) {
    const message = oauthError instanceof Error ? oauthError.message : String(oauthError);
    scheduleCodexLoopbackStop();
    return new Response(callbackHtml("Codex login failed", message, true), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

function ensureCodexLoopbackServer() {
  if (codexLoopbackServer) return codexLoopbackServer;

  codexLoopbackServer = Bun.serve({
    hostname: "127.0.0.1",
    port: CODEX_FIXED_PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === CODEX_CALLBACK_PATH || url.pathname === "/callback") {
        return handleCodexLoopbackCallback(url);
      }

      return new Response("Not Found", { status: 404 });
    },
    error(error) {
      return new Response(
        callbackHtml("Codex login failed", error instanceof Error ? error.message : String(error), true),
        {
          status: 500,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        },
      );
    },
  });

  codexLoopbackTimeout = setTimeout(() => stopCodexLoopbackServer(), CODEX_PROXY_TIMEOUT_MS);

  return codexLoopbackServer;
}

function stopCodexLoopbackServer() {
  if (codexLoopbackTimeout) {
    clearTimeout(codexLoopbackTimeout);
    codexLoopbackTimeout = null;
  }
  if (codexLoopbackServer) {
    codexLoopbackServer.stop(true);
    codexLoopbackServer = null;
  }
}

oauthRouter.get("/codex/callback", async (c) => {
  const response = await handleCodexLoopbackCallback(new URL(c.req.url));
  return new Response(response.body, response);
});

oauthRouter.post("/codex/callback", async (c) => {
  try {
    const body = await c.req.json<{ code?: string; state?: string }>();
    if (!body.code || !body.state) {
      return c.json({ error: "Missing code or state" }, 400);
    }
    const result = await completeCodexOAuth(body.code, body.state);
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

oauthRouter.post("/codex/complete", async (c) => {
  try {
    const body = await c.req.json<{ code?: string; state?: string }>();
    if (!body.code || !body.state) {
      return c.json({ error: "Missing code or state" }, 400);
    }
    const result = await completeCodexOAuth(body.code, body.state);
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

oauthRouter.post("/codex/import-token", async (c) => {
  try {
    const body = await c.req.json<{ accessToken?: string; name?: string }>();

    if (!body.accessToken || typeof body.accessToken !== "string") {
      return c.json({ error: "Access token is required" }, 400);
    }

    const connection = await importCodexAccessToken(body.accessToken, body.name);
    return c.json({ success: true, connection });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

oauthRouter.post("/codex/exchange", async (c) => {
  try {
    const body = await c.req.json<{
      code?: string;
      refreshToken?: string;
      tokens?: string[];
      redirectUri?: string;
      codeVerifier?: string;
      state?: string;
      meta?: Record<string, unknown>;
    }>();

    if (body.code && body.code.startsWith("eyJ") && body.code.includes(".")) {
      const connection = await importCodexAccessToken(body.code);
      return c.json({
        success: true,
        connection: {
          id: connection.id,
          provider: connection.provider,
          email: connection.email,
          displayName: connection.name,
        },
      });
    }

    if (body.code && body.redirectUri && body.codeVerifier) {
      const connection = await exchangeCodexAuthorizationCode({
        code: body.code,
        redirectUri: body.redirectUri,
        codeVerifier: body.codeVerifier,
      });
      return c.json({
        success: true,
        connection: {
          id: connection.id,
          provider: connection.provider,
          email: connection.email,
          displayName: connection.name,
        },
      });
    }

    if (body.code && body.state) {
      const result = await completeCodexOAuth(body.code, body.state);
      return c.json(result);
    }

    const refreshTokens = Array.isArray(body.tokens)
      ? body.tokens
      : [body.refreshToken || body.code || ""].filter(Boolean);

    if (refreshTokens.length === 0) {
      return c.json({ error: "Missing token/code/refreshToken" }, 400);
    }

    const result = await exchangeCodexRefreshTokens(refreshTokens);
    if (result.success > 0) {
      return c.json({
        success: true,
        connection: {
          provider: "codex",
          displayName: "Codex",
        },
        imported: result.success,
        failed: result.failed,
        errors: result.errors,
      });
    }

    return c.json(result, 400);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

oauthRouter.get("/codex/authorize", async (c) => {
  const redirectUri = c.req.query("redirect_uri") || `http://localhost:${CODEX_FIXED_PORT}${CODEX_CALLBACK_PATH}`;
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const authUrl = buildCodexAuthorizeUrl(redirectUri, codeChallenge, state);
  return c.json({
    authUrl,
    state,
    codeVerifier,
    codeChallenge,
    redirectUri,
    flowType: "authorization_code_pkce",
    fixedPort: CODEX_FIXED_PORT,
    callbackPath: CODEX_CALLBACK_PATH,
  });
});

oauthRouter.get("/codex/start-proxy", (c) => {
  const appPort = c.req.query("app_port") || "";
  const state = c.req.query("state") || "";
  const codeVerifier = c.req.query("code_verifier") || "";
  const redirectUri = c.req.query("redirect_uri") || `http://localhost:${CODEX_FIXED_PORT}${CODEX_CALLBACK_PATH}`;

  if (!appPort) return c.json({ error: "Missing app_port" }, 400);
  if (!state || !codeVerifier) return c.json({ error: "Missing state or code_verifier" }, 400);

  try {
    ensureCodexLoopbackServer();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = message.includes("EADDRINUSE") || message.includes("Address already in use")
      ? "port_busy"
      : message;
    return c.json({ success: false, reason, serverSide: false });
  }

  createCodexOAuthSession({ state, codeVerifier, redirectUri, appPort });
  updateCodexOAuthSession(state, { status: "waiting_callback" });

  return c.json({
    success: true,
    serverSide: true,
  });
});

oauthRouter.get("/codex/poll-status", (c) => {
  const state = c.req.query("state") || "";
  if (!state) return c.json({ error: "Missing state" }, 400);

  const session = getCodexOAuthSession(state);
  if (!session) {
    return c.json({ status: "unknown" });
  }

  if (session.status === "done" || session.status === "error" || session.status === "cancelled") {
    const consumed = consumeCodexOAuthSession(state);
    return c.json({
      status: consumed?.status,
      connection: consumed?.connection,
      error: consumed?.error,
    });
  }

  return c.json({ status: session.status });
});

oauthRouter.get("/codex/stop-proxy", (c) => {
  const state = c.req.query("state") || "";
  if (state) {
    updateCodexOAuthSession(state, { status: "cancelled", error: "Cancelled by user" });
    deleteCodexOAuthSession(state);
  }
  stopCodexLoopbackServer();
  return c.json({ success: true });
});

// 9router supports device-code on other providers; Codex does not use it here.
oauthRouter.get("/codex/device-code", (c) => {
  return c.json({ error: "Provider does not support device code flow" }, 400);
});

oauthRouter.post("/:provider/poll", (c) => {
  return c.json({ error: "Unsupported provider/action" }, 400);
});

oauthRouter.all("/:provider/:action", (c) => {
  return c.json({ error: "Unsupported provider/action" }, 400);
});

export default oauthRouter;
