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
const sessions = new Map<string, CodexOAuthSession>();

function now() {
  return Date.now();
}

function pruneExpiredSessions() {
  const cutoff = now() - SESSION_TTL_MS;
  for (const [state, session] of sessions) {
    if (session.updatedAt < cutoff || session.createdAt < cutoff) {
      sessions.delete(state);
    }
  }
}

export function createCodexOAuthSession(input: {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  appPort?: string;
}) {
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
  return session;
}

export function getCodexOAuthSession(state: string) {
  pruneExpiredSessions();
  return sessions.get(state) || null;
}

export function updateCodexOAuthSession(state: string, patch: Partial<CodexOAuthSession>) {
  const current = getCodexOAuthSession(state);
  if (!current) return null;
  const next: CodexOAuthSession = {
    ...current,
    ...patch,
    updatedAt: now(),
  };
  sessions.set(state, next);
  return next;
}

export function consumeCodexOAuthSession(state: string) {
  const session = getCodexOAuthSession(state);
  if (!session) return null;
  const consumedAt = now();
  if (["done", "error", "cancelled"].includes(session.status)) {
    sessions.delete(state);
    return { ...session, consumedAt };
  }
  return { ...session, consumedAt };
}

export function deleteCodexOAuthSession(state: string) {
  return sessions.delete(state);
}
