import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Minus, Plus, X } from "lucide-react";

interface StartAutomationModalProps {
  provider: string;
  providerLabel: string;
  subtitle: string;
  onClose: () => void;
  onStart: (config: {
    mode: "empas" | "refresh-token";
    empas: string;
    refreshTokens: string;
    concurrent: number;
    skipExisting: boolean;
    useProxy: boolean;
    captchaBehavior: "skip" | "handle";
  }) => void;
}

export default function StartAutomationModal({
  provider,
  providerLabel,
  subtitle,
  onClose,
  onStart,
}: StartAutomationModalProps) {
  const [mode, setMode] = useState<"empas" | "refresh-token">("empas");
  const [empas, setEmpas] = useState("");
  const [refreshTokens, setRefreshTokens] = useState("");
  const [concurrent, setConcurrent] = useState(2);
  const [skipExisting, setSkipExisting] = useState(true);
  const [useProxy, setUseProxy] = useState(false);
  const [captchaBehavior, setCaptchaBehavior] = useState<"skip" | "handle">("skip");

  function handleStart() {
    onStart({
      mode,
      empas,
      refreshTokens,
      concurrent,
      skipExisting,
      useProxy,
      captchaBehavior,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--background)] shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-[var(--border)] p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--primary)]/20">
              <span className="text-xl">⚡</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold">Start {providerLabel} Automation</h2>
              <p className="text-sm text-[var(--muted-foreground)]">{subtitle}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-6 p-6">
          {/* Mode tabs */}
          <div className="flex gap-2 rounded-lg border border-[var(--border)] p-1">
            <button
              onClick={() => setMode("empas")}
              className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${mode === "empas" ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "text-[var(--muted-foreground)] hover:bg-[var(--secondary)]"}`}
            >
              Email:Password
            </button>
            <button
              onClick={() => setMode("refresh-token")}
              className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${mode === "refresh-token" ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "text-[var(--muted-foreground)] hover:bg-[var(--secondary)]"}`}
            >
              Refresh Token
            </button>
          </div>

          {/* Textarea */}
          <Textarea
            rows={6}
            value={mode === "empas" ? empas : refreshTokens}
            onChange={(e) => (mode === "empas" ? setEmpas(e.target.value) : setRefreshTokens(e.target.value))}
            placeholder={mode === "empas" ? "email1@gmail.com:password123\nemail2@gmail.com:password456" : "refresh_token_1\nrefresh_token_2"}
            className="font-mono text-sm"
          />

          {/* CONCURRENT */}
          <div className="rounded-lg border border-[var(--border)] p-4">
            <div className="mb-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Concurrent</div>
              <div className="text-xs text-[var(--muted-foreground)]">How many browsers can run at the same time</div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setConcurrent(Math.max(1, concurrent - 1))}
                className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--secondary)] hover:bg-[var(--secondary)]/80"
              >
                <Minus className="h-4 w-4" />
              </button>
              <Input
                type="number"
                min={1}
                max={8}
                value={concurrent}
                onChange={(e) => setConcurrent(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                className="flex-1 text-center"
              />
              <button
                onClick={() => setConcurrent(Math.min(8, concurrent + 1))}
                className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--secondary)] hover:bg-[var(--secondary)]/80"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Skip existing accounts */}
          <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] p-4 cursor-pointer hover:bg-[var(--secondary)]/50">
            <input
              type="checkbox"
              checked={skipExisting}
              onChange={(e) => setSkipExisting(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-[var(--border)]"
            />
            <div>
              <div className="text-sm font-medium">Skip existing accounts</div>
              <div className="text-xs text-[var(--muted-foreground)]">Skip accounts that are already in the pool</div>
            </div>
          </label>

          {/* Use proxy for login */}
          <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] p-4 cursor-pointer hover:bg-[var(--secondary)]/50">
            <input
              type="checkbox"
              checked={useProxy}
              onChange={(e) => setUseProxy(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-[var(--border)]"
            />
            <div>
              <div className="text-sm font-medium">Use proxy for login</div>
              <div className="text-xs text-[var(--muted-foreground)]">Route browser traffic through configured proxy</div>
            </div>
          </label>

          {/* CAPTCHA BEHAVIOR */}
          <div className="rounded-lg border border-[var(--border)] p-4">
            <div className="mb-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Captcha Behavior</div>
              <div className="text-xs text-[var(--muted-foreground)]">What to do when an account hits a captcha during login</div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setCaptchaBehavior("skip")}
                className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${captchaBehavior === "skip" ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "border border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--secondary)]"}`}
              >
                Skip (mark as failed)
              </button>
              <button
                onClick={() => setCaptchaBehavior("handle")}
                className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${captchaBehavior === "handle" ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "border border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--secondary)]"}`}
              >
                Handle (60s popup)
              </button>
            </div>
            <p className="mt-2 text-xs text-[var(--muted-foreground)]">
              {captchaBehavior === "skip"
                ? "Accounts that hit a captcha are marked failed instantly with reason captcha_skipped."
                : "A popup will appear for 60s to let you solve the captcha manually."}
            </p>
          </div>

          {/* Footer text */}
          <p className="text-xs text-[var(--muted-foreground)]">
            This flow runs as a standalone {providerLabel} automation.
          </p>
        </div>

        {/* Footer buttons */}
        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] p-4">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleStart}>Start</Button>
        </div>
      </div>
    </div>
  );
}
