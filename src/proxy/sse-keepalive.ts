/**
 * SSE keepalive for long streaming responses.
 *
 * Two layers:
 *   1. Wire keepalive — SSE comment frames (`: keepalive …\n\n`). Keeps
 *      Bun.serve idleTimeout (255s) and reverse proxies from cutting an idle
 *      TCP connection. Spec-compliant clients ignore comments.
 *   2. Protocol activity — real SSE events the *client's* stream-idle
 *      watchdog can see. Claude Code aborts after ~5 min with no non-ping
 *      stream events (`StreamIdleTimeoutError` → "API Error: Response stalled
 *      mid-stream"). Its SSE parser skips `event: ping` before the consumer
 *      loop, so ping alone does NOT reset that timer. Callers must supply a
 *      protocol-level event (Anthropic `message_delta`, OpenAI empty delta,
 *      Responses `response.in_progress`, …).
 */

const encoder = new TextEncoder();

export type SseKeepaliveHandle = {
  /** Call after every real write so quiet-only keepalives stay quiet when chatty. */
  touch: () => void;
  stop: () => void;
};

export type SseKeepaliveOptions = {
  /**
   * Protocol-level activity frame. Invoked on the same quiet schedule as the
   * comment keepalive. Must enqueue a real SSE event (not a comment, not
   * Anthropic `ping`) so client event-idle watchdogs reset.
   */
  activity?: () => void;
};

/**
 * Start a keepalive timer that, when the stream has been quiet for
 * `intervalMs`:
 *   - always enqueues `: keepalive <ts>\n\n` (wire warmth)
 *   - optionally calls `activity()` for protocol-level client idle reset
 *
 * Returns touch/stop; always call stop() in a finally block.
 *
 * @param enqueue - write bytes to the client stream (must not throw permanently)
 * @param intervalMs - quiet threshold; <=0 disables (no-op handle)
 */
export function startSseKeepalive(
  enqueue: (bytes: Uint8Array) => void,
  intervalMs: number,
  options?: SseKeepaliveOptions,
): SseKeepaliveHandle {
  if (!intervalMs || intervalMs <= 0) {
    return { touch: () => {}, stop: () => {} };
  }

  let lastWrite = Date.now();
  // Tick at half the quiet window (min 1ms). Production default 15s → ~7.5s.
  // No 1s floor: short test intervals need sub-second ticks, and production
  // intervals are already multi-second so we never spin.
  const tickMs = Math.max(1, Math.floor(intervalMs / 2));
  const activity = options?.activity;
  const timer = setInterval(() => {
    if (Date.now() - lastWrite < intervalMs) return;
    try {
      // Protocol activity FIRST so a client that only counts events still
      // sees a frame even if the subsequent comment enqueue fails.
      if (activity) {
        try {
          activity();
        } catch {
          /* stream closed or activity failed */
        }
      }
      enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
      lastWrite = Date.now();
    } catch {
      /* stream closed */
    }
  }, tickMs);

  return {
    touch: () => {
      lastWrite = Date.now();
    },
    stop: () => {
      clearInterval(timer);
    },
  };
}
