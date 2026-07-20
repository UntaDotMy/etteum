import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Eye, EyeOff, Lock } from "lucide-react";
import {
  API_BASE,
  getDashboardAuthStatus,
  loginWithPassword,
} from "@/lib/api";

interface LoginProps {
  onLogin: () => void;
}

/**
 * Single-credential login: the POOL API key, entered into a field labeled
 * "password" (operator convention). The backend resolves it as an API key —
 * friend keys presented here are revoked and the caller IP banned.
 */
export default function Login({ onLogin }: LoginProps) {
  const [password, setPassword] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [oidcEnabled, setOidcEnabled] = useState(false);

  useEffect(() => {
    getDashboardAuthStatus().then((s) => {
      if (!s) return;
      setOidcEnabled(!!s.oidcEnabled);
      // Already have a valid session cookie.
      if (s.authenticated) {
        localStorage.setItem("dashboard_session", "1");
        onLogin();
      }
    });
  }, [onLogin]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      if (!password.trim()) {
        setError("Please enter your password (API key)");
        setLoading(false);
        return;
      }
      const result = await loginWithPassword(password.trim());
      if (!result.ok) {
        setError(result.error || "Invalid password");
        setLoading(false);
        return;
      }
      localStorage.setItem("dashboard_session", "1");
      // Clear any stale API key so subsequent requests use the session cookie.
      localStorage.removeItem("api_key");
      onLogin();
    } catch (err: any) {
      setError(err?.message || "Login failed");
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)] p-4">
      <Card className="w-full max-w-sm border-[var(--border)]">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--primary)]/10">
            <Lock className="h-6 w-6 text-[var(--primary)]" />
          </div>
          <CardTitle className="text-xl">Etteum</CardTitle>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            Sign in with your password (API key)
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <Input
                type={showKey ? "text" : "password"}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(null); }}
                placeholder="Password (your API key)"
                className="pr-10 font-mono text-sm"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            {error && (
              <div className="rounded-md bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Verifying..." : "Login"}
            </Button>

            {oidcEnabled && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => {
                  window.location.href = `${API_BASE}/api/dashboard-auth/oidc/start`;
                }}
              >
                Continue with SSO
              </Button>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
