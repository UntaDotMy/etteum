import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Terminal, Trash2, Pause, Play, Loader2 } from "lucide-react";
import { API_BASE, getApiKey } from "@/lib/api";
import { cn } from "@/lib/utils";

interface LogLine {
  ts: number;
  level: string;
  msg: string;
}

function levelClass(level: string): string {
  const l = level.toLowerCase();
  if (l === "error") return "text-[var(--error)]";
  if (l === "warn" || l === "warning") return "text-[var(--warning)]";
  if (l === "info" || l === "log") return "text-[var(--info)]";
  return "text-[var(--muted-foreground)]";
}

/**
 * Live Console — real-time server log tail for Etteum process output.
 * Connects to GET /api/console/stream (SSE + ring buffer of last 500 lines).
 */
export default function LiveConsole() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    // EventSource cannot set Authorization headers — use ?api_key= like WS/frames.
    const url = `${API_BASE}/api/console/stream?api_key=${encodeURIComponent(getApiKey())}`;
    const es = new EventSource(url);

    es.onopen = () => {
      setConnected(true);
      setError(null);
    };
    es.onerror = () => {
      setConnected(false);
      setError("Stream disconnected — reconnecting…");
    };
    es.onmessage = (ev) => {
      if (pausedRef.current) return;
      try {
        const line = JSON.parse(ev.data) as LogLine;
        setLines((prev) => [...prev.slice(-499), line]);
      } catch {
        setLines((prev) => [
          ...prev.slice(-499),
          { ts: Date.now(), level: "info", msg: ev.data },
        ]);
      }
    };

    return () => es.close();
  }, []);

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, paused]);

  const filtered = filter
    ? lines.filter(
        (l) =>
          l.msg.toLowerCase().includes(filter.toLowerCase()) ||
          l.level.toLowerCase().includes(filter.toLowerCase()),
      )
    : lines;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-[var(--foreground)]">
            <Terminal className="h-6 w-6 text-[var(--primary)]" /> Live Console
          </h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            Real-time server log stream (last 500 lines). Use this to watch boot, warmup, proxy, and
            auth messages without SSHing the host.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              "gap-1.5",
              connected
                ? "border-[var(--success)]/40 text-[var(--success)]"
                : "border-[var(--warning)]/40 text-[var(--warning)]",
            )}
          >
            {connected ? (
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
            ) : (
              <Loader2 className="h-3 w-3 animate-spin" />
            )}
            {connected ? "Connected" : "Connecting"}
          </Badge>
          <Button size="sm" variant="outline" onClick={() => setPaused((p) => !p)}>
            {paused ? (
              <>
                <Play className="mr-1 h-4 w-4" /> Resume
              </>
            ) : (
              <>
                <Pause className="mr-1 h-4 w-4" /> Pause
              </>
            )}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setLines([])}>
            <Trash2 className="mr-1 h-4 w-4" /> Clear
          </Button>
        </div>
      </div>

      {error && (
        <p className="text-xs text-[var(--warning)]">{error}</p>
      )}

      <Card className="border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)]">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base text-[var(--foreground)]">Output</CardTitle>
            <CardDescription className="text-[var(--muted-foreground)]">
              {filtered.length} line{filtered.length === 1 ? "" : "s"}
              {paused ? " · paused" : ""}
            </CardDescription>
          </div>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by level or text…"
            className="mt-2 h-8 max-w-xs text-xs"
          />
        </CardHeader>
        <CardContent>
          <div
            className={cn(
              "min-h-[400px] max-h-[600px] overflow-auto rounded-md border border-[var(--border)] p-3 font-mono text-xs",
              "bg-[var(--background)] text-[var(--foreground)]",
            )}
          >
            {filtered.length === 0 ? (
              <span className="text-[var(--muted-foreground)]">
                // waiting for log output… (server console is mirrored here after restart)
              </span>
            ) : (
              filtered.map((l, i) => (
                <div
                  key={`${l.ts}-${i}`}
                  className={cn(
                    "whitespace-pre-wrap break-all leading-relaxed",
                    l.level === "error"
                      ? "text-[var(--error)]"
                      : l.level === "warn" || l.level === "warning"
                        ? "text-[var(--warning)]"
                        : "text-[var(--foreground)]",
                  )}
                >
                  <span className="text-[var(--muted-foreground)]">
                    [{new Date(l.ts).toLocaleTimeString()}]
                  </span>{" "}
                  <span className={levelClass(l.level)}>{l.level}</span> {l.msg}
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
