import { describe, expect, test } from "bun:test";
import {
  createProviderProgressState,
  noteProgressEnqueued,
  noteProgressFinished,
  shouldResetProviderProgress,
} from "../../src/auth/warmup-queue";

/**
 * Simulates the open-generation policy used by enqueueBulk:
 * if generation is open and id already finished → skip re-queue.
 */
function wouldRequeue(
  state: ReturnType<typeof createProviderProgressState>,
  accountId: number,
): boolean {
  if (!shouldResetProviderProgress(state) && state.finished.has(accountId)) {
    return false;
  }
  return true;
}

describe("warmup progress unique-account counters", () => {
  test("re-enqueue same account does not inflate total (647×3 ≠ 2000+)", () => {
    const s = createProviderProgressState();
    for (let i = 1; i <= 647; i++) noteProgressEnqueued(s, i);
    expect(s.total).toBe(647);

    // Mid-batch re-queue (reset-tick) of the same fleet
    for (let i = 1; i <= 647; i++) noteProgressEnqueued(s, i);
    for (let i = 1; i <= 647; i++) noteProgressEnqueued(s, i);
    expect(s.total).toBe(647);
  });

  test("finish same account twice does not inflate completed", () => {
    const s = createProviderProgressState();
    noteProgressEnqueued(s, 1);
    noteProgressEnqueued(s, 2);
    noteProgressFinished(s, 1);
    noteProgressFinished(s, 1);
    noteProgressFinished(s, 2);
    expect(s.completed).toBe(2);
    expect(s.total).toBe(2);
  });

  test("shouldReset only when generation complete", () => {
    expect(shouldResetProviderProgress(undefined)).toBe(true);
    const s = createProviderProgressState();
    noteProgressEnqueued(s, 1);
    expect(shouldResetProviderProgress(s)).toBe(false);
    noteProgressFinished(s, 1);
    expect(shouldResetProviderProgress(s)).toBe(true);
  });

  test("finished ids are not re-queued mid-generation (reset-tick simulation)", () => {
    const s = createProviderProgressState();
    for (let i = 1; i <= 100; i++) noteProgressEnqueued(s, i);
    // First 40 finish
    for (let i = 1; i <= 40; i++) noteProgressFinished(s, i);
    expect(s.completed).toBe(40);
    expect(s.total).toBe(100);

    // Reset-tick tries to re-add finished + unfinished
    let requeued = 0;
    for (let i = 1; i <= 100; i++) {
      if (!wouldRequeue(s, i)) continue;
      // still active in queue would also block; here only finished policy
      noteProgressEnqueued(s, i);
      requeued++;
    }
    // Only unfinished 41–100 would be candidates; already in seen so total unchanged
    expect(s.total).toBe(100);
    expect(requeued).toBe(60); // unfinished may "requeue" but total stays 100
    expect(wouldRequeue(s, 1)).toBe(false);
    expect(wouldRequeue(s, 50)).toBe(true);
  });

  test("new generation after complete allows full re-queue", () => {
    let s = createProviderProgressState();
    noteProgressEnqueued(s, 1);
    noteProgressFinished(s, 1);
    expect(shouldResetProviderProgress(s)).toBe(true);
    s = createProviderProgressState();
    noteProgressEnqueued(s, 1);
    expect(s.total).toBe(1);
    expect(s.completed).toBe(0);
  });

  test("mid-batch expand with brand-new accounts grows total correctly", () => {
    const s = createProviderProgressState();
    for (let i = 1; i <= 100; i++) noteProgressEnqueued(s, i);
    for (let i = 101; i <= 110; i++) noteProgressEnqueued(s, i);
    expect(s.total).toBe(110);
  });
});

