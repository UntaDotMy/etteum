import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Shield, Database, Globe, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { fetchApi } from "@/lib/api";

interface AuthStatus {
  authenticated: boolean;
  user: { email: string; method: string } | null;
  oidcEnabled: boolean;
  passwordConfigured: boolean;
}

interface Msg { text: string; isError: boolean }

export default function SecurityProfile() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
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
  useEffect(() => { fetchStatus(); }, []);

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
    // The actual export is admin-guarded; open it directly (works from localhost).
    window.open("/api/sync/export", "_blank");
  }

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Shield className="w-6 h-6" /> Security & Profile</h1>
        <p className="text-muted-foreground mt-1">Dashboard authentication, OIDC SSO, and database backup.</p>
      </div>

      {message && <div className={`text-sm flex items-center gap-2 ${message.isError ? "text-red-500" : "text-green-500"}`}>{message.isError ? <AlertCircle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}{message.text}</div>}
      {!message && <div />}

      {/* Auth status */}
      <Card>
        <CardHeader><CardTitle className="text-base">Session</CardTitle><CardDescription>Current dashboard authentication state</CardDescription></CardHeader>
        <CardContent className="text-sm space-y-1">
          <div>Authenticated: <span className={status?.authenticated ? "text-green-500" : "text-red-500"}>{status?.authenticated ? "yes" : "no"}</span></div>
          {status?.user && <div>User: {status.user.email} <span className="text-xs text-muted-foreground">({status.user.method})</span></div>}
          <div>Login credential: <span className="text-muted-foreground">API key (pool). Rotate it on the API Key page.</span></div>
          <div>OIDC SSO: {status?.oidcEnabled ? "enabled" : "disabled"}</div>
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
