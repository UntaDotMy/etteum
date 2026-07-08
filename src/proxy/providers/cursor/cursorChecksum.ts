/**
 * Cursor checksum + header builder.
 *
 * 1:1 with the reference proxy open-sse/utils/cursorChecksum.js. Generates the
 * x-cursor-checksum header (Jyh cipher over a millisecond timestamp) and the
 * full header set the Cursor Connect-RPC API requires.
 */
import crypto from "node:crypto";
import os from "node:os";

/** SHA-256 hex of input + salt. */
export function generateHashed64Hex(input: string, salt = ""): string {
  return crypto.createHash("sha256").update(input + salt).digest("hex");
}

/** Stable host-derived machine id (no external dep). */
function getMachineId(): string {
  return generateHashed64Hex(`${os.hostname()}:${os.platform()}:${os.arch()}`);
}

/**
 * Generate the x-cursor-checksum (Jyh cipher).
 *
 * 1. timestamp = floor(now / 1e6) as 6 big-endian bytes
 * 2. XOR each byte with a running key (starts 165), then key = byte
 * 3. URL-safe base64 (no padding) + machineId suffix
 */
export function generateCursorChecksum(machineId: string): string {
  const timestamp = Math.floor(Date.now() / 1000000);
  const buf = Buffer.from([
    (timestamp >> 40) & 0xFF,
    (timestamp >> 32) & 0xFF,
    (timestamp >> 24) & 0xFF,
    (timestamp >> 16) & 0xFF,
    (timestamp >> 8) & 0xFF,
    timestamp & 0xFF,
  ]);

  let t = 165;
  for (let i = 0; i < buf.length; i++) {
    buf[i] = ((buf[i]! ^ t) + (i % 256)) & 0xFF;
    t = buf[i]!;
  }

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let encoded = "";
  for (let i = 0; i < buf.length; i += 3) {
    const a = buf[i]!;
    const b = i + 1 < buf.length ? buf[i + 1]! : 0;
    const c = i + 2 < buf.length ? buf[i + 2]! : 0;
    encoded += alphabet[a >> 2]!;
    encoded += alphabet[((a & 3) << 4) | (b >> 4)]!;
    if (i + 1 < buf.length) encoded += alphabet[((b & 15) << 2) | (c >> 6)]!;
    if (i + 2 < buf.length) encoded += alphabet[c & 63]!;
  }
  return `${encoded}${machineId}`;
}

/**
 * Build all Cursor API headers.
 * @param accessToken Bearer token (cursor auth token)
 * @param machineId Machine ID (generated from the host if absent)
 * @param ghostMode Enable ghost mode
 */
export function buildCursorHeaders(accessToken: string, machineId: string | null = null, ghostMode = true): Record<string, string> {
  const cleanToken = accessToken.includes("::") ? (accessToken.split("::")[1] ?? accessToken) : accessToken;
  const resolvedMachineId = machineId || getMachineId();

  // Stable client/session ids derived from the token.
  const clientKey = generateHashed64Hex(resolvedMachineId, "client");
  const sessionId = generateHashed64Hex(cleanToken, "session");
  const checksum = generateCursorChecksum(resolvedMachineId);

  const osName = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "macos" : "linux";
  let arch = "x64";
  if (process.arch === "arm64") arch = "aarch64";

  return {
    "authorization": `Bearer ${cleanToken}`,
    "connect-accept-encoding": "gzip",
    "connect-protocol-version": "1",
    "content-type": "application/connect+proto",
    "user-agent": "connect-es/1.6.1",
    "x-amzn-trace-id": `Root=${crypto.randomUUID()}`,
    "x-client-key": clientKey,
    "x-cursor-checksum": checksum,
    "x-cursor-client-version": "3.1.0",
    "x-cursor-client-type": "ide",
    "x-cursor-client-os": osName,
    "x-cursor-client-arch": arch,
    "x-cursor-client-device-type": "desktop",
    "x-cursor-config-version": crypto.randomUUID(),
    "x-cursor-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    "x-ghost-mode": ghostMode ? "true" : "false",
    "x-request-id": crypto.randomUUID(),
    "x-session-id": sessionId,
  };
}
