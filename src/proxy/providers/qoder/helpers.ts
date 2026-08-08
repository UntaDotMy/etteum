/** qoder helpers (auth, crypto, transforms). */
import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
} from "../base";
import type { Account } from "../../../db/schema";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyModelSpecs, resolveModelSpec } from "../../model-specs";
import { getUpstreamNameOverride } from "../custom-models";

// ============================================================================
// Qoder Cosy call path — chat / quota / activity
// Proven Free0 K3/Qwen3.8 path (Hermes live smoke 2026-07):
//   COSY 1.15.1 + clienttype 0 + machine* as stored (mt≠id, type hex, code+os).
// Do NOT use old CLI spoof 1.0.22 + clienttype "5" + machineType "5" — Lite only.
// Auth/login stays separate; this file owns the request shape that reaches Qoder.
// ============================================================================

export const COSY_VERSION = "1.15.1";
/** Desktop Cosy capture. Hermes: clienttype 0 unlocks K3/Qwen3.8 on Free0. */
export const COSY_CLIENT_TYPE = "0";
export const APPCODE = "cosy";
export const SIG_SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw=="; // base64("war, war never changes")
export const JOB_TOKEN_URL = "https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1";
export const USER_STATUS_URL = "https://center.qoder.sh/algo/api/v3/user/status?Encode=1";
export const QOTA_USAGE_URL = "https://openapi.qoder.sh/api/v2/quota/usage";
// COSY-signed GET. Returns per-model promo "free quota" buckets (e.g. qmodel_latest 200/day),
// distinct from QOTA_USAGE_URL which reports the account-wide credit balance.
export const ACTIVITY_URL = "https://openapi.qoder.sh/algo/api/v2/activity";
// COSY-signed GET on the inference host. Returns the live model catalog as
// { chat: [{ key, display_name, max_input_tokens, is_vl, is_reasoning,
//   enable, ... }] } — same shape open-sse services/qoderModels.js consumes.
// Sending a chat body whose model_config disagrees with this list silently
// downgrades the model upstream, so discovery doubles as config validation.
export const MODEL_LIST_URL = "https://api3.qoder.sh/algo/api/v2/model/list";

// Business descriptors sent in body.business and Cosy-Business-* headers.
// CLI uses product=cli, type=agent. Required for the server to attribute
// the request to the right billing/promo bucket.
export const BUSINESS_PRODUCT = "cli";
export const BUSINESS_TYPE = "agent";
export const BUSINESS_VERSION = "1.15.1";
export const COSY_SCENE = "assistant";
export const DEFAULT_MACHINE_OS = "x86_64_windows";

export function openApiHeaders(securityOauthToken: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${securityOauthToken}`,
    "Cosy-ClientType": COSY_CLIENT_TYPE,
    "Cosy-Version": COSY_VERSION,
    "User-Agent": `qoder/${COSY_VERSION}`,
  };
}
export const CHAT_URL =
  "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
// Fallback host used by some bridges (api3). Prefer api2 first.
export const CHAT_URL_FALLBACK =
  "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

// 1024-bit RSA pubkey extracted from qodercli bundle. Server uses this to decrypt
// the per-session AES key. Rotation by Qoder will break all clients at once.
export const SERVER_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
export const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export const CUSTOM_PAD = "$";

export const C2S = new Array(128).fill(-1);
export const S2C = new Array(128).fill(-1);
for (let i = 0; i < 64; i++) {
  C2S[CUSTOM_ALPHABET.charCodeAt(i)] = STD_ALPHABET.charCodeAt(i);
  S2C[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
}
C2S[CUSTOM_PAD.charCodeAt(0)] = "=".charCodeAt(0);
S2C["=".charCodeAt(0)] = CUSTOM_PAD.charCodeAt(0);

export function encodeQoderPayload(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  const std = bytes.toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.substring(n - a) + std.substring(a, n - a) + std.substring(0, a);
  let out = "";
  for (let i = 0; i < n; i++) {
    const c = rearranged.charCodeAt(i);
    const m = c < 128 ? S2C[c] : -1;
    if (m < 0) throw new Error(`char out of alphabet: ${rearranged[i]}`);
    out += String.fromCharCode(m);
  }
  return out;
}

/**
 * Inverse of encodeQoderPayload. Cosy Encode=1 sometimes wraps response body
 * fields in the same custom alphabet; chat SSE is usually plaintext JSON but
 * we try decode when normal JSON parse of a string body fails.
 */
export function decodeQoderPayload(encoded: string): string | null {
  try {
    const n = encoded.length;
    if (!n) return null;
    let std = "";
    for (let i = 0; i < n; i++) {
      const c = encoded.charCodeAt(i);
      const m = c < 128 ? C2S[c] : -1;
      if (m < 0) return null;
      std += String.fromCharCode(m);
    }
    const a = Math.floor(n / 3);
    // Same rearrange is an involution (encode applied twice ≈ original layout).
    const rearranged = std.substring(n - a) + std.substring(a, n - a) + std.substring(0, a);
    return Buffer.from(rearranged, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function tryParseJsonMaybeEncoded(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    /* try Cosy custom-base64 decode */
  }
  const decoded = decodeQoderPayload(raw);
  if (!decoded) return null;
  try {
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export function rfc1123Date(d = new Date()): string {
  return d.toUTCString();
}

export function md5Hex(s: string): string {
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}

export function signSignatureHeader(date: string): string {
  return md5Hex(`${APPCODE}&${SIG_SECRET}&${date}`);
}

export function rsaEncryptKey(tempKey: Buffer): Buffer {
  return crypto.publicEncrypt(
    { key: SERVER_PUBKEY_PEM, padding: crypto.constants.RSA_PKCS1_PADDING },
    tempKey,
  );
}

export function aesEncryptCbc(plain: Buffer, key: Buffer): Buffer {
  // IV = key (matches Java BearerBuilder)
  const cipher = crypto.createCipheriv("aes-128-cbc", key, key);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

export interface AuthIdentity {
  name: string;
  aid: string;
  uid: string;
  yx_uid: string;
  organization_id: string;
  organization_name: string;
  user_type: string;
  security_oauth_token: string;
  refresh_token: string;
}

export interface SessionContext {
  cosyKey: string; // base64(RSA(tempKey))
  info: string;    // base64(AES(identityJson, tempKey))
}

export function buildSessionContext(identity: AuthIdentity): SessionContext {
  const tempKey = Buffer.from(crypto.randomUUID().replace(/-/g, "").slice(0, 16), "ascii");
  const cosyKey = rsaEncryptKey(tempKey).toString("base64");
  const info = aesEncryptCbc(Buffer.from(JSON.stringify(identity), "utf8"), tempKey).toString("base64");
  return { cosyKey, info };
}

export function buildPayloadB64(info: string): string {
  // Insertion order matches qodercli 1.0.22 capture exactly:
  // {"version","requestId","info","cosyVersion","ideVersion"}
  // (NOT alphabetically sorted as the older qoder2api Java port did)
  const m = {
    version: "v1",
    requestId: crypto.randomUUID(),
    info,
    cosyVersion: COSY_VERSION,
    ideVersion: "",
  };
  return Buffer.from(JSON.stringify(m), "utf8").toString("base64");
}

export function signBearerRequest(payloadB64: string, cosyKey: string, cosyDate: string, body: string, pathSig: string): string {
  return md5Hex(`${payloadB64}\n${cosyKey}\n${cosyDate}\n${body}\n${pathSig}`);
}

export function pathSigFromUrl(fullUrl: string): string {
  const u = new URL(fullUrl);
  return u.pathname.startsWith("/algo") ? u.pathname.slice("/algo".length) : u.pathname;
}

/**
 * Qoder has two distinct credential families:
 *
 * 1) Console PAT (`personalToken`)
 *    - Created in Qoder settings (personal access token).
 *    - Only valid input to POST /algo/api/v3/user/jobToken.
 *    - jobToken returns securityOauthToken (+ refresh) for COSY/Bearer.
 *
 * 2) Browser device-flow session (`dt-…` from deviceToken/poll)
 *    - Poll body field is `token` (often `dt-` prefix), ~30d session.
 *    - Used directly as securityOauthToken / openapi Bearer — NOT as PAT.
 *    - jobToken rejects it with HTTP 401 "personal token is invalid".
 *
 * Never store a device-poll token in personalToken.
 */
export type QoderAuthMode = "pat" | "device";

export interface QoderTokens {
  /** Console PAT for jobToken only. Absent/empty for pure device-session accounts. */
  personalToken?: string;
  /** Session credential for COSY + openapi Bearer (from jobToken OR device poll). */
  securityOauthToken?: string;
  refreshToken?: string;
  userId?: string;
  userName?: string;
  userType?: string;
  plan?: string;
  expireTime?: number;
  email?: string;
  /** Locked at device/PAT bind — never rotate per request. */
  machineId: string;
  /** Opaque hex; must NOT equal machineId (old CLI spoof set them equal). */
  machineToken: string;
  /** Short hex fingerprint; must NOT be the literal "5". */
  machineType: string;
  /** Short hex device code (Cosy 1.15.1 desktop capture). */
  machineCode?: string;
  /** e.g. x86_64_windows */
  machineOs?: string;
  authMode?: QoderAuthMode;
}

/** Device-poll tokens commonly use a `dt-` prefix (reverse-engineered from 9router/qodercli). */
export function isDeviceSessionToken(token: string | null | undefined): boolean {
  if (!token) return false;
  return /^dt[-_]/i.test(token.trim());
}

/**
 * Normalize stored account.tokens into QoderTokens with correct auth roles.
 * Heals the historical bug where device poll `access_token` was written into
 * `personalToken` and then rejected by jobToken with 401.
 */
export function normalizeQoderTokens(raw: unknown): QoderTokens | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, any>;

  const accessToken =
    (typeof t.access_token === "string" && t.access_token.trim()) ||
    (typeof t.accessToken === "string" && t.accessToken.trim()) ||
    "";
  const securityFromStore =
    (typeof t.securityOauthToken === "string" && t.securityOauthToken.trim()) ||
    (typeof t.security_oauth_token === "string" && t.security_oauth_token.trim()) ||
    "";
  let personalRaw =
    (typeof t.personalToken === "string" && t.personalToken.trim()) ||
    (typeof t.personal_token === "string" && t.personal_token.trim()) ||
    "";

  // Previous incorrect mapping: personalToken === device access_token.
  if (personalRaw && accessToken && personalRaw === accessToken) {
    personalRaw = "";
  }
  // personalToken field holds a dt- session (never a console PAT).
  if (personalRaw && isDeviceSessionToken(personalRaw)) {
    // fold into session below; do not keep as PAT
  }

  const sessionToken =
    securityFromStore ||
    accessToken ||
    (isDeviceSessionToken(personalRaw) ? personalRaw : "") ||
    "";

  const personalToken =
    personalRaw && !isDeviceSessionToken(personalRaw) ? personalRaw : "";

  if (!personalToken && !sessionToken) return null;

  const refreshToken =
    (typeof t.refreshToken === "string" && t.refreshToken.trim()) ||
    (typeof t.refresh_token === "string" && t.refresh_token.trim()) ||
    "";

  const machineId =
    (typeof t.machineId === "string" && t.machineId) ||
    (typeof t.machine_id === "string" && t.machine_id) ||
    crypto.randomUUID();
  const machineTokenRaw =
    (typeof t.machineToken === "string" && t.machineToken) ||
    (typeof t.machine_token === "string" && t.machine_token) ||
    "";
  const machineTypeRaw =
    (typeof t.machineType === "string" && t.machineType) ||
    (typeof t.machine_type === "string" && t.machine_type) ||
    "";
  const machineCode =
    (typeof t.machineCode === "string" && t.machineCode) ||
    (typeof t.machine_code === "string" && t.machine_code) ||
    undefined;
  const machineOs =
    (typeof t.machineOs === "string" && t.machineOs) ||
    (typeof t.machine_os === "string" && t.machine_os) ||
    undefined;
  const userId =
    (typeof t.userId === "string" && t.userId) ||
    (typeof t.user_id === "string" && t.user_id) ||
    undefined;

  let expireTime: number | undefined =
    typeof t.expireTime === "number" && Number.isFinite(t.expireTime)
      ? t.expireTime
      : undefined;
  if (expireTime == null && typeof t.expires_at === "string" && t.expires_at) {
    const ms = Date.parse(t.expires_at);
    if (Number.isFinite(ms)) expireTime = ms;
  }

  const authMode: QoderAuthMode = personalToken ? "pat" : "device";

  // Prefer stored machine*; Cosy path will heal old CLI spoofs stably via
  // ensureCosyMachineFingerprint (does not invent a new machineId).
  return ensureCosyMachineFingerprint({
    personalToken: personalToken || undefined,
    securityOauthToken: sessionToken || undefined,
    refreshToken: refreshToken || undefined,
    userId,
    userName:
      (typeof t.userName === "string" && t.userName) ||
      (typeof t.display_name === "string" && t.display_name) ||
      (typeof t.name === "string" && t.name) ||
      undefined,
    userType: typeof t.userType === "string" ? t.userType : undefined,
    plan: typeof t.plan === "string" ? t.plan : undefined,
    expireTime,
    email: typeof t.email === "string" ? t.email : undefined,
    machineId,
    machineToken: machineTokenRaw || machineId,
    machineType: machineTypeRaw || "5",
    machineCode,
    machineOs,
    authMode,
  });
}

/** Stable short hex from a seed (locked fingerprint, not random per call). */
function stableHex(seed: string, bytes: number): string {
  return crypto.createHash("sha256").update(seed, "utf8").digest("hex").slice(0, bytes * 2);
}

/**
 * True when machine* looks like the old qodercli 1.0.22 spoof that breaks
 * kmodel_latest / qmodel_preview on free accounts.
 */
export function isSpoofedMachineFingerprint(tokens: {
  machineId?: string;
  machineToken?: string;
  machineType?: string;
  machineCode?: string;
  machineOs?: string;
}): boolean {
  const id = tokens.machineId || "";
  if (!id) return true;
  if (!tokens.machineToken || tokens.machineToken === id) return true;
  if (!tokens.machineType || tokens.machineType === "5") return true;
  if (!tokens.machineCode) return true;
  if (!tokens.machineOs) return true;
  return false;
}

/**
 * Ensure Cosy machine fingerprint is desktop-shaped and STABLE for a given
 * machineId. Heals old CLI spoofs without rotating machineId (device bind).
 */
export function ensureCosyMachineFingerprint(tokens: QoderTokens): QoderTokens {
  const machineId = tokens.machineId || crypto.randomUUID();
  if (!isSpoofedMachineFingerprint({ ...tokens, machineId })) {
    return { ...tokens, machineId };
  }
  return {
    ...tokens,
    machineId,
    // Opaque, not equal to machineId; stable across process restarts.
    machineToken: tokens.machineToken && tokens.machineToken !== machineId && tokens.machineToken !== "5"
      ? tokens.machineToken
      : stableHex(`qoder:mt:${machineId}`, 32),
    machineType:
      tokens.machineType && tokens.machineType !== "5"
        ? tokens.machineType
        : stableHex(`qoder:mtype:${machineId}`, 4),
    machineCode: tokens.machineCode || stableHex(`qoder:mcode:${machineId}`, 4),
    machineOs: tokens.machineOs || DEFAULT_MACHINE_OS,
  };
}

/** True when we have something we can use for chat/quota (PAT and/or session). */
export function hasQoderCredentials(tokens: QoderTokens | null | undefined): boolean {
  if (!tokens) return false;
  return Boolean(tokens.personalToken || tokens.securityOauthToken);
}

export function generateMachineIdentity() {
  // Desktop Cosy-style fingerprint: opaque machineToken ≠ machineId, hex
  // machineType (not "5"), plus machineCode + machineOs. Locked once per account.
  const machineId = crypto.randomUUID();
  return {
    machineId,
    machineToken: stableHex(`qoder:mt:${machineId}`, 32),
    machineType: stableHex(`qoder:mtype:${machineId}`, 4),
    machineCode: stableHex(`qoder:mcode:${machineId}`, 4),
    machineOs: DEFAULT_MACHINE_OS,
  };
}

export function signatureHeaders(tokens: QoderTokens): Record<string, string> {
  // Hermes: use machine* as stored (or healed once) — never force type "5".
  const t = ensureCosyMachineFingerprint(tokens);
  const date = rfc1123Date();
  return {
    "cosy-machinetoken": t.machineToken,
    "cosy-machinetype": t.machineType,
    "login-version": "v2",
    appcode: APPCODE,
    accept: "application/json",
    "accept-encoding": "identity",
    "cosy-version": COSY_VERSION,
    "cosy-clienttype": COSY_CLIENT_TYPE,
    date,
    signature: signSignatureHeader(date),
    "content-type": "application/json",
    "cosy-machineid": t.machineId,
    "user-agent": `qoder/${COSY_VERSION}`,
    "cosy-data-policy": "agree",
    ...(t.machineCode ? { "cosy-machinecode": t.machineCode } : {}),
    ...(t.machineOs ? { "cosy-machineos": t.machineOs } : {}),
  };
}

export interface JobTokenResponse {
  id?: string;
  name?: string;
  securityOauthToken?: string;
  refreshToken?: string;
  expireTime?: number;
  email?: string;
  plan?: string;
  userType?: string;
}

/**
 * One row from `/algo/api/v2/activity`. Each row is a server-managed promo
 * quota bucket scoped to one or more upstream model keys (e.g. `qmodel_latest`
 * → qd-Qwen3.7-Max). Reset cadence and timezone are dictated by the server
 * (`resetStrategy: DAY_EXPIRE`, `serverTimezone: Asia/Shanghai`).
 */
export interface QoderActivity {
  type: string;              // e.g. "MODEL_FREE_QUOTA"
  activityId: string;
  modelName: string;
  modelKeys: string[];       // upstream keys this quota applies to
  limit: number;
  used: number;
  remaining: number;
  resetAt: number;           // unix ms
  resetStrategy: string;     // e.g. "DAY_EXPIRE"
  serverTimezone: string;    // e.g. "Asia/Shanghai"
  description?: string;
  statusText?: string;
  tag?: string;
  tagStyle?: string;
  eligible: boolean;
  activityEndAt: number;     // unix ms — promo expiry
  detailUrl?: string;
}

export interface QoderActivitySnapshot {
  activities: QoderActivity[];
  queryAt: number;           // unix ms reported by server
  fetchedAt: string;         // ISO timestamp recorded locally
}

export interface ActivityResponse {
  code?: number;
  msg?: string;
  data?: { activities?: QoderActivity[]; queryAt?: number };
}

/**
 * One entry in GET /algo/api/v2/model/list's `chat` array — the live upstream
 * model catalog. `key` is the server-side upstream model key (same as
 * QoderModelDef.upstream, e.g. "qmodel_latest"); enable:false means the
 * account/plan can't use the model (chat returns code:112 + pricing URL).
 */
export interface QoderModelListEntry {
  key?: string;
  display_name?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  is_vl?: boolean;
  is_reasoning?: boolean;
  enable?: boolean;
  description?: string;
}

export interface QoderModelListResponse {
  code?: number;
  msg?: string;
  data?: { chat?: QoderModelListEntry[] } | QoderModelListEntry[];
  chat?: QoderModelListEntry[];
}

export async function exchangeJobToken(tokens: QoderTokens): Promise<JobTokenResponse> {
  // jobToken only accepts a console PAT. Device-session (dt-) tokens are not PATs.
  const pat = (tokens.personalToken || "").trim();
  if (!pat || isDeviceSessionToken(pat)) {
    throw new Error(
      "jobToken requires a console personalToken (PAT). Device-session tokens (dt-…) cannot be exchanged — re-login or import a PAT.",
    );
  }
  const inner = {
    personalToken: pat,
    securityOauthToken: tokens.securityOauthToken || "",
    refreshToken: tokens.refreshToken || "",
    needRefresh: !!tokens.refreshToken,
    authInfo: {},
  };
  const outer = { payload: JSON.stringify(inner), encodeVersion: "1" };
  const body = encodeQoderPayload(JSON.stringify(outer));

  const resp = await fetch(JOB_TOKEN_URL, {
    method: "POST",
    headers: signatureHeaders(tokens),
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`jobToken HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  return (await resp.json()) as JobTokenResponse;
}

export function buildIdentity(tokens: QoderTokens): AuthIdentity {
  return {
    name: tokens.userName || "",
    aid: tokens.userId || "",
    uid: tokens.userId || "",
    yx_uid: "",
    organization_id: "",
    organization_name: "",
    user_type: tokens.userType || "personal_standard",
    security_oauth_token: tokens.securityOauthToken || "",
    refresh_token: tokens.refreshToken || "",
  };
}

export interface BearerCallOptions {
  url: string;
  /** Pass `null`/`undefined` for GET-style calls with no body. */
  body?: unknown;
  /** Defaults to "POST". Use "GET" for query-only endpoints (e.g. /activity). */
  method?: "GET" | "POST";
  extraHeaders?: Record<string, string>;
  stream?: boolean;
}

export async function bearerFetch(tokens: QoderTokens, opts: BearerCallOptions): Promise<Response> {
  const method = opts.method || "POST";
  const t = ensureCosyMachineFingerprint(tokens);
  const session = buildSessionContext(buildIdentity(t));
  const bodyEncoded = opts.body == null ? "" : encodeQoderPayload(JSON.stringify(opts.body));
  const payloadB64 = buildPayloadB64(session.info);
  const date = String(Math.floor(Date.now() / 1000));
  const pathSig = pathSigFromUrl(opts.url);
  const sig = signBearerRequest(payloadB64, session.cosyKey, date, bodyEncoded, pathSig);

  // Cosy 1.15.1 desktop path (Hermes live Free0 K3/Qwen3.8):
  //   - cosy-version 1.15.1, cosy-clienttype "0"
  //   - machine* from token store (mt≠id, type hex, code+os) — never force "5"
  //   - business product/type/scene for billing bucket attribution
  const headers: Record<string, string> = {
    "cosy-data-policy": "agree",
    "cosy-machinetype": t.machineType,
    "cosy-clienttype": COSY_CLIENT_TYPE,
    "cosy-date": date,
    "cosy-user": t.userId || "",
    "cosy-key": session.cosyKey,
    "cache-control": "no-cache",
    "cosy-business-product": BUSINESS_PRODUCT,
    "cosy-business-type": BUSINESS_TYPE,
    "cosy-scene": COSY_SCENE,
    accept: opts.stream ? "text/event-stream" : "application/json",
    authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "accept-encoding": "identity",
    "cosy-version": COSY_VERSION,
    "cosy-machineid": t.machineId,
    "cosy-machinetoken": t.machineToken,
    "login-version": "v2",
    "user-agent": `qoder/${COSY_VERSION}`,
    ...(t.machineCode ? { "cosy-machinecode": t.machineCode } : {}),
    ...(t.machineOs ? { "cosy-machineos": t.machineOs } : {}),
    ...(opts.extraHeaders || {}),
  };

  // content-type is meaningful only when there's a body to send.
  const init: RequestInit = { method, headers };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    init.body = bodyEncoded;
  }
  return fetch(opts.url, init);
}

// ============================================================================
// Provider implementation
// ============================================================================

export interface QoderModelDef {
  id: string;           // proxy-facing ID (qd-*)
  /** Server-side model key. Optional for live-discovered entries, where the
   *  proxy id itself carries the key (`qd-<key>` — see friendlyIdForUpstream). */
  upstream?: string;
  display_name: string;
  max_input_tokens: number;
  is_vl: boolean;
  is_reasoning: boolean;
  price_factor: number;
}

export const QODER_MODELS: QoderModelDef[] = [
  // Product tiers (not raw SKUs) — pricing maps via toCanonicalModelName aliases.
  { id: "qd-Auto",              upstream: "auto",          display_name: "Auto",              max_input_tokens: 180000, is_vl: true,  is_reasoning: false, price_factor: 1 },
  { id: "qd-Ultimate",          upstream: "ultimate",      display_name: "Ultimate",          max_input_tokens: 180000, is_vl: true,  is_reasoning: true,  price_factor: 1.6 },
  { id: "qd-Performance",       upstream: "performance",   display_name: "Performance",       max_input_tokens: 272000, is_vl: true,  is_reasoning: false, price_factor: 1.1 },
  { id: "qd-Efficient",         upstream: "efficient",     display_name: "Efficient",         max_input_tokens: 180000, is_vl: true,  is_reasoning: false, price_factor: 0.3 },
  // Always-free path on Community (price_factor 0). Not an /activity promo bucket.
  { id: "qd-Lite",              upstream: "lite",          display_name: "Lite",              max_input_tokens: 180000, is_vl: false, is_reasoning: false, price_factor: 0 },
  // Named SKUs — max_input_tokens match model-specs.ts (applyModelSpecs overrides too).
  // Qwen3.7-Max: free /activity promo bucket (qmodel_latest). Thinking-capable.
  { id: "qd-Qwen3.7-Max",       upstream: "qmodel_latest", display_name: "Qwen3.7-Max",       max_input_tokens: 1000000, is_vl: true,  is_reasoning: true,  price_factor: 0.2 },
  // Qwen 3.8 preview — NOT qmodel_latest (that is 3.7). Hermes Free0 path uses qmodel_preview.
  { id: "qd-Qwen3.8-Max-Preview", upstream: "qmodel_preview", display_name: "Qwen3.8-Max-Preview", max_input_tokens: 1000000, is_vl: true,  is_reasoning: false, price_factor: 0.2 },
  { id: "qd-DeepSeek-V4-Pro",   upstream: "dmodel",        display_name: "DeepSeek-V4-Pro",   max_input_tokens: 1000000, is_vl: true,  is_reasoning: true,  price_factor: 0.5 },
  { id: "qd-DeepSeek-V4-Flash", upstream: "dfmodel",       display_name: "DeepSeek-V4-Flash", max_input_tokens: 1000000, is_vl: true,  is_reasoning: true,  price_factor: 0.1 },
  // Kimi K3 → kmodel_latest (NOT bare kmodel). 1M context, thinking model.
  { id: "qd-Kimi-K3",           upstream: "kmodel_latest", display_name: "Kimi-K3",           max_input_tokens: 1048576, is_vl: true,  is_reasoning: true,  price_factor: 0.3 },
  // Legacy alias — kmodel now serves Kimi K2.7 Code (live catalog 2026-08).
  { id: "qd-Kimi-K2.6",         upstream: "kmodel",        display_name: "Kimi-K2.6",         max_input_tokens: 262144, is_vl: true,  is_reasoning: false, price_factor: 0.3 },
  // Kimi K2.7 Code — docs.qoder.com/cli/model: long-context coding model,
  // fast-mode only, no thinking toggle. Live key: kmodel (catalog 2026-08).
  { id: "qd-Kimi-K2.7-Code",    upstream: "kmodel",        display_name: "Kimi-K2.7-Code",    max_input_tokens: 262144, is_vl: true,  is_reasoning: false, price_factor: 0.3 },
  // Qwen3.8-Max — live key qmodel_38max (catalog 2026-08; docs: 2.4T MoE,
  // thinking toggle). Distinct from qmodel_preview (the 3.8 preview bucket).
  { id: "qd-Qwen3.8-Max",       upstream: "qmodel_38max",  display_name: "Qwen3.8-Max",       max_input_tokens: 1000000, is_vl: true,  is_reasoning: true,  price_factor: 0.2 },
  // Qwen3.7-Plus — live key qmodel (catalog 2026-08).
  { id: "qd-Qwen3.7-Plus",      upstream: "qmodel",        display_name: "Qwen3.7-Plus",      max_input_tokens: 1000000, is_vl: true,  is_reasoning: true,  price_factor: 0.2 },
  // Legacy alias — qmodel now serves Qwen3.7-Plus (live catalog 2026-08).
  { id: "qd-Qwen3.6-Plus",      upstream: "qmodel",        display_name: "Qwen3.6-Plus",      max_input_tokens: 1000000, is_vl: true,  is_reasoning: false, price_factor: 0.2 },
  // GLM 5.2 — live key gm51model (catalog 2026-08).
  { id: "qd-GLM-5.2",           upstream: "gm51model",     display_name: "GLM-5.2",           max_input_tokens: 198000, is_vl: true,  is_reasoning: true,  price_factor: 0.6 },
  // Legacy alias — gm51model now serves GLM 5.2 (live catalog 2026-08).
  { id: "qd-GLM-5.1",           upstream: "gm51model",     display_name: "GLM-5.1",           max_input_tokens: 198000, is_vl: true,  is_reasoning: true,  price_factor: 0.6 },
  // MiniMax-M3 — current Qoder frontier name (docs.qoder.com/en/cli/model, 0.2x).
  // Cosy upstream key remains mmodel (pi-provider-qoder: minimax-m3 → mmodel;
  // minimax-m2.7 was the previous friendly alias for the same key).
  { id: "qd-MiniMax-M3",        upstream: "mmodel",        display_name: "MiniMax-M3",        max_input_tokens: 1000000, is_vl: true,  is_reasoning: false, price_factor: 0.2 },
  // Legacy alias — same upstream as M3 so existing clients keep working.
  { id: "qd-MiniMax-M2.7",      upstream: "mmodel",        display_name: "MiniMax-M2.7",      max_input_tokens: 1000000, is_vl: true,  is_reasoning: false, price_factor: 0.2 },
];

export const MODEL_CONFIGS: Record<string, QoderModelDef> = Object.fromEntries(
  QODER_MODELS.map((m) => [m.id, m]),
);

/** Lowercased-id lookup so case variants (qd-kimi-k3, QD-AUTO) resolve like
 *  the exact curated id. Live-discovered ids are already lowercase. */
const MODEL_CONFIGS_BY_LOWER_ID: Record<string, QoderModelDef> = Object.fromEntries(
  QODER_MODELS.map((m) => [m.id.toLowerCase(), m]),
);

/** Effective upstream key: explicit key, or the key embedded in a
 *  live-discovered proxy id (`qd-<key>`). */
export function qoderUpstreamKey(def: QoderModelDef): string {
  return def.upstream ?? def.id.slice(3);
}

/**
 * Resolve the model config for an incoming request.model.
 *
 * why: MODEL_CONFIGS is keyed by the exact curated id ("qd-Kimi-K3"), but
 * requests arrive with any case the client chose. The old exact-match lookup
 * silently fell back to QODER_MODELS[0] (qd-Auto) for variants like
 * "qd-kimi-k3", "qd-Qwen3.7-max" — and for every live-discovered catalog id —
 * so the request was dispatched to Auto instead of the model asked for.
 */
export function resolveQoderModelConfig(model: string): QoderModelDef {
  const m = String(model ?? "").trim();
  const exact = MODEL_CONFIGS[m];
  if (exact) return exact;
  const byLower = MODEL_CONFIGS_BY_LOWER_ID[m.toLowerCase()];
  if (byLower) return byLower;
  // Live-catalog ids (qd-<key> / legacy qd/<key>): synthesize a config from
  // the embedded upstream key so dispatch never silently falls back to Auto.
  const keyMatch = m.match(/^qd[-/]([\w.+-]+)$/i);
  if (keyMatch) {
    const key = keyMatch[1]!;
    const spec = resolveModelSpec(key);
    return {
      id: m,
      upstream: key,
      display_name: key,
      max_input_tokens: spec?.contextWindow ?? 180_000,
      is_vl: spec?.vision === true,
      is_reasoning: spec?.thinking === true,
      price_factor: 0.3,
    };
  }
  return QODER_MODELS[0]!;
}

/**
 * Friendly proxy id for a live-discovered upstream key. Curated SKUs keep
 * their display names (`qmodel_latest` → qd-Qwen3.7-Max); genuinely new keys
 * get a readable id (`kmodel_latest` → qd-Kimi-K3) so model-specs/pricing
 * resolve by canonical name instead of the raw key.
 */
const FRIENDLY_ID_BY_UPSTREAM: Record<string, string> = {
  qmodel_latest: "qd-Qwen3.7-Max",
  qmodel_preview: "qd-Qwen3.8-Max-Preview",
  qmodel_38max: "qd-Qwen3.8-Max",
  qmodel: "qd-Qwen3.7-Plus",
  dmodel: "qd-DeepSeek-V4-Pro",
  dfmodel: "qd-DeepSeek-V4-Flash",
  gm51model: "qd-GLM-5.2",
  kmodel_latest: "qd-Kimi-K3",
  kmodel: "qd-Kimi-K2.7-Code",
  mmodel: "qd-MiniMax-M3",
};

export function friendlyIdForUpstream(upstream: string): string {
  return FRIENDLY_ID_BY_UPSTREAM[upstream.toLowerCase()] ?? `qd-${upstream}`;
}

let CACHED_TEMPLATE: any = null;
export function loadTemplate(): any {
  if (CACHED_TEMPLATE) return CACHED_TEMPLATE;
  try {
    const filePath = path.join(__dirname, "qoder-baseprompt.json");
    let raw = fs.readFileSync(filePath, "utf8");
    raw = raw.replace(/\{UUID[1-5]\}/g, () => crypto.randomUUID());
    raw = raw.replace(/\{TIME1\}/g, String(Date.now()));
    CACHED_TEMPLATE = JSON.parse(raw);
  } catch (e) {
    CACHED_TEMPLATE = null;
  }
  return CACHED_TEMPLATE;
}

export function extractLatestUserPrompt(request: ChatCompletionRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const msg = request.messages[i];
    if (!msg || msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const text = (msg.content as any[]).find((b) => b?.type === "text")?.text;
      if (typeof text === "string" && text) return text;
    }
  }
  return "";
}

export function extractLatestUserImages(request: ChatCompletionRequest): any[] {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const msg = request.messages[i];
    if (!msg || msg.role !== "user") continue;
    if (!Array.isArray(msg.content)) continue;
    const images: any[] = [];
    for (const b of msg.content as any[]) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "image_url" || b.type === "image") {
        images.push(normalizeImageBlock(b));
      }
    }
    if (images.length > 0) return images;
  }
  return [];
}

export function normalizeImageBlock(block: any): any {
  // OpenAI format: { type: "image_url", image_url: { url: "..." } }
  if (block.type === "image_url" && block.image_url?.url) {
    return block; // already in OpenAI format
  }
  // Anthropic format: { type: "image", source: { type: "base64", media_type: "...", data: "..." } }
  if (block.type === "image" && block.source?.type === "base64") {
    const { media_type, data } = block.source;
    return {
      type: "image_url",
      image_url: {
        url: `data:${media_type};base64,${data}`,
      },
    };
  }
  // Fallback: return as-is
  return block;
}

export function buildQoderMessages(request: ChatCompletionRequest, templateMessages: any[] | undefined, hasIncomingTools: boolean): any[] {
  const incomingHasSystem = request.messages.some((m) => m.role === "system");
  const result: any[] = [];

  if (hasIncomingTools && !incomingHasSystem) {
    // Build detailed tool descriptions with schemas for better guidance
    const toolDescriptions = (request.tools || [])
      .map((t: any) => {
        const name = t?.function?.name || t?.name;
        const desc = t?.function?.description || t?.description || "No description";
        const params = t?.function?.parameters?.properties || t?.parameters?.properties || {};
        const paramNames = Object.keys(params);
        const paramInfo = paramNames.length > 0
          ? ` Parameters: ${paramNames.join(", ")}`
          : "";
        return `- ${name}: ${desc}${paramInfo}`;
      })
      .filter(Boolean)
      .join("\n");

    const toolNames = (request.tools || [])
      .map((t: any) => t?.function?.name || t?.name)
      .filter(Boolean)
      .join(", ");

    result.push({
      role: "system",
      content: `You are a helpful assistant with access to the following tools:

${toolDescriptions}

## Tool Usage Guidelines:

1. **When to use tools**: When the user's request requires information retrieval, file operations, code execution, or any action that these tools can perform, you MUST call the appropriate tool. Do not say you cannot help; instead, invoke the tool with the correct arguments.

2. **Trust tool results**: After calling a tool, you will receive the tool result in the conversation. The tool result contains the actual data or outcome of the tool execution. Use this information to formulate your response. Do not claim you didn't receive file contents or data if the tool result was provided.

3. **Multi-turn workflows**: For complex tasks requiring multiple tool calls:
   - Call tools sequentially as needed
   - Use information from previous tool results to inform subsequent calls
   - Only respond with your final answer after you have gathered all necessary information

4. **Error handling**: If a tool returns an error or empty result, acknowledge this to the user and suggest alternatives or next steps.

5. **Text-only responses**: Only respond with plain text (without tool calls) when:
   - No available tool can address the user's request
   - You already have all the information needed from previous tool results
   - The user is asking for clarification or a simple answer

Available tools: ${toolNames}`,
    });
  } else if (!hasIncomingTools && !incomingHasSystem) {
    // Do NOT pull system messages from the Qoder-CLI template — they put
    // the model in "Qoder CLI agent" mode (TodoWrite-everything, Windows
    // hardcoded paths, "verify your output" loops, etc.) which causes
    // off-topic repetition for plain chat. Add a neutral, minimal system
    // prompt instead so the model just acts as a helpful assistant.
    result.push({
      role: "system",
      content: "You are a helpful AI assistant. Answer the user's questions clearly and concisely. Maintain context from earlier turns in the conversation.",
    });
  }

  // Messages are already normalized to canonical OpenAI format by the
  // centralized normalizeRequestToOpenAI() in the proxy entry points.
  // We only need to add the Qoder-native `contents` array alongside each
  // message's standard `content` field.
  for (const m of request.messages) {
    const content = typeof m.content === "string" ? m.content : "";
    const msg: any = { role: m.role, content, contents: content ? [{ type: "text", text: content }] : [] };

    // Preserve tool_call_id for role:"tool" messages.
    if (m.role === "tool" && (m as any).tool_call_id) {
      msg.tool_call_id = (m as any).tool_call_id;
    }

    // Preserve tool_calls for assistant messages.
    if (m.role === "assistant" && Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length > 0) {
      msg.tool_calls = (m as any).tool_calls;
    }

    // Handle multimodal user content (array of text + image_url blocks).
    if (Array.isArray(m.content)) {
      const blocks = m.content as any[];
      const textParts: string[] = [];
      const imageParts: any[] = [];
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string") textParts.push(b.text);
        else if (b?.type === "image_url" || b?.type === "image") imageParts.push(normalizeImageBlock(b));
      }
      const textContent = textParts.join("\n");
      const contentsArr: any[] = [];
      if (textContent) contentsArr.push({ type: "text", text: textContent });
      contentsArr.push(...imageParts);
      msg.content = textContent;
      msg.contents = contentsArr;
    }

    result.push(msg);
  }

  return result;
}

/**
 * Derive a stable session_id from a conversation's ANCHOR (the parts that
 * don't change as the conversation grows).
 *
 * Qoder server uses session_id as the key for server-side persisted
 * conversation state (context, tool call records, compaction boundaries).
 * The session_id MUST stay constant across every turn of the same chat —
 * otherwise the server treats each turn as a brand-new conversation, the
 * model "forgets" prior context, and answers loop or repeat themselves.
 *
 * Bug we're fixing: the previous implementation hashed ALL messages, so
 * every new turn (with one more message appended) produced a different
 * session_id. Effectively: every turn = new session = no memory.
 *
 * Fix: hash only the conversation ANCHOR — everything that's stable across
 * turns:
 *   1. All system messages (system prompts don't change mid-conversation)
 *   2. The FIRST user message (the conversation opener)
 *
 * The first user turn is the natural fingerprint of "which conversation
 * is this." Two different chats almost never start with identical opener
 * text, so collisions are rare; the same chat always rehashes to the same
 * value because the anchor never changes.
 */
export function deriveSessionId(messages: ChatCompletionRequest["messages"]): string {
  const hash = crypto.createHash("sha256");
  let firstUserSeen = false;

  const updateWithContent = (content: unknown) => {
    if (typeof content === "string") {
      hash.update(content);
    } else if (Array.isArray(content)) {
      for (const block of content as any[]) {
        if (block?.type === "text" && typeof block.text === "string") {
          hash.update(block.text);
        }
      }
    }
  };

  for (const msg of messages) {
    if (msg.role === "system") {
      hash.update("system:");
      updateWithContent(msg.content);
      hash.update("\n");
    } else if (msg.role === "user" && !firstUserSeen) {
      hash.update("user:");
      updateWithContent(msg.content);
      hash.update("\n");
      firstUserSeen = true;
      // Stop here — anything after the first user message is volatile
      // (the assistant's reply, follow-up turns) and would destabilize
      // the session_id as the conversation grows.
      break;
    }
  }

  // Edge case: no user message yet (e.g. system-only probe). Fall back to
  // hashing the role sequence so probes still get deterministic IDs.
  if (!firstUserSeen) {
    hash.update("__no_user__");
  }

  const hex = hash.digest("hex").slice(0, 32);
  // Format as valid UUID v4
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function buildChatBody(request: ChatCompletionRequest, tokens: QoderTokens): any {
  const prompt = extractLatestUserPrompt(request);
  const images = extractLatestUserImages(request);
  const baseCfg = resolveQoderModelConfig(request.model);
  // Honor operator-set upstream-name override (catalog rename). Clone so we
  // never mutate the shared MODEL_CONFIGS entry.
  const upstreamOverride = getUpstreamNameOverride(request.model);
  const cfg = upstreamOverride ? { ...baseCfg, upstream: upstreamOverride } : baseCfg;
  const upstreamKey = qoderUpstreamKey(cfg);
  const reqId = crypto.randomUUID();
  const chatRecordId = crypto.randomUUID();
  const sessionId = deriveSessionId(request.messages);
  const hasIncomingTools = Array.isArray(request.tools) && request.tools.length > 0;

  const template = loadTemplate();
  const body: any = template ? JSON.parse(JSON.stringify(template)) : {};

  body.request_id = reqId;
  body.chat_record_id = chatRecordId;
  body.request_set_id = crypto.randomUUID();
  body.session_id = sessionId;
  body.stream = true;
  // Empty aliyun_user_type matches free-path routing (Hermes / qodercli free bucket).
  // Non-empty personal_standard can bypass free promo routing.
  body.aliyun_user_type = "";
  // Prefer chat session type used by working Free0 Cosy path.
  body.session_type = body.session_type || "qoder";
  body.agent_id = body.agent_id || "agent_common";
  body.task_id = body.task_id || "common";
  body.chat_task = body.chat_task || "FREE_INPUT";
  body.version = body.version || "3";
  body.source = body.source ?? 1;

  if (!body.model_config) body.model_config = {};
  body.model_config.key = upstreamKey;
  body.model_config.display_name = cfg.display_name;
  body.model_config.is_vl = cfg.is_vl;
  body.model_config.is_reasoning = cfg.is_reasoning;
  body.model_config.max_input_tokens = cfg.max_input_tokens;
  body.model_config.format = body.model_config.format || "openai";
  body.model_config.source = body.model_config.source || "system";

  // Business object — qodercli 1.0.22 shape. Server reads product/type/stage
  // to attribute the request to the right billing bucket. Without these, the
  // request is served but does NOT charge against the qmodel_latest free
  // quota.
  body.business = {
    product: BUSINESS_PRODUCT,
    version: BUSINESS_VERSION,
    type: BUSINESS_TYPE,
    id: crypto.randomUUID(),
    name: prompt.slice(0, 30),
    begin_at: Date.now(),
    stage: "start",
  };

  if (!body.chat_context) body.chat_context = {};
  body.chat_context.text = { type: "text", text: prompt };
  if (images.length > 0) {
    body.chat_context.images = images;
    // Also set imageUrls at chat_context level (some Qoder endpoints check this)
    body.chat_context.imageUrls = images.map((img: any) => img.image_url?.url).filter(Boolean);
  }
  if (!body.chat_context.extra) body.chat_context.extra = {};
  body.chat_context.extra.originalContent = { type: "text", text: prompt };
  if (images.length > 0) {
    body.chat_context.extra.images = images;
  }
  if (!body.chat_context.extra.modelConfig) body.chat_context.extra.modelConfig = {};
  body.chat_context.extra.modelConfig.key = upstreamKey;
  body.chat_context.extra.modelConfig.is_reasoning = cfg.is_reasoning;

  // Set top-level image_urls (Qoder API also checks this field)
  if (images.length > 0) {
    body.image_urls = images.map((img: any) => img.image_url?.url).filter(Boolean);
  }

  body.messages = buildQoderMessages(request, body.messages, hasIncomingTools);

  // Mirror messages[0] system prompt up to top-level body.system. Qodercli
  // 1.0.22 sends BOTH locations identically — server reads top-level `system`
  // for billing/routing decisions while messages[0] feeds the model.
  const sysMsg = body.messages.find((m: any) => m?.role === "system");
  if (sysMsg && typeof sysMsg.content === "string") {
    body.system = sysMsg.content;
  }

  if (request.max_tokens && body.parameters) {
    body.parameters.max_tokens = request.max_tokens;
  }

  // ALWAYS override `body.tools` from the request — never inherit the
  // template's Qoder-CLI tool list (Bash/BashOutput/Edit/etc). If the
  // client didn't send tools, send none. Inheriting template tools makes
  // the model hallucinate tool calls the client cannot execute, which
  // surfaces as repeated/looping responses (model keeps "trying" a tool
  // that never returns a result).
  if (hasIncomingTools) {
    body.tools = request.tools;
  } else {
    body.tools = [];
  }

  return body;
}

/**
 * Generate OpenAI-style tool call ID.
 * OpenAI uses format: "call_" + 24 alphanumeric characters
 */
export function generateOpenAIToolId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'call_';
  for (let i = 0; i < 24; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Normalize tool call ID to OpenAI format.
 * OpenAI uses simple alphanumeric IDs like "call_abc123...", not Anthropic's "toolu_*" format.
 * If the upstream ID is too short, generate a new one.
 */
export function normalizeToolCallId(id: string | undefined, index: number): string {
  if (!id) {
    // Generate OpenAI-style ID if none provided
    return generateOpenAIToolId();
  }
  // Strip Anthropic prefix if present (for compatibility)
  if (id.startsWith("toolu_")) {
    id = id.slice(6);
  }
  // If ID is too short (< 20 chars after stripping), generate a new one
  if (id.length < 20) {
    return generateOpenAIToolId();
  }
  return id;
}

export interface ToolCallAcc {
  index: number;
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ParsedDelta {
  role?: string;
  content?: string;
  reasoningContent?: string;
  toolCalls?: any[];
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/**
 * Pull assistant-visible text from a Cosy/OpenAI-style delta OR a richer
 * llm_model_result event. Kimi K3 often streams only reasoning_* first.
 */
function extractDeltaText(delta: Record<string, any>): {
  content?: string;
  reasoningContent?: string;
} {
  const out: { content?: string; reasoningContent?: string } = {};
  if (typeof delta.content === "string" && delta.content) out.content = delta.content;
  for (const key of [
    "reasoning_content",
    "reasoning",
    "reasoning_text",
    "thinking",
    "thinking_content",
  ]) {
    const v = delta[key];
    if (typeof v === "string" && v) {
      out.reasoningContent = (out.reasoningContent || "") + v;
    }
  }
  if (!out.content && Array.isArray(delta.content)) {
    const parts: string[] = [];
    for (const p of delta.content as any[]) {
      if (typeof p === "string") parts.push(p);
      else if (p?.type === "text" && typeof p.text === "string") parts.push(p.text);
      else if (typeof p?.text === "string") parts.push(p.text);
    }
    if (parts.length) out.content = parts.join("");
  }
  // Cosy agent events sometimes put text on the event itself.
  for (const key of ["text", "output_text", "answer", "result", "message"]) {
    if (out.content) break;
    const v = delta[key];
    if (typeof v === "string" && v) out.content = v;
    else if (v && typeof v === "object" && typeof v.text === "string" && v.text) out.content = v.text;
    else if (v && typeof v === "object" && typeof v.content === "string" && v.content) out.content = v.content;
  }
  return out;
}

function fillParsedFromOpenAiShape(inner: any, result: ParsedDelta): void {
  if (inner?.usage) {
    result.usage = {
      prompt_tokens: Number(inner.usage.prompt_tokens) || 0,
      completion_tokens: Number(inner.usage.completion_tokens) || 0,
      total_tokens: Number(inner.usage.total_tokens) || 0,
    };
  }
  const choice = inner?.choices?.[0];
  if (choice) {
    const delta = choice.delta || choice.message || {};
    if (choice.finish_reason) result.finishReason = choice.finish_reason;
    if (typeof delta.role === "string") result.role = delta.role;
    const text = extractDeltaText(delta);
    if (text.content) result.content = text.content;
    if (text.reasoningContent) result.reasoningContent = text.reasoningContent;
    if (!result.content && typeof choice.message?.content === "string" && choice.message.content) {
      result.content = choice.message.content;
    }
    if (
      !result.reasoningContent &&
      typeof choice.message?.reasoning_content === "string" &&
      choice.message.reasoning_content
    ) {
      result.reasoningContent = choice.message.reasoning_content;
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      result.toolCalls = delta.tool_calls;
    }
    return;
  }
  // Flat delta / Cosy agent payload without choices[]
  if (inner?.delta && typeof inner.delta === "object") {
    const text = extractDeltaText(inner.delta);
    if (text.content) result.content = text.content;
    if (text.reasoningContent) result.reasoningContent = text.reasoningContent;
    if (typeof inner.delta.role === "string") result.role = inner.delta.role;
    if (Array.isArray(inner.delta.tool_calls) && inner.delta.tool_calls.length > 0) {
      result.toolCalls = inner.delta.tool_calls;
    }
  }
  // llm_model_result / agent event shapes
  if (!result.content && !result.reasoningContent) {
    const text = extractDeltaText(inner || {});
    if (text.content) result.content = text.content;
    if (text.reasoningContent) result.reasoningContent = text.reasoningContent;
  }
  if (typeof inner?.finish_reason === "string" && !result.finishReason) {
    result.finishReason = inner.finish_reason;
  }
}

export function parseSseLine(line: string): ParsedDelta | null {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try {
    const wrapper = tryParseJsonMaybeEncoded(data);
    if (!wrapper || typeof wrapper !== "object") return null;

    const result: ParsedDelta = {};

    // Cosy wraps OpenAI-style JSON in { body: "<json string or encoded>" }.
    if (typeof wrapper.body === "string" && wrapper.body) {
      if (wrapper.body === "[DONE]") return null;
      const inner = tryParseJsonMaybeEncoded(wrapper.body);
      if (inner) fillParsedFromOpenAiShape(inner, result);
    } else if (wrapper.choices || wrapper.usage || wrapper.delta || wrapper.content || wrapper.text) {
      fillParsedFromOpenAiShape(wrapper, result);
    } else if (wrapper.data && typeof wrapper.data === "object") {
      // Some FetchKeys envelopes: { type, data: { ... } }
      fillParsedFromOpenAiShape(wrapper.data, result);
      if (!result.content && !result.reasoningContent) {
        fillParsedFromOpenAiShape(wrapper, result);
      }
    } else {
      fillParsedFromOpenAiShape(wrapper, result);
    }

    return result.content ||
      result.reasoningContent ||
      result.toolCalls ||
      result.usage ||
      result.finishReason
      ? result
      : null;
  } catch {
    return null;
  }
}

