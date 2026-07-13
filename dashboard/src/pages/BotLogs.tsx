import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { BrowserSessionCard } from "@/components/auth/BrowserSessionCard";
import { fetchBrowserSessions, BrowserSessionInfo } from "@/lib/browserApi";
import { useWsEvent, useWsStatus } from "@/hooks/useWebSocket";
import { ArrowLeft, ArrowRight, Radio, Monitor, Zap } from "lucide-react";

interface Challenge {
  image_base64: string;
  image_format: string;
  prompt: string;
  seq: number;
}

/** Hide Grok farm job overview (no -wN) so concurrency N → N worker cards. */
function isWorkerDisplaySession(s: BrowserSessionInfo): boolean {
  if (
    s.provider === "grok" &&
    s.sessionId.startsWith("grok-farm-") &&
    !/-w\d+$/.test(s.sessionId)
  ) {
    return false;
  }
  return true;
}

export default function BotLogs() {
  const navigate = useNavigate();
  const wsStatus = useWsStatus();
  const [sessions, setSessions] = useState<BrowserSessionInfo[]>([]);
  const [challenges, setChallenges] = useState<Record<string, Challenge>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const s = await fetchBrowserSessions();
      setSessions(s.filter(isWorkerDisplaySession));
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

  useWsEvent("login_progress", (msg) => {
    const e = (msg as any)?.data ?? msg;
    if (!e) return;

    if (e.sessionId || e.email) {
      setSessions((prev) =>
        prev.map((s) => {
          const match =
            (e.sessionId && s.sessionId === e.sessionId) ||
            (e.email && s.email === e.email);
          if (!match) return s;
          return {
            ...s,
            phase: e.step === "phase" ? e.phase || s.phase : e.step || s.phase,
            lastMessage: e.message || s.lastMessage,
          };
        }),
      );
    }

    if (e.step === "manual_challenge") {
      const challengePayload = {
        image_base64: e.challenge_image_base64 || "",
        image_format: e.challenge_image_format || "jpeg",
        prompt: e.prompt || "Type the characters",
        seq: e.challenge_seq || 1,
      };
      if (e.sessionId) {
        setChallenges((c) => ({ ...c, [e.sessionId]: challengePayload }));
      } else if (e.email) {
        setSessions((prev) => {
          const sid = prev.find((s) => s.email === e.email)?.sessionId;
          if (sid) setChallenges((c) => ({ ...c, [sid]: challengePayload }));
          return prev;
        });
      }
    }
  });

  useWsEvent("login_failed", () => {
    void load();
  });
  useWsEvent("login_success", () => {
    void load();
  });
  useWsEvent("browser_frame", () => {
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
    <div className="space-y-6">
      {/* Page header — matches Automation / Dashboard */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Browser Logs</h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            One card per worker: live frame + step log.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
            <Radio
              className={`mr-1.5 h-3 w-3 ${
                wsStatus === "open" ? "animate-pulse text-[var(--primary)]" : ""
              }`}
            />
            WS {wsStatus}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => navigate("/automation")}>
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Automation
            <ArrowRight className="ml-1.5 h-3.5 w-3.5 opacity-60" />
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />
        </div>
      ) : activeSessions.length === 0 && doneSessions.length === 0 ? (
        <Card className="border-[var(--primary)]/20 shadow-[var(--shadow-card)]">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary)_12%,var(--card))]">
              <Monitor className="h-7 w-7 text-[var(--primary)]" />
            </div>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">No browser sessions</h2>
            <p className="mt-2 max-w-sm text-sm text-[var(--muted-foreground)]">
              Start a provider from Automation. Each worker registers here with a live frame and its own log.
            </p>
            <Button className="mt-5" size="sm" onClick={() => navigate("/automation")}>
              <Zap className="mr-1.5 h-4 w-4" />
              Go to Automation
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
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
        </div>
      )}
    </div>
  );
}
