/**
 * Contract-regression test for the combo wrong-account-exclusion fix.
 *
 * Bug: routeComboFallback probed account A (liveness), then routeRequest
 * re-selected its OWN account B internally and recorded B only in a private
 * copy of the exclusion set (router.ts copies options.excludeAccountIds into a
 * new attemptedAccountIds). On failure combo excluded the probe A — innocent —
 * while the genuinely-failed B stayed eligible for the rest of the combo.
 *
 * Fix: routeRequest accepts an optional `attemptedAccountIdsOut` set that it
 * populates with every account id it actually attempts; combo passes its
 * `excludedAccounts` so the real failed account is excluded. This test pins
 * that wiring so a refactor can't silently drop it. (Behavioral coverage of
 * routeRequest's live account selection would require live pool accounts and
 * real upstreams, which the suite deliberately avoids.)
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const routerSrc = readFileSync(
  path.join(import.meta.dir, "../../src/proxy/router.ts"),
  "utf8",
);
const comboSrc = readFileSync(
  path.join(import.meta.dir, "../../src/proxy/combo.ts"),
  "utf8",
);

describe("combo account-exclusion contract", () => {
  test("routeRequest exposes an attemptedAccountIdsOut option", () => {
    expect(routerSrc).toContain("attemptedAccountIdsOut?: Set<number>");
  });

  test("routeRequest copies the caller exclusion set (does not share/mutate it)", () => {
    // The internal set is a fresh copy — this is WHY the out-param is needed.
    expect(routerSrc).toMatch(/const attemptedAccountIds = new Set<number>\(\)/);
  });

  test("routeRequest records each attempted account into the out set", () => {
    expect(routerSrc).toContain("options?.attemptedAccountIdsOut?.add(account.id)");
  });

  test("combo passes its excludedAccounts as the out set", () => {
    expect(comboSrc).toContain("attemptedAccountIdsOut: excludedAccounts");
  });

  test("combo still excludes the probe account on failure as a fallback", () => {
    expect(comboSrc).toContain("excludedAccounts.add(account.id)");
  });
});
