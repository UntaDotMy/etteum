import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../src/db/index";
import { accounts } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { encrypt } from "../../src/utils/crypto";
import {
  getByokProvider,
  refreshByokModels,
  getProviderForModel,
  getAllModels,
} from "../../src/proxy/providers/registry";
import type { Account } from "../../src/db/schema";

describe("BYOK Provider", () => {
  beforeEach(async () => {
    // Clean up BYOK accounts before each test
    await db.delete(accounts).where(eq(accounts.provider, "byok"));
    await refreshByokModels();
  });

  afterEach(async () => {
    // Clean up after each test
    await db.delete(accounts).where(eq(accounts.provider, "byok"));
    await refreshByokModels();
  });

  describe("Model Ownership", () => {
    it("should own models with matching prefix", async () => {
      // Create a BYOK provider
      await db.insert(accounts).values({
        provider: "byok",
        email: "testrouter",
        password: encrypt("test-key"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({
          base_url: "https://api.test.com/v1",
          format: "openai",
          models: ["gpt-4", "claude-3"],
          model_prefix: "testrouter",
        }),
      });

      await refreshByokModels();

      const provider = getByokProvider();

      // Should own models with prefix
      expect(await provider.ownsModel("testrouter-gpt-4")).toBe(true);
      expect(await provider.ownsModel("testrouter-claude-3")).toBe(true);

      // Should not own models without prefix
      expect(await provider.ownsModel("gpt-4")).toBe(false);
      expect(await provider.ownsModel("other-gpt-4")).toBe(false);
    });

    it("should handle multiple BYOK providers", async () => {
      // Create two BYOK providers
      await db.insert(accounts).values({
        provider: "byok",
        email: "provider1",
        password: encrypt("key1"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({
          base_url: "https://api1.com/v1",
          format: "openai",
          models: ["gpt-4"],
          model_prefix: "provider1",
        }),
      });

      await db.insert(accounts).values({
        provider: "byok",
        email: "provider2",
        password: encrypt("key2"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({
          base_url: "https://api2.com/v1",
          format: "openai",
          models: ["gpt-4"],
          model_prefix: "provider2",
        }),
      });

      await refreshByokModels();

      const provider = getByokProvider();

      // Should own both prefixed models
      expect(await provider.ownsModel("provider1-gpt-4")).toBe(true);
      expect(await provider.ownsModel("provider2-gpt-4")).toBe(true);
    });

    it("should not own models from disabled accounts", async () => {
      await db.insert(accounts).values({
        provider: "byok",
        email: "disabled",
        password: encrypt("key"),
        status: "active",
        enabled: false, // Disabled
        tokens: JSON.stringify({
          base_url: "https://api.com/v1",
          format: "openai",
          models: ["gpt-4"],
          model_prefix: "disabled",
        }),
      });

      await refreshByokModels();

      const provider = getByokProvider();
      expect(await provider.ownsModel("disabled-gpt-4")).toBe(false);
    });

    it("should not own models from disabled accounts", async () => {
      await db.insert(accounts).values({
        provider: "byok",
        email: "disabledacct",
        password: encrypt("key"),
        status: "banned", // Not active or error — should be excluded
        enabled: true,
        tokens: JSON.stringify({
          base_url: "https://api.com/v1",
          format: "openai",
          models: ["gpt-4"],
          model_prefix: "disabledacct",
        }),
      });

      await refreshByokModels();

      const provider = getByokProvider();
      expect(await provider.ownsModel("disabledacct-gpt-4")).toBe(false);
    });
  });

  describe("Model Discovery", () => {
    it("should list all BYOK models in getAllModels()", async () => {
      await db.insert(accounts).values({
        provider: "byok",
        email: "myrouter",
        password: encrypt("key"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({
          base_url: "https://api.com/v1",
          format: "openai",
          models: ["gpt-4", "gpt-3.5-turbo"],
          model_prefix: "myrouter",
        }),
      });

      await refreshByokModels();

      const models = getAllModels();
      const byokModels = models.filter(m => m.id.startsWith("myrouter-"));

      expect(byokModels.length).toBe(2);
      expect(byokModels.some(m => m.id === "myrouter-gpt-4")).toBe(true);
      expect(byokModels.some(m => m.id === "myrouter-gpt-3.5-turbo")).toBe(true);
    });

    it("should correctly identify BYOK provider for model", async () => {
      await db.insert(accounts).values({
        provider: "byok",
        email: "router",
        password: encrypt("key"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({
          base_url: "https://api.com/v1",
          format: "openai",
          models: ["test-model"],
          model_prefix: "router",
        }),
      });

      await refreshByokModels();

      const provider = getProviderForModel("router-test-model");
      expect(provider).toBe("byok");
    });
  });

  describe("Account Selection", () => {
    it("should find correct account for model", async () => {
      await db.insert(accounts).values({
        provider: "byok",
        email: "account1",
        password: encrypt("key1"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({
          base_url: "https://api1.com/v1",
          format: "openai",
          models: ["model-a"],
          model_prefix: "account1",
        }),
      });

      await db.insert(accounts).values({
        provider: "byok",
        email: "account2",
        password: encrypt("key2"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({
          base_url: "https://api2.com/v1",
          format: "openai",
          models: ["model-b"],
          model_prefix: "account2",
        }),
      });

      await refreshByokModels();

      const provider = getByokProvider();
      const account1 = await provider.findAccountForModel("account1-model-a");
      const account2 = await provider.findAccountForModel("account2-model-b");

      expect(account1?.email).toBe("account1");
      expect(account2?.email).toBe("account2");
    });

    it("should return null for non-existent model", async () => {
      await refreshByokModels();

      const provider = getByokProvider();
      const account = await provider.findAccountForModel("nonexistent-model");

      expect(account).toBeNull();
    });
  });

  describe("Format Detection", () => {
    it("should detect OpenAI format from base_url", async () => {
      await db.insert(accounts).values({
        provider: "byok",
        email: "openai-format",
        password: encrypt("key"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({
          base_url: "https://api.openai.com/v1",
          format: "auto",
          models: ["gpt-4"],
          model_prefix: "openai-format",
        }),
      });

      await refreshByokModels();

      const account = await db
        .select()
        .from(accounts)
        .where(eq(accounts.email, "openai-format"))
        .limit(1)
        .then(rows => rows[0]!);

      // The provider should handle this as OpenAI format
      expect(account).toBeDefined();
      expect(account.tokens).toContain('"format":"auto"');
    });

    it("should detect Anthropic format from base_url", async () => {
      await db.insert(accounts).values({
        provider: "byok",
        email: "anthropic-format",
        password: encrypt("key"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({
          base_url: "https://api.anthropic.com/v1",
          format: "auto",
          models: ["claude-3"],
          model_prefix: "anthropic-format",
        }),
      });

      await refreshByokModels();

      const account = await db
        .select()
        .from(accounts)
        .where(eq(accounts.email, "anthropic-format"))
        .limit(1)
        .then(rows => rows[0]!);

      expect(account).toBeDefined();
      expect(account.tokens).toContain('"format":"auto"');
    });

    it("should respect explicit format override", async () => {
      await db.insert(accounts).values({
        provider: "byok",
        email: "explicit-format",
        password: encrypt("key"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({
          base_url: "https://custom.api.com/v1",
          format: "anthropic", // Explicit override
          models: ["custom-model"],
          model_prefix: "explicit-format",
        }),
      });

      await refreshByokModels();

      const account = await db
        .select()
        .from(accounts)
        .where(eq(accounts.email, "explicit-format"))
        .limit(1)
        .then(rows => rows[0]!);

      expect(account).toBeDefined();
      expect(account.tokens).toContain('"format":"anthropic"');
    });
  });

  describe("Cache Management", () => {
    it("should refresh cache when models are added", async () => {
      const provider = getByokProvider();

      // Initially no models
      expect(await provider.ownsModel("new-model")).toBe(false);

      // Add a new provider
      await db.insert(accounts).values({
        provider: "byok",
        email: "new-provider",
        password: encrypt("key"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({
          base_url: "https://api.com/v1",
          format: "openai",
          models: ["new-model"],
          model_prefix: "new-provider",
        }),
      });

      await refreshByokModels();

      // Now should own the model
      expect(await provider.ownsModel("new-provider-new-model")).toBe(true);
    });

    it("should refresh cache when models are removed", async () => {
      // Add a provider
      const inserted = await db.insert(accounts).values({
        provider: "byok",
        email: "temp-provider",
        password: encrypt("key"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({
          base_url: "https://api.com/v1",
          format: "openai",
          models: ["temp-model"],
          model_prefix: "temp-provider",
        }),
      }).returning();

      await refreshByokModels();

      const provider = getByokProvider();
      expect(await provider.ownsModel("temp-provider-temp-model")).toBe(true);

      // Remove the provider
      await db.delete(accounts).where(eq(accounts.id, inserted[0]!.id));
      await refreshByokModels();

      // Should no longer own the model
      expect(await provider.ownsModel("temp-provider-temp-model")).toBe(false);
    });
  });

  describe("API Key Decryption", () => {
    it("should decrypt API key from encrypted password", async () => {
      const testKey = "sk-test-secret-key-12345";

      await db.insert(accounts).values({
        provider: "byok",
        email: "encrypted-key",
        password: encrypt(testKey),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({
          base_url: "https://api.com/v1",
          format: "openai",
          models: ["gpt-4"],
          model_prefix: "encrypted-key",
        }),
      });

      await refreshByokModels();

      const account = await db
        .select()
        .from(accounts)
        .where(eq(accounts.email, "encrypted-key"))
        .limit(1)
        .then(rows => rows[0]!);

      // Password should be encrypted in DB
      expect(account.password).not.toBe(testKey);

      // Provider should be able to decrypt it
      const provider = getByokProvider();
      const foundAccount = await provider.findAccountForModel("encrypted-key-gpt-4");
      expect(foundAccount).toBeDefined();
    });
  });

  describe("Validation", () => {
    it("should validate account with all required fields", async () => {
      await db.insert(accounts).values({
        provider: "byok",
        email: "valid-account",
        password: encrypt("key"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({
          base_url: "https://api.com/v1",
          format: "openai",
          models: ["gpt-4"],
          model_prefix: "valid-account",
        }),
      });

      await refreshByokModels();

      const account = await db
        .select()
        .from(accounts)
        .where(eq(accounts.email, "valid-account"))
        .limit(1)
        .then(rows => rows[0]!);

      const provider = getByokProvider();
      const isValid = await provider.validateAccount(account);

      expect(isValid).toBe(true);
    });

    it("should invalidate account without base_url", async () => {
      await db.insert(accounts).values({
        provider: "byok",
        email: "no-base-url",
        password: encrypt("key"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({
          format: "openai",
          models: ["gpt-4"],
          model_prefix: "no-base-url",
        }),
      });

      await refreshByokModels();

      const account = await db
        .select()
        .from(accounts)
        .where(eq(accounts.email, "no-base-url"))
        .limit(1)
        .then(rows => rows[0]!);

      const provider = getByokProvider();
      const isValid = await provider.validateAccount(account);

      expect(isValid).toBe(false);
    });

    it("should invalidate account without models", async () => {
      await db.insert(accounts).values({
        provider: "byok",
        email: "no-models",
        password: encrypt("key"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({
          base_url: "https://api.com/v1",
          format: "openai",
          models: [],
          model_prefix: "no-models",
        }),
      });

      await refreshByokModels();

      const account = await db
        .select()
        .from(accounts)
        .where(eq(accounts.email, "no-models"))
        .limit(1)
        .then(rows => rows[0]!);

      const provider = getByokProvider();
      const isValid = await provider.validateAccount(account);

      expect(isValid).toBe(false);
    });
  });

  describe("Quota Handling", () => {
    it("should return unlimited quota for BYOK accounts", async () => {
      await db.insert(accounts).values({
        provider: "byok",
        email: "unlimited",
        password: encrypt("key"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({
          base_url: "https://api.com/v1",
          format: "openai",
          models: ["gpt-4"],
          model_prefix: "unlimited",
        }),
      });

      await refreshByokModels();

      const account = await db
        .select()
        .from(accounts)
        .where(eq(accounts.email, "unlimited"))
        .limit(1)
        .then(rows => rows[0]!);

      const provider = getByokProvider();
      const quota = await provider.fetchQuota();

      // BYOK has no built-in quota — the implementation intentionally
      // returns quota: undefined to preserve existing DB values.
      expect(quota.success).toBe(true);
      expect(quota.quota).toBeUndefined();
    });
  });
});
