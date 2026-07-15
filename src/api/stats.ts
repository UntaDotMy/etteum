import { Hono } from "hono";
import { db } from "../db/index";
import { requestLogs, accounts, usageSummary } from "../db/schema";
import { desc, sql, eq } from "drizzle-orm";
import { pool } from "../proxy/pool";
import { config } from "../config";
import { getAllModels } from "../proxy/router";

export const statsRouter = new Hono();

function normalizeTimeZone(value: string | undefined): string {
  if (!value) return "UTC";
  if (!/^[A-Za-z0-9_+./-]+$/.test(value)) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "UTC";
  }
}

function sqlString(value: string) {
  return sql.raw(`'${value.replace(/'/g, "''")}'`);
}

function clampNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function summaryBucketExpr(grain: "hour" | "day" | "month", timeZone: string) {
  // NOTE: usage_summary.bucket is a TEXT ISO-8601 UTC string (e.g. '2026-06-03T09:00:00Z').
  // SQLite's strftime cannot apply IANA time zone names, so the timeZone param is accepted
  // and echoed back in the JSON response but intentionally ignored here: all bucketing is
  // done in UTC directly over the already-UTC bucket string.
  void timeZone;
  switch (grain) {
    case "hour":
      return sql<string>`strftime('%Y-%m-%dT%H:00:00Z', ${usageSummary.bucket})`;
    case "day":
      return sql<string>`strftime('%Y-%m-%dT00:00:00Z', ${usageSummary.bucket})`;
    case "month":
      return sql<string>`strftime('%Y-%m-01T00:00:00Z', ${usageSummary.bucket})`;
  }
}

/**
 * GET /api/stats - Get overall statistics (from usage_summary)
 * Supports optional ?hours=N&range=all to filter by time period
 */
statsRouter.get("/", async (c) => {
  const range = c.req.query("range");
  const hours = c.req.query("hours") ? clampNumber(c.req.query("hours"), 24, 1, 24 * 365) : null;
  const isAll = range === "all";

  const timeFilter = (!isAll && hours)
    ? sql`${usageSummary.bucket} >= ${new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()}`
    : sql`1=1`;

  const [poolStats, requestStats] = await Promise.all([
    pool.getStats(),
    db
      .select({
        total: sql<number>`COALESCE(SUM(total_requests), 0)`,
        success: sql<number>`COALESCE(SUM(success_requests), 0)`,
        errors: sql<number>`COALESCE(SUM(error_requests), 0)`,
        totalTokens: sql<number>`COALESCE(SUM(total_tokens), 0)`,
        promptTokens: sql<number>`COALESCE(SUM(prompt_tokens), 0)`,
        completionTokens: sql<number>`COALESCE(SUM(completion_tokens), 0)`,
        credits: sql<number>`COALESCE(SUM(credits_used), 0)`,
        totalCost: sql<number>`COALESCE(SUM(total_cost), 0)`,
        avgDuration: sql<number>`CASE WHEN SUM(success_requests) > 0 THEN CAST(SUM(total_duration_ms) AS REAL) / SUM(success_requests) ELSE 0 END`,
      })
      .from(usageSummary)
      .where(timeFilter),
  ]);

  const stats = requestStats[0];

  return c.json({
    pool: poolStats,
    requests: {
      total: stats?.total || 0,
      success: stats?.success || 0,
      errors: stats?.errors || 0,
    },
    tokens: {
      total: stats?.totalTokens || 0,
      prompt: stats?.promptTokens || 0,
      completion: stats?.completionTokens || 0,
      credits: stats?.credits || 0,
    },
    cost: {
      total: Number(stats?.totalCost || 0),
    },
    performance: {
      avgDurationMs: Math.round(stats?.avgDuration || 0),
    },
  });
});

/**
 * GET /api/stats/requests - Get recent request logs (from request_logs, max 500)
 *
 * IMPORTANT: This endpoint intentionally OMITS the heavy `requestBody` and
 * `responseBody` columns to keep list payloads small. Each row's prompt can be
 * ~1 MB (system prompt + conversation history), so selecting them here would
 * mean tens of MB of JSON over the wire just to render a table. The full
 * bodies are loaded on demand via `GET /api/stats/requests/:id` when the user
 * opens the detail drawer.
 */
statsRouter.get("/requests", async (c) => {
  const limit = clampNumber(c.req.query("limit"), 50, 1, 500);
  const offset = clampNumber(c.req.query("offset"), 0, 0, 100_000);
  const provider = c.req.query("provider");

  const lightColumns = {
    id: requestLogs.id,
    accountId: requestLogs.accountId,
    provider: requestLogs.provider,
    model: requestLogs.model,
    promptTokens: requestLogs.promptTokens,
    completionTokens: requestLogs.completionTokens,
    totalTokens: requestLogs.totalTokens,
    creditsUsed: requestLogs.creditsUsed,
    cost: requestLogs.cost,
    status: requestLogs.status,
    durationMs: requestLogs.durationMs,
    errorMessage: requestLogs.errorMessage,
    accountEmail: requestLogs.accountEmail,
    accountQuotaBefore: requestLogs.accountQuotaBefore,
    accountQuotaAfter: requestLogs.accountQuotaAfter,
    compressionStats: requestLogs.compressionStats,
    createdAt: requestLogs.createdAt,
  };

  const baseQuery = provider
    ? db.select(lightColumns).from(requestLogs).where(eq(requestLogs.provider, provider))
    : db.select(lightColumns).from(requestLogs);

  const logs = await baseQuery
    .orderBy(desc(requestLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({ data: logs, limit, offset });
});

/**
 * GET /api/stats/requests/:id - Get request log detail
 */
statsRouter.get("/requests/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const [log] = await db.select().from(requestLogs).where(eq(requestLogs.id, id));
  if (!log) return c.json({ error: "Request log not found" }, 404);
  // Surface body-logging policy so the UI can explain empty request/response panels
  // (default: bodies disabled to keep request_logs from multi-GB growth).
  return c.json({
    data: log,
    meta: {
      logBodyEnabled: config.logBodyEnabled,
      logBodyFull: config.logBodyFull,
      logBodyMaxBytes: config.logBodyMaxBytes,
    },
  });
});

/**
 * GET /api/stats/usage - Get usage over time (from usage_summary)
 */
statsRouter.get("/usage", async (c) => {
  const range = c.req.query("range");
  const hours = clampNumber(c.req.query("hours"), 24, 1, 24 * 365);
  const timeZone = normalizeTimeZone(c.req.query("timeZone"));
  const isAll = range === "all";
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const bucketExpr =
    isAll
      ? summaryBucketExpr("month", timeZone)
      : hours <= 48
      ? summaryBucketExpr("hour", timeZone)
      : hours <= 24 * 32
        ? summaryBucketExpr("day", timeZone)
        : summaryBucketExpr("month", timeZone);

  const whereExpr = isAll
    ? sql`${usageSummary.totalTokens} > 0`
    : sql`${usageSummary.bucket} >= ${since.toISOString()} AND ${usageSummary.totalTokens} > 0`;

  const hourlyUsage = await db
    .select({
      hour: bucketExpr,
      provider: usageSummary.provider,
      model: usageSummary.model,
      count: sql<number>`SUM(total_requests)`,
      tokens: sql<number>`SUM(total_tokens)`,
      promptTokens: sql<number>`SUM(prompt_tokens)`,
      completionTokens: sql<number>`SUM(completion_tokens)`,
      credits: sql<number>`SUM(credits_used)`,
      cost: sql<number>`COALESCE(SUM(total_cost), 0)`,
      avgDuration: sql<number>`CASE WHEN SUM(success_requests) > 0 THEN CAST(SUM(total_duration_ms) AS REAL) / SUM(success_requests) ELSE 0 END`,
    })
    .from(usageSummary)
    .where(whereExpr)
    .groupBy(bucketExpr, usageSummary.provider, usageSummary.model)
    .orderBy(bucketExpr, usageSummary.provider, usageSummary.model);

  return c.json({ data: hourlyUsage, hours: isAll ? null : hours, range: isAll ? "all" : `${hours}h`, timeZone });
});

/**
 * GET /api/stats/providers - Get per-provider statistics (from usage_summary + accounts)
 */
statsRouter.get("/providers", async (c) => {
  const allowedProviders = new Set<string>(config.providers);
  const requestStats = await db
    .select({
      provider: usageSummary.provider,
      totalRequests: sql<number>`SUM(total_requests)`,
      successRequests: sql<number>`SUM(success_requests)`,
      errorRequests: sql<number>`SUM(error_requests)`,
      totalTokens: sql<number>`COALESCE(SUM(total_tokens), 0)`,
      promptTokens: sql<number>`COALESCE(SUM(prompt_tokens), 0)`,
      completionTokens: sql<number>`COALESCE(SUM(completion_tokens), 0)`,
      creditsUsed: sql<number>`COALESCE(SUM(credits_used), 0)`,
      totalCost: sql<number>`COALESCE(SUM(total_cost), 0)`,
      avgDuration: sql<number>`CASE WHEN SUM(success_requests) > 0 THEN CAST(SUM(total_duration_ms) AS REAL) / SUM(success_requests) ELSE 0 END`,
    })
    .from(usageSummary)
    .groupBy(usageSummary.provider);

  const quotaStats = await db
    .select({
      provider: accounts.provider,
      activeAccounts: sql<number>`SUM(CASE WHEN status = 'active' AND enabled = 1 THEN 1 ELSE 0 END)`,
      exhaustedAccounts: sql<number>`SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END)`,
      errorAccounts: sql<number>`SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)`,
      pendingAccounts: sql<number>`SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)`,
      disabledAccounts: sql<number>`SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END)`,
      totalAccounts: sql<number>`count(*)`,
      // Package total = enabled accounts' limits (include exhausted so total
      // does not shrink when accounts burn out). Remaining = enabled remaining.
      // Sentinel -1 (unlimited/unknown) is treated as 0 for aggregation.
      activeQuotaLimit: sql<number>`COALESCE(SUM(CASE WHEN enabled = 1 AND quota_limit > 0 THEN quota_limit ELSE 0 END), 0)`,
      activeQuotaRemaining: sql<number>`COALESCE(SUM(CASE WHEN enabled = 1 AND quota_remaining > 0 THEN quota_remaining ELSE 0 END), 0)`,
      // Keep total quota (all accounts) for informational/debug purposes
      totalQuotaLimit: sql<number>`COALESCE(SUM(CASE WHEN quota_limit < 0 THEN 0 ELSE quota_limit END), 0)`,
      totalQuotaRemaining: sql<number>`COALESCE(SUM(CASE WHEN quota_remaining < 0 THEN 0 ELSE quota_remaining END), 0)`,
    })
    .from(accounts)
    .groupBy(accounts.provider);

  const byProvider = new Map(
    requestStats
      .filter((row) => row.provider && allowedProviders.has(row.provider))
      .map((row) => [row.provider, row])
  );
  for (const quota of quotaStats) {
    if (!allowedProviders.has(quota.provider)) continue;
    const current = byProvider.get(quota.provider) || { provider: quota.provider } as any;
    byProvider.set(quota.provider, { ...current, ...quota });
  }

  const data = config.providers
    .map((provider) => byProvider.get(provider))
    .filter(Boolean);

  return c.json({ data });
});

/**
 * GET /api/stats/models - Get per-model statistics (from usage_summary)
 * Supports optional ?hours=N&range=all to filter by time period
 */
statsRouter.get("/models", async (c) => {
  const range = c.req.query("range");
  const hours = c.req.query("hours") ? clampNumber(c.req.query("hours"), 24, 1, 24 * 365) : null;
  const isAll = range === "all";

  const whereExpr = (!isAll && hours)
    ? sql`${usageSummary.bucket} >= ${new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()}`
    : sql`1=1`;

  const modelMeta = new Map(getAllModels().map((model) => [model.id, model]));
  const modelStats = await db
    .select({
      provider: usageSummary.provider,
      model: usageSummary.model,
      totalRequests: sql<number>`SUM(total_requests)`,
      totalTokens: sql<number>`COALESCE(SUM(total_tokens), 0)`,
      promptTokens: sql<number>`COALESCE(SUM(prompt_tokens), 0)`,
      completionTokens: sql<number>`COALESCE(SUM(completion_tokens), 0)`,
      credits: sql<number>`COALESCE(SUM(credits_used), 0)`,
      totalCost: sql<number>`COALESCE(SUM(total_cost), 0)`,
      avgDuration: sql<number>`CASE WHEN SUM(success_requests) > 0 THEN CAST(SUM(total_duration_ms) AS REAL) / SUM(success_requests) ELSE 0 END`,
    })
    .from(usageSummary)
    .where(whereExpr)
    .groupBy(usageSummary.provider, usageSummary.model)
    .having(sql`COALESCE(SUM(total_tokens), 0) > 0 OR COALESCE(SUM(credits_used), 0) > 0`)
    .orderBy(sql`COALESCE(SUM(total_tokens), 0) DESC`);

  const data = modelStats.map((row) => {
    const meta = modelMeta.get(row.model || "");
    return {
      ...row,
      creditUnit: meta?.creditUnit || "token",
      creditRate: meta?.creditRate || 1 / 1000,
      creditSource: meta?.creditSource || "estimated",
    };
  });

  return c.json({ data });
});
