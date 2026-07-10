import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShieldCheck, ShieldAlert, Play, Square, Power, Key, Network, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { fetchApi } from "@/lib/api";

interface MitmStatus {
  running: boolean;
  certExists: boolean;
  certTrusted: boolean;
  port?: number;
  dnsStatus?: Record<string, boolean>;
  [k: string]: unknown;
}

interface Msg { text: string; isError: boolean }

export default function Mitm() {
  const [status, setStatus] = useState<MitmStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const { message, setMessage } = useTimedMessage<Msg>(null, 3000);
  const ok = (text: string) => setMessage({ text, isError: false });
  const err = (text: string) => setMessage({ text, isError: true });

  async function fetchStatus() {
    setLoading(true);
    try {
      const status = await fetchApi<MitmStatus>("/api/mitm/status");
      setStatus(status);
    } catch {}
    setLoading(false);
  }
  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 5000);
    return () => clearInterval(id);
  }, []);

  async function call(endpoint: string, method = "POST", body?: any) {
    setBusy(endpoint);
    try {
      const j = await fetchApi<any>(`/api/mitm/${endpoint}`, {
        method,
        body: body ? JSON.stringify(body) : undefined,
      });
      ok(j?.message || `${endpoint} OK`);
      fetchStatus();
    } catch (e: any) { err(e?.message || `${endpoint} failed`); }
    setBusy(null);
  }

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Network className="w-6 h-6" /> MITM Interception</h1>
        <p className="text-muted-foreground mt-1">HTTPS interception for IDE tools — route vendor API calls through the pool via a local CA + DNS redirect.</p>
      </div>

      {message && <div className={`text-sm flex items-center gap-2 ${message.isError ? "text-red-500" : "text-green-500"}`}>{message.isError ? <AlertCircle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}{message.text}</div>}

      {/* Status overview */}
      <Card>
        <CardHeader><CardTitle className="text-base">Status</CardTitle><CardDescription>Current MITM server state</CardDescription></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div className="flex items-center gap-2">{status?.running ? <ShieldCheck className="w-5 h-5 text-green-500" /> : <ShieldAlert className="w-5 h-5 text-muted-foreground" />} Running: <span className={status?.running ? "text-green-500" : "text-muted-foreground"}>{status?.running ? "yes" : "no"}</span></div>
          <div className="flex items-center gap-2"><Key className="w-5 h-5" /> CA cert: <span className={status?.certExists ? "text-green-500" : "text-red-500"}>{status?.certExists ? "exists" : "missing"}</span></div>
          <div className="flex items-center gap-2"><ShieldCheck className="w-5 h-5" /> Trusted: <span className={status?.certTrusted ? "text-green-500" : "text-yellow-500"}>{status?.certTrusted ? "yes" : "no"}</span></div>
          <div className="flex items-center gap-2"><Network className="w-5 h-5" /> Port: <span>{status?.port ?? "—"}</span></div>
        </CardContent>
      </Card>

      {/* Controls */}
      <Card>
        <CardHeader><CardTitle className="text-base">Controls</CardTitle><CardDescription>Start/stop the MITM server and manage the CA cert (some actions need sudo/admin password)</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2 items-end">
            <div className="flex-1 max-w-xs">
              <label className="text-xs text-muted-foreground">Admin/sudo password (for cert trust + DNS)</label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => call("start", "POST", { password })} disabled={busy === "start" || status?.running}><Play className="w-4 h-4 mr-1" /> Start</Button>
            <Button variant="outline" onClick={() => call("stop")} disabled={busy === "stop" || !status?.running}><Square className="w-4 h-4 mr-1" /> Stop</Button>
            <Button variant="outline" onClick={() => call("disable")} disabled={busy === "disable"}><Power className="w-4 h-4 mr-1" /> Disable (stop + strip DNS)</Button>
            <Button variant="secondary" onClick={() => call("trust-cert", "POST", { password })} disabled={busy === "trust-cert" || !status?.certExists}><ShieldCheck className="w-4 h-4 mr-1" /> Trust CA Cert</Button>
            <Button variant="secondary" onClick={() => call("enable-dns", "POST", { password })} disabled={busy === "enable-dns"}><Network className="w-4 h-4 mr-1" /> Enable DNS Redirect</Button>
          </div>
        </CardContent>
      </Card>

      {/* DNS status per tool */}
      {status?.dnsStatus && Object.keys(status.dnsStatus).length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Per-Tool DNS Redirect</CardTitle><CardDescription>Which IDE tools have their vendor hosts pointing to 127.0.0.1</CardDescription></CardHeader>
          <CardContent>
            <div className="space-y-1 text-sm">
              {Object.entries(status.dnsStatus).map(([tool, mapped]) => (
                <div key={tool} className="flex items-center justify-between">
                  <code>{tool}</code>
                  <span className={mapped ? "text-green-500" : "text-muted-foreground"}>{mapped ? "redirected ✓" : "not redirected"}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
