import { describe, test, expect } from "bun:test";
import { parseSseEvents } from "./responses-proxy";

// NOTE: this previously re-implemented parseSseEvents as a "spec mirror" and
// only asserted the module loaded. It now tests the REAL exported parser, so
// the SSE-wire-format contract is actually pinned (including the multi-line
// data: join + single-space-strip fix per the WHATWG event-stream spec).

describe("responses-proxy module", () => {
  test("loads without error (imports resolve)", () => {
    // If any import in responses-proxy.ts is broken, this file fails to load.
    expect(true).toBe(true);
  });
});

describe("parseSseEvents (real implementation)", () => {
  test("parses a single response.create event", () => {
    const frame = 'event: response.create\ndata: {"type":"response.create","response":{"model":"gpt-5","input":"hi"}}\n\n';
    const events = parseSseEvents(frame);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("response.create");
    expect(JSON.parse(events[0].data).response.model).toBe("gpt-5");
  });

  test("parses multiple events in one buffer", () => {
    const frame =
      'event: response.created\ndata: {"id":"resp_1"}\n\n' +
      'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n' +
      'event: response.completed\ndata: {"id":"resp_1","status":"completed"}\n\n';
    const events = parseSseEvents(frame);
    expect(events.map((e) => e.event)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(JSON.parse(events[2].data).status).toBe("completed");
  });

  test("joins multiple data: lines with \\n (WHATWG spec) and strips only one leading space", () => {
    // Two data: lines must join with a single \n between values (not concat
    // with no separator, which the old code did). Also: only ONE leading space
    // is stripped, so " data:  two" → value " two" (leading-space strip is once).
    const frame = 'event: response.create\ndata: line1\ndata: line2\n\n';
    const events = parseSseEvents(frame);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("line1\nline2");
  });

  test("strips only one leading space from a data: value", () => {
    // Per spec: strip exactly one U+0020 after "data:". "data:  x" → " x".
    const frame = 'event: e\ndata:  x\n\n';
    const events = parseSseEvents(frame);
    expect(events[0].data).toBe(" x");
  });

  test("ignores blocks with no event field", () => {
    const frame = 'data: {"no":"event"}\n\n';
    const events = parseSseEvents(frame);
    expect(events).toHaveLength(0);
  });

  test("handles empty / whitespace input", () => {
    expect(parseSseEvents("")).toEqual([]);
    expect(parseSseEvents("\n\n  \n\n")).toEqual([]);
  });
});
