/**
 * Admin-origin resolution + guard behaviour.
 *
 * Pins two audit fixes:
 *   §4.3  adminGuard() (header-only) could never allow a local request, so
 *         POST /api/settings, /api/sync/export and /api/tunnel/enable were
 *         permanently 403. adminGuardFromPeer must allow loopback.
 *   §W1b  scripts/serve-dashboard.ts forwards /api/* from loopback. Without an
 *         X-Forwarded-For stamp every remote caller looked local, which handed
 *         them /api/update/apply (RCE) and /api/backup/* (.env + ENCRYPTION_KEY).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  adminGuard,
  adminGuardFromPeer,
  effectiveAdminOriginIp,
  isLocalOriginFromPeer,
} from "../../src/utils/security";

const ENV_KEYS = ["TRUST_PROXY", "ALLOW_REMOTE_ADMIN", "CLI_ADMIN_TOKEN", "ETTEUM_CLI_TOKEN"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const h = (init?: Record<string, string>) => new Headers(init);

describe("effectiveAdminOriginIp", () => {
  test("a non-loopback peer wins over any x-forwarded-for", () => {
    expect(effectiveAdminOriginIp("203.0.113.9", h({ "x-forwarded-for": "127.0.0.1" })))
      .toBe("203.0.113.9");
  });

  test("loopback peer with no XFF is a genuinely local caller", () => {
    expect(effectiveAdminOriginIp("127.0.0.1", h())).toBe("127.0.0.1");
  });

  test("loopback peer + stamped XFF resolves to the real client (local proxy hop)", () => {
    expect(effectiveAdminOriginIp("127.0.0.1", h({ "x-forwarded-for": "203.0.113.9" })))
      .toBe("203.0.113.9");
  });

  test("only the first hop of an XFF chain is used", () => {
    expect(effectiveAdminOriginIp("127.0.0.1", h({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })))
      .toBe("203.0.113.9");
  });

  test("no peer and no trusted proxy cannot prove an origin", () => {
    expect(effectiveAdminOriginIp(null, h({ "x-forwarded-for": "127.0.0.1" }))).toBe("unknown");
  });
});

describe("isLocalOriginFromPeer", () => {
  test("allows a direct loopback caller", () => {
    expect(isLocalOriginFromPeer("127.0.0.1", h())).toBe(true);
  });

  test("denies a remote caller forwarded through the local dashboard proxy", () => {
    expect(isLocalOriginFromPeer("127.0.0.1", h({ "x-forwarded-for": "203.0.113.9" }))).toBe(false);
  });

  test("denies a direct remote caller", () => {
    expect(isLocalOriginFromPeer("203.0.113.9", h())).toBe(false);
  });

  test("a spoofed loopback XFF cannot make a remote peer look local", () => {
    expect(isLocalOriginFromPeer("203.0.113.9", h({ "x-forwarded-for": "127.0.0.1" }))).toBe(false);
  });

  test("fails closed when the peer is unknown", () => {
    expect(isLocalOriginFromPeer(null, h())).toBe(false);
  });
});

describe("adminGuardFromPeer", () => {
  test("allows loopback (regression: adminGuard denied even local)", () => {
    expect(adminGuardFromPeer("127.0.0.1", h()).allowed).toBe(true);
    // The old header-only guard cannot allow the same request.
    expect(adminGuard(h({ "x-real-ip": "127.0.0.1" }), null).allowed).toBe(false);
  });

  test("denies a remote peer without a CLI token", () => {
    expect(adminGuardFromPeer("203.0.113.9", h()).allowed).toBe(false);
  });

  test("allows a remote peer presenting a valid CLI admin token", () => {
    process.env.CLI_ADMIN_TOKEN = "cli-token-abcdefghijklmnop";
    expect(adminGuardFromPeer("203.0.113.9", h({ "x-9r-cli-token": "cli-token-abcdefghijklmnop" })).allowed)
      .toBe(true);
  });

  test("denies a remote peer presenting a wrong CLI admin token", () => {
    process.env.CLI_ADMIN_TOKEN = "cli-token-abcdefghijklmnop";
    expect(adminGuardFromPeer("203.0.113.9", h({ "x-9r-cli-token": "nope" })).allowed).toBe(false);
  });
});
