import type { Hono } from "hono";
import { db } from "../../db/index";
import { accounts, requestLogs, vccCards, vccTransactions, settings } from "../../db/schema";
import { eq, inArray, and, sql, desc, ne, or, like, gte, lte, isNull, not, asc, count } from "drizzle-orm";
import { encrypt, decrypt } from "../../utils/crypto";
import { broadcast } from "../../ws/index";
import { adminGuardFromPeer, peerIpFromHonoContext, RateLimiter } from "../../utils/security";
import type { NewAccount, Account } from "../../db/schema";
import { loginQueue } from "../../auth/queue";
import { warmupQueue } from "../../auth/warmup-queue";
import { warmupAccount } from "../../auth/warmup-runner";
import { pool, type ProviderName } from "../../proxy/pool";
import { activateQoderPat } from "../../proxy/providers/qoder";
import { activateYouMindKey } from "../../proxy/providers/youmind";
import {
  exchangeRefreshToken,
  bundleFromAccessToken,
  GROK_OAUTH,
} from "../../proxy/providers/grok/oauth";
import { providers } from "../../proxy/providers/registry";
import { config } from "../../config";
import {
  HttpError,
  parseByokTokens,
  getByokPrefix,
  getByokKeyLabel,
  normalizeModels,
  BYOK_PREFIX_RE,
  BYOK_KEY_LABEL_RE,
} from "./shared";
import * as shared from "./shared";

/** Register routes on the parent accounts router (order-sensitive). */

export type CreateGitlabDuoInput = {
  gitlabBaseUrl?: string;
  pat: string;
  label?: string;
  existingAccountId?: number;
  /**
   * When set, the bot's original Gmail credentials are persisted alongside
   * the PAT so future flows (re-login, trial extend) can re-use them.
   */
  gmailEmail?: string;
  gmailPassword?: string;
};

export type CreateGitlabDuoOk = {
  ok: true;
  id: number;
  label: string;
  username: string;
  namespacePath: string;
  defaultModel: string;
  modelsCount: number;
};

export type CreateGitlabDuoErr = {
  ok: false;
  status: number;
  error: string;
};

export async function createGitlabDuoAccount(
  input: CreateGitlabDuoInput
): Promise<CreateGitlabDuoOk | CreateGitlabDuoErr> {
  const baseUrl = (input.gitlabBaseUrl || "https://gitlab.com").replace(/\/$/, "");
  const pat = input.pat?.trim();
  if (!pat) return { ok: false, status: 400, error: "pat is required" };

  // PAT auth — match the official duo-cli (which uses `Private-Token` for
  // PAT and reserves `Authorization: Bearer …` for OAuth tokens).
  const headers = {
    "Private-Token": pat,
    "Content-Type": "application/json",
    "User-Agent": "etteum-pool/gitlab-duo",
    "X-Gitlab-Client-Name": "Duo CLI",
    "X-Gitlab-Client-Version": "8.104.0",
  };

  // 1. Validate PAT — must have `api` scope and not be revoked.
  try {
    const r = await fetch(`${baseUrl}/api/v4/personal_access_tokens/self`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return { ok: false, status: 400, error: `PAT invalid (HTTP ${r.status})` };
    const j = (await r.json()) as { scopes?: string[]; revoked?: boolean };
    if (j.revoked) return { ok: false, status: 400, error: "PAT is revoked" };
    if (!Array.isArray(j.scopes) || !j.scopes.includes("api")) {
      return { ok: false, status: 400, error: "PAT must have `api` scope" };
    }
  } catch (e) {
    return { ok: false, status: 502, error: `Cannot reach GitLab: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 2. Resolve user + duo-default namespace via GraphQL.
  let username = "";
  let userId = 0;
  let namespacePath = "";
  let namespaceId = 0;
  try {
    const gqlBody = {
      operationName: "getUser",
      query: `query getUser {
        currentUser {
          id
          username
          userPreferences { duoDefaultNamespace { id fullPath } }
          groups(first: 1, permissionScope: CREATE_PROJECTS) {
            nodes { id fullPath }
          }
        }
      }`,
      variables: {},
    };
    const r = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify(gqlBody),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await r.json()) as any;
    if (json.errors) return { ok: false, status: 400, error: `GraphQL: ${JSON.stringify(json.errors)}` };
    const cu = json.data?.currentUser;
    if (!cu) return { ok: false, status: 400, error: "currentUser is null — PAT lacks read_user scope?" };

    const duoNs = cu.userPreferences?.duoDefaultNamespace;
    const fallbackNs = cu.groups?.nodes?.[0];
    const ns = duoNs ?? fallbackNs;
    if (!ns) {
      return {
        ok: false,
        status: 400,
        error: "Cannot resolve a namespace for this PAT. Either set a default namespace in GitLab → Preferences → Duo, or grant the user access to at least one group.",
      };
    }
    username = cu.username;
    userId = Number(String(cu.id).split("/").pop());
    namespacePath = ns.fullPath;
    namespaceId = Number(String(ns.id).split("/").pop());
  } catch (e) {
    return { ok: false, status: 502, error: `GraphQL fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 3. List available models for that namespace.
  let defaultModel = "claude_sonnet_4_6_vertex";
  let availableModels: Array<{ name: string; ref: string }> = [];
  let gitlabVersion = "";
  try {
    const gqlBody = {
      operationName: "lsp_aiChatAvailableModels",
      query: `query lsp_aiChatAvailableModels($rootNamespaceId: GroupID!) {
        metadata { version }
        aiChatAvailableModels(rootNamespaceId: $rootNamespaceId) {
          defaultModel { name ref }
          selectableModels { name ref }
        }
      }`,
      variables: { rootNamespaceId: `gid://gitlab/Group/${namespaceId}` },
    };
    const r = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify(gqlBody),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await r.json()) as any;
    gitlabVersion = json.data?.metadata?.version ?? "";
    const dm = json.data?.aiChatAvailableModels?.defaultModel;
    const sm = json.data?.aiChatAvailableModels?.selectableModels;
    if (dm?.ref) defaultModel = dm.ref;
    if (Array.isArray(sm)) availableModels = sm;
  } catch {
    // Non-fatal — fall back to bundled defaults.
  }

  const label = input.label?.trim() || username;
  const tokens = {
    gitlabBaseUrl: baseUrl,
    namespaceId,
    namespacePath,
    userId,
    ...(input.gmailEmail ? { gmailEmail: input.gmailEmail } : {}),
  };
  const metadata: Record<string, unknown> = {
    defaultModel,
    availableModels,
    gitlabVersion,
  };
  if (input.gmailPassword) {
    // Encrypt the Gmail password again under metadata so it survives PAT
    // rotation without leaking outside `password` (which holds the PAT).
    metadata.gmailPasswordEncrypted = encrypt(input.gmailPassword);
  }

  // 3.5. Pull live GitLab Credits (trial wallet) — every trial seat gets
  // ~24 credits over the 30-day window. We hit `trialUsage.usersUsage.users`
  // and pick the row matching our user's gid; falls back to the first node.
  let quotaLimit = 0;
  let quotaRemaining = 0;
  let quotaResetAt: Date | null = null;
  try {
    const r = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationName: "getTrialUsage",
        query: `query getTrialUsage($namespacePath: ID) {
          trialUsage(namespacePath: $namespacePath) {
            activeTrial { startDate endDate }
            usersUsage {
              users(first: 50) {
                nodes { id username usage { creditsUsed totalCredits } }
              }
            }
          }
        }`,
        variables: { namespacePath },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (r.ok) {
      const j = (await r.json()) as any;
      const trial = j?.data?.trialUsage;
      const nodes: Array<{ id?: string; username?: string; usage?: { creditsUsed?: number; totalCredits?: number } }> =
        trial?.usersUsage?.users?.nodes ?? [];
      const ourGid = userId ? `gid://gitlab/User/${userId}` : null;
      const me =
        nodes.find((n) => ourGid && n.id === ourGid) ??
        nodes.find((n) => n.username && username && n.username.toLowerCase() === username.toLowerCase()) ??
        nodes[0];
      const used = me?.usage?.creditsUsed;
      const total = me?.usage?.totalCredits;
      if (typeof used === "number" && typeof total === "number") {
        quotaLimit = total;
        quotaRemaining = Math.max(0, total - used);
      }
      const endDate = trial?.activeTrial?.endDate ? new Date(trial.activeTrial.endDate) : null;
      if (endDate && !isNaN(endDate.getTime())) quotaResetAt = endDate;
    }
  } catch {
    // Non-fatal: leave quota at 0/0; the periodic warmup will fill it later.
  }

  // 4. Insert OR update existing pending row (bot path).
  try {
    if (input.existingAccountId) {
      // Update path — bot already inserted a pending row at queue time. Same
      // (provider, email) unique constraint already passed; just complete the
      // row with real PAT/tokens/metadata.
      const updated = await db.update(accounts)
        .set({
          password: encrypt(pat),
          status: "active",
          enabled: true,
          tokens,
          metadata,
          quotaLimit,
          quotaRemaining,
          quotaResetAt,
          errorMessage: null,
          lastLoginAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, input.existingAccountId))
        .returning();
      const row = updated[0];
      if (!row) return { ok: false, status: 404, error: "Pending account row not found" };
      pool.invalidate("gitlab-duo" as ProviderName);
      const { refreshGitlabDuoModels } = await import("../../proxy/providers/registry");
      await refreshGitlabDuoModels();
      broadcast({
        type: "account_updated",
        data: { id: row.id, provider: "gitlab-duo", email: row.email, status: "active" },
      });
      return {
        ok: true,
        id: row.id,
        label: row.email,
        username,
        namespacePath,
        defaultModel,
        modelsCount: availableModels.length,
      };
    }

    // Standard insert path (manual PAT add via dashboard).
    const existing = await db.select().from(accounts)
      .where(eq(accounts.email, label))
      .then((rows) => rows.find((r) => r.provider === "gitlab-duo"));
    if (existing) {
      return { ok: false, status: 409, error: "GitLab Duo account with this label already exists" };
    }

    const result = await db.insert(accounts).values({
      provider: "gitlab-duo",
      email: label,
      password: encrypt(pat),
      status: "active",
      enabled: true,
      tokens,
      metadata,
      quotaLimit,
      quotaRemaining,
      quotaResetAt,
    } as NewAccount).returning();
    const created = result[0]!;
    pool.invalidate("gitlab-duo" as ProviderName);

    const { refreshGitlabDuoModels } = await import("../../proxy/providers/registry");
    await refreshGitlabDuoModels();

    broadcast({
      type: "account_created",
      data: { id: created.id, provider: "gitlab-duo", email: label },
    });

    return {
      ok: true,
      id: created.id,
      label,
      username,
      namespacePath,
      defaultModel,
      modelsCount: availableModels.length,
    };
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
