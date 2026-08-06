/**
 * Env setup for management-ws.test.ts — runs before any src/* import because
 * this module is imported first. DATABASE_PATH points at a fresh temp file so
 * the kv table (AES-GCM encryptedText) never touches the operator's real
 * poolprox3.db rows (which the test key cannot decrypt).
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";
process.env.DATABASE_PATH =
  require("node:os").tmpdir() +
  "/etteum-mgmt-ws-test-" +
  Date.now() +
  "-" +
  Math.floor(Math.random() * 1e6) +
  ".db";
