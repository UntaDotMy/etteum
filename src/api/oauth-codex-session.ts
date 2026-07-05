import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

type CodexOAuthStatus = "pending" | "waiting_callback" | "exchanging" | "done" | "error" | "cancelled";

export interface CodexOAuthSession {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  appPort?: string;
  status: CodexOAuthStatus;
  createdAt: number;
  updatedAt: number;
  consumedAt?: number;
  connection?: {
    id: number;
    provider: string;
    email: string;
    displayName: string;
    workspace?: string | null;
    plan?: string | null;
  };
  error?: string;
}

const SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * Sessions are kept in memory for fast access AND mirrored to a JSON file so
 * they survive process restarts (e.g. an update-triggered restart mid-OAuth).
 * The file is written-through on every mutation and reloaded lazily on first
 * access after a (re)start.
 */
const sessions = new Map<string, CodexOAuthSession>();
let _sessionFile: string | null = null;
function sessionFile(): string {
  if (_sessionFile) return _sessionFile;
  _sessionFile =
    process.env.POOLPROX_OAUTH_SESSION_FILE ||
    path.join(process.cwd(), "data", "codex-oauth-sessions.json");
  return _sessionFile;
}

let loaded = false;

function now() {
  return Date.now();
}

function loadFromDisk() {
  if (loaded) return;
  loaded = true;
  try {
    if (existsSync(sessionFile())) {
      const raw = readFileSync(sessionFile(), "utf8");
      const arr = JSON.parse(raw) as CodexOAuthSession[];
      const cutoff = now() - SESSION_TTL_MS;
      for (const s of arr) {
        if (s.updatedAt >= cutoff && s.createdAt >= cutoff) {
          sessions.set(s.state, s);
        }
      }
    }
  } catch {
    // Corrupt or missing file — start fresh.
  }
}

function flushToDisk() {
  try {
    const dir = path.dirname(sessionFile());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const arr = Array.from(sessions.values());
    writeFileSync(sessionFile(), JSON.stringify(arr), "utf8");
  } catch (e) {
    console.error("[OAuth] Failed to persist sessions:", e instanceof Error ? e.message : e);
  }
}

function pruneExpiredSessions() {
  const cutoff = now() - SESSION_TTL_MS;
  let changed = false;
  for (const [state, session] of sessions) {
    if (session.updatedAt < cutoff || session.createdAt < cutoff) {
      sessions.delete(state);
      changed = true;
    }
  }
  if (changed) flushToDisk();
}

export function createCodexOAuthSession(input: {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  appPort?: string;
}) {
  loadFromDisk();
  pruneExpiredSessions();
  const ts = now();
  const session: CodexOAuthSession = {
    state: input.state,
    codeVerifier: input.codeVerifier,
    redirectUri: input.redirectUri,
    appPort: input.appPort,
    status: "pending",
    createdAt: ts,
    updatedAt: ts,
  };
  sessions.set(input.state, session);
  flushToDisk();
  return session;
}

export function getCodexOAuthSession(state: string) {
  loadFromDisk();
  pruneExpiredSessions();
  return sessions.get(state) || null;
}

export function updateCodexOAuthSession(state: string, patch: Partial<CodexOAuthSession>) {
  loadFromDisk();
  const current = getCodexOAuthSession(state);
  if (!current) return null;
  const next: CodexOAuthSession = {
    ...current,
    ...patch,
    updatedAt: now(),
  };
  sessions.set(state, next);
  flushToDisk();
  return next;
}

export function consumeCodexOAuthSession(state: string) {
  loadFromDisk();
  const session = getCodexOAuthSession(state);
  if (!session) return null;
  const consumedAt = now();
  if (["done", "error", "cancelled"].includes(session.status)) {
    sessions.delete(state);
    flushToDisk();
    return { ...session, consumedAt };
  }
  return { ...session, consumedAt };
}

export function deleteCodexOAuthSession(state: string) {
  loadFromDisk();
  const deleted = sessions.delete(state);
  if (deleted) flushToDisk();
  return deleted;
}