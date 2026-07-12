/**
 * Dashboard security layer — TS port of the reference proxy's
 * src/lib/auth/{dashboardSession,oidc,loginLimiter}.js, 1:1 behavior.
 *
 * Uses only Node's built-in crypto (WebCrypto + scrypt) — no `jose`/`bcryptjs`
 * dependency. Provides:
 *   - createDashboardAuthToken / verify: HS256 JWT sessions in httpOnly cookies
 *   - hashDashboardPassword / verifyDashboardPassword: scrypt (bcrypt-equivalent)
 *   - OIDC: discovery fetch, PKCE, JWKS ID-token verification, code exchange
 *   - loginLimiter: progressive brute-force lockout per IP
 *
 * Closes the security/multi-tenancy HIGH gaps .
 */
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config";
import { db } from "../db/index";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { constantTimeEqual } from "../utils/security";

// NOTE: no hard-coded default password. First-boot login requires either a
// stored hash (set via CLI / Settings) or INITIAL_PASSWORD in the env. This
// closes CWE-259 (Use of Hard-coded Password) — a fresh deploy with no
// password configured simply refuses login until the operator sets one.
const SESSION_COOKIE_NAME = "auth_token";
const SESSION_TTL_HOURS = 24;

// --- JWT secret (mirrors reference's loadJwtSecret) ---
function loadJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const dir = config.databasePath ? path.dirname(config.databasePath) : "./data";
  const file = path.join(dir, "jwt-secret");
  try {
    return readFileSync(file, "utf8").trim();
  } catch { /* not yet generated */ }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

const JWT_SECRET = loadJwtSecret();
const SECRET_BYTES = new TextEncoder().encode(JWT_SECRET);

function base64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64url");
}

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

// --- HS256 JWT sign/verify (WebCrypto) ---
export async function createDashboardAuthToken(claims: Record<string, unknown> = {}): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { authenticated: true, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + SESSION_TTL_HOURS * 3600, ...claims };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey("raw", SECRET_BYTES as unknown as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(Buffer.from(sig))}`;
}

export async function verifyDashboardAuthToken(token?: string): Promise<Record<string, any> | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64 = "", payloadB64 = "", sigB64 = ""] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey("raw", SECRET_BYTES as unknown as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sigBytes = new Uint8Array(base64urlDecode(sigB64));
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(signingInput)).catch(() => false);
  if (!valid) return null;
  try {
    const payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
    if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function shouldUseSecureCookie(headers: Headers): boolean {
  if (process.env.AUTH_COOKIE_SECURE === "true") return true;
  return headers.get("x-forwarded-proto") === "https";
}

export function sessionCookieOptions(headers: Headers) {
  return {
    httpOnly: true,
    secure: shouldUseSecureCookie(headers),
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_HOURS * 3600,
  };
}

export const SESSION_COOKIE = SESSION_COOKIE_NAME;

// --- Password hashing (scrypt — bcrypt-equivalent, Node built-in) ---
export async function hashDashboardPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyDashboardPassword(password: string, stored: string): boolean {
  if (typeof password !== "string" || !password) return false;
  if (stored.startsWith("scrypt$")) {
    const parts = stored.split("$");
    const saltHex = parts[1] || "";
    const hashHex = parts[2] || "";
    if (!saltHex || !hashHex) return false;
    const hash = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64);
    const storedHash = Buffer.from(hashHex, "hex");
    if (hash.length !== storedHash.length) return false;
    return crypto.timingSafeEqual(hash, storedHash);
  }
  // No stored hash yet → first-boot. Allow login ONLY via an explicit
  // INITIAL_PASSWORD env var set by the operator. Never a hard-coded default.
  const initial = process.env.INITIAL_PASSWORD;
  if (!initial) return false;
  return constantTimeEqual(password, initial);
}

export async function getStoredPasswordHash(): Promise<string | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, "password"));
  return row?.value || null;
}

// --- OIDC/SSO (mirrors reference's oidc.js) ---
export const OIDC_COOKIE_NAMES = { state: "oidc_state", nonce: "oidc_nonce", verifier: "oidc_code_verifier" };

/**
 * SSRF guard for OIDC issuer URLs. Rejects internal/loopback/link-local
 * addresses before we ever `fetch()` them. Pragmatic reduction — full
 * DNS-rebinding prevention would need resolution pinning (out of scope).
 */
function assertPublicIssuer(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("OIDC issuer is not a valid URL");
  }
  const host = parsed.hostname.toLowerCase();
  const isLocalDev = (host === "localhost" || host === "127.0.0.1" || host === "::1") && process.env.NODE_ENV !== "production";
  if (parsed.protocol !== "https:" && !isLocalDev) {
    throw new Error("OIDC issuer must use https (http only allowed for localhost in non-production)");
  }
  if (host.endsWith(".local")) {
    throw new Error("OIDC issuer .local mDNS hostnames are not allowed");
  }
  if (isLocalDev) return; // localhost/127.0.0.1 explicitly allowed for dev
  // Reject IP literals in private/loopback/link-local ranges.
  if (isPrivateIpLiteral(host)) {
    throw new Error(`OIDC issuer resolves to a disallowed internal/loopback address: ${host}`);
  }
}

function isPrivateIpLiteral(host: string): boolean {
  // IPv4 dotted quad
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = parseInt(v4[1]!, 10);
    const b = parseInt(v4[2]!, 10);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
    if (a === 192 && b === 168) return true; // private 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
    if (a === 0) return true; // 0.0.0.0/8
  }
  // IPv6 (bracket-stripped already by URL.hostname). Block ::1, fc00::/7, fe80::/10.
  const v6 = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (v6 === "::1") return true; // loopback
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // unique-local fc00::/7
  if (v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) return true; // link-local fe80::/10
  return false;
}

export interface OidcRuntimeConfig {
  enabled: boolean;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
}

export async function getOidcRuntimeConfig(): Promise<OidcRuntimeConfig> {
  const [row] = await db.select().from(settings).where(eq(settings.key, "oidc_config"));
  if (!row?.value) return { enabled: false };
  try { return { enabled: true, ...JSON.parse(row.value) }; } catch { return { enabled: false }; }
}

export async function fetchOidcDiscovery(issuer: string): Promise<any> {
  assertPublicIssuer(issuer);
  const url = issuer.endsWith("/") ? `${issuer}.well-known/openid-configuration` : `${issuer}/.well-known/openid-configuration`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
  return res.json();
}

export function createOidcState(): string {
  return crypto.randomBytes(16).toString("base64url");
}
export function createOidcNonce(): string {
  return crypto.randomBytes(16).toString("base64url");
}
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function getPublicOrigin(headers: Headers): string {
  const proto = headers.get("x-forwarded-proto") || "http";
  const host = headers.get("x-forwarded-host") || headers.get("host") || "localhost";
  return `${proto}://${host}`;
}

export async function buildOidcAuthorizationUrl(opts: {
  discovery: any; clientId: string; redirectUri: string; state: string; nonce: string; challenge: string; scopes?: string[];
}): Promise<string> {
  const url = new URL(opts.discovery.authorization_endpoint);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("nonce", opts.nonce);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  const scopes = opts.scopes || ["openid", "profile", "email"];
  url.searchParams.set("scope", scopes.join(" "));
  return url.toString();
}

export async function exchangeOidcCode(opts: {
  discovery: any; clientId: string; clientSecret?: string; code: string; redirectUri: string; verifier: string;
}): Promise<any> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.verifier,
  });
  if (opts.clientSecret) body.set("client_secret", opts.clientSecret);
  const res = await fetch(opts.discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`OIDC token exchange failed (${res.status})`);
  return res.json();
}

/** Verify an OIDC ID token's signature against the issuer's JWKS. */
export async function verifyOidcIdToken(idToken: string, discovery: any, clientId: string): Promise<Record<string, any> | null> {
  try {
    const [headerB64 = "", payloadB64 = "", sigB64 = ""] = idToken.split(".");
    const header = JSON.parse(base64urlDecode(headerB64).toString("utf8"));
    const payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
    if (payload.aud !== clientId) return null;
    if (payload.iss !== discovery.issuer) return null;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && now >= payload.exp) return null;
    if (payload.nbf && now < payload.nbf) return null;
    // Fetch JWKS and verify with the matching key.
    // FAIL-CLOSED: any inability to fetch JWKS, find the matching key, or verify
    // the signature returns null (no session) — never the unverified payload.
    // Mirrors reference oidc.js:212-226 where jose jwtVerify throws → /login?error.
    const jwksRes = await fetch(discovery.jwks_uri, { headers: { accept: "application/json" } });
    if (!jwksRes.ok) return null; // JWKS unreachable → refuse login
    const jwks = (await jwksRes.json()) as any;
    const key = jwks.keys?.find((k: any) => k.kid === header.kid);
    if (!key) return null; // no key for token's kid → refuse login
    // SECURITY: pin the supported alg set (RFC 8725 §3.1). Only RS256/RS384
    // are allowed; 'none'/HS256/ES256/unknown algorithms are rejected.
    const ALLOWED_ALGS: Record<string, string> = { RS256: "SHA-256", RS384: "SHA-384" };
    const hash = ALLOWED_ALGS[header.alg];
    if (!hash) return null; // unsupported alg → refuse login
    const cryptoKey = await crypto.subtle.importKey("jwk", key as any, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
    const sigBytes = new Uint8Array(base64urlDecode(sigB64));
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, sigBytes, new TextEncoder().encode(`${headerB64}.${payloadB64}`));
    return valid ? payload : null;
  } catch {
    return null;
  }
}

export function pickOidcEmail(payload: any = {}): string {
  return payload.email || "";
}
export function pickOidcDisplayName(payload: any = {}): string {
  return payload.name || payload.preferred_username || payload.email || "";
}

// --- Progressive brute-force lockout (mirrors reference's loginLimiter.js) ---
const MAX_FAILS_BEFORE_LOCK = 5;
const LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000];
const FAIL_WINDOW_MS = 60 * 60 * 1000;
// Reset lockLevel/fails if the last failure was more than this long ago, so a
// legitimate user recovers after the window and lockLevel cannot grow unbounded.
const LOCK_LEVEL_RESET_MS = 60 * 60 * 1000;

interface LockEntry { fails: number; lockUntil: number; lockLevel: number; lastFailAt: number }
const attempts = new Map<string, LockEntry>();

export function checkLock(ip: string): { locked: boolean; retryAfter?: number } {
  const e = attempts.get(ip);
  if (!e || !e.lockUntil) return { locked: false };
  if (Date.now() - e.lastFailAt > FAIL_WINDOW_MS) { attempts.delete(ip); return { locked: false }; }
  const remaining = e.lockUntil - Date.now();
  if (remaining <= 0) return { locked: false };
  return { locked: true, retryAfter: Math.ceil(remaining / 1000) };
}

export function recordFail(ip: string): { remainingBeforeLock: number } {
  const e = attempts.get(ip) || { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0 };
  // Reset after the inactivity window so lockLevel can't grow without bound
  // and a user recovers after the cooldown.
  if (e.lastFailAt && Date.now() - e.lastFailAt > LOCK_LEVEL_RESET_MS) {
    e.fails = 0;
    e.lockLevel = 0;
  }
  e.fails += 1;
  e.lastFailAt = Date.now();
  if (e.fails >= MAX_FAILS_BEFORE_LOCK) {
    const step = LOCK_STEPS_MS[Math.min(e.lockLevel, LOCK_STEPS_MS.length - 1)] ?? 30_000;
    e.lockUntil = Date.now() + step;
    // Cap lockLevel at the array length so it never indexes past LOCK_STEPS_MS.
    e.lockLevel = Math.min(e.lockLevel + 1, LOCK_STEPS_MS.length);
    e.fails = 0;
  }
  attempts.set(ip, e);
  return { remainingBeforeLock: Math.max(0, MAX_FAILS_BEFORE_LOCK - e.fails) };
}

export function recordSuccess(ip: string): void {
  attempts.delete(ip);
}

export function getClientIp(headers: Headers): string {
  // SECURITY: forwarding headers are client-controllable. Only trust them
  // behind an explicitly-trusted reverse proxy. Previously x-9r-real-ip /
  // x-real-ip were read unconditionally, allowing a remote attacker to
  // spoof their IP and bypass the loginLimiter (CWE-348).
  if (process.env.TRUST_PROXY === "true") {
    const realIp = headers.get("x-9r-real-ip") || headers.get("x-real-ip");
    if (realIp) return realIp;
    const xff = headers.get("x-forwarded-for");
    if (xff) return (xff.split(",")[0] || "").trim();
  }
  return "unknown";
}
