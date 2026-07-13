/**
 * Grok farm multi-worker frame/session routing contract.
 * Pure helpers mirror src/auth/automation/grokFarm.ts worker session ids.
 */
import { describe, expect, test } from "bun:test";

function workerSessionId(jobId: string, workerId: number): string {
  return `${jobId}-w${workerId}`;
}

function parseEtteumJson(line: string): Record<string, unknown> | null {
  const raw = line.replace(/\r/g, "").trimEnd();
  if (!raw.startsWith("ETTEUM_JSON:")) return null;
  try {
    return JSON.parse(raw.slice("ETTEUM_JSON:".length)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe("grok farm multi-worker session ids", () => {
  test("worker session id is jobId-wN", () => {
    expect(workerSessionId("grok-farm-abc", 1)).toBe("grok-farm-abc-w1");
    expect(workerSessionId("grok-farm-abc", 3)).toBe("grok-farm-abc-w3");
  });

  test("concurrency 3 produces three distinct session ids", () => {
    const jobId = "grok-farm-x";
    const sids = [1, 2, 3].map((w) => workerSessionId(jobId, w));
    expect(new Set(sids).size).toBe(3);
    expect(sids.every((s) => s.startsWith(jobId + "-w"))).toBe(true);
  });
});

describe("ETTEUM_JSON frame/progress envelope", () => {
  test("parses frame with workerId", () => {
    const line =
      'ETTEUM_JSON:{"type":"frame","workerId":2,"email":"a@b.com","format":"jpeg","base64":"abc"}';
    const p = parseEtteumJson(line);
    expect(p).not.toBeNull();
    expect(p!.type).toBe("frame");
    expect(p!.workerId).toBe(2);
    expect(p!.base64).toBe("abc");
    expect(workerSessionId("job1", p!.workerId as number)).toBe("job1-w2");
  });

  test("parses progress and worker_done", () => {
    const progress = parseEtteumJson(
      'ETTEUM_JSON:{"type":"progress","workerId":1,"step":"otp","message":"wait","email":"x@y.z"}',
    );
    expect(progress?.type).toBe("progress");
    expect(progress?.step).toBe("otp");

    const done = parseEtteumJson(
      'ETTEUM_JSON:{"type":"worker_done","workerId":1,"ok":true,"email":"x@y.z","message":"ok"}',
    );
    expect(done?.type).toBe("worker_done");
    expect(done?.ok).toBe(true);
  });

  test("ignores non-json and non-prefix lines", () => {
    expect(parseEtteumJson("plain log line")).toBeNull();
    expect(parseEtteumJson("ETTEUM_JSON:not-json")).toBeNull();
  });
});
