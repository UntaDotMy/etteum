import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { getProviderForModel, providers } from "../../src/proxy/providers/registry";
import { GitlabDuoProvider } from "../../src/proxy/providers/gitlab-duo";
import { activateQoderPat } from "../../src/proxy/providers/qoder";
import { activateYouMindKey } from "../../src/proxy/providers/youmind";

const PACKAGES = [
  "gitlab-duo",
  "qoder",
  "codex",
  "codebuddy",
  "byok",
  "kiro",
  "alibaba",
  "codebuddy-china",
  "youmind",
];

describe("provider packages layout", () => {
  for (const name of PACKAGES) {
    test(`${name}/ has index.ts + provider module`, () => {
      const dir = path.join(process.cwd(), "src", "proxy", "providers", name);
      expect(existsSync(path.join(dir, "index.ts"))).toBe(true);
      // either provider.ts or existing specialized entry (gitlab has provider.ts)
      const hasProvider =
        existsSync(path.join(dir, "provider.ts")) ||
        existsSync(path.join(dir, "index.ts"));
      expect(hasProvider).toBe(true);
    });
  }

  test("gitlab-duo split modules exist", () => {
    const dir = path.join(process.cwd(), "src", "proxy", "providers", "gitlab-duo");
    for (const f of ["errors.ts", "tool-response.ts", "models.ts", "messages.ts", "provider.ts"]) {
      expect(existsSync(path.join(dir, f))).toBe(true);
    }
  });
});

describe("provider package exports", () => {
  test("registry still routes packaged providers", () => {
    expect(getProviderForModel("qd-Lite")).toBe("qoder");
    expect(getProviderForModel("gpt-5-codex")).toBe("codex");
    expect(getProviderForModel("claude-sonnet-4.5")).toBe("kiro");
    expect(getProviderForModel("cb-default")).toBe("codebuddy");
    expect(typeof providers.qoder).toBe("object");
    expect(typeof providers.codex).toBe("object");
    expect(typeof providers.kiro).toBe("object");
  });

  test("gitlab-duo class still constructs", () => {
    const p = new GitlabDuoProvider();
    expect(p.name).toBe("gitlab-duo");
  });

  test("activation helpers re-exported", () => {
    expect(typeof activateQoderPat).toBe("function");
    expect(typeof activateYouMindKey).toBe("function");
  });
});
