import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Terminal, Trash2, Pause, Play } from "lucide-react";

interface LogLine {
  ts: number;
  level: string;
  msg: string;
}

export default function LiveConsole() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    // Connect to the live console SSE stream.
    const es = new EventSource("/api/console/stream");
    es.onmessage = (ev) => {
      if (pausedRef.current) return;
      try {
        const line = JSON.parse(ev.data) as LogLine;
        setLines((prev) => [...prev.slice(-499), line]);
      } catch {
        setLines((prev) => [...prev.slice(-499), { ts: Date.now(), level: "info", msg: ev.data }]);
      }
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, paused]);

  const filtered = filter
    ? lines.filter((l) => l.msg.toLowerCase().includes(filter.toLowerCase()) || l.level.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Terminal className="w-6 h-6" /> Live Console
          </h1>
          <p className="text-muted-foreground mt-1">Real-time server log stream (last 500 lines, ring buffer)</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setPaused((p) => !p)}>
            {paused ? <><Play className="w-4 h-4 mr-1" /> Resume</> : <><Pause className="w-4 h-4 mr-1" /> Pause</>}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setLines([])}>
            <Trash2 className="w-4 h-4 mr-1" /> Clear
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Output</CardTitle>
          <CardDescription>
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter…"
              className="text-xs h-7 max-w-xs"
            />
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="font-mono text-xs bg-black text-green-400 p-3 rounded min-h-[400px] max-h-[600px] overflow-auto">
            {filtered.length === 0 ? (
              <span className="text-gray-500">// waiting for log output…</span>
            ) : (
              filtered.map((l, i) => (
                <div key={i} className={`whitespace-pre-wrap break-all ${l.level === "error" ? "text-red-400" : l.level === "warn" ? "text-yellow-400" : ""}`}>
                  <span className="text-gray-500">[{new Date(l.ts).toLocaleTimeString()}]</span>{" "}
                  <span className="text-blue-400">{l.level}</span>{" "}
                  {l.msg}
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
