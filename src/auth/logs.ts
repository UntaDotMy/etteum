import { existsSync, appendFileSync, readFileSync, truncateSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "../config";

export interface AuthLogEntry {
  id: number;
  timestamp: string;
  type: string;
  accountId?: number;
  email?: string;
  provider?: string;
  step?: string;
  message?: string;
  error?: string;
  data?: unknown;
}

const MAX_LOGS = 500;
let nextId = 1;
const logs = new Array<AuthLogEntry | undefined>(MAX_LOGS);
let start = 0;
let count = 0;

// --- Disk persistence (survives restart) ---
// Auth/warmup/refresh logs were previously in-memory only and lost on restart.
// Now we persist to a JSONL file in the data dir: append each new entry, and
// seed the in-memory ring buffer from the file's tail on first load. The file
// is capped at ~2× MAX_LOGS lines to bound growth (truncated on load).
const LOG_DIR = config.databasePath ? path.dirname(config.databasePath) : "./data";
const LOG_FILE = path.join(LOG_DIR, "auth-logs.jsonl");
const MAX_FILE_LINES = MAX_LOGS * 2;

/** Load the tail of the persisted log into the ring buffer (once, at import). */
function loadFromDisk(): void {
  try {
    if (!existsSync(LOG_FILE)) return;
    const text = readFileSync(LOG_FILE, "utf8");
    const lines = text.split("\n").filter(Boolean);
    if (lines.length === 0) return;
    // Truncate the file if it has grown past the cap (keeps it bounded).
    if (lines.length > MAX_FILE_LINES) {
      const keep = lines.slice(-MAX_FILE_LINES);
      truncateSync(LOG_FILE, 0);
      appendFileSync(LOG_FILE, keep.join("\n") + "\n", "utf8");
    }
    // Seed the ring buffer from the most recent MAX_LOGS entries.
    const seed = lines.slice(-MAX_LOGS);
    for (const line of seed) {
      try {
        const entry = JSON.parse(line) as AuthLogEntry;
        const writeIndex = (start + count) % MAX_LOGS;
        logs[writeIndex] = entry;
        if (count < MAX_LOGS) count += 1;
        else start = (start + 1) % MAX_LOGS;
        if (entry.id >= nextId) nextId = entry.id + 1;
      } catch { /* skip malformed line */ }
    }
  } catch { /* best effort — fall back to empty buffer */ }
}

let dirEnsured = false;
function appendToDisk(entry: AuthLogEntry): void {
  try {
    if (!dirEnsured) { mkdirSync(LOG_DIR, { recursive: true }); dirEnsured = true; }
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch { /* best effort — in-memory buffer still has the entry */ }
}

// Load persisted logs at module import (once).
loadFromDisk();

export function addAuthLog(entry: Omit<AuthLogEntry, "id" | "timestamp">): AuthLogEntry {
  const log: AuthLogEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    ...entry,
  };

  const writeIndex = (start + count) % MAX_LOGS;
  logs[writeIndex] = log;

  if (count < MAX_LOGS) {
    count += 1;
  } else {
    start = (start + 1) % MAX_LOGS;
  }

  // Persist (best-effort, sync — append-only is cheap; entries are infrequent
  // outside of an active login/warmup burst).
  appendToDisk(log);

  return log;
}

export function getAuthLogs(limit = 100): AuthLogEntry[] {
  const boundedLimit = Math.max(0, Math.min(limit, count));
  const result: AuthLogEntry[] = [];

  for (let i = 0; i < boundedLimit; i++) {
    const index = (start + count - 1 - i) % MAX_LOGS;
    const log = logs[index];
    if (log) result.push(log);
  }

  return result;
}

export function clearAuthLogs(): void {
  logs.fill(undefined);
  start = 0;
  count = 0;
  try { if (existsSync(LOG_FILE)) truncateSync(LOG_FILE, 0); } catch { /* best effort */ }
}
