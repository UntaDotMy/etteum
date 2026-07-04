import { fetchApi } from "./api";

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

/**
 * Open an SSE connection to the session's frame stream. Returns a cleanup function.
 */
export function connectFrameStream(sessionId: string, onFrame: (base64: string, format: string) => void, onDone?: () => void): () => void {
  const es = new EventSource(`/api/browser-session/${sessionId}/frames`);
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.base64) onFrame(data.base64, data.format || "jpeg");
      if (data.connected) return;
    } catch {}
  };
  es.onerror = () => {
    es.close();
    onDone?.();
  };
  return () => es.close();
}
