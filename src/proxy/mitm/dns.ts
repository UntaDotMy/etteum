/**
 * MITM DNS hijack (F10) — writes vendor hosts to the OS hosts file so IDEs
 * that hardcode vendor endpoints resolve to 127.0.0.1 (where the MITM TLS
 * server listens). Strips them on shutdown.
 *
 * Faithful 1:1 TS port of the reference proxy src/mitm/dns/dnsConfig.js:
 *   - hosts file path per-OS (Windows SystemRoot\...\hosts, else /etc/hosts)
 *   - atomic write on Windows with rollback (.new → .bak → rename)
 *   - sudo-with-password on macOS/Linux (password prompted via the API)
 *   - DNS cache flush per-OS (ipconfig / dscacheutil / resolvectl)
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TOOL_HOSTS } from "./paths";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
export const HOSTS_FILE = IS_WIN
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts")
  : "/etc/hosts";

/** Marker we tag our hosts entries with so we can find + strip them cleanly. */
const ETTEUM_TAG = "# etteum-mitm";

export function isSudoAvailable(): boolean {
  if (IS_WIN) return false;
  try {
    execSync("command -v sudo", { stdio: "ignore" } as any);
    return true;
  } catch {
    return false;
  }
}

export function canRunSudoWithoutPassword(): boolean {
  if (IS_WIN || !isSudoAvailable()) return true;
  try {
    execSync("sudo -n true", { stdio: "ignore" } as any);
    return true;
  } catch {
    return false;
  }
}

export function isSudoPasswordRequired(): boolean {
  return !IS_WIN && isSudoAvailable() && !canRunSudoWithoutPassword();
}

/** True when the current process has admin/root rights (no sudo needed). */
export function isAdmin(): boolean {
  if (IS_WIN) {
    try {
      execSync("net session", { stdio: "ignore" } as any);
      return true;
    } catch {
      return false;
    }
  }
  return process.getuid?.() === 0;
}

/** Execute a shell command with a sudo password piped via stdin (Unix only). */
export function execWithPassword(cmd: string, password: string): { ok: boolean; error?: string } {
  if (IS_WIN) {
    try { execSync(cmd, { stdio: "ignore", windowsHide: true } as any); return { ok: true }; }
    catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  }
  try {
    // Pass password to sudo -S via stdin.
    execSync(`echo ${shellEscape(password)} | sudo -S -p '' ${cmd}`, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true } as any);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Atomic hosts-file write on Windows with rollback (.new/.bak rename dance). */
function atomicWriteHostsWin(target: string, originalContent: string, newContent: string): void {
  const tmpNew = `${target}.etteum.new`;
  const tmpBak = `${target}.etteum.bak`;
  try {
    writeFileSync(tmpNew, newContent, "utf8");
    try { unlinkSync(tmpBak); } catch { /* none */ }
    renameSync(target, tmpBak);
    try {
      renameSync(tmpNew, target);
    } catch (e) {
      try { renameSync(tmpBak, target); } catch { writeFileSync(target, originalContent, "utf8"); }
      throw e;
    }
    try { unlinkSync(tmpBak); } catch { /* best effort */ }
  } finally {
    try { unlinkSync(tmpNew); } catch { /* already moved or never created */ }
  }
}

function flushDnsCache(): void {
  try {
    if (IS_WIN) {
      execSync("ipconfig /flushdns", { windowsHide: true, stdio: "ignore" } as any);
    } else if (IS_MAC) {
      execSync("dscacheutil -flushcache && killall -HUP mDNSResponder", { stdio: "ignore" } as any);
    } else {
      // resolvectl, not resolvctl; the typo made every Linux flush a silent
      // no-op because `|| true` swallowed "command not found".
      execSync("resolvectl flush-caches 2>/dev/null || true", { stdio: "ignore" } as any);
    }
  } catch { /* best effort */ }
}

/** All MITM tool hosts (flattened). */
function allToolHosts(): string[] {
  return Object.values(TOOL_HOSTS).flat();
}

/**
 * Add `127.0.0.1 <host>` entries for the given hosts to the hosts file.
 * Idempotent: skips hosts already present. Uses sudo on Unix when needed.
 * Returns { ok, needsPassword } — when needsPassword, the API must prompt + retry.
 */
export function addDNSEntry(hosts: string[], password?: string): { ok: boolean; needsPassword: boolean; error?: string } {
  const allHosts = hosts.length > 0 ? hosts : allToolHosts();
  const eol = IS_WIN ? "\r\n" : "\n";
  let content = "";
  try { content = readFileSync(HOSTS_FILE, "utf8"); } catch { /* may not exist yet */ }

  const linesToAdd: string[] = [];
  for (const h of allHosts) {
    if (hostMappedToLoopback(content, h)) continue;
    linesToAdd.push(`127.0.0.1 ${h}  ${ETTEUM_TAG}`);
  }
  if (linesToAdd.length === 0) return { ok: true, needsPassword: false };
  const newContent = content.replace(/[\r\n\s]+$/g, "") + eol + linesToAdd.join(eol) + eol;

  if (isAdmin()) {
    writeHostsFile(newContent);
    flushDnsCache();
    return { ok: true, needsPassword: false };
  }
  if (IS_WIN) {
    return { ok: false, needsPassword: true, error: "Administrator rights required to edit hosts file" };
  }
  if (!isSudoAvailable()) {
    return { ok: false, needsPassword: false, error: "sudo not available; run server as root to modify hosts" };
  }
  if (canRunSudoWithoutPassword()) {
    writeHostsFileSudo(newContent);
    flushDnsCache();
    return { ok: true, needsPassword: false };
  }
  if (!password) {
    return { ok: false, needsPassword: true };
  }
  const res = writeHostsFileSudoWithPassword(newContent, password);
  if (res.ok) flushDnsCache();
  return { ok: res.ok, needsPassword: false, error: res.error };
}

function writeHostsFile(newContent: string): void {
  if (IS_WIN) {
    atomicWriteHostsWin(HOSTS_FILE, readFileSync(HOSTS_FILE, "utf8"), newContent);
  } else {
    writeFileSync(HOSTS_FILE, newContent, "utf8");
  }
}

function writeHostsFileSudo(newContent: string): void {
  // tee via sudo, content piped via stdin (no password needed — sudo -n works).
  execSync("sudo tee '" + HOSTS_FILE + "' > /dev/null", { input: newContent, stdio: ["pipe", "ignore", "ignore"] } as any);
}

function writeHostsFileSudoWithPassword(newContent: string, password: string): { ok: boolean; error?: string } {
  // Write content to a temp file (user-writable), then `sudo mv` it into place
  // with the password piped to sudo. Avoids the stdin-content-vs-password conflict.
  const tmp = require("node:os").tmpdir() + path.sep + `etteum-hosts-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, newContent, "utf8");
    const res = execWithPassword(`cp '${tmp}' '${HOSTS_FILE}' && rm -f '${tmp}'`, password);
    return res;
  } catch (e: any) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Remove all etteum-mitm hosts entries. Best-effort on shutdown.
 */
export function removeAllDNSEntriesSync(): void {
  try {
    if (!existsSync(HOSTS_FILE)) return;
    const content = readFileSync(HOSTS_FILE, "utf8");
    const eol = IS_WIN ? "\r\n" : "\n";
    const allHosts = allToolHosts();
    // Remove a line iff it maps any tool host to 127.0.0.1 (token-exact) OR
    // carries our tag. Token-exact matching avoids stripping unrelated lines
    // that merely contain a tool hostname as a substring.
    const filtered = content
      .split(/\r?\n/)
      .filter((l) => !allHosts.some((h) => hostMappedToLoopback(l, h)) && !l.includes(ETTEUM_TAG))
      .join(eol);
    const next = filtered.replace(/[\r\n\s]+$/g, "") + eol;
    if (next === content) return;
    if (isAdmin()) {
      writeHostsFile(next);
      flushDnsCache();
    } else if (!IS_WIN && isSudoAvailable() && canRunSudoWithoutPassword()) {
      writeHostsFileSudo(next);
      flushDnsCache();
    }
    // else: can't strip without privileges on shutdown — leave entries; harmless.
  } catch { /* best effort during shutdown */ }
}

/**
 * Token-exact check: is `host` an alias on a 127.0.0.1 line in `content`?
 * Uses whitespace-delimited token matching (per hosts(5)), NOT substring
 * matching — `l.includes(host)` would false-match (e.g. checking "foo.com"
 * would match a line for "api.foo.com"). Comments (#…) are stripped first.
 */
function hostMappedToLoopback(content: string, host: string): boolean {
  return content.split(/\r?\n/).some((line) => {
    const hash = line.indexOf("#");
    const data = hash >= 0 ? line.slice(0, hash) : line;
    const tokens = data.trim().split(/\s+/);
    return tokens[0] === "127.0.0.1" && tokens.slice(1).includes(host);
  });
}

/** Check whether a host is currently mapped to 127.0.0.1 in the hosts file. */
export function checkDNSEntry(host: string): boolean {
  try {
    const content = readFileSync(HOSTS_FILE, "utf8");
    return hostMappedToLoopback(content, host);
  } catch {
    return false;
  }
}

/** Per-tool DNS status (each tool's hosts → mapped?). */
export function checkAllDNSStatus(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [tool, hosts] of Object.entries(TOOL_HOSTS)) {
    out[tool] = hosts.every((h) => checkDNSEntry(h));
  }
  return out;
}
