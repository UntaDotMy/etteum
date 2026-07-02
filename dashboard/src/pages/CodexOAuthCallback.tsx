import { useEffect, useMemo, useState } from "react";
import { completeCodexOAuth } from "@/lib/api";

export default function CodexOAuthCallback() {
  const [message, setMessage] = useState("Completing Codex login...");
  const [done, setDone] = useState(false);

  const params = useMemo(() => new URLSearchParams(window.location.search), []);

  useEffect(() => {
    let active = true;

    async function run() {
      const code = params.get("code") || "";
      const state = params.get("state") || "";
      const error = params.get("error") || "";
      const errorDescription = params.get("error_description") || error;

      if (error) {
        setMessage(errorDescription || "OAuth login failed");
        window.opener?.postMessage({ type: "codex_oauth_result", success: false, error: errorDescription || error, state }, window.location.origin);
        setDone(true);
        return;
      }

      if (!code || !state) {
        setMessage("Missing authorization code or state");
        window.opener?.postMessage({ type: "codex_oauth_result", success: false, error: "Missing authorization code or state", state }, window.location.origin);
        setDone(true);
        return;
      }

      try {
        const result = await completeCodexOAuth({ code, state });
        if (!active) return;
        setMessage(`Connected as ${result.connection?.displayName || result.connection?.email || "Codex"}`);
        window.opener?.postMessage({ type: "codex_oauth_result", success: true, state }, window.location.origin);
      } catch (error) {
        if (!active) return;
        const text = error instanceof Error ? error.message : String(error);
        setMessage(text);
        window.opener?.postMessage({ type: "codex_oauth_result", success: false, error: text, state }, window.location.origin);
      } finally {
        if (active) setDone(true);
        setTimeout(() => window.close(), 1200);
      }
    }

    run();
    return () => {
      active = false;
    };
  }, [params]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--background)] p-6 text-center">
      <div className="max-w-md space-y-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-6">
        <h1 className="text-lg font-semibold text-[var(--foreground)]">Codex Login</h1>
        <p className="text-sm text-[var(--muted-foreground)]">{message}</p>
        {done && <p className="text-xs text-[var(--muted-foreground)]">You can close this window.</p>}
      </div>
    </div>
  );
}
