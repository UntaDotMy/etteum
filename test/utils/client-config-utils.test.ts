/**
 * Unit tests for client-config generator utilities:
 *   stripJsonc, upsertRootTomlString, removeTomlSection, escapeTomlString.
 *
 * The module also imports node:fs helpers and pure types; nothing reads env
 * or touches disk at import time, so no env setup is required here.
 */
import { describe, test, expect } from "bun:test";
import {
  stripJsonc,
  upsertRootTomlString,
  removeTomlSection,
  escapeTomlString,
} from "../../src/lib/client-configs/generators/utils";

describe("stripJsonc", () => {
  test("strips single-line comments", () => {
    const input = '{\n  // a comment\n  "a": 1\n}';
    const result = stripJsonc(input);
    expect(result.includes("comment")).toBe(false);
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });

  test("strips block comments", () => {
    const input = '{ /* block\n comment */ "a": 1 }';
    const result = stripJsonc(input);
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });

  test("strips trailing commas in objects and arrays", () => {
    const input = '{\n  "a": 1,\n  "b": [1, 2, 3,],\n}';
    const result = stripJsonc(input);
    expect(JSON.parse(result)).toEqual({ a: 1, b: [1, 2, 3] });
  });

  test("preserves comment-like text inside strings", () => {
    const input = '{"url": "http://example.com", "s": "not // a comment", "t": "not /* a */ comment"}';
    const result = stripJsonc(input);
    expect(JSON.parse(result)).toEqual({
      url: "http://example.com",
      s: "not // a comment",
      t: "not /* a */ comment",
    });
  });

  test("preserves escaped quotes inside strings", () => {
    const input = '{"s": "she said \\"hi\\" // still string"}';
    const result = stripJsonc(input);
    expect(JSON.parse(result)).toEqual({ s: 'she said "hi" // still string' });
  });

  test("handles single-quoted strings without stripping inside them", () => {
    const input = "{ 's': 'not // stripped' }";
    const result = stripJsonc(input);
    expect(result.includes("not // stripped")).toBe(true);
  });

  test("line comment without trailing newline terminates at EOF", () => {
    const input = '{"a": 1} // trailing comment';
    const result = stripJsonc(input);
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });

  test("empty input returns empty string", () => {
    expect(stripJsonc("")).toBe("");
  });

  test("unterminated block comment consumes to EOF", () => {
    const result = stripJsonc('{"a": 1} /* never closed');
    expect(result.includes("never closed")).toBe(false);
  });

  test("plain JSON passes through unchanged", () => {
    const input = '{"a": 1, "b": [true, null]}';
    expect(stripJsonc(input)).toBe(input);
  });
});

describe("escapeTomlString", () => {
  // NOTE: escapeTomlString returns the escaped INNER value only — it does not
  // wrap in quotes. Callers (e.g. upsertRootTomlString) add the surrounding
  // quotes themselves.

  test("escapes backslashes", () => {
    expect(escapeTomlString("C:\\Users\\x")).toBe("C:\\\\Users\\\\x");
  });

  test("escapes double quotes", () => {
    expect(escapeTomlString('say "hi"')).toBe('say \\"hi\\"');
  });

  test("does not escape control chars like newline (characterization)", () => {
    // Only backslash and double-quote are escaped; a raw newline passes
    // through unchanged.
    expect(escapeTomlString("a\nb")).toBe("a\nb");
  });

  test("plain string passes through unchanged", () => {
    expect(escapeTomlString("hello")).toBe("hello");
  });
});

describe("upsertRootTomlString", () => {
  test("inserts a new key into an empty document", () => {
    expect(upsertRootTomlString("", "name", "value")).toBe('name = "value"');
  });

  test("appends a new root key before existing sections", () => {
    const input = "[server]\nport = 1\n";
    const result = upsertRootTomlString(input, "name", "v");
    expect(result.startsWith('name = "v"')).toBe(true);
    expect(result.includes("[server]")).toBe(true);
    // The new key must be a root key: it appears before the first section header.
    expect(result.indexOf('name = "v"')).toBeLessThan(result.indexOf("[server]"));
  });

  test("updates an existing root key in place", () => {
    const input = 'name = "old"\nother = "x"\n[sec]\na = 1\n';
    const result = upsertRootTomlString(input, "name", "new");
    expect(result.includes('name = "new"')).toBe(true);
    expect(result.includes("old")).toBe(false);
    expect(result.includes('other = "x"')).toBe(true);
    expect(result.includes("[sec]")).toBe(true);
  });

  test("does not touch a same-named key inside a section", () => {
    const input = '[server]\nname = "inner"\n';
    const result = upsertRootTomlString(input, "name", "outer");
    expect(result.includes('name = "inner"')).toBe(true);
    expect(result.includes('name = "outer"')).toBe(true);
    // Root key must precede the section.
    expect(result.indexOf('name = "outer"')).toBeLessThan(result.indexOf("[server]"));
  });

  test("value is escaped via escapeTomlString", () => {
    const result = upsertRootTomlString("", "path", "C:\\tmp");
    expect(result).toBe('path = "C:\\\\tmp"');
  });
});

describe("removeTomlSection", () => {
  test("removes a section and its body", () => {
    const input = '[server]\nport = 1\nhost = "x"\n[other]\na = 2\n';
    const result = removeTomlSection(input, "server");
    expect(result.includes("[server]")).toBe(false);
    expect(result.includes("port = 1")).toBe(false);
    expect(result.includes("[other]")).toBe(true);
    expect(result.includes("a = 2")).toBe(true);
  });

  test("removes the last section (no following header)", () => {
    const input = "[keep]\na = 1\n[gone]\nb = 2\n";
    const result = removeTomlSection(input, "gone");
    expect(result).toBe("[keep]\na = 1");
  });

  test("does not remove a section whose name merely prefixes the target", () => {
    const input = "[server-extra]\na = 1\n";
    const result = removeTomlSection(input, "server");
    expect(result.includes("[server-extra]")).toBe(true);
  });

  test("treats regex metacharacters in the section name literally", () => {
    const input = "[a.b]\nx = 1\n[axb]\ny = 2\n";
    const result = removeTomlSection(input, "a.b");
    expect(result.includes("[a.b]")).toBe(false);
    expect(result.includes("[axb]")).toBe(true);
  });

  test("preserves CRLF line endings", () => {
    const input = "[a]\r\nx = 1\r\n[b]\r\ny = 2\r\n";
    const result = removeTomlSection(input, "a");
    expect(result).toBe("[b]\r\ny = 2");
  });

  test("empty input returns empty string", () => {
    expect(removeTomlSection("", "a")).toBe("");
  });

  test("missing section returns content trimmed of trailing whitespace", () => {
    const input = "[a]\nx = 1\n\n\n";
    expect(removeTomlSection(input, "nope")).toBe("[a]\nx = 1");
  });
});
