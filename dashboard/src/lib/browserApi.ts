import { fetchApi } from "./api";

export interface BrowserSessionStep {
  ts: number;
  step: string;
  message: string;
  provider: string;
}

export interface BrowserSessionInfo {
  sessionId: string;
  accountId: number;
  email: string;
  provider: string;
  phase: string;
  lastMessage: string;
  terminal: boolean;
  hasChallenge: boolean;
  startedAt: number;
  steps?: BrowserSessionStep[];
}

export async function fetchBrowserSessions(): Promise<BrowserSessionInfo[]> {
  const res = await fetchApi<{ sessions: BrowserSessionInfo[] }>("/api/browser-sessions");
  return res.sessions || [];
}

export async function sendBrowserInput(sessionId: string, input: { type: "pointer"; x: number; y: number; action: string } | { type: "key"; text: string; code: string; action: string }): Promise<boolean> {
  const res = await fetchApi<{ success: boolean }>(`/api/browser-session/${sessionId}/input`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return res.success;
}

export async function sendCaptchaAnswer(sessionId: string, answer: string): Promise<boolean> {
  const res = await fetchApi<{ success: boolean }>(`/api/browser-session/${sessionId}/captcha`, {
    method: "POST",
    body: JSON.stringify({ answer }),
  });
  return res.success;
}

export async function cancelBrowserSession(sessionId: string): Promise<boolean> {
  const res = await fetchApi<{ success: boolean }>(`/api/browser-session/${sessionId}/cancel`, {
    method: "POST",
  });
  return res.success;
}

/** Remove finished (terminal) session cards from Browser Logs. */
export async function clearEndedBrowserSessions(): Promise<{ cleared: number }> {
  return fetchApi<{ success: boolean; cleared: number }>("/api/browser-sessions/clear-ended", {
    method: "POST",
  });
}

/** Cancel all live browser sessions and stop a running Grok farm job. */
export async function stopAllBrowserSessions(): Promise<{ cancelled: number; farmCancelled?: boolean }> {
  return fetchApi<{ success: boolean; cancelled: number; farmCancelled?: boolean }>(
    "/api/browser-sessions/stop-all",
    { method: "POST" },
  );
}

/**
 * Open an SSE connection to the session's frame stream. Auto-reconnects on
 * transient errors (long batch sessions outlive a single connection). Returns
 * a cleanup function. Matches the ennowxai frame contract: the server sends
 * {base64, format} with RAW base64; onFrame receives that raw base64.
 */
export function connectFrameStream(sessionId: string, onFrame: (base64: string, format: string) => void, onDone?: () => void): () => void {
  const apiKey = localStorage.getItem("api_key") || "pool-proxy-secret-key";
  let es: EventSource | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed) return;
    es = new EventSource(`/api/browser-session/${sessionId}/frames?api_key=${encodeURIComponent(apiKey)}`);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.base64) onFrame(data.base64, data.format || "jpeg");
      } catch {}
    };
    es.onerror = () => {
      // EventSource auto-reconnects natively, but Hono's ReadableStream closes
      // on terminal sessions. Close this one and retry once after a short
      // backoff; if the session is truly gone, the retry will 404 and we stop.
      es?.close();
      es = null;
      if (closed) return;
      reconnectTimer = setTimeout(open, 1500);
    };
  };
  open();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    es?.close();
    es = null;
    onDone?.();
  };
}
