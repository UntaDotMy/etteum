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
import { createGitlabDuoAccount } from "./gitlab-helpers";

/** Register routes on the parent accounts router (order-sensitive). */
export function registerGitlabDuoRoutes(router: Hono): void {
  router.post("/gitlab-duo", async (c) => {
    const body = await c.req.json<{
      gitlab_base_url?: string;
      gitlabBaseUrl?: string;
      pat: string;
      label?: string;
      gmail_email?: string;
      gmailEmail?: string;
      gmail_password?: string;
      gmailPassword?: string;
    }>();
    const result = await createGitlabDuoAccount({
      gitlabBaseUrl: body.gitlab_base_url ?? body.gitlabBaseUrl,
      pat: body.pat,
      label: body.label,
      gmailEmail: body.gmail_email ?? body.gmailEmail,
      gmailPassword: body.gmail_password ?? body.gmailPassword,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as any);
    return c.json({
      success: true,
      id: result.id,
      label: result.label,
      username: result.username,
      namespacePath: result.namespacePath,
      defaultModel: result.defaultModel,
      modelsCount: result.modelsCount,
    }, 201);
  });

  /**
   * POST /api/accounts/gitlab-duo/:id/refresh - Re-resolve namespace + models for
   * an existing account. Useful after the user changes their default namespace
   * or when GitLab adds new selectable models to your tier.
   */
  router.post("/gitlab-duo/:id/refresh", async (c) => {
    const id = Number(c.req.param("id"));
    const [account] = await db.select().from(accounts).where(eq(accounts.id, id));
    if (!account || account.provider !== "gitlab-duo") {
      return c.json({ error: "Not a GitLab Duo account" }, 404);
    }

    const tokens = (typeof account.tokens === "string"
      ? JSON.parse(account.tokens)
      : account.tokens) as { gitlabBaseUrl: string; namespaceId?: number };
    const oldMeta = (typeof account.metadata === "string"
      ? JSON.parse(account.metadata)
      : account.metadata) ?? {};
    const pat = decrypt(account.password);
    const baseUrl = tokens.gitlabBaseUrl;

    const headers = {
      "Private-Token": pat,
      "Content-Type": "application/json",
      "User-Agent": "etteum-pool/gitlab-duo",
    };

    try {
      // 1. Re-resolve duoDefaultNamespace (it can change in GitLab Preferences UI),
      //    or fall back to the user's first writable group.
      const userR = await fetch(`${baseUrl}/api/graphql`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          operationName: "getUser",
          query: `query getUser {
            currentUser {
              userPreferences { duoDefaultNamespace { id fullPath } }
              groups(first: 1, permissionScope: CREATE_PROJECTS) {
                nodes { id fullPath }
              }
            }
          }`,
          variables: {},
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const userJson = (await userR.json()) as any;
      const cu = userJson.data?.currentUser;
      const duoNs = cu?.userPreferences?.duoDefaultNamespace;
      const fallbackNs = cu?.groups?.nodes?.[0];
      const ns = duoNs ?? fallbackNs;
      if (!ns) return c.json({ error: "no namespace resolvable for this PAT" }, 400);

      const namespaceId = Number(String(ns.id).split("/").pop());
      const namespacePath = ns.fullPath;

      // 2. Re-fetch the available models for that namespace
      const modelsR = await fetch(`${baseUrl}/api/graphql`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          operationName: "lsp_aiChatAvailableModels",
          query: `query lsp_aiChatAvailableModels($rootNamespaceId: GroupID!) {
            metadata { version }
            aiChatAvailableModels(rootNamespaceId: $rootNamespaceId) {
              defaultModel { name ref }
              selectableModels { name ref }
            }
          }`,
          variables: { rootNamespaceId: `gid://gitlab/Group/${namespaceId}` },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const modelsJson = (await modelsR.json()) as any;
      const dm = modelsJson.data?.aiChatAvailableModels?.defaultModel;
      const sm = modelsJson.data?.aiChatAvailableModels?.selectableModels;
      const gitlabVersion = modelsJson.data?.metadata?.version ?? oldMeta.gitlabVersion ?? "";

      const nextTokens = { ...tokens, namespaceId, namespacePath };
      const nextMeta = {
        ...oldMeta,
        defaultModel: dm?.ref ?? oldMeta.defaultModel ?? "claude_sonnet_4_6_vertex",
        availableModels: Array.isArray(sm) ? sm : oldMeta.availableModels ?? [],
        gitlabVersion,
      };

      // 3. Pull current GitLab Credits balance via trialUsage so quota columns
      //    reflect the live wallet (creditsUsed / totalCredits per user).
      let quotaLimit = account.quotaLimit ?? 0;
      let quotaRemaining = account.quotaRemaining ?? 0;
      let quotaResetAt: Date | null = account.quotaResetAt ?? null;
      try {
        const { providers } = await import("../../proxy/router");
        const duoProvider = providers["gitlab-duo"];
        if (duoProvider) {
          const probe = await duoProvider.fetchQuota({
            ...account,
            tokens: nextTokens,
            metadata: nextMeta,
          });
          if (probe.success && probe.quota && probe.quota.limit >= 0) {
            quotaLimit = probe.quota.limit;
            quotaRemaining = probe.quota.remaining;
            if (probe.quota.resetAt instanceof Date) quotaResetAt = probe.quota.resetAt;
          }
        }
      } catch {
        // Non-fatal — keep stored quota values.
      }

      await db.update(accounts)
        .set({
          tokens: nextTokens,
          metadata: nextMeta,
          quotaLimit,
          quotaRemaining,
          quotaResetAt,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, id));

      // Trigger provider cache refresh so the new model list is routable immediately
      const { refreshGitlabDuoModels } = await import("../../proxy/providers/registry");
      await refreshGitlabDuoModels();

      return c.json({
        success: true,
        namespacePath,
        namespaceId,
        defaultModel: nextMeta.defaultModel,
        modelsCount: nextMeta.availableModels.length,
        quotaLimit,
        quotaRemaining,
        quotaResetAt,
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  /**
   * GET /api/accounts/:id - Get single account
   */
}
