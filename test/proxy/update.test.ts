import { describe, expect, test, beforeEach, mock, jest } from "bun:test";
import {
  git,
  readVersionLabel,
  readLocalCommit,
  readRemoteCommit,
  computeStatus,
  detectSupervisor,
  restartCommand,
  manualRestartHint,
} from "../../src/api/update";

// ── git() against the real repo (this test repo IS a git clone) ────────────

describe("git helper", () => {
  test("returns ok + stdout for a valid git command", () => {
    const r = git(["rev-parse", "--is-inside-work-tree"]);
    expect(r.ok).toBe(true);
    expect(r.out).toBe("true");
  });

  test("returns not-ok for a failing git command", () => {
    const r = git(["not-a-real-subcommand"]);
    expect(r.ok).toBe(false);
  });
});

describe("readVersionLabel / readLocalCommit / readRemoteCommit", () => {
  test("local commit is a 40-char hex hash", () => {
    const c = readLocalCommit();
    expect(c).not.toBeNull();
    expect(c!.length).toBe(40);
    expect(c!).toMatch(/^[0-9a-f]{40}$/);
  });

  test("version label is a non-empty string", () => {
    expect(readVersionLabel().length).toBeGreaterThan(0);
  });

  test("readRemoteCommit returns null or a 40-char hash", () => {
    const r = readRemoteCommit();
    expect(r === null || /^[0-9a-f]{40}$/.test(r)).toBe(true);
  });
});

// ── computeStatus (uses real git) ──────────────────────────────────────────

describe("computeStatus", () => {
  test("returns a well-formed status object", () => {
    const s = computeStatus(true);
    expect(s).toHaveProperty("currentCommit");
    expect(s).toHaveProperty("latestCommit");
    expect(s).toHaveProperty("updateAvailable");
    expect(typeof s.updateAvailable).toBe("boolean");
    expect(s.currentVersion.length).toBeGreaterThan(0);
    expect(s.lastCheckedAt).not.toBeNull();
  });

  test("caches across calls (force=false reuses cache)", () => {
    const a = computeStatus(true);
    const b = computeStatus(false);
    expect(b.lastCheckedAt).toBe(a.lastCheckedAt);
  });

  test("updateAvailable reflects only commits pullable from origin (behind>0)", () => {
    // Plain hash-difference was wrong: when LOCAL is ahead of origin
    // (unpushed commits) the hashes differ but nothing is pullable.
    // Compare against the same default remote branch computeStatus uses
    // (origin/HEAD → master/main) — NOT the current work branch. PR CI is
    // often on a feature branch or detached HEAD; using HEAD's branch name
    // made this assertion disagree with the implementation.
    const s = computeStatus(true);
    if (s.currentCommit && s.latestCommit) {
      const headRef = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
      let base = "master";
      if (headRef.ok && headRef.out.startsWith("refs/remotes/origin/")) {
        base = headRef.out.slice("refs/remotes/origin/".length);
      } else {
        for (const cand of ["master", "main"] as const) {
          if (git(["rev-parse", "--verify", `origin/${cand}`]).ok) {
            base = cand;
            break;
          }
        }
      }
      const behind = Number(git(["rev-list", "--count", `HEAD..origin/${base}`]).out) || 0;
      expect(s.updateAvailable).toBe(behind > 0);
    }
  });
});

// ── detectSupervisor / restartCommand / manualRestartHint ──────────────────

describe("supervisor detection", () => {
  test("detectSupervisor returns one of the known values", () => {
    const sup = detectSupervisor();
    expect(["systemd", "nssm", "launchd", "manual"]).toContain(sup);
  });

  test("restartCommand returns a command for every supervisor", () => {
    for (const sup of ["systemd", "nssm", "launchd", "manual"] as const) {
      const rc = restartCommand(sup);
      expect(typeof rc.description).toBe("string");
      if (sup === "manual") {
        expect(rc.cmd.length).toBe(0);
      } else {
        expect(rc.cmd.length).toBeGreaterThan(0);
      }
    }
  });

  test("systemd restart uses systemctl", () => {
    const rc = restartCommand("systemd");
    expect(rc.cmd[0]).toBe("systemctl");
    expect(rc.cmd).toContain("etteum");
  });

  test("nssm restart uses nssm", () => {
    const rc = restartCommand("nssm");
    expect(rc.cmd[0]).toBe("nssm");
  });

  test("manualRestartHint mentions bun + production.ts", () => {
    const hint = manualRestartHint();
    expect(hint).toContain("production.ts");
  });
});
