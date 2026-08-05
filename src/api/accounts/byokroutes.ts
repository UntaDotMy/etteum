import type { Hono } from "hono";
import { db } from "../../db/index";
import { accounts, settings } from "../../db/schema";
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
  normalizeByokKeys,
  buildByokEmail,
  normalizeByokLbMethod,
  setByokLbMethod,
  getByokLbMethods,
  refreshByokRuntime,
  detachAccountDependents,
  BYOK_PREFIX_RE,
  BYOK_KEY_LABEL_RE,
  type ByokKeyInput,
  type ByokTokensShape,
} from "./shared";

/** Register routes on the parent accounts router (order-sensitive). */
export function registerByokRoutes(router: Hono): void {
  router.post("/byok", async (c) => {
    const body = await c.req.json<{
      label: string;
      base_url: string;
      api_key?: string;
      api_keys?: ByokKeyInput[];
      format?: "openai" | "anthropic" | "auto";
      models: string[];
      headers?: Record<string, string>;
      load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
    }>();

    const label = String(body.label || "").trim().toLowerCase();
    const baseUrl = String(body.base_url || "").trim().replace(/\/$/, "");
    const models = normalizeModels(body.models);

    if (!label || !baseUrl || models.length === 0) {
      return c.json({ error: "label, base_url, and models[] are required" }, 400);
    }
    if (!BYOK_PREFIX_RE.test(label)) {
      return c.json({ error: "label must be lowercase alphanumeric with hyphens only" }, 400);
    }

    let keyInputs: Array<{ label: string; key: string; weight?: number; priority?: number }>;
    try {
      keyInputs = normalizeByokKeys(body.api_keys, body.api_key);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    if (keyInputs.length === 0) {
      return c.json({ error: "At least one API key is required" }, 400);
    }

    const existingByok = await db.select().from(accounts).where(eq(accounts.provider, "byok"));
    if (existingByok.some((acc) => getByokPrefix(acc) === label)) {
      return c.json({ error: "BYOK provider with this label already exists" }, 409);
    }

    try {
      const createdRows = [];
      for (const [index, keyInput] of keyInputs.entries()) {
        const tokens: ByokTokensShape = {
          base_url: baseUrl,
          format: body.format || "auto",
          models,
          model_prefix: label,
          headers: body.headers || {},
          key_label: keyInput.label,
          weight: keyInput.weight,
          priority: keyInput.priority ?? index,
          load_balancing_method: normalizeByokLbMethod(body.load_balancing_method),
        };

        const result = await db.insert(accounts).values({
          provider: "byok",
          email: buildByokEmail(label, keyInput.label),
          password: encrypt(keyInput.key),
          status: "active",
          enabled: true,
          tokens,
          quotaLimit: -1,
          quotaRemaining: -1,
        }).returning();
        if (result[0]) createdRows.push(result[0]);
      }

      await setByokLbMethod(label, normalizeByokLbMethod(body.load_balancing_method));
      await refreshByokRuntime();
      broadcast({
        type: "byok_created",
        data: { id: createdRows[0]?.id, label, keyCount: createdRows.length },
      });

      return c.json({
        success: true,
        id: createdRows[0]?.id,
        label,
        key_count: createdRows.length,
        models: models.map((m) => `${label}-${m}`),
      }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
    }
  });

  /**
   * GET /api/accounts/byok - List BYOK provider groups with masked key metadata.
   */
  router.get("/byok", async (c) => {
    const byokAccounts = await db.select().from(accounts)
      .where(eq(accounts.provider, "byok"));

    const lbMethods = await getByokLbMethods(Array.from(new Set(byokAccounts.map((acc) => getByokPrefix(acc)))));

    const groups = new Map<string, {
      id: number;
      label: string;
      base_url: string;
      format: "openai" | "anthropic" | "auto";
      models: string[];
      model_prefix: string;
      headers?: Record<string, string>;
      status: string;
      enabled: boolean;
      available_models: string[];
      key_count: number;
      active_key_count: number;
      load_balancing_method: string;
      keys: Array<{
        id: number;
        label: string;
        status: string;
        enabled: boolean;
        weight?: number;
        priority?: number;
        lastUsedAt?: Date | null;
        errorMessage?: string | null;
      }>;
    }>();

    for (const acc of byokAccounts) {
      const tokens = parseByokTokens(acc.tokens);
      const prefix = tokens.model_prefix || getByokPrefix(acc);
      const keyLabel = getByokKeyLabel(acc);
      const models = normalizeModels(tokens.models || []);
      const existing = groups.get(prefix);

      if (!existing) {
        groups.set(prefix, {
          id: acc.id,
          label: prefix,
          base_url: tokens.base_url || "",
          format: tokens.format || "auto",
          models,
          model_prefix: prefix,
          headers: tokens.headers || {},
          status: acc.status,
          enabled: Boolean(acc.enabled),
          available_models: models.map((m) => `${prefix}-${m}`),
          key_count: 0,
          active_key_count: 0,
          load_balancing_method: lbMethods.get(prefix) || tokens.load_balancing_method || "round_robin",
          keys: [],
        });
      } else {
        const modelSet = new Set(existing.models);
        for (const model of models) modelSet.add(model);
        existing.models = Array.from(modelSet);
        existing.available_models = existing.models.map((m) => `${prefix}-${m}`);
        existing.enabled = existing.enabled || Boolean(acc.enabled);
        existing.status = existing.status === "active" || acc.status !== "active" ? existing.status : "active";
      }

      const group = groups.get(prefix)!;
      group.key_count += 1;
      if (acc.enabled && acc.status === "active") group.active_key_count += 1;
      group.keys.push({
        id: acc.id,
        label: keyLabel,
        status: acc.status,
        enabled: Boolean(acc.enabled),
        weight: tokens.weight,
        priority: tokens.priority,
        lastUsedAt: acc.lastUsedAt,
        errorMessage: acc.errorMessage,
      });
    }

    const providers = Array.from(groups.values()).map((group) => ({
      ...group,
      keys: group.keys.sort((a, b) => (Number(a.priority ?? 9999) - Number(b.priority ?? 9999)) || a.id - b.id),
    })).sort((a, b) => a.label.localeCompare(b.label));

    return c.json({ providers, total: providers.length });
  });

  /**
   * POST /api/accounts/byok/:id/reveal - Reveal a stored BYOK key secret.
   *
   * The list endpoint intentionally keeps secrets masked. This endpoint is called
   * only on an explicit eye-icon action from the authenticated dashboard so the
   * secret is not sent with normal page loads or websocket refreshes.
   */
  router.post("/byok/:id/reveal", async (c) => {
    // Secret disclosure: require local origin / CLI admin token.
    const guard = adminGuardFromPeer(peerIpFromHonoContext(c), c.req.raw.headers, new URL(c.req.url).searchParams);
    if (!guard.allowed) return c.json({ error: `Forbidden: ${guard.reason}` }, 403);

    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid BYOK key id" }, 400);

    const account = await db.select().from(accounts).where(eq(accounts.id, id)).get();
    if (!account || account.provider !== "byok") {
      return c.json({ error: "BYOK key not found" }, 404);
    }

    try {
      return c.json({
        success: true,
        id: account.id,
        label: getByokKeyLabel(account),
        key: decrypt(account.password),
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Failed to decrypt BYOK key" }, 500);
    }
  });

  /**
   * PATCH /api/accounts/byok/:id - Update a BYOK provider group.
   * If `api_keys` is provided it becomes the desired key set: existing keys can be
   * referenced by id/label and omitted keys are deleted from the group.
   */
  router.patch("/byok/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{
      base_url?: string;
      api_key?: string;
      api_keys?: ByokKeyInput[];
      format?: "openai" | "anthropic" | "auto";
      models?: string[];
      headers?: Record<string, string>;
      load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
    }>();

    const account = await db.select().from(accounts)
      .where(eq(accounts.id, id))
      .get();

    if (!account || account.provider !== "byok") {
      return c.json({ error: "BYOK provider not found" }, 404);
    }

    const prefix = getByokPrefix(account);
    const allByok = await db.select().from(accounts).where(eq(accounts.provider, "byok"));
    const groupAccounts = allByok.filter((acc) => getByokPrefix(acc) === prefix);
    const currentTokens = parseByokTokens(account.tokens);
    const nextBaseUrl = body.base_url?.trim().replace(/\/$/, "") || currentTokens.base_url || "";
    const nextFormat = body.format || currentTokens.format || "auto";
    const nextModels = body.models ? normalizeModels(body.models) : normalizeModels(currentTokens.models || []);
    const nextHeaders = body.headers ?? currentTokens.headers ?? {};

    if (!nextBaseUrl || nextModels.length === 0) {
      return c.json({ error: "base_url and at least one model are required" }, 400);
    }

    try {
      const keyPayloadProvided = Array.isArray(body.api_keys);
      const desiredKeys = keyPayloadProvided ? (body.api_keys || []) : [];
      const touchedIds = new Set<number>();

      // Run all key mutations inside a single transaction so a crash or error
      // between add/update/delete cannot leave a half-reconciled BYOK group
      // (CWE-362). Post-transaction side-effects (cache refresh, broadcast) run
      // after commit.
      const removedKeyIds: number[] = [];
      await db.transaction(async (tx) => {
        if (keyPayloadProvided) {
          const seenLabels = new Set<string>();
          for (const [index, keyInput] of desiredKeys.entries()) {
            const keyLabel = String(keyInput.label || `key-${index + 1}`).trim().toLowerCase();
            const keySecret = String(keyInput.key || keyInput.api_key || "").trim();
            if (!BYOK_KEY_LABEL_RE.test(keyLabel)) {
              throw new HttpError(400, "key label must start with lowercase alphanumeric and contain only lowercase letters, numbers, hyphen, or underscore");
            }
            if (seenLabels.has(keyLabel)) throw new HttpError(400, `duplicate BYOK key label: ${keyLabel}`);
            seenLabels.add(keyLabel);

            const existing = groupAccounts.find((acc) =>
              (keyInput.id && acc.id === keyInput.id) || getByokKeyLabel(acc) === keyLabel
            );
            const tokens: ByokTokensShape = {
              ...parseByokTokens(existing?.tokens),
              base_url: nextBaseUrl,
              format: nextFormat,
              models: nextModels,
              model_prefix: prefix,
              headers: nextHeaders,
              key_label: keyLabel,
              weight: Number.isFinite(Number(keyInput.weight)) ? Number(keyInput.weight) : undefined,
              priority: Number.isFinite(Number(keyInput.priority)) ? Number(keyInput.priority) : index,
              load_balancing_method: normalizeByokLbMethod(body.load_balancing_method || currentTokens.load_balancing_method),
            };

            if (existing) {
              const updateData: Record<string, unknown> = {
                email: buildByokEmail(prefix, keyLabel),
                tokens,
                enabled: typeof keyInput.enabled === "boolean" ? keyInput.enabled : existing.enabled,
                updatedAt: new Date(),
              };
              if (keySecret) updateData.password = encrypt(keySecret);
              await tx.update(accounts).set(updateData).where(eq(accounts.id, existing.id));
              touchedIds.add(existing.id);
            } else {
              if (!keySecret) throw new HttpError(400, `new key "${keyLabel}" requires a secret`);
              const inserted = await tx.insert(accounts).values({
                provider: "byok",
                email: buildByokEmail(prefix, keyLabel),
                password: encrypt(keySecret),
                status: "active",
                enabled: keyInput.enabled ?? true,
                tokens,
                quotaLimit: -1,
                quotaRemaining: -1,
              }).returning();
              if (inserted[0]) touchedIds.add(inserted[0].id);
            }
          }

          const toDelete = groupAccounts.filter((acc) => !touchedIds.has(acc.id));
          for (const acc of toDelete) {
            await detachAccountDependents(tx, acc.id);
            await tx.delete(accounts).where(eq(accounts.id, acc.id));
            removedKeyIds.push(acc.id);
          }
        } else {
          for (const acc of groupAccounts) {
            const tokens = parseByokTokens(acc.tokens);
            const updateData: Record<string, unknown> = {
              tokens: {
                ...tokens,
                base_url: nextBaseUrl,
                format: nextFormat,
                models: nextModels,
                model_prefix: prefix,
                headers: nextHeaders,
                load_balancing_method: normalizeByokLbMethod(body.load_balancing_method || tokens.load_balancing_method),
              },
              updatedAt: new Date(),
            };
            if (body.api_key && acc.id === id) updateData.password = encrypt(body.api_key);
            await tx.update(accounts).set(updateData).where(eq(accounts.id, acc.id));
          }
        }
      });

      if (removedKeyIds.length > 0) {
        warmupQueue.cancelAccounts(removedKeyIds);
        loginQueue.cancelAccounts(removedKeyIds);
      }

      // Only overwrite the authoritative settings row when the caller explicitly
      // provides a method — otherwise a partial PATCH would clobber a method set
      // via the settings API back to round_robin.
      if (body.load_balancing_method !== undefined) {
        await setByokLbMethod(prefix, normalizeByokLbMethod(body.load_balancing_method));
      }
      await refreshByokRuntime();
      broadcast({ type: "byok_updated", data: { id, label: prefix } });

      return c.json({
        success: true,
        id,
        label: prefix,
        models: nextModels.map((m) => `${prefix}-${m}`),
      });
    } catch (error) {
      if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
      return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
    }
  });

  /**
   * POST /api/accounts/byok/:id/keys - Append API keys to an existing BYOK provider group.
   * Additive bulk-add: incoming keys that already exist on the group are skipped
   * (idempotent retry-safe), a label that collides with a different stored secret
   * is a 409 conflict, and all inserts run in one transaction.
   */
  router.post("/byok/:id/keys", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{ api_key?: string; api_keys?: ByokKeyInput[] }>();

    const account = await db.select().from(accounts).where(eq(accounts.id, id)).get();
    if (!account || account.provider !== "byok") {
      return c.json({ error: "BYOK provider not found" }, 404);
    }

    const prefix = getByokPrefix(account);
    const allByok = await db.select().from(accounts).where(eq(accounts.provider, "byok"));
    const groupAccounts = allByok.filter((acc) => getByokPrefix(acc) === prefix);
    const templateTokens = parseByokTokens(account.tokens);

    // Within-batch normalization reuses the shared helper (rejects duplicate
    // labels and duplicate key values inside the submitted batch).
    let keyInputs: Array<{ label: string; key: string; weight?: number; priority?: number }>;
    try {
      keyInputs = normalizeByokKeys(body.api_keys, body.api_key);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    if (keyInputs.length === 0) {
      return c.json({ error: "At least one API key is required" }, 400);
    }

    // Index the existing group by label and by decrypted secret so duplicates can
    // be skipped and label conflicts detected without ever inserting a dupe.
    const existingByLabel = new Map<string, { id: number; secret: string }>();
    const existingBySecret = new Map<string, string>();
    for (const acc of groupAccounts) {
      const keyLabel = getByokKeyLabel(acc);
      let secret = "";
      try { secret = decrypt(acc.password); } catch { /* undecryptable row: match on label only */ }
      existingByLabel.set(keyLabel, { id: acc.id, secret });
      if (secret && !existingBySecret.has(secret)) existingBySecret.set(secret, keyLabel);
    }

    const results: Array<{ label: string; status: "added" | "duplicate"; id?: number }> = [];
    let added = 0;
    let skipped = 0;
    const maxPriority = groupAccounts.reduce((max, acc) => {
      const priority = Number(parseByokTokens(acc.tokens).priority);
      return Number.isFinite(priority) ? Math.max(max, priority) : max;
    }, -1);

    try {
      await db.transaction(async (tx) => {
        for (const [index, keyInput] of keyInputs.entries()) {
          const labelConflict = existingByLabel.get(keyInput.label);
          if (labelConflict && labelConflict.secret && labelConflict.secret !== keyInput.key) {
            throw new HttpError(409, `key label "${keyInput.label}" already exists with a different secret`);
          }

          const duplicateOf = labelConflict?.secret === keyInput.key
            ? keyInput.label
            : existingBySecret.get(keyInput.key);
          if (duplicateOf !== undefined) {
            results.push({ label: keyInput.label, status: "duplicate" });
            skipped += 1;
            continue;
          }

          const tokens: ByokTokensShape = {
            ...templateTokens,
            key_label: keyInput.label,
            weight: keyInput.weight,
            priority: Number.isFinite(Number(keyInput.priority)) ? Number(keyInput.priority) : maxPriority + index + 1,
          };
          const inserted = await tx.insert(accounts).values({
            provider: "byok",
            email: buildByokEmail(prefix, keyInput.label),
            password: encrypt(keyInput.key),
            status: "active",
            enabled: true,
            tokens,
            quotaLimit: -1,
            quotaRemaining: -1,
          }).returning();

          results.push({ label: keyInput.label, status: "added", id: inserted[0]?.id });
          existingBySecret.set(keyInput.key, keyInput.label);
          existingByLabel.set(keyInput.label, { id: inserted[0]?.id ?? -1, secret: keyInput.key });
          added += 1;
        }
      });
    } catch (error) {
      if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
      return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
    }

    if (added > 0) {
      await refreshByokRuntime();
      broadcast({ type: "byok_updated", data: { id, label: prefix } });
    }

    return c.json({ success: true, label: prefix, added, skipped, results });
  });

  /**
   * DELETE /api/accounts/byok/:id - Delete a BYOK provider group and all keys in it.
   */
  router.delete("/byok/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const account = await db.select().from(accounts).where(eq(accounts.id, id)).get();

    if (!account || account.provider !== "byok") {
      return c.json({ error: "BYOK provider not found" }, 404);
    }

    const prefix = getByokPrefix(account);
    const allByok = await db.select().from(accounts).where(eq(accounts.provider, "byok"));
    const groupAccounts = allByok.filter((acc) => getByokPrefix(acc) === prefix);
    const deletedIds: number[] = [];

    // One transaction for the whole group so a partial multi-delete cannot leave orphaned keys.
    await db.transaction(async (tx) => {
      for (const acc of groupAccounts) {
        await detachAccountDependents(tx, acc.id);
        const result = await tx.delete(accounts).where(eq(accounts.id, acc.id)).returning();
        if (result[0]) deletedIds.push(result[0].id);
      }
    });

    warmupQueue.cancelAccounts(deletedIds);
    loginQueue.cancelAccounts(deletedIds);

    await refreshByokRuntime();
    broadcast({ type: "byok_deleted", data: { id, label: prefix, deletedIds } });

    return c.json({ success: true, deleted: id, deletedIds, label: prefix });
  });

  /**
   * Helper: Auto-fix account if in error state after successful test
   */
  async function autoFixAccountIfError(accountId: number, accountStatus: string) {
    if (accountStatus === 'error') {
      await db.update(accounts)
        .set({
          status: 'active',
          errorMessage: null,
          updatedAt: new Date()
        })
        .where(eq(accounts.id, accountId));
      pool.invalidate('byok');
      const { refreshByokModels } = await import("../../proxy/providers/registry");
      await refreshByokModels();
      broadcast({
        type: 'account_status',
        data: { id: accountId, status: 'active' }
      });
      return true;
    }
    return false;
  }

  /**
   * POST /api/accounts/byok/:id/test - Test BYOK connection
   * Accepts optional { model?: string } body to test a specific model.
   * Returns latency_ms and auto_fixed status.
   */
  // Rate-limit BYOK /test: it burns real upstream credits/quota. 3 tests/min per account id.
  const byokTestLimiter = new RateLimiter(3, 3);

  router.post("/byok/:id/test", async (c) => {
    const id = Number(c.req.param("id"));
    const rlKey = `byok-test-${id}`;
    const rl = byokTestLimiter.check(rlKey);
    if (!rl.allowed) {
      return c.json({ error: "Too many test requests. Wait a minute and retry.", retryAfterMs: rl.retryAfterMs }, 429);
    }
    const reqBody = await c.req.json().catch(() => ({})) as { model?: string };

    const account = await db.select().from(accounts)
      .where(eq(accounts.id, id))
      .get();

    if (!account || account.provider !== "byok") {
      return c.json({ error: "BYOK provider not found" }, 404);
    }

    const tokens = typeof account.tokens === "string"
      ? JSON.parse(account.tokens)
      : account.tokens;

    if (!tokens?.base_url || !tokens?.models || tokens.models.length === 0) {
      return c.json({ success: false, error: "Invalid BYOK configuration" });
    }

    const apiKey = decrypt(account.password);
    const format = tokens.format || "auto";
    const testModel = reqBody.model || tokens.models[0];

    // Validate model if provided
    if (reqBody.model && !tokens.models.includes(reqBody.model)) {
      return c.json({
        success: false,
        error: `Model "${reqBody.model}" not found in provider configuration`
      }, 400);
    }

    // Determine endpoint based on format
    const isAnthropic = format === "anthropic" ||
      (format === "auto" && (tokens.base_url.includes("anthropic.com") || tokens.base_url.includes("/v1/messages")));

    const url = isAnthropic
      ? `${tokens.base_url}/messages`
      : `${tokens.base_url}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(tokens.headers || {}),
    };

    const body = isAnthropic
      ? {
          model: testModel,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 1,
        }
      : {
          model: testModel,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 1,
        };

    if (isAnthropic) {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    try {
      const startTime = Date.now();
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const latencyMs = Date.now() - startTime;

      if (response.status === 401 || response.status === 403) {
        return c.json({ success: false, error: "Authentication failed", latency_ms: latencyMs });
      }

      if (response.status === 429) {
        const autoFixed = await autoFixAccountIfError(id, account.status);
        return c.json({
          success: true,
          warning: "Rate limited but authentication works",
          latency_ms: latencyMs,
          auto_fixed: autoFixed
        });
      }

      if (!response.ok) {
        const text = await response.text();
        return c.json({ success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}`, latency_ms: latencyMs });
      }

      const autoFixed = await autoFixAccountIfError(id, account.status);
      return c.json({
        success: true,
        message: "Connection test passed",
        model: testModel,
        format: isAnthropic ? "anthropic" : "openai",
        latency_ms: latencyMs,
        auto_fixed: autoFixed
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : "Network error",
      });
    }
  });

  /**
   * POST /api/accounts/byok/fetch-models — Fetch models from an upstream provider without saving.
   * Accepts { base_url, api_key, format? }. Uses the URL as-is — just appends /models.
   * For Anthropic format, hits /models. For OpenAI-compatible, appends /models to the user's URL.
   */
  router.post("/byok/fetch-models", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      base_url?: string;
      api_key?: string;
      format?: "openai" | "anthropic" | "auto";
    };

    const baseUrl = String(body.base_url || "").trim().replace(/\/+$/, "");
    const apiKey = String(body.api_key || "").trim();
    const format = body.format || "auto";

    if (!baseUrl) return c.json({ error: "base_url is required" }, 400);
    if (!apiKey) return c.json({ error: "api_key is required" }, 400);

    const isAnthropic = format === "anthropic" ||
      (format === "auto" && (baseUrl.includes("anthropic.com") || baseUrl.includes("/v1/messages")));

    // Use the user's URL as-is — just append /models. Works for /v1, /v2, /api etc.
    const url = `${baseUrl}/models`;

    const headers: Record<string, string> = {};
    if (isAnthropic) {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    try {
      const response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return c.json({ error: `HTTP ${response.status}: ${text.slice(0, 300)}` }, 400);
      }

      const data = await response.json() as Record<string, unknown>;

      let modelIds: string[] = [];
      if (Array.isArray(data.data)) {
        modelIds = data.data.map((m: any) => m.id || m.name || String(m)).filter(Boolean);
      } else if (Array.isArray(data.models)) {
        modelIds = data.models.map((m: any) => m.id || m.name || String(m)).filter(Boolean);
      } else if (data.id) {
        modelIds = [data.id as string];
      }

      if (modelIds.length === 0) {
        return c.json({ models: [], warning: "No models found in upstream response" });
      }

      return c.json({ models: modelIds, total: modelIds.length });
    } catch (error: any) {
      return c.json({ error: error?.message || "Network error" }, 400);
    }
  });

  /**
   * POST /api/accounts/byok/:id/fetch-models - Fetch available models from upstream provider.
   * Uses the user's URL as-is — just appends /models. Works for /v1, /v2, /api etc.
   * Accepts optional { password?: string } body to pass a key for this one-off fetch.
   */
  router.post("/byok/:id/fetch-models", async (c) => {
    const id = Number(c.req.param("id"));
    const reqBody = await c.req.json().catch(() => ({})) as { password?: string };

    const account = await db.select().from(accounts)
      .where(eq(accounts.id, id))
      .get();

    if (!account || account.provider !== "byok") {
      return c.json({ error: "BYOK provider not found" }, 404);
    }

    const tokens = typeof account.tokens === "string"
      ? JSON.parse(account.tokens)
      : account.tokens;

    if (!tokens?.base_url) {
      return c.json({ error: "No base URL configured" }, 400);
    }

    const baseUrl = String(tokens.base_url).trim().replace(/\/+$/, "");
    const apiKey = reqBody.password ? reqBody.password : decrypt(account.password);
    const format = tokens.format || "auto";
    const isAnthropic = format === "anthropic" ||
      (format === "auto" && (baseUrl.includes("anthropic.com") || baseUrl.includes("/v1/messages")));

    // Use the user's URL as-is — just append /models. Works for /v1, /v2, /api etc.
    const url = `${baseUrl}/models`;

    const headers: Record<string, string> = { ...(tokens.headers || {}) };
    if (isAnthropic) {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    try {
      const response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        const text = await response.text();
        return c.json({ error: `HTTP ${response.status}: ${text.slice(0, 300)}` }, 400);
      }

      const data = await response.json() as Record<string, unknown>;

      // OpenAI-compatible: { object:"list", data: [{ id: "model-id", ... }] }
      // Anthropic: { data: [{ id: "model-id", ... }] }
      // Olama/Ollama: { models: [{ name: "model-id", ... }] }
      let modelIds: string[] = [];

      if (Array.isArray(data.data)) {
        modelIds = data.data.map((m: any) => m.id || m.name || String(m)).filter(Boolean);
      } else if (Array.isArray(data.models)) {
        modelIds = data.models.map((m: any) => m.id || m.name || String(m)).filter(Boolean);
      } else if (data.id) {
        modelIds = [data.id as string];
      }

      if (modelIds.length === 0) {
        return c.json({ models: [], warning: "No models found in upstream response" });
      }

      return c.json({ models: modelIds, total: modelIds.length });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Network error" }, 400);
    }
  });

  /**
   * ============================================================================
   * Alibaba DashScope Management Endpoints
   * NOTE: Must be defined BEFORE /:id routes to avoid route collision.
   * ============================================================================
   */

  /**
   * POST /api/accounts/alibaba - Create Alibaba DashScope accounts from API keys.
   *
   * Body: { api_keys: string } — newline-separated list of sk-... keys.
   * Creates one account per key with auto-generated label.
   */
}
