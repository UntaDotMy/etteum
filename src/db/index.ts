import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "./schema";
import { config } from "../config";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

mkdirSync(dirname(config.databasePath), { recursive: true });

const sqlite = new Database(config.databasePath, { create: true });

// Performance pragmas: WAL for concurrent reads, memory temp store, large cache,
// normal sync (safe but faster than full), and memory-mapped I/O. These are
// safe to set every startup — SQLite treats idempotent pragmas as no-ops when
// already in the requested state.
sqlite.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -64000;
  PRAGMA mmap_size = 268435456;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

export const db = drizzle(sqlite, { schema });
export { sqlite as client };
export type DB = typeof db;
