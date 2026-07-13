import { useEffect, useRef, useState, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { connectFrameStream, sendBrowserInput, sendCaptchaAnswer, cancelBrowserSession } from "@/lib/browserApi";
import { Loader2, X, Send } from "lucide-react";

interface SessionStep {
  ts: number;
  step: string;
  message: string;
  provider: string;
}

interface SessionInfo {
  sessionId: string;
  accountId: number;
  email: string;
  provider: string;
  phase: string;
  lastMessage: string;
  terminal: boolean;
  hasChallenge: boolean;
  startedAt: number;
  steps?: SessionStep[];
}

interface Challenge {
  image_base64: string;
  image_format: string;
  prompt: string;
  seq: number;
}

interface Props {
  session: SessionInfo;
  challenge: Challenge | null;
}

function stepTone(step: string, message: string): string {
  if (step === "error" || step === "quota_skip" || step === "failed") {
    return "text-[var(--error)] bg-[var(--error)]/10";
  }
  if (step === "success" || step === "authenticated" || step === "tokens") {
    return "text-[var(--success)] bg-[var(--success)]/10";
  }
  if (step === "result") {
    return message.includes("succeed")
      ? "text-[var(--success)] bg-[var(--success)]/10"
      : "text-[var(--error)] bg-[var(--error)]/10";
  }
  if (step === "manual_challenge" || step === "manual_input_waiting") {
    return "text-[var(--warning)] bg-[var(--warning)]/10";
  }
  return "text-[var(--muted-foreground)] bg-[var(--secondary)]";
}

/**
 * Theme-aligned worker card (enowxai layout, etteum tokens).
 * Two content sections: frame + per-worker log.
 */
export function BrowserSessionCard({ session, challenge }: Props) {
  const [frameSrc, setFrameSrc] = useState<string>("");
  const [captchaText, setCaptchaText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (session.terminal) return;
    const cleanup = connectFrameStream(session.sessionId, (base64, format) => {
      if (base64) setFrameSrc(`data:image/${format || "jpeg"};base64,${base64}`);
    });
    return cleanup;
  }, [session.sessionId, session.terminal]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [session.steps?.length]);

  const handlePointer = useCallback((e: React.PointerEvent, action: "down" | "move" | "up") => {
    if (!imgRef.current || session.terminal) return;
    const img = imgRef.current;
    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    void sendBrowserInput(session.sessionId, {
      type: "pointer",
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
      action,
    });
  }, [session.sessionId, session.terminal]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (session.terminal || challenge) return;
    if (e.target instanceof HTMLInputElement) return;
    void sendBrowserInput(session.sessionId, {
      type: "key",
      text: e.key,
      code: e.code,
      action: e.type === "keydown" ? "down" : "up",
    });
  }, [session.sessionId, session.terminal, challenge]);

  async function handleCaptchaSubmit() {
    if (!captchaText.trim()) return;
    setSubmitting(true);
    try {
      await sendCaptchaAnswer(session.sessionId, captchaText.trim());
      setCaptchaText("");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel() {
    await cancelBrowserSession(session.sessionId);
  }

  const phaseColor =
    session.phase === "complete"
      ? "success"
      : session.phase === "failed" || session.phase === "error" || session.phase === "cancelled"
        ? "error"
        : session.phase === "manual_input_waiting"
          ? "warning"
          : "secondary";

  const isGrokWorker =
    session.provider === "grok" &&
    session.sessionId.startsWith("grok-farm-") &&
    /-w\d+$/.test(session.sessionId);
  const showEnded = session.terminal;
  const live = !session.terminal;
  const steps = session.steps || [];

  return (
    <div
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--card-foreground)] shadow-[var(--shadow-card)] transition-shadow",
        live && "hover:shadow-[var(--glow)]",
      )}
    >
      {live && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[var(--primary)]/50 to-transparent" />
      )}

      {/* Identity chrome */}
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--secondary)]/40 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              live
                ? "animate-pulse bg-[var(--primary)]"
                : session.phase === "complete"
                  ? "bg-[var(--success)]"
                  : "bg-[var(--error)]",
            )}
          />
          <span className="truncate text-sm font-medium text-[var(--foreground)]">
            {session.email}
          </span>
          <Badge variant="outline" className="shrink-0 text-[10px] font-normal uppercase tracking-wide">
            {session.provider}
          </Badge>
          {isGrokWorker && (
            <Badge variant="outline" className="shrink-0 text-[10px] font-normal text-[var(--muted-foreground)]">
              headless
            </Badge>
          )}
          <Badge variant={phaseColor as "success" | "error" | "warning" | "secondary"} className="shrink-0">
            {session.phase || "unknown"}
          </Badge>
        </div>
        {!session.terminal && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleCancel()}
            className="h-8 shrink-0 border-[var(--error)]/40 text-[var(--error)] hover:bg-[var(--error)]/10"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Section 1 — Frame */}
      <div
        role="application"
        tabIndex={0}
        aria-label="browser preview"
        onKeyDown={handleKeyDown}
        className="relative flex min-h-[220px] w-full items-center justify-center overflow-hidden bg-[var(--background)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]"
      >
        {frameSrc ? (
          <img
            ref={imgRef}
            src={frameSrc}
            alt="browser frame"
            decoding="async"
            draggable={false}
            onPointerDown={(e) => handlePointer(e, "down")}
            onPointerMove={(e) => {
              if (e.buttons > 0) handlePointer(e, "move");
            }}
            onPointerUp={(e) => handlePointer(e, "up")}
            className={cn(
              "block h-auto max-h-[48vh] w-full object-contain",
              isGrokWorker ? "cursor-default" : "cursor-crosshair",
              showEnded && "opacity-85",
            )}
          />
        ) : showEnded ? (
          <p className="px-4 py-10 text-center text-sm text-[var(--muted-foreground)]">Session ended.</p>
        ) : (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />
            <p className="text-xs text-[var(--muted-foreground)]">Waiting for frame…</p>
          </div>
        )}

        {challenge && !session.terminal && (
          <div className="absolute inset-0 z-10 flex flex-col justify-end bg-[color-mix(in_srgb,var(--background)_72%,transparent)] p-3 backdrop-blur-[2px]">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 shadow-[var(--shadow-card)]">
              <div className="mb-2">
                <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                  Captcha
                </p>
                <p className="text-xs text-[var(--foreground)]">
                  {challenge.prompt || "Type the characters you see"}
                </p>
              </div>
              {challenge.image_base64 && (
                <div className="mb-2 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--secondary)] p-2">
                  <img
                    src={`data:image/${challenge.image_format || "jpeg"};base64,${challenge.image_base64}`}
                    alt="captcha"
                    className="mx-auto max-h-24 w-auto object-contain"
                    decoding="async"
                    draggable={false}
                  />
                </div>
              )}
              <Input
                autoFocus
                value={captchaText}
                onChange={(e) => setCaptchaText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCaptchaSubmit();
                }}
                placeholder="Enter captcha text"
                disabled={submitting}
                className="w-full"
              />
              <div className="mt-3 flex items-center justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => void handleCancel()} disabled={submitting}>
                  Close
                </Button>
                <Button
                  size="sm"
                  onClick={() => void handleCaptchaSubmit()}
                  disabled={!captchaText.trim() || submitting}
                >
                  {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                  Send
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Section 2 — Worker log */}
      <div className="flex max-h-44 min-h-[7.5rem] flex-col border-t border-[var(--border)] bg-[var(--secondary)]/25">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
            Worker log
          </span>
          {session.lastMessage && (
            <span className="max-w-[65%] truncate text-[10px] text-[var(--muted-foreground)]">
              {session.lastMessage}
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {steps.length === 0 ? (
            <p className="text-[11px] text-[var(--muted-foreground)]">
              {showEnded ? "No steps recorded." : "Waiting for progress…"}
            </p>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {steps.map((s, i) => (
                <li key={`${s.ts}-${i}`} className="flex items-start gap-2 text-[11px]">
                  <span className="shrink-0 font-mono tabular-nums text-[var(--muted-foreground)]">
                    {new Date(s.ts).toLocaleTimeString([], { hour12: false })}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      stepTone(s.step, s.message),
                    )}
                  >
                    {s.step}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-[var(--foreground)]">{s.message}</span>
                </li>
              ))}
              <div ref={logEndRef} />
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
