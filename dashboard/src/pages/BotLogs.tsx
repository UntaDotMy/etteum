import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BrowserSessionCard } from "@/components/auth/BrowserSessionCard";
import { fetchBrowserSessions, BrowserSessionInfo } from "@/lib/browserApi";
import { useWsEvent, useWsStatus } from "@/hooks/useWebSocket";
import {
  ArrowLeft,
  Radio,
  Monitor,
  Zap,
  Trash2,
  Activity,
} from "lucide-react";

interface Challenge {
  image_base64: string;
  image_format: string;
  prompt: string;
  seq: number;
}

type LiveEvent = {
  ts: number;
  provider: string;
  step: string;
  message: string;
  level: "info" | "error" | "success";
};

export default function BotLogs() {
  const navigate = useNavigate();
  const wsStatus = useWsStatus();
  const [sessions, setSessions] = useState<BrowserSessionInfo[]>([]);
  const [challenges, setChallenges] = useState<Record<string, Challenge>>({});
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  const pushEvent = useCallback((ev: LiveEvent) => {
    setEvents((prev) => [...prev.slice(-499), ev]);
  }, []);

  useWsEvent("login_progress", (msg) => {
    const e = (msg as any)?.data ?? msg;
    if (!e) return;
    pushEvent({
      ts: Date.now(),
      provider: e.provider || "",
      step: e.step || "progress",
      message: e.message || "",
      level: e.step === "error" ? "error" : "info",
    });
    if (e.step === "phase" || e.step) {
      setSessions((prev) =>
        prev.map((s) =>
          s.email === e.email
            ? { ...s, phase: e.step === "phase" ? e.phase : e.step || s.phase, lastMessage: e.message || s.lastMessage }
            : s,
        ),
      );
    }
    if (e.step === "manual_challenge") {
      setSessions((prev) => {
        const sid = prev.find((s) => s.email === e.email)?.sessionId;
        if (sid) {
          setChallenges((c) => ({
            ...c,
            [sid]: {
              image_base64: e.challenge_image_base64 || "",
              image_format: e.challenge_image_format || "jpeg",
              prompt: e.prompt || "Type the characters",
              seq: e.challenge_seq || 1,
            },
          }));
        }
        return prev;
      });
    }
  });

  useWsEvent("login_failed", (msg) => {
    const e = (msg as any)?.data ?? msg;
    if (!e) return;
    pushEvent({
      ts: Date.now(),
      provider: e.provider || "",
      step: "failed",
      message: e.error || "login failed",
      level: "error",
    });
    void load();
  });

  useWsEvent("login_success", (msg) => {
    const e = (msg as any)?.data ?? msg;
    if (!e) return;
    pushEvent({
      ts: Date.now(),
      provider: e.provider || "",
      step: "success",
      message: "login succeeded",
      level: "success",
    });
    void load();
  });

  useWsEvent("browser_frame", () => {
    // Frame bytes go through the session registry + SSE; refresh list so new
    // camoufox-* sessions appear without waiting for the 2s poll.
    void load();
  });

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
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-[var(--foreground)]">Browser Logs</h1>
            {activeSessions.length > 0 && (
              <Badge variant="info" className="gap-1">
                <Radio className="h-3 w-3 animate-pulse" />
                {activeSessions.length} live
              </Badge>
            )}
            {doneSessions.length > 0 && activeSessions.length === 0 && (
              <Badge variant="success">Idle</Badge>
            )}
            <Badge
              variant="outline"
              className={
                wsStatus === "open"
                  ? "border-[var(--primary)]/40 text-[var(--primary)]"
                  : "text-[var(--muted-foreground)]"
              }
            >
              WS {wsStatus}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            Live Camoufox frames + step timeline from Automation logins.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setEvents([])} disabled={events.length === 0}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Clear log
          </Button>
          <Button variant="outline" size="sm" onClick={() => navigate("/automation")}>
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Automation
          </Button>
        </div>
      </div>

      {/* Connection strip */}
      <Card className="border-[var(--primary)]/20">
        <CardContent className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground)]">
            <span className="inline-flex items-center gap-1.5 text-[var(--foreground)]">
              <Zap className="h-3.5 w-3.5 text-[var(--primary)]" />
              Automation start
            </span>
            <span className="text-[var(--muted-foreground)]">→</span>
            <span className="inline-flex items-center gap-1.5 text-[var(--foreground)]">
              <Activity className="h-3.5 w-3.5 text-[var(--primary)]" />
              WS progress + frames
            </span>
            <span className="text-[var(--muted-foreground)]">→</span>
            <span className="inline-flex items-center gap-1.5 text-[var(--foreground)]">
              <Monitor className="h-3.5 w-3.5 text-[var(--primary)]" />
              Session registry + SSE preview
            </span>
          </div>
          <p className="text-[11px] text-[var(--muted-foreground)]">
            Session ids: <code className="text-[var(--primary)]">camoufox-{"{id}"}</code> /{" "}
            <code className="text-[var(--primary)]">batch-{"{id}"}</code>
          </p>
        </CardContent>
      </Card>

      {/* Event log — theme tokens, not raw black terminal */}
      <Card className="shrink-0">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div>
            <CardTitle className="text-sm">Activity stream</CardTitle>
            <CardDescription className="text-xs">
              login_progress / success / failed · {events.length} events
            </CardDescription>
          </div>
          <Activity className="h-4 w-4 text-[var(--primary)]" />
        </CardHeader>
        <CardContent className="pt-0">
          {events.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/30 px-4 py-6 text-center text-xs text-[var(--muted-foreground)]">
              Waiting for automation events. Start a login from Automation to fill this stream.
            </div>
          ) : (
            <div className="max-h-40 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 font-mono text-[11px]">
              {events.map((ev, i) => (
                <div
                  key={`${ev.ts}-${i}`}
                  className="flex gap-2 border-b border-[var(--border)]/50 px-3 py-1 last:border-0"
                >
                  <span className="shrink-0 text-[var(--muted-foreground)]">
                    {new Date(ev.ts).toLocaleTimeString()}
                  </span>
                  <span className="shrink-0 font-medium text-[var(--primary)]">
                    {ev.provider || "—"}
                  </span>
                  <span
                    className={
                      ev.level === "error"
                        ? "shrink-0 text-[var(--error)]"
                        : ev.level === "success"
                          ? "shrink-0 text-[var(--success)]"
                          : "shrink-0 text-[var(--warning)]"
                    }
                  >
                    {ev.step}
                  </span>
                  <span className="min-w-0 flex-1 break-all text-[var(--foreground)]">{ev.message}</span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sessions + sidebar */}
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto pb-4">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />
            </div>
          ) : activeSessions.length === 0 && doneSessions.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary)_10%,var(--card))]">
                  <Monitor className="h-7 w-7 text-[var(--primary)]" />
                </div>
                <h2 className="text-lg font-semibold text-[var(--foreground)]">No browser sessions</h2>
                <p className="mt-2 max-w-sm text-sm text-[var(--muted-foreground)]">
                  Start a Camoufox automation from the Automation page. Sessions register automatically and frames stream here.
                </p>
                <Button className="mt-5" size="sm" onClick={() => navigate("/automation")}>
                  <Zap className="mr-1.5 h-4 w-4" />
                  Go to Automation
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              {activeSessions.map((s) => (
                <BrowserSessionCard
                  key={s.sessionId}
                  session={s}
                  challenge={challenges[s.sessionId] || null}
                />
              ))}
              {doneSessions.map((s) => (
                <BrowserSessionCard key={s.sessionId} session={s} challenge={null} />
              ))}
            </>
          )}
        </div>

        {sessions.length > 0 && (
          <div className="hidden w-72 shrink-0 lg:block xl:w-80">
            <Card className="sticky top-0 overflow-hidden">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b border-[var(--border)] py-3">
                <div className="flex items-center gap-2">
                  <Radio className="h-3.5 w-3.5 text-[var(--primary)]" />
                  <CardTitle className="text-xs font-medium text-[var(--muted-foreground)]">
                    Sessions
                  </CardTitle>
                </div>
                <span className="text-xs text-[var(--muted-foreground)]">{sessions.length}</span>
              </CardHeader>
              <CardContent className="max-h-[28rem] space-y-0 overflow-y-auto p-0">
                {sessions.map((s) => (
                  <div
                    key={s.sessionId}
                    className="border-b border-[var(--border)] px-3 py-2.5 last:border-0"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          s.terminal
                            ? s.phase === "complete"
                              ? "bg-[var(--success)]"
                              : "bg-[var(--error)]"
                            : "animate-pulse bg-[var(--primary)]"
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--foreground)]">
                        {s.email}
                      </span>
                      <Badge
                        variant={
                          s.terminal
                            ? s.phase === "complete"
                              ? "success"
                              : "error"
                            : "warning"
                        }
                        className="text-[10px]"
                      >
                        {s.phase}
                      </Badge>
                    </div>
                    <p className="mt-1 truncate font-mono text-[10px] text-[var(--muted-foreground)]">
                      {s.sessionId}
                    </p>
                    {s.lastMessage && (
                      <p className="mt-0.5 truncate text-[10px] text-[var(--muted-foreground)]">
                        {s.lastMessage}
                      </p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
