process.env.ENCRYPTION_KEY =
  "encrypted-column-test-key-9f8e7d6c5b4a3210";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { encryptedJson, encryptedText } from "../../src/db/encrypted-columns";
import { migrateSensitiveColumnEncryption } from "../../src/db/sensitive-migration";
import { decrypt, isGcm } from "../../src/utils/crypto";

const TEST_KEY = "encrypted-column-test-key-9f8e7d6c5b4a3210";
const secrets = sqliteTable("secrets", {
  id: text("id").primaryKey(),
  jsonValue: encryptedJson("json_value").notNull(),
  textValue: encryptedText("text_value").notNull(),
});

const sqlite = new Database(":memory:");
sqlite.exec(`
  CREATE TABLE secrets (
    id TEXT PRIMARY KEY NOT NULL,
    json_value TEXT NOT NULL,
    text_value TEXT NOT NULL
  )
`);
const db = drizzle(sqlite, { schema: { secrets } });

beforeEach(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
  sqlite.run("DELETE FROM secrets");
});

afterAll(() => sqlite.close());

describe("encrypted ORM columns", () => {
  test("store ciphertext while preserving JSON and text values for callers", async () => {
    const token = { access_token: "oauth-secret", refresh_token: "refresh-secret" };
    await db.insert(secrets).values({ id: "current", jsonValue: token, textValue: "kv-secret" });

    const raw = sqlite
      .query("SELECT json_value, text_value FROM secrets WHERE id = 'current'")
      .get() as { json_value: string; text_value: string };
    expect(isGcm(raw.json_value)).toBe(true);
    expect(isGcm(raw.text_value)).toBe(true);
    expect(raw.json_value).not.toContain("oauth-secret");
    expect(raw.text_value).not.toContain("kv-secret");

    const [row] = await db.select().from(secrets);
    expect(row?.jsonValue).toEqual(token);
    expect(row?.textValue).toBe("kv-secret");
  });

  test("reads legacy plaintext rows until the startup migration upgrades them", async () => {
    sqlite.run(
      "INSERT INTO secrets (id, json_value, text_value) VALUES (?, ?, ?)",
      ["legacy", JSON.stringify({ session: "legacy-secret" }), "legacy-kv"],
    );
    const rows = await db.select().from(secrets);
    const legacy = rows.find((row) => row.id === "legacy");
    expect(legacy?.jsonValue).toEqual({ session: "legacy-secret" });
    expect(legacy?.textValue).toBe("legacy-kv");
  });
});

describe("sensitive-column startup migration", () => {
  test("encrypts legacy account, provider-node, and KV values idempotently", () => {
    const migrationDb = new Database(":memory:");
    try {
      migrationDb.exec(`
        CREATE TABLE accounts (id INTEGER PRIMARY KEY, tokens TEXT);
        CREATE TABLE provider_nodes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL);
        INSERT INTO accounts (id, tokens) VALUES (1, '{"access_token":"account-secret"}');
        INSERT INTO provider_nodes (id, data) VALUES ('node', '{"apiKey":"node-secret"}');
        INSERT INTO kv (scope, key, value) VALUES ('searchApiKeys', 'exa', '{"apiKey":"kv-secret"}');
      `);

      expect(migrateSensitiveColumnEncryption(migrationDb)).toBe(3);
      expect(migrateSensitiveColumnEncryption(migrationDb)).toBe(0);

      for (const [table, column] of [
        ["accounts", "tokens"],
        ["provider_nodes", "data"],
        ["kv", "value"],
      ] as const) {
        const row = migrationDb.query(`SELECT ${column} AS value FROM ${table} LIMIT 1`).get() as { value: string };
        expect(isGcm(row.value)).toBe(true);
        expect(decrypt(row.value)).toContain("secret");
      }
    } finally {
      migrationDb.close();
    }
  });
});
