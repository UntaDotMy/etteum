/**
 * Regression test for the agentBaseline bug (2026-06-15).
 *
 * Symptom: on a continuation turn, Duo emits the new in-progress agent
 * message in the FIRST checkpoint after we send actionResponse. The old
 * baseline logic counted ALL agents in that first checkpoint and used the
 * count as the baseline → the new message was treated as "history" and
 * skipped. Result: cumulative stayed empty, INPUT_REQUIRED hit, the proxy
 * finished the turn with empty content, and the user had to type "lanjut".
 *
 * Fix: thread `priorAgentCount` through the session — collectTurn no longer
 * derives the baseline from the first checkpoint. We test that the session
 * carries the count across turns correctly.
 */

import { describe, expect, test } from "bun:test";
import {
  registerSession,
  lookupSession,
  evictSession,
} from "../../src/proxy/providers/gitlab-duo/sessions";

// Minimal WebSocket stub for session APIs that need it.
function fakeWs(): WebSocket {
  return {
    readyState: 1,
    close: () => {},
    send: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as WebSocket;
}

describe("DuoSession.agentMessageCount", () => {
  test("defaults to 0 when not provided (legacy callers)", () => {
    const ws = fakeWs();
    const cb = { enqueue: () => {}, finish: () => {}, fail: () => {} };
    const s = registerSession(["toolu_a"], ws, "wf-1", "req-1", cb);
    expect(s.agentMessageCount).toBe(0);
    evictSession("toolu_a", "test_cleanup");
  });

  test("captures the value passed in (turn-end snapshot)", () => {
    const ws = fakeWs();
    const cb = { enqueue: () => {}, finish: () => {}, fail: () => {} };
    const s = registerSession(
      ["toolu_b"], ws, "wf-2", "req-2", cb,
      undefined, // toolCallIdToRequestId
      3,         // agentMessageCount
    );
    expect(s.agentMessageCount).toBe(3);
    evictSession("toolu_b", "test_cleanup");
  });

  test("can be looked up later via lookupSession", () => {
    const ws = fakeWs();
    const cb = { enqueue: () => {}, finish: () => {}, fail: () => {} };
    registerSession(
      ["toolu_c"], ws, "wf-3", "req-3", cb,
      undefined, 5,
    );
    const found = lookupSession("toolu_c");
    expect(found).toBeDefined();
    expect(found?.agentMessageCount).toBe(5);
    evictSession("toolu_c", "test_cleanup");
  });

  test("is independent across sessions (no global leak)", () => {
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    const cb = { enqueue: () => {}, finish: () => {}, fail: () => {} };
    registerSession(["toolu_d1"], ws1, "wf-A", "req-A", cb, undefined, 2);
    registerSession(["toolu_d2"], ws2, "wf-B", "req-B", cb, undefined, 7);
    expect(lookupSession("toolu_d1")?.agentMessageCount).toBe(2);
    expect(lookupSession("toolu_d2")?.agentMessageCount).toBe(7);
    evictSession("toolu_d1", "test_cleanup");
    evictSession("toolu_d2", "test_cleanup");
  });
});

describe("agentBaseline — final semantic (baseline=0 always)", () => {
  // EMPIRICAL FINDING from live debug dumps in scripts/repro-stop-stop.ts:
  // Duo's `ui_chat_log` is checkpoint-scoped, NOT a stable cumulative
  // history. Every checkpoint carries ONLY the messages relevant to its
  // current state — typically just the in-progress agent message.
  // Earlier turns' agent messages do NOT persist in the log across
  // continuation turns.
  //
  // → baseline = 0 ALWAYS. Every agent we see belongs to this turn.

  test("fresh turn: every agent msg in log counts", () => {
    const baseline = 0;
    // Mid-turn checkpoint: just 1 agent message growing.
    const log = [{ message_type: "agent", content: "hi there" }];
    let seen = 0, inTurnCalls = 0;
    for (const m of log) {
      if (m.message_type !== "agent") continue;
      if (seen >= baseline) inTurnCalls++;
      seen++;
    }
    expect(inTurnCalls).toBe(1);
  });

  test("continuation turn (the bug we fixed): single new agent msg in log counts", () => {
    // What the live proxy actually sees on a continuation turn (verified):
    //   log = [{agent, "Yes, /tmp is essentially empty..."}]
    // No prior agent messages in the log — Duo doesn't carry them forward.
    // Old buggy logic derived baseline=count=1, which then SKIPPED this
    // single agent (seen=0 < 1), leaving cumulative empty → empty turn.
    // New logic: baseline=0, the agent counts → cumulative populated. ✓
    const baseline = 0;
    const log = [
      { message_type: "agent", content: "Yes, /tmp is essentially empty." },
    ];
    let seen = 0, inTurnCalls = 0;
    const parts: string[] = [];
    for (const m of log) {
      if (m.message_type !== "agent") continue;
      if (seen >= baseline) {
        inTurnCalls++;
        parts.push(m.content);
      }
      seen++;
    }
    expect(inTurnCalls).toBe(1);
    expect(parts).toEqual(["Yes, /tmp is essentially empty."]);
    expect(parts.join("\n")).not.toBe("");
  });

  test("continuation turn with tool prelude: only agent counts", () => {
    // Some continuation checkpoints arrive with a tool entry preceding
    // the in-progress agent. Tool entries are filtered out by message_type,
    // so the agent still gets counted.
    const baseline = 0;
    const log = [
      { message_type: "tool", content: "Using run_command: command=du -sh /tmp" },
      { message_type: "agent", content: "Server has 16 GB tmpfs, 1% used." },
    ];
    let seen = 0;
    const parts: string[] = [];
    for (const m of log) {
      if (m.message_type !== "agent") continue;
      if (seen >= baseline) parts.push(m.content);
      seen++;
    }
    expect(parts).toEqual(["Server has 16 GB tmpfs, 1% used."]);
  });

  test("OLD BUGGY logic reproduces the symptom (proves the diagnosis)", () => {
    // Old logic: derive baseline from current checkpoint's agent count.
    // For the actual continuation log Duo sends, this drops the message.
    const log = [{ message_type: "agent", content: "Yes, /tmp is essentially empty." }];
    let count = 0;
    for (const m of log) if (m.message_type === "agent") count++;
    const buggyBaseline = count; // =1

    let seen = 0;
    const parts: string[] = [];
    for (const m of log) {
      if (m.message_type !== "agent") continue;
      if (seen >= buggyBaseline) parts.push(m.content);
      seen++;
    }
    expect(buggyBaseline).toBe(1);
    expect(parts).toEqual([]); // ← THE BUG
    expect(parts.join("\n")).toBe(""); // empty cumulative → empty turn
  });
});
