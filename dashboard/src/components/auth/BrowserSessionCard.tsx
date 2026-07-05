import { useEffect, useRef, useState, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { connectFrameStream, sendBrowserInput, sendCaptchaAnswer, cancelBrowserSession } from "@/lib/browserApi";
import { Loader2, X, Send, Globe } from "lucide-react";

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

export function BrowserSessionCard({ session, challenge }: Props) {
  const [frameSrc, setFrameSrc] = useState<string>("");
  const [captchaText, setCaptchaText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Connect to the SSE frame stream. Renders frames as a base64 data-URI —
  // this matches the ennowxai frame contract byte-for-byte: the server sends
  // {base64, format} with RAW base64 (no data: prefix), and the client builds
  // `data:image/${format};base64,${base64}`.
  useEffect(() => {
    if (session.terminal) return;
    const cleanup = connectFrameStream(session.sessionId, (base64, format) => {
      if (base64) setFrameSrc(`data:image/${format || "jpeg"};base64,${base64}`);
    });
    return cleanup;
  }, [session.sessionId, session.terminal]);

  // Pointer event forwarding: compute relative coords scaled to the browser viewport.
  const handlePointer = useCallback((e: React.PointerEvent, action: "down" | "move" | "up") => {
    if (!imgRef.current || session.terminal) return;
    const img = imgRef.current;
    const rect = img.getBoundingClientRect();
    // The image uses objectFit: contain, so scale from displayed size to natural size.
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    void sendBrowserInput(session.sessionId, { type: "pointer", x: Math.round(x), y: Math.round(y), action });
  }, [session.sessionId, session.terminal]);

  // Keyboard forwarding.
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (session.terminal || challenge) return;
    // Don't forward if focus is in the captcha input.
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

  const phaseColor = session.phase === "complete" ? "success" : session.phase === "failed" ? "error" : session.phase === "manual_input_waiting" ? "warning" : "secondary";
  const showSpinner = !frameSrc && !session.terminal;
  const showEnded = session.terminal;

  return (
    <div className="relative rounded-xl border border-[var(--border)] bg-[var(--card)] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
            <span className="font-mono text-[var(--foreground)]" title={session.sessionId}>{session.sessionId.slice(0, 16)}</span>
            <span className="font-mono text-[var(--muted-foreground)] truncate">{session.email}</span>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={phaseColor as any}>{session.phase || "unknown"}</Badge>
            {session.lastMessage && <p className="truncate text-xs text-[var(--muted-foreground)]">{session.lastMessage}</p>}
          </div>
        </div>
        {!session.terminal && (
          <Button variant="outline" size="sm" onClick={handleCancel} className="shrink-0 text-[var(--error)]">
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>

      {/* Browser surface */}
      <div
        ref={containerRef}
        role="application"
        tabIndex={0}
        aria-label="nodriver browser input surface"
        onKeyDown={handleKeyDown}
        className="relative flex w-full items-center justify-center overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--background)] outline-none focus-visible:border-[var(--primary)]"
        style={{ minHeight: "200px" }}
      >
        {frameSrc && !showEnded ? (
          <img
            ref={imgRef}
            src={frameSrc}
            alt="nodriver browser frame"
            decoding="async"
            draggable={false}
            onPointerDown={(e) => handlePointer(e, "down")}
            onPointerMove={(e) => { if (e.buttons > 0) handlePointer(e, "move"); }}
            onPointerUp={(e) => handlePointer(e, "up")}
            style={{ display: "block", width: "100%", height: "auto", maxHeight: "60vh", objectFit: "contain", cursor: "crosshair" }}
          />
        ) : showEnded ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <p className="text-sm text-[var(--muted-foreground)]">Browser frame ended with the session.</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />
            <p className="text-xs text-[var(--muted-foreground)]">Waiting for browser frame...</p>
          </div>
        )}

        {/* Captcha overlay */}
        {challenge && !session.terminal && (
          <div className="absolute inset-0 z-10 flex flex-col justify-end bg-black/70 p-3">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)]/95 p-3 backdrop-blur-sm">
              <div className="mb-2">
                <p className="text-[10px] font-mono text-[var(--muted-foreground)]">Captcha input</p>
                <p className="text-xs text-[var(--foreground)]">{challenge.prompt || "Type the characters you see"}</p>
              </div>
              {challenge.image_base64 && (
                <div className="mb-2 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--background)]/80 p-2">
                  <img
                    src={`data:image/${challenge.image_format || "jpeg"};base64,${challenge.image_base64}`}
                    alt="captcha preview"
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
                onKeyDown={(e) => { if (e.key === "Enter") handleCaptchaSubmit(); }}
                placeholder="Enter captcha text"
                disabled={submitting}
                className="w-full"
              />
              <p className="mt-2 text-[11px] text-[var(--muted-foreground)]">Text will be submitted to this browser only.</p>
              <div className="mt-3 flex items-center justify-end gap-2">
                <Button variant="outline" size="sm" onClick={handleCancel} disabled={submitting}>Close</Button>
                <Button size="sm" onClick={handleCaptchaSubmit} disabled={!captchaText.trim() || submitting}>
                  {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                  Send captcha
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Step timeline — the structured automation log (per-step progress/error/result) */}
      {session.steps && session.steps.length > 0 && (
        <div className="max-h-32 overflow-y-auto border-t border-[var(--border)] px-3 py-2">
          <div className="mb-1 text-[10px] font-mono uppercase tracking-wide text-[var(--muted-foreground)]">
            Automation log
          </div>
          <ol className="flex flex-col gap-1">
            {session.steps.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px] font-mono">
                <span className="shrink-0 text-[var(--muted-foreground)]">
                  {new Date(s.ts).toLocaleTimeString([], { hour12: false })}
                </span>
                <span
                  className="shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold uppercase"
                  style={{
                    color:
                      s.step === "error" || s.step === "quota_skip" ? "var(--error)" :
                      s.step === "result" ? (s.message.includes("succeed") ? "var(--success)" : "var(--error)") :
                      s.step === "authenticated" || s.step === "tokens" ? "var(--success)" :
                      "var(--muted-foreground)",
                  }}
                >
                  {s.step}
                </span>
                <span className="min-w-0 flex-1 break-words text-[var(--foreground)]">{s.message}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
