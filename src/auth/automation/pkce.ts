import crypto from "node:crypto";

/**
 * PKCE (Proof Key for Code Exchange) helpers — TS port of the reference proxy's
 * src/lib/oauth/utils/pkce.js, 1:1.
 */

/** Generate a PKCE code verifier (43-128 chars). bytes=32 default, xAI uses 96. */
export function generateCodeVerifier(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Derive the S256 code challenge from a verifier. */
export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function generateState(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export interface PkceChallenge {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

export function generatePkce(bytes = 32): PkceChallenge {
  const codeVerifier = generateCodeVerifier(bytes);
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  return { codeVerifier, codeChallenge, state };
}
