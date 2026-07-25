/**
 * SSE comment-frame keepalive for long streaming responses.
 *
 * Bun.serve idleTimeout (255s hard cap) and many reverse proxies cut idle
 * HTTP responses. Claude thinking / tool waits can silence the wire for
 * minutes — without keepalive the client connection dies mid-request and
 * the answer looks like it "stopped with no reason".
 *
 * Spec-compliant SSE clients ignore comment lines (`: …\n\n`).
 */

const encoder = new TextEncoder();

export type SseKeepaliveHandle = {
  /** Call after every real write so quiet-only keepalives stay quiet when chatty. */
  touch: () => void;
  stop: () => void;
};

/**
 * Start a keepalive timer that enqueues `: keepalive <ts>\n\n` when the stream
 * has been quiet for `intervalMs`. Returns touch/stop; always call stop() in
 * a finally block.
 *
 * @param enqueue - write bytes to the client stream (must not throw permanently)
 * @param intervalMs - quiet threshold; <=0 disables (no-op handle)
 */
export function startSseKeepalive(
  enqueue: (bytes: Uint8Array) => void,
  intervalMs: number,
): SseKeepaliveHandle {
  if (!intervalMs || intervalMs <= 0) {
    return { touch: () => {}, stop: () => {} };
  }

  let lastWrite = Date.now();
  // Tick at half the quiet window (min 1ms). Production default 15s → ~7.5s.
  // No 1s floor: short test intervals need sub-second ticks, and production
  // intervals are already multi-second so we never spin.
  const tickMs = Math.max(1, Math.floor(intervalMs / 2));
  const timer = setInterval(() => {
    if (Date.now() - lastWrite < intervalMs) return;
    try {
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
