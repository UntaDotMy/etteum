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
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("request_logs_created_at_idx").on(table.createdAt),
  index("request_logs_status_created_at_idx").on(table.status, table.createdAt),
  index("request_logs_provider_created_at_idx").on(table.provider, table.createdAt),
  index("request_logs_provider_model_status_idx").on(table.provider, table.model, table.status),
  index("request_logs_account_idx").on(table.accountId),
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
}, (table) => [
  uniqueIndex("usage_summary_bucket_provider_model_idx").on(table.bucket, table.provider, table.model),
  index("usage_summary_bucket_idx").on(table.bucket),
  index("usage_summary_provider_idx").on(table.provider, table.bucket),
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

// Type exports
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
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
