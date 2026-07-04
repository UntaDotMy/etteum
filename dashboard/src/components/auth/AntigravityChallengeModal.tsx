import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { submitChallengeAnswer, cancelManualLogin } from "@/lib/api";
import { useWsEvent } from "@/hooks/useWebSocket";
import { Loader2, Send, XCircle } from "lucide-react";

interface ChallengeData {
  accountId: number;
  email?: string;
  challenge_type?: string;
  challenge_seq?: number;
  challenge_image_base64?: string;
  challenge_image_format?: string;
  message?: string;
  prompt?: string;
}

/**
 * Renders a modal whenever a `manual_challenge` WebSocket event arrives from a
 * running antigravity manual-login session (the visible nodriver 'frame').
 * Shows the CAPTCHA image (base64) + a text input; Submit sends the answer to
 * the running script via POST /api/accounts/:id/challenge-answer; Cancel writes
 * the cancel-signal-file via POST /api/accounts/:id/cancel-manual.
 *
 * Mirrors enowxai's manual-challenge modal UX.
 */
export function AntigravityChallengeModal() {
  const [challenge, setChallenge] = useState<ChallengeData | null>(null);
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useWsEvent("manual_challenge", (data: unknown) => {
    const c = data as ChallengeData;
    if (!c || typeof c.accountId !== "number") return;
    setChallenge(c);
    setAnswer("");
  });

  // Clear the modal when the account succeeds/fails (login_success/login_failed).
  useWsEvent("login_success", (data: unknown) => {
    const d = data as { accountId?: number };
    if (challenge && d?.accountId === challenge.accountId) setChallenge(null);
  });
  useWsEvent("login_failed", (data: unknown) => {
    const d = data as { accountId?: number };
    if (challenge && d?.accountId === challenge.accountId) setChallenge(null);
  });

  useEffect(() => {
    if (!challenge) return;
    setAnswer("");
  }, [challenge?.challenge_seq, challenge?.accountId]);

  const open = challenge !== null;

  const handleSubmit = async () => {
    if (!challenge || !answer.trim()) return;
    setSubmitting(true);
    try {
      await submitChallengeAnswer(challenge.accountId, answer.trim());
      // Don't close — the script validates; if wrong, a new challenge_seq arrives.
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!challenge) return;
    setCancelling(true);
    try {
      await cancelManualLogin(challenge.accountId);
    } finally {
      setCancelling(false);
      setChallenge(null);
    }
  };

  const imgSrc = challenge?.challenge_image_base64
    ? `data:image/${challenge.challenge_image_format || "png"};base64,${challenge.challenge_image_base64}`
    : "";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Antigravity — Manual Challenge</DialogTitle>
          <DialogDescription>
            {challenge?.message || "A visible browser window opened. Complete the step shown there, or solve the CAPTCHA below."}
            {challenge?.email ? ` (${challenge.email})` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3 py-2">
          {imgSrc ? (
            <img
              src={imgSrc}
              alt="CAPTCHA"
              className="max-h-40 w-auto rounded border border-[var(--border)] bg-white"
              style={{ imageRendering: "pixelated" }}
            />
          ) : (
            <div className="rounded border border-[var(--border)] bg-[var(--muted)] px-4 py-6 text-center text-sm text-[var(--muted-foreground)]">
              No CAPTCHA image captured. If a browser window is open, complete the step directly in that window.
            </div>
          )}
          <p className="text-xs text-[var(--muted-foreground)]">
            {challenge?.prompt || "Type the characters shown in the image"}
          </p>
          <Input
            autoFocus
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
            placeholder="Enter the characters you see"
            disabled={submitting || cancelling}
          />
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={handleCancel} disabled={cancelling}>
            {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!answer.trim() || submitting || cancelling}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Submit Answer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
