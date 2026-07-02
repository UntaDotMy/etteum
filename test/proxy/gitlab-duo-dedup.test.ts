/**
 * Cross-turn content-dedup regression test (2026-06-15).
 *
 * Bug: Duo's `ui_chat_log` is inconsistently scoped across checkpoints.
 * Sometimes it carries scratch view (just the new agent message), other
 * times it carries full history including completed agent messages from
 * EARLIER turns. Position-based baselines (count-agents-and-skip-N)
 * cannot distinguish the two cases reliably.
 *
 * Fix: track a Set<string> of agent contents we've already streamed on
 * this WS. On each new checkpoint, skip any agent message whose content
 * is in the set — those are history.
 */

import { describe, expect, test } from "bun:test";
import {
  registerSession,
  lookupSession,
  evictSession,
} from "../../src/proxy/providers/gitlab-duo/sessions";

function fakeWs(): WebSocket {
  return {
    readyState: 1, close: () => {}, send: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
  } as unknown as WebSocket;
}

describe("DuoSession.emittedAgentTexts", () => {
  test("defaults to empty set when not provided", () => {
    const ws = fakeWs();
    const cb = { enqueue: () => {}, finish: () => {}, fail: () => {} };
    const s = registerSession(["t1"], ws, "wf1", "r1", cb);
    expect(s.emittedAgentTexts).toBeDefined();
    expect(s.emittedAgentTexts.size).toBe(0);
    evictSession("t1", "test");
  });

  test("captures the set passed in", () => {
    const ws = fakeWs();
    const cb = { enqueue: () => {}, finish: () => {}, fail: () => {} };
    const texts = new Set(["#### Rencana Landing Page", "**Tahap 2 — Tulis index.html**"]);
    const s = registerSession(
      ["t2"], ws, "wf2", "r2", cb,
      undefined, 2, texts,
    );
    expect(s.emittedAgentTexts.size).toBe(2);
    expect(s.emittedAgentTexts.has("#### Rencana Landing Page")).toBe(true);
    expect(s.emittedAgentTexts.has("**Tahap 2 — Tulis index.html**")).toBe(true);
    evictSession("t2", "test");
  });

  test("merges across re-registration on the SAME tool id (carries history)", () => {
    const ws = fakeWs();
    const cb = { enqueue: () => {}, finish: () => {}, fail: () => {} };
    // Turn 1: register with texts A and B.
    registerSession(
      ["t3"], ws, "wf3a", "r3a", cb,
      undefined, 2, new Set(["A", "B"]),
    );
    // Turn 2 consumes that session, then re-registers (same tool id reused
    // in a new tool_use round) with NEW text C. The history A,B must
    // carry forward so dedup keeps working.
    registerSession(
      ["t3"], ws, "wf3b", "r3b", cb,
      undefined, 3, new Set(["C"]),
    );
    const found = lookupSession("t3");
    expect(found?.emittedAgentTexts.size).toBe(3);
    expect(found?.emittedAgentTexts.has("A")).toBe(true);
    expect(found?.emittedAgentTexts.has("B")).toBe(true);
    expect(found?.emittedAgentTexts.has("C")).toBe(true);
    evictSession("t3", "test");
  });
});

describe("Cross-turn dedup semantic", () => {
  // The proxy's collectTurn loop:
  //   for (const m of log) {
  //     if (m.message_type !== "agent") continue;
  //     if (priorEmittedTexts.has(m.content)) continue;  // ← skip history
  //     parts.push(m.content);
  //   }
  //
  // Below we exercise the math against real-shaped checkpoints.

  test("scratch log (single new agent) — content surfaces", () => {
    const priorEmittedTexts = new Set<string>([
      "#### Rencana Landing Page (already-streamed turn 1 content)",
    ]);
    const log = [
      { message_type: "agent", content: "**Tahap 2 — Tulis index.html**" },
    ];
    const parts: string[] = [];
    for (const m of log) {
      if (m.message_type !== "agent") continue;
      if (priorEmittedTexts.has(m.content)) continue;
      parts.push(m.content);
    }
    expect(parts).toEqual(["**Tahap 2 — Tulis index.html**"]);
  });

  test("cumulative log with old agent + new tool — old skipped, no doubling", () => {
    const priorEmittedTexts = new Set<string>([
      "#### Rencana Landing Page\n\nLanding page rental modern.",
    ]);
    const log = [
      { message_type: "user", content: "Buat landing page..." },
      { message_type: "agent", content: "#### Rencana Landing Page\n\nLanding page rental modern." },  // OLD
      { message_type: "tool", content: "Using run_command: mkdir -p /tmp/sewa" },
      { message_type: "agent", content: "**Tahap 2** — sekarang tulis HTML." }, // NEW
    ];
    const parts: string[] = [];
    for (const m of log) {
      if (m.message_type !== "agent") continue;
      if (priorEmittedTexts.has(m.content)) continue;
      parts.push(m.content);
    }
    expect(parts).toEqual(["**Tahap 2** — sekarang tulis HTML."]);
  });

  test("cumulative log with old agent + NO new agent (pure tool turn) — empty parts", () => {
    const priorEmittedTexts = new Set<string>([
      "#### Rencana ...",
    ]);
    const log = [
      { message_type: "agent", content: "#### Rencana ..." },  // OLD
      { message_type: "tool", content: "Using run_command: ls" },
    ];
    const parts: string[] = [];
    for (const m of log) {
      if (m.message_type !== "agent") continue;
      if (priorEmittedTexts.has(m.content)) continue;
      parts.push(m.content);
    }
    expect(parts).toEqual([]);
  });

  test("OLD position-based logic would HAVE re-emitted history — proves dedup needed", () => {
    // No prior tracking → old agent message gets re-emitted → user sees
    // the same paragraph twice in chat (the user's screenshot symptom).
    const log = [
      { message_type: "user", content: "Buat landing page..." },
      { message_type: "agent", content: "#### Rencana Landing Page (already-streamed)" },
      { message_type: "tool", content: "tool" },
      { message_type: "agent", content: "Sekarang lanjut ke tahap berikutnya." },
    ];
    // Buggy: baseline=0, NO content tracking — emit BOTH agents.
    const parts: string[] = [];
    for (const m of log) {
      if (m.message_type !== "agent") continue;
      parts.push(m.content);
    }
    expect(parts.length).toBe(2);
    expect(parts[0]).toContain("Rencana Landing Page"); // ← bug: re-emitting history
  });
});
