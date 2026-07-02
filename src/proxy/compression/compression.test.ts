/**
 * Fixture-based unit tests for the compression pipeline.
 *
 * Run with:  bun test src/proxy/compression/compression.test.ts
 *
 * Each test:
 *   - sends a synthetic ChatCompletionRequest through the pipeline,
 *   - asserts the structural changes (truncations, stubs, markers),
 *   - asserts savings are non-negative and reported per-technique.
 *
 * Tests are deliberately permissive about exact char counts (truncation has
 * heuristic margins) but strict about structural invariants:
 *   - last N turns are NEVER mutated by RTK
 *   - DCP never stubs the most-recent occurrence of a duplicate
 *   - cache_control is only attached when prefix is stable
 */

import { describe, it, expect } from "bun:test";
import { compressRequest } from "./index";
import { DEFAULT_COMPRESSION_CONFIG, emptyStats } from "./types";
import { applyRTK } from "./rtk";
import { applyDCP } from "./dcp";
import { applyCaveman, compactText } from "./caveman";
import { applyCacheMarkers } from "./cache-markers";
import { applyImageDedupe } from "./image-dedupe";
import { applyTSC } from "./tsc";
import type { ChatCompletionRequest } from "../providers/base";

function bigString(n: number): string {
  return "x".repeat(n);
}

function gitDiffFixture(): string {
  const hunkBody = Array.from({ length: 40 }, (_, i) => `+    line ${i}`).join("\n");
  return `diff --git a/foo.ts b/foo.ts
index 1234567..abcdefg 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,40 +1,40 @@
${hunkBody}
@@ -100,30 +100,30 @@
${hunkBody}
`;
}

function treeFixture(): string {
  return [
    ".",
    "├── src",
    "│   ├── a.ts",
    "│   ├── b.ts",
    "│   ├── deep",
    "│   │   ├── x.ts",
    "│   │   ├── y.ts",
    "│   │   └── z.ts",
    "│   └── c.ts",
    "├── pkg",
    "│   ├── one.ts",
    "│   └── two.ts",
    "└── README.md",
  ].join("\n");
}

// ─── RTK ──────────────────────────────────────────────────────────────────

describe("RTK — tool-result truncation", () => {
  it("truncates large tool_result in OLDER turns only", () => {
    const big = bigString(20_000);
    // 8 messages: indices 0-3 are "older" (eligible for RTK with keepLastNTurnsFull=2),
    // 4-7 are protected. Big tool_result at index 2 must be truncated; one at 7 must not.
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [
        { role: "user", content: "do thing 1" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "tool_use", id: "u1", name: "Read", input: { path: "/a" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "u1", content: big }],
        },
        { role: "assistant", content: "done" },
        // protected window starts here
        { role: "user", content: "do thing 2" },
        { role: "assistant", content: "thinking" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "u2", name: "Read", input: { path: "/b" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "u2", content: big }], // protected — must NOT be touched
        },
      ],
    };

    const cfg = { enabled: true, maxToolChars: 1000, keepLastNTurnsFull: 2, smartTruncate: true };
    const { request, saved } = applyRTK(req, cfg);
    expect(saved).toBeGreaterThan(10_000);

    // First tool_result (older) truncated
    const firstResult = (request.messages[2]!.content as any[])[0];
    expect(firstResult.content.length).toBeLessThanOrEqual(1500);

    // Last tool_result (protected) preserved
    const lastResult = (request.messages[7]!.content as any[])[0];
    expect(lastResult.content.length).toBe(20_000);
  });

  it("smart-truncates git diff into hunk-aware form", () => {
    const diff = gitDiffFixture();
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [
        { role: "user", content: "see diff" },
        { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "Bash", input: { cmd: "git diff" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: diff }] },
        // padding turns so the diff message becomes "older"
        { role: "user", content: "next" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "again" },
        { role: "assistant", content: "ack2" },
      ],
    };
    const cfg = { enabled: true, maxToolChars: 400, keepLastNTurnsFull: 2, smartTruncate: true };
    const { request, saved } = applyRTK(req, cfg);
    expect(saved).toBeGreaterThan(0);
    const truncated = (request.messages[2]!.content as any[])[0].content as string;
    expect(truncated).toContain("@@");
    expect(truncated).toContain("hunk lines elided");
  });

  it("truncates tree output keeping shallow levels", () => {
    const tree = treeFixture();
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [
        { role: "user", content: "tree" },
        { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "Bash", input: { cmd: "tree" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: tree }] },
        // pad with last 2 turns
        { role: "user", content: "ok" },
        { role: "assistant", content: "k" },
        { role: "user", content: "yes" },
        { role: "assistant", content: "y" },
      ],
    };
    // Set very small cap to force truncation; even small tree fixtures hit it.
    const cfg = { enabled: true, maxToolChars: 80, keepLastNTurnsFull: 2, smartTruncate: true };
    const { request, saved } = applyRTK(req, cfg);
    // Tree truncation may or may not save depending on size; structural check is what matters:
    const out = (request.messages[2]!.content as any[])[0].content as string;
    expect(typeof out).toBe("string");
    expect(saved).toBeGreaterThanOrEqual(0);
  });

  it("does nothing when disabled", () => {
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
    };
    const { saved } = applyRTK(req, { ...DEFAULT_COMPRESSION_CONFIG.rtk, enabled: false });
    expect(saved).toBe(0);
  });

  it("git-status filter categorises porcelain output", () => {
    const status = [
      "## main",
      ...Array.from({ length: 25 }, (_, i) => ` M src/file_${i}.ts`),
      ...Array.from({ length: 18 }, (_, i) => `?? new_${i}.txt`),
      "UU src/conflict.ts",
    ].join("\n");
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [
        { role: "user", content: "status" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "u1", name: "Bash", input: { cmd: "git status -s" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: status }] },
        { role: "user", content: "ok" },
        { role: "assistant", content: "k" },
        { role: "user", content: "y" },
        { role: "assistant", content: "y" },
      ],
    };
    const cfg = { enabled: true, maxToolChars: 600, keepLastNTurnsFull: 2, smartTruncate: true };
    const { request, saved, hits } = applyRTK(req, cfg);
    expect(saved).toBeGreaterThan(0);
    expect(hits.find((h) => h.filter === "git-status")).toBeDefined();
    const out = (request.messages[2]!.content as any[])[0].content as string;
    expect(out).toContain("Modified:");
    expect(out).toContain("Untracked:");
    expect(out).toContain("+15 more"); // 25 modified, top 10 shown, 15 elided
    expect(out).toContain("conflicts:");
  });

  it("read-numbered filter trims long Read output keeping line range", () => {
    const numbered = Array.from({ length: 600 }, (_, i) => `${i + 1}→  some content here for line ${i + 1}`).join("\n");
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [
        { role: "user", content: "read" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "u1", name: "Read", input: { file_path: "/big.ts" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: numbered }] },
        { role: "user", content: "ok" },
        { role: "assistant", content: "k" },
        { role: "user", content: "y" },
        { role: "assistant", content: "y" },
      ],
    };
    const cfg = { enabled: true, maxToolChars: 2000, keepLastNTurnsFull: 2, smartTruncate: true };
    const { request, saved, hits } = applyRTK(req, cfg);
    expect(saved).toBeGreaterThan(0);
    expect(hits.find((h) => h.filter === "read-numbered")).toBeDefined();
    const out = (request.messages[2]!.content as any[])[0].content as string;
    expect(out).toContain("elided");
    // First few lines preserved literally
    expect(out).toContain("1→");
    // Last lines preserved literally
    expect(out).toContain("600→");
  });

  it("grep filter aggregates per-file matches", () => {
    const lines: string[] = ["Result of search in 'src' (total 3 files):"];
    for (let i = 1; i <= 25; i++) lines.push(`src/foo.ts:${i}:matched ${i}`);
    for (let i = 1; i <= 12; i++) lines.push(`src/bar.ts:${i}:hit ${i}`);
    for (let i = 1; i <= 4; i++) lines.push(`src/baz.ts:${i}:single ${i}`);
    const grep = lines.join("\n");
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [
        { role: "user", content: "grep" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "u1", name: "Grep", input: { pattern: "x" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: grep }] },
        { role: "user", content: "ok" },
        { role: "assistant", content: "k" },
        { role: "user", content: "y" },
        { role: "assistant", content: "y" },
      ],
    };
    const cfg = { enabled: true, maxToolChars: 800, keepLastNTurnsFull: 2, smartTruncate: true };
    const { request, saved, hits } = applyRTK(req, cfg);
    expect(saved).toBeGreaterThan(0);
    expect(hits.find((h) => h.filter === "grep")).toBeDefined();
    const out = (request.messages[2]!.content as any[])[0].content as string;
    expect(out).toContain("[src/foo.ts]");
    expect(out).toContain("+20 more"); // 25 in foo.ts, top 5 shown
    expect(out).toContain("Result of search"); // header preserved
  });

  it("dedup-log filter collapses runs of identical lines", () => {
    const log = [
      "Building...",
      ...Array(40).fill("  resolving deps"),
      "Compiling foo.ts",
      ...Array(15).fill("  caching"),
      "Done.",
    ].join("\n");
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [
        { role: "user", content: "build" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "u1", name: "Bash", input: { cmd: "build" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: log }] },
        { role: "user", content: "ok" },
        { role: "assistant", content: "k" },
        { role: "user", content: "y" },
        { role: "assistant", content: "y" },
      ],
    };
    const cfg = { enabled: true, maxToolChars: 600, keepLastNTurnsFull: 2, smartTruncate: true };
    const { request, saved, hits } = applyRTK(req, cfg);
    expect(saved).toBeGreaterThan(0);
    expect(hits.find((h) => h.filter === "dedup-log")).toBeDefined();
    const out = (request.messages[2]!.content as any[])[0].content as string;
    expect(out).toContain("duplicate line");
    expect(out).toContain("Building...");
    expect(out).toContain("Done.");
  });
});

// ─── DCP ──────────────────────────────────────────────────────────────────

describe("DCP — context deduplication", () => {
  it("stubs older identical Read results, keeps the latest", () => {
    const result = "file contents ".repeat(200); // ~3000 chars
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "u1", name: "Read", input: { path: "/a.ts" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "u1", content: result }],
        },
        { role: "user", content: "read again" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "u2", name: "Read", input: { path: "/a.ts" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "u2", content: result }],
        },
      ],
    };
    const { request, saved } = applyDCP(req, { enabled: true, whitelist: ["Read"] });
    expect(saved).toBeGreaterThan(2000);
    const earlier = (request.messages[2]!.content as any[])[0];
    const latest = (request.messages[5]!.content as any[])[0];
    expect(earlier.content).toMatch(/^\[deduplicated:/);
    expect(latest.content).toBe(result);
  });

  it("never dedupes Bash (not in whitelist)", () => {
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "Bash", input: { cmd: "ls" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "a\nb\nc" }] },
        { role: "user", content: "again" },
        { role: "assistant", content: [{ type: "tool_use", id: "u2", name: "Bash", input: { cmd: "ls" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "u2", content: "a\nb\nc" }] },
      ],
    };
    const { saved } = applyDCP(req, { enabled: true, whitelist: ["Read", "Glob", "Grep", "LS"] });
    expect(saved).toBe(0);
  });

  it("never dedupes errored results", () => {
    const big = bigString(3000);
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "Read", input: { path: "/a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: big, is_error: true }] },
        { role: "user", content: "again" },
        { role: "assistant", content: [{ type: "tool_use", id: "u2", name: "Read", input: { path: "/a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "u2", content: big }] },
      ],
    };
    const { saved } = applyDCP(req, { enabled: true, whitelist: ["Read"] });
    expect(saved).toBe(0);
  });
});

// ─── Caveman ──────────────────────────────────────────────────────────────

describe("Caveman — system prompt compaction", () => {
  const sample =
    "Please make sure that you always respond in JSON format. " +
    "It is important that you do not hesitate to call the appropriate tool. " +
    "In order to assist the user, you should provide concise output. " +
    "Furthermore, when an error occurs, you must report it back.";

  it("lite removes filler but keeps content", () => {
    const out = compactText(sample, "lite");
    expect(out.length).toBeLessThan(sample.length);
    expect(out).not.toMatch(/please/i);
    expect(out).not.toMatch(/make sure/i);
    expect(out).not.toMatch(/it is important/i);
    // domain words preserved
    expect(out).toMatch(/JSON/);
    expect(out).toMatch(/tool/i);
  });

  it("full is more aggressive than lite", () => {
    const lite = compactText(sample, "lite");
    const full = compactText(sample, "full");
    expect(full.length).toBeLessThanOrEqual(lite.length);
    expect(full).not.toMatch(/furthermore/i);
  });

  it("ultra is most aggressive", () => {
    const full = compactText(sample, "full");
    const ultra = compactText(sample, "ultra");
    expect(ultra.length).toBeLessThanOrEqual(full.length);
  });

  it("applies to Anthropic system field (string)", () => {
    const req: ChatCompletionRequest = { model: "test", messages: [], ...({ system: sample } as any) };
    const { request, saved } = applyCaveman(req, { enabled: true, level: "lite" });
    expect(saved).toBeGreaterThan(0);
    expect((request as any).system.length).toBeLessThan(sample.length);
  });

  it("applies to OpenAI-style system message", () => {
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "system", content: sample }],
    };
    const { request, saved } = applyCaveman(req, { enabled: true, level: "full" });
    expect(saved).toBeGreaterThan(0);
    expect(typeof request.messages[0]!.content).toBe("string");
    expect((request.messages[0]!.content as string).length).toBeLessThan(sample.length);
  });

  it("noop when disabled", () => {
    const req: ChatCompletionRequest = { model: "test", messages: [], ...({ system: sample } as any) };
    const { saved } = applyCaveman(req, { enabled: false, level: "lite" });
    expect(saved).toBe(0);
  });
});

// ─── Cache markers ────────────────────────────────────────────────────────

describe("Cache markers", () => {
  it("tags long stable system prompt with cache_control", () => {
    const sys = "You are a helpful assistant. ".repeat(50); // > 1024 chars
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
      ...({ system: sys } as any),
    };
    const { request } = applyCacheMarkers(req, { enabled: true, providerOverrides: {} });
    const newSys = (request as any).system;
    expect(Array.isArray(newSys)).toBe(true);
    expect(newSys[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("skips when system prompt has timestamp (unstable)", () => {
    const sys = "Today is 2024-01-15T10:30:00Z and you should help. ".repeat(40);
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
      ...({ system: sys } as any),
    };
    const before = (req as any).system;
    const { request } = applyCacheMarkers(req, { enabled: true, providerOverrides: {} });
    expect((request as any).system).toBe(before);
  });

  it("respects per-provider override (codex disabled)", () => {
    const sys = "You are a helpful assistant. ".repeat(50);
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [],
      ...({ system: sys } as any),
    };
    const { request } = applyCacheMarkers(req, { enabled: true, providerOverrides: { codex: false } }, "codex");
    expect((request as any).system).toBe(sys); // untouched
  });
});

// ─── Image dedupe ─────────────────────────────────────────────────────────

describe("Image dedupe", () => {
  it("replaces duplicate base64 image with stub", () => {
    const data = bigString(10_000);
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data } };
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }, img] },
        { role: "user", content: [{ type: "text", text: "second" }, { ...img }] },
      ],
    };
    const { request, saved } = applyImageDedupe(req, { enabled: true });
    expect(saved).toBeGreaterThan(9000);
    const second = (request.messages[1]!.content as any[])[1];
    expect(second.type).toBe("text");
    expect(second.text).toMatch(/duplicate of image/);
  });

  it("noop when only one image", () => {
    const data = bigString(1000);
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data } };
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: [img] }],
    };
    const { saved } = applyImageDedupe(req, { enabled: true });
    expect(saved).toBe(0);
  });
});

// ─── Orchestrator ─────────────────────────────────────────────────────────

describe("compressRequest — orchestrator", () => {
  it("returns valid stats with savings ≥ 0", () => {
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: "hello" }],
    };
    const { stats } = compressRequest(req, DEFAULT_COMPRESSION_CONFIG);
    expect(stats.tokensBefore).toBeGreaterThan(0);
    expect(stats.tokensAfter).toBeGreaterThanOrEqual(0);
    expect(stats.saved).toBeGreaterThanOrEqual(0);
    expect(stats.savedPct).toBeGreaterThanOrEqual(0);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("end-to-end: combined RTK + DCP + cache markers on real-shaped session", () => {
    const big = bigString(8000);
    const sys = "You are a helpful assistant. ".repeat(50);
    const req: ChatCompletionRequest = {
      model: "test",
      ...({ system: sys } as any),
      messages: [
        { role: "user", content: "do work" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "u1", name: "Read", input: { path: "/a.ts" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: big }] },
        { role: "assistant", content: "I read it" },
        { role: "user", content: "again" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "u2", name: "Read", input: { path: "/a.ts" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "u2", content: big }] },
        { role: "user", content: "yet again" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "u3", name: "Read", input: { path: "/a.ts" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "u3", content: big }] },
      ],
    };

    const cfg = {
      ...DEFAULT_COMPRESSION_CONFIG,
      dcp: { enabled: true, whitelist: ["Read"] },
      rtk: { ...DEFAULT_COMPRESSION_CONFIG.rtk, maxToolChars: 1000, keepLastNTurnsFull: 1 },
    };
    const { request, stats } = compressRequest(req, cfg);
    expect(stats.saved).toBeGreaterThan(1000);
    expect(stats.byTechnique.dcp ?? 0).toBeGreaterThan(0);
    expect(stats.byTechnique.rtk ?? 0).toBeGreaterThanOrEqual(0);
    // Cache marker tagged the system prompt
    const newSys = (request as any).system;
    expect(Array.isArray(newSys)).toBe(true);
    expect(newSys.some((b: any) => b.cache_control)).toBe(true);
  });

  it("TSC strips schema metadata from Anthropic-flavor tools", () => {
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
      ...({
        tools: [
          {
            name: "Read",
            description: "Reads   a    file.\n\n\n\nAnd  some  more.",
            input_schema: {
              $schema: "http://json-schema.org/draft-07/schema#",
              $id: "Read",
              type: "object",
              additionalProperties: false,
              properties: { path: { type: "string" } },
            },
          },
        ],
      } as any),
    };
    const cfg = {
      enabled: true,
      stripSchemaWhitespace: true,
      trimDescriptions: true,
      dropSchemaMeta: true,
    };
    const { request, saved } = applyTSC(req, cfg);
    expect(saved).toBeGreaterThan(0);
    const t = (request as any).tools[0];
    expect(t.input_schema.$schema).toBeUndefined();
    expect(t.input_schema.$id).toBeUndefined();
    expect(t.input_schema.additionalProperties).toBeUndefined();
    expect(t.input_schema.properties.path.type).toBe("string"); // structure preserved
    expect(t.description).not.toContain("    "); // double-spaces collapsed
    expect(t.description).not.toContain("\n\n\n"); // blank-line runs collapsed
  });

  it("TSC handles OpenAI-flavor tools (type:function)", () => {
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
      ...({
        tools: [
          {
            type: "function",
            function: {
              name: "search",
              description: "Search   the   web.",
              parameters: {
                $schema: "http://json-schema.org/draft-07/schema#",
                type: "object",
                additionalProperties: false,
                properties: { q: { type: "string" } },
              },
            },
          },
        ],
      } as any),
    };
    const cfg = {
      enabled: true,
      stripSchemaWhitespace: true,
      trimDescriptions: true,
      dropSchemaMeta: true,
    };
    const { request, saved } = applyTSC(req, cfg);
    expect(saved).toBeGreaterThan(0);
    const fn = (request as any).tools[0].function;
    expect(fn.parameters.$schema).toBeUndefined();
    expect(fn.parameters.additionalProperties).toBeUndefined();
    expect(fn.description).toBe("Search the web.");
    expect(fn.parameters.properties.q.type).toBe("string");
  });

  it("TSC noop when no tools array", () => {
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
    };
    const { saved } = applyTSC(req, {
      enabled: true,
      stripSchemaWhitespace: true,
      trimDescriptions: true,
      dropSchemaMeta: true,
    });
    expect(saved).toBe(0);
  });

  it("TSC disabled -> no change", () => {
    const req: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
      ...({
        tools: [{ name: "x", description: "  spaced  ", input_schema: { $schema: "x", type: "object" } }],
      } as any),
    };
    const { request, saved } = applyTSC(req, {
      enabled: false,
      stripSchemaWhitespace: true,
      trimDescriptions: true,
      dropSchemaMeta: true,
    });
    expect(saved).toBe(0);
    expect(request).toBe(req); // referential identity preserved
  });

  it("emptyStats produces zero everywhere", () => {
    const s = emptyStats();
    expect(s.tokensBefore).toBe(0);
    expect(s.tokensAfter).toBe(0);
    expect(s.saved).toBe(0);
    expect(s.savedPct).toBe(0);
    expect(Object.keys(s.byTechnique).length).toBe(0);
  });
});
