import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Eye, EyeOff, Lock } from "lucide-react";
import {
  validateApiKey,
  API_BASE,
  getDashboardAuthStatus,
  loginWithPassword,
} from "@/lib/api";

interface LoginProps {
  onLogin: () => void;
}

type Mode = "api_key" | "password";

export default function Login({ onLogin }: LoginProps) {
  const [mode, setMode] = useState<Mode>("api_key");
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [passwordConfigured, setPasswordConfigured] = useState(false);

  useEffect(() => {
    getDashboardAuthStatus().then((s) => {
      if (!s) return;
      setOidcEnabled(!!s.oidcEnabled);
      setPasswordConfigured(!!s.passwordConfigured);
      // Prefer password mode when a dashboard password is configured.
      if (s.passwordConfigured) setMode("password");
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
      if (mode === "password") {
        if (!password.trim()) {
          setError("Please enter the dashboard password");
          setLoading(false);
          return;
        }
        const result = await loginWithPassword(password);
        if (!result.ok) {
          setError(result.error || "Invalid password");
          setLoading(false);
          return;
        }
        localStorage.setItem("dashboard_session", "1");
        // Clear any stale API key so subsequent requests use the session cookie.
        // Operator can still paste a key later on the API Key page.
        onLogin();
        setLoading(false);
        return;
      }

      if (!key.trim()) {
        setError("Please enter an API key");
        setLoading(false);
        return;
      }
      const valid = await validateApiKey(key.trim());
      if (valid) {
        localStorage.setItem("api_key", key.trim());
        localStorage.removeItem("dashboard_session");
        onLogin();
      } else {
        setError("Invalid API key");
      }
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
            {mode === "password"
              ? "Sign in with your dashboard password"
              : "Enter your API key to access the dashboard"}
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 mb-4">
            <Button
              type="button"
              variant={mode === "password" ? "default" : "outline"}
              className="flex-1"
              onClick={() => { setMode("password"); setError(null); }}
            >
              Password
            </Button>
            <Button
              type="button"
              variant={mode === "api_key" ? "default" : "outline"}
              className="flex-1"
              onClick={() => { setMode("api_key"); setError(null); }}
            >
              API key
            </Button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "api_key" ? (
              <div className="relative">
                <Input
                  type={showKey ? "text" : "password"}
                  value={key}
                  onChange={(e) => { setKey(e.target.value); setError(null); }}
                  placeholder="sk-pool-..."
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
            ) : (
              <Input
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(null); }}
                placeholder={passwordConfigured ? "Dashboard password" : "Set password first (Security page) or use API key"}
                className="text-sm"
                autoFocus
              />
            )}

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
