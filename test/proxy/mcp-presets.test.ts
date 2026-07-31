import { describe, expect, test } from "bun:test";
import path from "node:path";
import { buildLocalStdioPlugins } from "../../src/proxy/mcp/stdioSseBridge";

const SAFE_ROOT = path.join(process.cwd(), "mcp-test-root");

describe("local MCP presets", () => {
  test("filesystem MCP is disabled until an operator sets an explicit root", () => {
    expect(buildLocalStdioPlugins({})).toEqual([]);
  });

  test("rejects relative roots and roots that expose the working directory", () => {
    expect(() => buildLocalStdioPlugins({ MCP_FILESYSTEM_ROOT: "." })).toThrow("absolute path");
    expect(() => buildLocalStdioPlugins({ MCP_FILESYSTEM_ROOT: process.cwd() })).toThrow("working directory");
    expect(() => buildLocalStdioPlugins({ MCP_FILESYSTEM_ROOT: path.dirname(process.cwd()) })).toThrow("working directory");
  });

  test("pin every npx package to an exact version", () => {
    for (const plugin of buildLocalStdioPlugins({ MCP_FILESYSTEM_ROOT: SAFE_ROOT })) {
      if (plugin.command !== "npx") continue;
      const packageArg = plugin.args.find((arg) => !arg.startsWith("-"));
      expect(packageArg).toBeDefined();
      expect(packageArg).toMatch(/^@[^/]+\/[^@]+@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
      expect(packageArg).not.toContain("@latest");
      expect(packageArg).not.toContain("@next");
    }
  });

  test("does not advertise removed or unpublished presets", () => {
    expect(buildLocalStdioPlugins({ MCP_FILESYSTEM_ROOT: SAFE_ROOT }).map((plugin) => plugin.name)).toEqual(["filesystem"]);
  });
});
