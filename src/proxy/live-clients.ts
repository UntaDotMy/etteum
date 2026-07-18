/**
 * Process-level in-flight client request counter for the friend share board.
 *
 * Distinct from pool.trackRequest* (per-account load balancing). This counts
 * concurrent chat completions the proxy is currently serving — streams stay
 * open until finalize, non-streams until the response is fully built.
 */

let active = 0;

/** Begin tracking one client-facing request. Returns an end() that is idempotent. */
export function trackClientRequestStart(): () => void {
  active += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    active = Math.max(0, active - 1);
  };
}

/** Current number of in-flight client requests (stream + non-stream). */
export function getActiveClientRequests(): number {
  return active;
}

/** Test-only reset. */
export function __resetActiveClientRequestsForTests(): void {
  active = 0;
}
