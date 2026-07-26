/**
 * §4.7; the /v1/share rate limiter was skipped for direct connections.
 *
 * The old predicate derived the IP from headers and put "" in its LOCAL set, so
 * any client that simply omitted x-forwarded-for was classified local and never
 * metered. Locality must come from the resolved peer instead.
 */
import { describe, test, expect } from "bun:test";
import { effectiveClientIpFromParts } from "../../src/utils/ip-ban";
import { isLoopbackIp } from "../../src/utils/security";

/** Mirrors shareClientIp + isLocalShareRequest in src/proxy/index.ts. */
function isExemptFromShareLimit(peerIp: string | null, headers: Headers): boolean {
  const ip = effectiveClientIpFromParts(peerIp, headers) || "unknown";
  return isLoopbackIp(ip);
}

/** The predicate as it was before the fix, for contrast. */
function legacyIsLocalRequest(headers: Headers, hostname: string): boolean {
  const xf = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const xr = headers.get("x-real-ip");
  const ip = xf || xr || "";
  const LOCAL = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost", ""]);
  const host = (hostname || "").toLowerCase();
  return LOCAL.has(ip) || host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

describe("share rate-limit exemption", () => {
  test("a direct remote client with no forwarding headers IS metered", () => {
    // Regression: the legacy predicate exempted exactly this caller.
    expect(legacyIsLocalRequest(new Headers(), "pool.example.com")).toBe(true);
    expect(isExemptFromShareLimit("203.0.113.9", new Headers())).toBe(false);
  });

  test("a remote client behind the local share proxy IS metered", () => {
    expect(isExemptFromShareLimit("127.0.0.1", new Headers({ "x-forwarded-for": "203.0.113.9" })))
      .toBe(false);
  });

  test("a genuinely local caller is exempt", () => {
    expect(isExemptFromShareLimit("127.0.0.1", new Headers())).toBe(true);
    expect(isExemptFromShareLimit("::1", new Headers())).toBe(true);
  });

  test("a spoofed loopback XFF cannot buy an exemption", () => {
    expect(isExemptFromShareLimit("203.0.113.9", new Headers({ "x-forwarded-for": "127.0.0.1" })))
      .toBe(false);
  });

  test("a spoofed Host header cannot buy an exemption", () => {
    // The legacy predicate trusted the Host header; the new one never sees it.
    expect(legacyIsLocalRequest(new Headers({ "x-forwarded-for": "203.0.113.9" }), "localhost")).toBe(true);
    expect(isExemptFromShareLimit("203.0.113.9", new Headers())).toBe(false);
  });

  test("unknown origin is metered, not exempted", () => {
    expect(isExemptFromShareLimit(null, new Headers())).toBe(false);
  });
});
