/**
 * safeJsonParse regression tests — Windows/PowerShell/cmd tool-call arguments.
 *
 * LLMs frequently emit tool arguments containing Windows paths with UNESCAPED
 * backslashes (`C:\Users\...`) which break JSON.parse (invalid `\U` escape) or,
 * worse, get silently corrupted (`C:\test\node` → tab + newline). safeJsonParse
 * repairs these on a fallback pass. These tests pin both the happy paths and
 * two previously-broken cases:
 *
 *   Bug 1 — a command mixing a REAL newline escape (`\n`) with an unescaped
 *           Windows path had its `\n` corrupted to a literal backslash-n.
 *   Bug 2 — a path ending in a trailing backslash (`C:\Users\HP\`) failed to
 *           parse at all (returned undefined).
 */
import { describe, test, expect } from "bun:test";
import { safeJsonParse } from "../../src/utils/safe-json";

describe("safeJsonParse — Windows paths", () => {
  test("already-valid double-backslash path is untouched", () => {
    const r = safeJsonParse<{ command: string }>('{"command":"ls C:\\\\Users\\\\HP\\\\test"}');
    expect(r?.command).toBe("ls C:\\Users\\HP\\test");
  });

  test("unescaped \\U \\H path is repaired", () => {
    const r = safeJsonParse<{ command: string }>('{"command":"ls C:\\Users\\HP\\test"}');
    expect(r?.command).toBe("ls C:\\Users\\HP\\test");
  });

  test("bare path value with invalid escapes", () => {
    const r = safeJsonParse<{ path: string }>('{"path":"C:\\Users\\HP\\proj\\file.ts"}');
    expect(r?.path).toBe("C:\\Users\\HP\\proj\\file.ts");
  });

  test("trailing backslash before closing quote (Bug 2)", () => {
    const r = safeJsonParse<{ path: string }>('{"path":"C:\\Users\\HP\\"}');
    expect(r?.path).toBe("C:\\Users\\HP\\");
  });

  test("trailing backslash on a valid escaped path", () => {
    const r = safeJsonParse<{ path: string }>('{"path":"C:\\\\Users\\\\HP\\\\"}');
    expect(r?.path).toBe("C:\\Users\\HP\\");
  });
});

describe("safeJsonParse — escapes must survive the repair pass", () => {
  test("mixed real \\n newline + unescaped Windows path (Bug 1)", () => {
    const r = safeJsonParse<{ command: string }>(
      '{"command":"echo line1\\nline2 && cd C:\\Users\\HP"}',
    );
    expect(r?.command).toBe("echo line1\nline2 && cd C:\\Users\\HP");
  });

  test("PowerShell pipeline with real newline + path", () => {
    const r = safeJsonParse<{ command: string }>(
      '{"command":"Get-ChildItem C:\\Users\\HP\\proj | Out-String\\necho done"}',
    );
    expect(r?.command).toBe("Get-ChildItem C:\\Users\\HP\\proj | Out-String\necho done");
    expect(r?.command).toContain("\n");
    expect(r?.command).not.toContain("\\n");
  });

  test("\\t inside a Windows path resolves to a literal separator", () => {
    const r = safeJsonParse<{ command: string }>('{"command":"cd C:\\Users\\HP\\test"}');
    expect(r?.command).toBe("cd C:\\Users\\HP\\test");
  });

  test("unicode escape \\u0041 survives repair alongside a path", () => {
    const r = safeJsonParse<{ v: string }>('{"v":"\\u0041 C:\\Users"}');
    expect(r?.v).toBe("A C:\\Users");
  });
});

describe("safeJsonParse — cmd / powershell quoting", () => {
  test('cmd /c with quoted "Program Files" path', () => {
    const r = safeJsonParse<{ command: string }>(
      '{"command":"cmd /c \\"C:\\\\Program Files\\\\app\\\\run.exe\\""}',
    );
    expect(r?.command).toBe('cmd /c "C:\\Program Files\\app\\run.exe"');
  });

  test("PowerShell $env var + unescaped path", () => {
    const r = safeJsonParse<{ command: string }>(
      '{"command":"echo $env:USERPROFILE && type C:\\Users\\HP\\file.txt"}',
    );
    expect(r?.command).toBe("echo $env:USERPROFILE && type C:\\Users\\HP\\file.txt");
  });

  test("regex \\d (valid escape) passes through untouched", () => {
    const r = safeJsonParse<{ pattern: string }>('{"pattern":"\\\\d+"}');
    expect(r?.pattern).toBe("\\d+");
  });
});

describe("safeJsonParse — fallbacks", () => {
  test("malformed JSON returns fallback", () => {
    expect(safeJsonParse('{"a": "unterminated')).toBeUndefined();
    expect(safeJsonParse('{"a": "unterminated', { a: "" })).toEqual({ a: "" });
  });

  test("non-JSON returns fallback", () => {
    expect(safeJsonParse("not json at all")).toBeUndefined();
  });

  test("empty object string parses", () => {
    expect(safeJsonParse<Record<string, unknown>>("{}")).toEqual({});
  });
});
