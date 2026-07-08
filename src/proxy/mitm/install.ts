/**
 * MITM Root-CA trust-store install (F10).
 * Ported from the reference proxy src/mitm/cert/install.js. Installs the generated Root CA
 * into the OS trust store so leaf certs it signs are trusted by the IDEs:
 *   - macOS:   security add-trusted-cert (System.keychain)
 *   - Linux:   copy to the distro's CA anchors dir + update-ca-certificates/trust
 *   - Windows: certutil -addstore Root (admin)
 *
 * All operations need elevation (sudo / admin). The API surfaces a
 * `needsPassword`/`requiresAdmin` result so the dashboard can prompt.
 */
import { execSync } from "node:child_process";
import { existsSync, copyFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { ROOT_CA_CERT_PATH } from "./paths";
import { execWithPassword, isAdmin, isSudoAvailable, canRunSudoWithoutPassword } from "./dns";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const LINUX_CERT_PATHS = [
  { dir: "/usr/local/share/ca-certificates", cmd: "update-ca-certificates" }, // Debian/Ubuntu
  { dir: "/etc/ca-certificates/trust-source/anchors", cmd: "update-ca-trust" }, // Arch/CachyOS/Manjaro
  { dir: "/etc/pki/ca-trust/source/anchors", cmd: "update-ca-trust" }, // Fedora/RHEL/CentOS
  { dir: "/etc/pki/trust/anchors", cmd: "update-ca-certificates" }, // openSUSE
];

function getLinuxCertConfig(): { dir: string; cmd: string } {
  for (const config of LINUX_CERT_PATHS) {
    if (existsSync(config.dir)) return config;
  }
  return LINUX_CERT_PATHS[0] ?? { dir: "/usr/local/share/ca-certificates", cmd: "update-ca-certificates" };
}

function getCertFingerprint(certPath: string): string {
  const pem = readFileSync(certPath, "utf-8");
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""), "base64");
  return createHash("sha1").update(der).digest("hex").toUpperCase().match(/.{2}/g)?.join(":") || "";
}

export interface TrustResult {
  ok: boolean;
  requiresAdmin?: boolean;
  needsPassword?: boolean;
  error?: string;
}

/** Check if the Root CA is already installed + trusted. */
export function isCertTrusted(): boolean {
  if (!existsSync(ROOT_CA_CERT_PATH)) return false;
  const fingerprint = getCertFingerprint(ROOT_CA_CERT_PATH).replace(/:/g, "");
  try {
    if (IS_MAC) {
      const out = execSync(`security find-certificate -a -Z /Library/Keychains/System.keychain 2>/dev/null`, { stdio: ["ignore", "pipe", "ignore"] } as any).toString();
      return new RegExp(`SHA-1 hash:\\s*${fingerprint}`, "i").test(out);
    }
    if (IS_WIN) {
      const out = execSync(`certutil -store Root`, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true } as any).toString();
      return out.includes(fingerprint);
    }
    // Linux: check the anchors dir for our cert basename.
    const cfg = getLinuxCertConfig();
    return existsSync(`${cfg.dir}/etteum-mitm-root-ca.crt`);
  } catch {
    return false;
  }
}

/**
 * Install the Root CA into the OS trust store. Requires elevation.
 * Returns `requiresAdmin`/`needsPassword` so the API can prompt + retry.
 */
export function installRootCA(password?: string): TrustResult {
  if (!existsSync(ROOT_CA_CERT_PATH)) {
    return { ok: false, error: "Root CA not generated. Generate it first." };
  }
  if (isCertTrusted()) return { ok: true };

  const elevated = isAdmin() || (!IS_WIN && isSudoAvailable() && canRunSudoWithoutPassword());
  if (!elevated && !password) {
    return { ok: false, requiresAdmin: IS_WIN, needsPassword: !IS_WIN };
  }

  if (IS_MAC) {
    const cmd = `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain '${ROOT_CA_CERT_PATH}'`;
    if (isAdmin()) return run(cmd);
    return passwordResult(execWithPassword(cmd, password || ""));
  }
  if (IS_WIN) {
    if (!isAdmin()) return { ok: false, requiresAdmin: true };
    return run(`certutil -addstore -f Root '${ROOT_CA_CERT_PATH}'`);
  }
  // Linux
  const cfg = getLinuxCertConfig();
  if (!existsSync(cfg.dir)) mkdirSync(cfg.dir, { recursive: true });
  const dest = `${cfg.dir}/etteum-mitm-root-ca.crt`;
  copyFileSync(ROOT_CA_CERT_PATH, dest);
  if (isAdmin()) return run(cfg.cmd);
  if (canRunSudoWithoutPassword()) return run(`sudo ${cfg.cmd}`);
  return passwordResult(execWithPassword(cfg.cmd, password || ""));
}

function run(cmd: string): TrustResult {
  try {
    execSync(cmd, { stdio: "ignore", windowsHide: true } as any);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function passwordResult(r: { ok: boolean; error?: string }): TrustResult {
  return { ok: r.ok, error: r.error };
}
