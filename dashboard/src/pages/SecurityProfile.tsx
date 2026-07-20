import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Shield, Database, Globe, CheckCircle2, AlertCircle, Loader2, Ban, ScrollText } from "lucide-react";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { fetchApi } from "@/lib/api";

interface AuthStatus {
  authenticated: boolean;
  user: { email: string; method: string } | null;
  oidcEnabled: boolean;
  passwordConfigured: boolean;
}

interface IpBan {
  ip: string;
  reason: string;
  detail: string | null;
  createdAt: string | Date | null;
  expiresAt: string | Date;
}

interface SecurityEvent {
  id: number;
  createdAt: string | Date | null;
  ip: string | null;
  surface: string;
  path: string | null;
  keyPreview: string | null;
  action: string;
  detail: string | null;
}

interface Msg { text: string; isError: boolean }

function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return "—";
  try {
    return new Date(v).toLocaleString();
  } catch {
    return String(v);
  }
}

export default function SecurityProfile() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [bans, setBans] = useState<IpBan[]>([]);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [loadingBans, setLoadingBans] = useState(false);
  const [unbanning, setUnbanning] = useState<string | null>(null);
  const { message, setMessage } = useTimedMessage<Msg>(null, 3000);
  const ok = (text: string) => setMessage({ text, isError: false });
  const err = (text: string) => setMessage({ text, isError: true });

  // OIDC config
  const [oidcIssuer, setOidcIssuer] = useState("");
  const [oidcClientId, setOidcClientId] = useState("");
  const [oidcClientSecret, setOidcClientSecret] = useState("");
  const [savingOidc, setSavingOidc] = useState(false);
  const [testingOidc, setTestingOidc] = useState(false);

  async function fetchStatus() {
    setLoading(true);
    try {
      const status = await fetchApi<AuthStatus>("/api/dashboard-auth/status");
      setStatus(status);
    } catch {}
    setLoading(false);
  }

  async function fetchSecurity() {
    setLoadingBans(true);
    try {
      const [banRes, evtRes] = await Promise.all([
        fetchApi<{ bans: IpBan[] }>("/api/security/bans"),
        fetchApi<{ events: SecurityEvent[] }>("/api/security/events?limit=100"),
      ]);
      setBans(banRes.bans || []);
      setEvents(evtRes.events || []);
    } catch (e: any) {
      err(e?.message || "Failed to load bans/events");
    }
    setLoadingBans(false);
  }

  useEffect(() => {
    fetchStatus();
    fetchSecurity();
  }, []);

  async function saveOidc() {
    setSavingOidc(true);
    try {
      const cfg = JSON.stringify({ enabled: !!oidcIssuer, issuer: oidcIssuer, clientId: oidcClientId, clientSecret: oidcClientSecret, scopes: ["openid", "profile", "email"] });
      await fetchApi("/api/settings", {
        method: "POST",
        body: JSON.stringify({ key: "oidc_config", value: cfg }),
      });
      ok("OIDC config saved");
      fetchStatus();
    } catch (e: any) { err(e?.message || "Save failed (needs local access)"); }
    setSavingOidc(false);
  }

  async function testOidc() {
    setTestingOidc(true);
    try {
      const j = await fetchApi<{ success?: boolean; issuer?: string; error?: string }>("/api/dashboard-auth/oidc/test");
      if (j.success) ok(`OIDC OK: ${j.issuer}`); else err(j.error || "OIDC test failed");
    } catch (e: any) { err(e?.message || "OIDC test failed"); }
    setTestingOidc(false);
  }

  async function exportDb() {
    err("DB export via /api/sync/export requires local access");
    window.open("/api/sync/export", "_blank");
  }

  async function handleUnban(ip: string) {
    setUnbanning(ip);
    try {
      const res = await fetchApi<{ removed: boolean }>(`/api/security/bans/${encodeURIComponent(ip)}`, {
        method: "DELETE",
      });
      if (res.removed) {
        ok(`Unbanned ${ip}`);
        await fetchSecurity();
      } else {
        err(`${ip} was not banned`);
      }
    } catch (e: any) {
      err(e?.message || "Unban failed");
    }
    setUnbanning(null);
  }

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Shield className="w-6 h-6" /> Security & Profile</h1>
        <p className="text-muted-foreground mt-1">Dashboard authentication, IP bans, audit log, OIDC SSO, and database backup.</p>
      </div>

      {message && <div className={`text-sm flex items-center gap-2 ${message.isError ? "text-red-500" : "text-green-500"}`}>{message.isError ? <AlertCircle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}{message.text}</div>}
      {!message && <div />}

      {/* Auth status */}
      <Card>
        <CardHeader><CardTitle className="text-base">Session</CardTitle><CardDescription>Current dashboard authentication state</CardDescription></CardHeader>
        <CardContent className="text-sm space-y-1">
          <div>Authenticated: <span className={status?.authenticated ? "text-green-500" : "text-red-500"}>{status?.authenticated ? "yes" : "no"}</span></div>
          {status?.user && <div>User: {status.user.email} <span className="text-xs text-muted-foreground">({status.user.method})</span></div>}
          <div>OIDC SSO: {status?.oidcEnabled ? "enabled" : "disabled"}</div>
        </CardContent>
      </Card>

      {/* IP bans */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2"><Ban className="w-4 h-4" /> IP bans</CardTitle>
            <CardDescription>
              Abusers who hit the dashboard with a wrong password or a friend key. Keys stay active for other IPs.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={fetchSecurity} disabled={loadingBans}>
            {loadingBans ? <Loader2 className="w-4 h-4 animate-spin" /> : "Refresh"}
          </Button>
        </CardHeader>
        <CardContent>
          {bans.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active bans.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-[var(--border)]">
                    <th className="py-2 pr-3 font-medium">IP</th>
                    <th className="py-2 pr-3 font-medium">Reason</th>
                    <th className="py-2 pr-3 font-medium">Detail</th>
                    <th className="py-2 pr-3 font-medium">Banned</th>
                    <th className="py-2 pr-3 font-medium">Expires</th>
                    <th className="py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {bans.map((b) => (
                    <tr key={b.ip} className="border-b border-[var(--border)]/60 align-top">
                      <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">{b.ip}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{b.reason}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground max-w-md break-all">{b.detail || "—"}</td>
                      <td className="py-2 pr-3 whitespace-nowrap text-xs">{fmtDate(b.createdAt)}</td>
                      <td className="py-2 pr-3 whitespace-nowrap text-xs">{fmtDate(b.expiresAt)}</td>
                      <td className="py-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={unbanning === b.ip}
                          onClick={() => handleUnban(b.ip)}
                        >
                          {unbanning === b.ip ? <Loader2 className="w-3 h-3 animate-spin" /> : "Unban"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Security events */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><ScrollText className="w-4 h-4" /> Security log</CardTitle>
          <CardDescription>
            IP, path, action, redacted key preview, user-agent / machine / host when the client sent them. Full secrets are never stored.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events yet.</p>
          ) : (
            <div className="overflow-x-auto max-h-[28rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[var(--card)]">
                  <tr className="text-left text-muted-foreground border-b border-[var(--border)]">
                    <th className="py-2 pr-3 font-medium">When</th>
                    <th className="py-2 pr-3 font-medium">IP</th>
                    <th className="py-2 pr-3 font-medium">Action</th>
                    <th className="py-2 pr-3 font-medium">Surface / path</th>
                    <th className="py-2 pr-3 font-medium">Key</th>
                    <th className="py-2 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id} className="border-b border-[var(--border)]/60 align-top">
                      <td className="py-2 pr-3 whitespace-nowrap text-xs">{fmtDate(e.createdAt)}</td>
                      <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">{e.ip || "—"}</td>
                      <td className="py-2 pr-3 whitespace-nowrap text-xs">{e.action}</td>
                      <td className="py-2 pr-3 text-xs whitespace-nowrap">{e.surface}{e.path ? ` ${e.path}` : ""}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{e.keyPreview || "—"}</td>
                      <td className="py-2 text-xs text-muted-foreground max-w-lg break-all">{e.detail || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* OIDC SSO config */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Globe className="w-4 h-4" /> OIDC / SSO</CardTitle><CardDescription>Configure an external identity provider for single sign-on</CardDescription></CardHeader>
        <CardContent className="space-y-2 max-w-md">
          <div><label className="text-xs text-muted-foreground">Issuer URL</label><Input value={oidcIssuer} onChange={(e) => setOidcIssuer(e.target.value)} placeholder="https://accounts.google.com" /></div>
          <div><label className="text-xs text-muted-foreground">Client ID</label><Input value={oidcClientId} onChange={(e) => setOidcClientId(e.target.value)} /></div>
          <div><label className="text-xs text-muted-foreground">Client Secret</label><Input type="password" value={oidcClientSecret} onChange={(e) => setOidcClientSecret(e.target.value)} /></div>
          <div className="flex gap-2">
            <Button onClick={saveOidc} disabled={savingOidc}>{savingOidc ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save Config"}</Button>
            <Button variant="outline" onClick={testOidc} disabled={testingOidc || !oidcIssuer}>Test Discovery</Button>
            {status?.oidcEnabled && <a href="/api/dashboard-auth/oidc/start"><Button variant="secondary">Login via SSO</Button></a>}
          </div>
        </CardContent>
      </Card>

      {/* DB backup */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Database className="w-4 h-4" /> Database Backup</CardTitle><CardDescription>Export configuration (requires local access)</CardDescription></CardHeader>
        <CardContent>
          <Button variant="outline" onClick={exportDb}><Database className="w-4 h-4 mr-1" /> Export Config (JSON)</Button>
          <p className="text-xs text-muted-foreground mt-2">Export includes custom models, disabled models, and pricing. Account credentials are not exported. The endpoint is admin-guarded (localhost or CLI token only).</p>
        </CardContent>
      </Card>
    </div>
  );
}
