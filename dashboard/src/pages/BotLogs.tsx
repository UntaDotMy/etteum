import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BrowserSessionCard } from "@/components/auth/BrowserSessionCard";
import { fetchBrowserSessions, BrowserSessionInfo } from "@/lib/browserApi";
import { useWsEvent } from "@/hooks/useWebSocket";
import { ExternalLink, Radio, Monitor } from "lucide-react";

interface Challenge {
  image_base64: string;
  image_format: string;
  prompt: string;
  seq: number;
}

export default function BotLogs() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<BrowserSessionInfo[]>([]);
  const [challenges, setChallenges] = useState<Record<string, Challenge>>({});
  const [loading, setLoading] = useState(true);
  // Camoufox adapter live event log — the automation browser log stream.
  const [events, setEvents] = useState<Array<{ ts: number; provider: string; step: string; message: string; level: string }>>([]);

  // Poll the session list every 2s.
  const load = useCallback(async () => {
    try {
      const s = await fetchBrowserSessions();
      setSessions(s);
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 2000);
    return () => clearInterval(interval);
  }, [load]);

  // Capture the adapter emit stream (login_progress / login_failed /
  // login_success / manual_challenge) into a live event log so the browser log
  // is populated even without frame-preview sessions.
  useWsEvent("login_progress", (data: unknown) => {
    const e = data as any;
    if (!e) return;
    setEvents((prev) => [...prev.slice(-499), { ts: Date.now(), provider: e.provider || "", step: e.step || "", message: e.message || "", level: "info" }]);
  });
  useWsEvent("login_failed", (data: unknown) => {
    const e = data as any;
    if (!e) return;
    setEvents((prev) => [...prev.slice(-499), { ts: Date.now(), provider: e.provider || "", step: "failed", message: e.error || "login failed", level: "error" }]);
  });
  useWsEvent("login_success", (data: unknown) => {
    const e = data as any;
    if (!e) return;
    setEvents((prev) => [...prev.slice(-499), { ts: Date.now(), provider: e.provider || "", step: "success", message: "login succeeded", level: "success" }]);
  });

  // Listen for phase changes via WS to update session state immediately.
  useWsEvent("login_progress", (data: unknown) => {
    const e = data as any;
    if (e?.step === "phase") {
      setSessions((prev) => prev.map((s) => {
        if (s.email === e.email) return { ...s, phase: e.phase, lastMessage: e.message };
        return s;
      }));
    }
    if (e?.step === "manual_challenge") {
      const sid = sessions.find((s) => s.email === e.email)?.sessionId;
      if (sid) {
        setChallenges((prev) => ({
          ...prev,
          [sid]: {
            image_base64: e.challenge_image_base64 || "",
            image_format: e.challenge_image_format || "jpeg",
            prompt: e.prompt || "Type the characters",
            seq: e.challenge_seq || 1,
          },
        }));
      }
    }
  });

  // Clear challenge when session becomes terminal.
  useEffect(() => {
    for (const s of sessions) {
      if (s.terminal && challenges[s.sessionId]) {
        setChallenges((prev) => {
          const next = { ...prev };
          delete next[s.sessionId];
          return next;
        });
      }
    }
  }, [sessions, challenges]);

  const activeSessions = sessions.filter((s) => !s.terminal);
  const doneSessions = sessions.filter((s) => s.terminal);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-[var(--foreground)]">Browser Logs</h1>
          {activeSessions.length > 0 && (
            <Badge variant="info" className="flex items-center gap-1">
              <Radio className="w-3 h-3 animate-pulse" />
              {activeSessions.length} active
            </Badge>
          )}
          {doneSessions.length > 0 && activeSessions.length === 0 && (
            <Badge variant="success">Done</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate("/automation")}>
            <ExternalLink className="h-4 w-4 mr-2" /> Back to Automation
          </Button>
        </div>
      </div>

      {/* Camoufox automation live event log (browser log stream) */}
      {events.length > 0 && (
        <div className="border-b border-[var(--border)] bg-black/95 px-4 py-2 max-h-48 overflow-auto">
          <div className="text-xs text-gray-500 mb-1 font-mono">automation log · Camoufox</div>
          {events.slice(-50).map((ev, i) => (
            <div key={i} className={`font-mono text-xs whitespace-pre-wrap break-all ${ev.level === "error" ? "text-red-400" : ev.level === "success" ? "text-green-400" : "text-gray-300"}`}>
              <span className="text-gray-600">[{new Date(ev.ts).toLocaleTimeString()}]</span>{" "}
              <span className="text-blue-400">{ev.provider}</span>{" "}
              <span className="text-yellow-500">{ev.step}</span>{" "}
              {ev.message}
            </div>
          ))}
        </div>
      )}

      {/* Body: session cards (left) + sidebar (right) */}
      <div className="flex flex-1 min-h-0 gap-4 p-4">
        {/* Session cards */}
        <div className="flex-1 min-w-0 flex flex-col gap-4 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--primary)]" />
            </div>
          ) : activeSessions.length === 0 && doneSessions.length === 0 ? (
            <div className="flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--card)] py-20">
              <div className="text-center">
                <Monitor className="w-12 h-12 text-[var(--muted-foreground)] mx-auto mb-4" />
                <h2 className="text-lg font-semibold text-[var(--foreground)] mb-2">No Active Sessions</h2>
                <p className="text-sm text-[var(--muted-foreground)] mb-4">Start a browser automation batch from the Automation page to see sessions here.</p>
                <Button size="sm" onClick={() => navigate("/automation")}>Go to Automation</Button>
              </div>
            </div>
          ) : (
            <>
              {activeSessions.map((s) => (
                <BrowserSessionCard key={s.sessionId} session={s} challenge={challenges[s.sessionId] || null} />
              ))}
              {doneSessions.map((s) => (
                <BrowserSessionCard key={s.sessionId} session={s} challenge={null} />
              ))}
            </>
          )}
        </div>

        {/* Session list sidebar */}
        {sessions.length > 0 && (
          <div className="w-72 lg:w-80 shrink-0">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] overflow-hidden sticky top-4">
              <div className="flex items-center justify-between h-9 px-3 border-b border-[var(--border)]">
                <div className="flex items-center gap-2">
                  <Radio className="w-3 h-3 text-[var(--primary)]" />
                  <span className="text-xs font-medium text-[var(--muted-foreground)]">Sessions</span>
                </div>
                <span className="text-xs text-[var(--muted-foreground)]">{sessions.length}</span>
              </div>
              <div className="max-h-96 overflow-y-auto">
                {sessions.map((s) => (
                  <div key={s.sessionId} className="border-b border-[var(--border)] px-3 py-2 last:border-0">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${s.terminal ? (s.phase === "complete" ? "bg-[var(--success)]" : "bg-[var(--error)]") : "bg-[var(--primary)] animate-pulse"}`} />
                      <span className="flex-1 truncate text-xs font-mono text-[var(--foreground)]">{s.email}</span>
                      <Badge variant={s.terminal ? (s.phase === "complete" ? "success" : "error") : "warning"} className="text-[10px]">
                        {s.phase}
                      </Badge>
                    </div>
                    {s.lastMessage && <p className="mt-1 truncate text-[10px] text-[var(--muted-foreground)]">{s.lastMessage}</p>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
