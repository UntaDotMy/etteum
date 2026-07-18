import { sqliteTable, text, real, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull(), // kiro | codebuddy | canva
  email: text("email").notNull(),
  password: text("password").notNull(), // encrypted
  status: text("status").notNull().default("pending"), // active | exhausted | error | pending
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true), // user toggle: false = skip in upstream pool
  tokens: text("tokens", { mode: "json" }), // { access_token, refresh_token, ... }
  quotaLimit: real("quota_limit").default(0),
  quotaRemaining: real("quota_remaining").default(0),
  quotaResetAt: integer("quota_reset_at", { mode: "timestamp" }),
  // Qoder Free counter — mirror of /activity bucket qmodel_latest (Qwen3.7-Max promo).
  // Decremented per-request when the model maps to qmodel_latest (e.g. qd-Qwen3.7-Max).
  // Re-synced from Qoder by warmup; Qoder is source of truth on every override.
  freeLimit: real("free_limit").default(0),
  freeRemaining: real("free_remaining").default(0),
  freeResetAt: integer("free_reset_at", { mode: "timestamp" }),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
  errorMessage: text("error_message"),
  metadata: text("metadata", { mode: "json" }), // extra provider-specific data
  // --- Routing resilience  ---
  // Transient-error exponential backoff: an account here is temporarily
  // excluded from selection until the timestamp passes, then auto-reinstated.
  // NULL = not cooling down.
  cooldownUntil: integer("cooldown_until", { mode: "timestamp" }),
  // Backoff bookkeeping: consecutive transient failures and the next backoff
  // delay (doubles each time, capped). Reset to 0 on success.
  consecutiveTransientFailures: integer("consecutive_transient_failures").notNull().default(0),
  nextBackoffMs: integer("next_backoff_ms").notNull().default(0),
  // Terminal-error hysteresis: consecutive hard auth/persistent errors. At
  // >= TERMINAL_ERROR_THRESHOLD the account is marked `error` (disabled from
  // pool). Reset to 0 on success. Prevents a single transient 401 from
  // permanently killing an account.
  consecutiveAuthErrors: integer("consecutive_auth_errors").notNull().default(0),
  // 
  // Lower number = tried first. Enables "paid first, free fallback" ordering
  // of credentials within a provider. Default 0 preserves existing LB order.
  priority: integer("priority").notNull().default(0),
  // --- Sticky round-robin: consecutive requests served as the active pick ---
  // Rotates at the threshold. Persisted so stickiness survives restarts.
  consecutiveUseCount: integer("consecutive_use_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => [
  // Email must be unique PER provider (same email can exist for kiro + codebuddy + canva)
  uniqueIndex("accounts_provider_email_idx").on(table.provider, table.email),
]);

export const requestLogs = sqliteTable("request_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").references(() => accounts.id),
  provider: text("provider").notNull(),
  model: text("model"),
  promptTokens: integer("prompt_tokens").default(0),
  completionTokens: integer("completion_tokens").default(0),
  totalTokens: integer("total_tokens").default(0),
  creditsUsed: real("credits_used").default(0),
  status: text("status").notNull(), // success | error
  durationMs: integer("duration_ms"),
  errorMessage: text("error_message"),
  requestBody: text("request_body", { mode: "json" }),
  responseBody: text("response_body", { mode: "json" }),
  accountEmail: text("account_email"),
  accountQuotaBefore: real("account_quota_before").default(0),
  accountQuotaAfter: real("account_quota_after").default(0),
  /** JSON-encoded CompressionStats (see src/proxy/compression/types.ts). null when compression is fully disabled. */
  compressionStats: text("compression_stats", { mode: "json" }),
  /**
   * The actual request body sent upstream (post-compression pipeline).
   * Unlike `requestBody` which stores the ORIGINAL client request,
   * this field holds what was actually transmitted — enabling accurate
   * replay and compression savings analysis.
   * Respects logBodyEnabled / logBodyFull / logBodyMaxBytes limits.
   */
  compressedRequestBody: text("compressed_request_body", { mode: "json" }),
  /**
   * Human-readable savings breakdown per compression technique.
   * Derived from compressionStats.byTechnique at insert time so it is
   * queryable with plain SQL (no JSON parsing) on the dashboard.
   * Stored as a flat JSON object, e.g. { "rtk": 320, "tsc": 140 }.
   * null when compression is disabled.
   */
  savingsByTechnique: text("savings_by_technique", { mode: "json" }),
  // 
  // Which client API key made this request (null = legacy single-key or
  // internal). Enables "which client key spent the most" analytics that the
  // old schema could not answer.
  apiKeyId: integer("api_key_id"),
  // Estimated USD cost of this request, computed from per-model pricing.
  // null when pricing is unknown. Additive — creditsUsed (credits) is preserved.
  cost: real("cost"),
  // The upstream response id (e.g. Codex/OpenAI-Responses `id` field). Enables
  // sticky response-id pinning: a follow-up request carrying previous_response_id
  // is routed back to the account that created that response.
  responseId: text("response_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("request_logs_created_at_idx").on(table.createdAt),
  index("request_logs_status_created_at_idx").on(table.status, table.createdAt),
  index("request_logs_provider_created_at_idx").on(table.provider, table.createdAt),
  index("request_logs_provider_model_status_idx").on(table.provider, table.model, table.status),
  index("request_logs_account_idx").on(table.accountId),
  index("request_logs_api_key_idx").on(table.apiKeyId),
  index("request_logs_response_id_idx").on(table.responseId),
]);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const usageSummary = sqliteTable("usage_summary", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Stored as an ISO-8601 string (NOT integer timestamp): bucket is part of a unique
  // index and is compared as an ISO string in raw SQL (bucket >= '...') elsewhere.
  // Keeping it text preserves those string comparisons and the unique index under SQLite.
  bucket: text("bucket").notNull(), // start of hour (UTC), ISO-8601 string
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  totalRequests: integer("total_requests").default(0),
  successRequests: integer("success_requests").default(0),
  errorRequests: integer("error_requests").default(0),
  promptTokens: integer("prompt_tokens", { mode: "number" }).default(0),
  completionTokens: integer("completion_tokens", { mode: "number" }).default(0),
  totalTokens: integer("total_tokens", { mode: "number" }).default(0),
  creditsUsed: real("credits_used").default(0),
  totalDurationMs: integer("total_duration_ms", { mode: "number" }).default(0),
  // 
  apiKeyId: integer("api_key_id"),
  totalCost: real("total_cost").default(0),
}, (table) => [
  uniqueIndex("usage_summary_bucket_provider_model_idx").on(table.bucket, table.provider, table.model),
  index("usage_summary_bucket_idx").on(table.bucket),
  index("usage_summary_provider_idx").on(table.provider, table.bucket),
  index("usage_summary_api_key_idx").on(table.apiKeyId),
]);

export const vccCards = sqliteTable("vcc_cards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  number: text("number").notNull(),
  expMonth: text("exp_month").notNull(),
  expYear: text("exp_year").notNull(),
  cvv: text("cvv").notNull(),
  name: text("name").default("John Doe"),
  status: text("status").notNull().default("active"), // active, used, declined
  usedByAccountId: integer("used_by_account_id").references(() => accounts.id),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => [
  index("vcc_cards_status_idx").on(table.status),
]);

export const vccTransactions = sqliteTable("vcc_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").references(() => accounts.id),
  cardLast4: text("card_last4").notNull(),
  cardBrand: text("card_brand"), // visa, mastercard, etc
  amount: real("amount"),
  currency: text("currency").default("usd"),
  status: text("status").notNull(), // success, declined, error
  stripeChargeId: text("stripe_charge_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("vcc_transactions_account_idx").on(table.accountId),
  index("vcc_transactions_status_idx").on(table.status),
]);

export const imageStudioChats = sqliteTable("image_studio_chats", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title"),
  messages: text("messages", { mode: "json" }).notNull().$defaultFn(() => []),
  finalPrompt: text("final_prompt"),
  options: text("options", { mode: "json" }).$defaultFn(() => []),
  assistModel: text("assist_model"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => [
  index("image_studio_chats_updated_at_idx").on(table.updatedAt),
]);

export const imageStudioResults = sqliteTable("image_studio_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").references(() => imageStudioChats.id, { onDelete: "set null" }),
  prompt: text("prompt").notNull(),
  type: text("type").notNull().default("image"),
  aspectRatio: text("aspect_ratio").notNull().default("1:1"),
  n: integer("n").notNull().default(1),
  urls: text("urls", { mode: "json" }).notNull().$defaultFn(() => []),
  creditsUsed: real("credits_used").default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("image_studio_results_created_at_idx").on(table.createdAt),
  index("image_studio_results_chat_idx").on(table.chatId),
]);

export const filterRules = sqliteTable("filter_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ruleId: text("rule_id").notNull().unique(),
  pattern: text("pattern").notNull(),
  replacement: text("replacement").notNull().default(""),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  isRegex: integer("is_regex", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => [
  index("filter_rules_sort_order_idx").on(table.sortOrder),
]);

export const proxyPool = sqliteTable("proxy_pool", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull(),
  type: text("type").notNull().default("http"), // http | socks5
  label: text("label"),
  status: text("status").notNull().default("active"), // active | disabled | error
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }),
  errorMessage: text("error_message"),
  latencyMs: integer("latency_ms"),
  successCount: integer("success_count").default(0),
  failCount: integer("fail_count").default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => [
  index("proxy_pool_status_idx").on(table.status),
]);

// Model mappings for CLI integration (e.g. Claude Code). Incoming model ids are
// rewritten at the proxy edge to a target model available in the pool. Example:
// source "haiku" (match_type=contains) -> target "qwen-3.7".
export const modelMappings = sqliteTable("model_mappings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourcePattern: text("source_pattern").notNull(), // e.g. "haiku" / "claude-3-5-sonnet" / regex
  matchType: text("match_type").notNull().default("contains"), // contains | exact | regex
  targetModel: text("target_model").notNull().default(""), // model id available in the pool
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  priority: integer("priority").notNull().default(0), // lower = evaluated first
  label: text("label"), // optional human label e.g. "Claude Code · Haiku"
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => [
  index("model_mappings_priority_idx").on(table.priority),
]);

// Combos: named model chains for multi-model fallback.
// Clients send "my-combo/claude-sonnet" and the router expands to
// the configured chain: [provider-a/model-a, provider-b/model-b, ...].
// Strategies per combo (stored in settings, keyed by combo name):
//   fallback     — try first model, fall through to next on error/rate-limit
//   sticky       — round-robin within combo, sticky session (same account per combo)
//   fusion       — parallel inference, judge model picks winner (advanced)
export const combos = sqliteTable("combos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(), // e.g. "zero-cost" or "premium"
  models: text("models", { mode: "json" }).$type<string[]>().notNull().$defaultFn(() => []),
  // Strategy for the combo chain (mirrors the reference proxy `combos.kind`).
  //   fallback — try first model, fall through to next on error/rate-limit
  //   sticky   — round-robin within combo, sticky session (same account per combo)
  //   fusion   — parallel inference, judge model picks winner (advanced)
  // Default "fallback" preserves existing behavior for rows created pre-Wave-2.
  kind: text("kind").notNull().default("fallback"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => [
  index("combos_name_idx").on(table.name),
]);

// 
// Replaces the single-global-key model with named, machine-bound, individually
// revocable keys. The legacy single key (settings.api_key) is preserved as a
// fallback during the transition — nothing is dropped.
export const apiKeys = sqliteTable("api_keys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // The actual key string clients send as Authorization: Bearer <key>.
  // Prefixed "etteum_" so it is distinguishable from provider tokens.
  key: text("key").notNull().unique(),
  name: text("name"), // human label e.g. "Claude Code · Dev Machine"
  machineId: text("machine_id"), // optional per-machine binding
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  // ── Friend-key limits (all optional; null/absent = unrestricted) ──────────
  // JSON array of allowed model ids. null/empty = every model in the catalog.
  allowedModels: text("allowed_models"),
  // Total token budget for the key. null = unlimited.
  tokenQuota: integer("token_quota"),
  // Tokens consumed so far (decremented from request_logs attribution on each request).
  tokensUsed: integer("tokens_used").notNull().default(0),
  // Per-key requests/minute cap (token bucket). null = no extra cap.
  rateLimit: integer("rate_limit"),
  // Optional expiry timestamp; key stops working after this instant.
  expiresAt: integer("expires_at", { mode: "timestamp" }),
}, (table) => [
  index("api_keys_key_idx").on(table.key),
  index("api_keys_active_idx").on(table.isActive),
]);

// 
// Used by: customModels, disabledModels, pricing, mitmAlias scopes.
// A single table avoids one-off tables for each small config namespace.
export const kv = sqliteTable("kv", {
  scope: text("scope").notNull(), // e.g. "customModels" | "disabledModels" | "pricing" | "mitmAlias"
  key: text("key").notNull(), // e.g. model id or provider:model
  value: text("value").notNull(), // JSON-encoded payload
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => [
  // composite primary key via unique index — Drizzle sqlite composite PK helper
  // is verbose; a unique index on (scope, key) achieves the same lookup semantics.
  index("kv_scope_idx").on(table.scope),
  uniqueIndex("kv_scope_key_idx").on(table.scope, table.key),
]);

/**
 * F13: dynamic compatible-node providers — user-defined OpenAI/Anthropic-
 * compatible endpoints added at runtime via the dashboard, resolved by model
 * prefix (mirrors reference providerNodes + nodesRepo). Each node carries its
 * own baseUrl + apiType + prefix + models, so a user can add e.g. a local
 * Ollama or a third-party relay without writing a provider class.
 *
 * `data` JSON holds: { name, prefix, type ("openai-compatible"|"anthropic-compatible"|"custom-embedding"),
 *   baseUrl, apiType, models[], headers? }.
 */
export const providerNodes = sqliteTable("provider_nodes", {
  id: text("id").primaryKey(), // user-supplied node id (also the routing key)
  type: text("type").notNull(), // "openai-compatible" | "anthropic-compatible" | "custom-embedding"
  name: text("name").notNull(),
  data: text("data", { mode: "json" }).notNull(), // { prefix, baseUrl, apiType, models[], headers? }
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Type exports
export type Combo = typeof combos.$inferSelect;
export type NewCombo = typeof combos.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type ProviderNode = typeof providerNodes.$inferSelect;
export type NewProviderNode = typeof providerNodes.$inferInsert;
export type RequestLog = typeof requestLogs.$inferSelect;
export type NewRequestLog = typeof requestLogs.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type UsageSummary = typeof usageSummary.$inferSelect;
export type NewUsageSummary = typeof usageSummary.$inferInsert;
export type VccTransaction = typeof vccTransactions.$inferSelect;
export type NewVccTransaction = typeof vccTransactions.$inferInsert;
export type VccCard = typeof vccCards.$inferSelect;
export type NewVccCard = typeof vccCards.$inferInsert;
export type ProxyPoolEntry = typeof proxyPool.$inferSelect;
export type NewProxyPoolEntry = typeof proxyPool.$inferInsert;
export type ImageStudioChat = typeof imageStudioChats.$inferSelect;
export type NewImageStudioChat = typeof imageStudioChats.$inferInsert;
export type ImageStudioResult = typeof imageStudioResults.$inferSelect;
export type NewImageStudioResult = typeof imageStudioResults.$inferInsert;
export type FilterRule = typeof filterRules.$inferSelect;
export type NewFilterRule = typeof filterRules.$inferInsert;
export type ModelMapping = typeof modelMappings.$inferSelect;
export type NewModelMapping = typeof modelMappings.$inferInsert;
// 
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type KvEntry = typeof kv.$inferSelect;
export type NewKvEntry = typeof kv.$inferInsert;
