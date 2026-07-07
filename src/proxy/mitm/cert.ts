/**
 * MITM certificate authority + per-domain leaf certs (F10).
 * Faithful 1:1 TS port of 9router src/mitm/cert/rootCA.js.
 *
 * Generates a 10-year self-signed Root CA (RSA 2048, cA:true, keyCertSign+cRLSign,
 * SHA-256) and per-domain leaf certs (RSA 2048, 1yr, SAN domain+wildcard,
 * serverAuth) signed by it. Stored at MITM_DIR/rootCA.{key,crt}. Auto-regenerates
 * if expired within 30 days.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as forge from "node-forge";
import { MITM_DIR, ROOT_CA_CERT_PATH, ROOT_CA_KEY_PATH } from "./paths";

const CERT_COMMON_NAME = "etteum MITM Root CA";
const CERT_ORG = "etteum";

/** Check if a cert PEM file is expired or expiring within 30 days. */
export function isCertExpired(certPath: string): boolean {
  try {
    const cert = forge.pki.certificateFromPem(readFileSync(certPath, "utf8"));
    const expiryThreshold = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    return cert.validity.notAfter < expiryThreshold;
  } catch {
    return true; // unreadable → treat as expired
  }
}

/**
 * Generate the Root CA (only once; auto-regenerate if expired).
 * Mirrors reference generateRootCA (rootCA.js:26-93).
 */
export async function generateRootCA(): Promise<{ key: string; cert: string }> {
  const exists = existsSync(ROOT_CA_KEY_PATH) && existsSync(ROOT_CA_CERT_PATH);
  if (exists && !isCertExpired(ROOT_CA_CERT_PATH)) {
    return { key: ROOT_CA_KEY_PATH, cert: ROOT_CA_CERT_PATH };
  }
  if (exists) {
    try { unlinkSync(ROOT_CA_KEY_PATH); } catch { /* ignore */ }
    try { unlinkSync(ROOT_CA_CERT_PATH); } catch { /* ignore */ }
  }
  if (!existsSync(MITM_DIR)) mkdirSync(MITM_DIR, { recursive: true });

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: "commonName", value: CERT_COMMON_NAME },
    { name: "organizationName", value: CERT_ORG },
    { name: "countryName", value: "US" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);
  writeFileSync(ROOT_CA_KEY_PATH, privateKeyPem, { mode: 0o600 });
  writeFileSync(ROOT_CA_CERT_PATH, certPem);
  return { key: ROOT_CA_KEY_PATH, cert: ROOT_CA_CERT_PATH };
}

export interface LoadedRootCA {
  key: forge.pki.PrivateKey;
  cert: forge.pki.Certificate;
}

/** Load the Root CA from disk (throws if not generated). Mirrors reference loadRootCA. */
export function loadRootCA(): LoadedRootCA {
  if (!existsSync(ROOT_CA_KEY_PATH) || !existsSync(ROOT_CA_CERT_PATH)) {
    throw new Error("Root CA not found. Generate it first.");
  }
  const keyPem = readFileSync(ROOT_CA_KEY_PATH, "utf8");
  const certPem = readFileSync(ROOT_CA_CERT_PATH, "utf8");
  return {
    key: forge.pki.privateKeyFromPem(keyPem),
    cert: forge.pki.certificateFromPem(certPem),
  };
}

export interface LeafCert {
  key: string; // PEM
  cert: string; // PEM
}

/**
 * Generate a leaf certificate for a domain, signed by the Root CA.
 * SAN = domain + wildcard, serverAuth, SHA-256. Mirrors reference
 * generateLeafCert (rootCA.js:115-164).
 */
export function generateLeafCert(domain: string, rootCA: LoadedRootCA): LeafCert {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Math.floor(Math.random() * 1_000_000));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  cert.setSubject([{ name: "commonName", value: domain }]);
  cert.setIssuer(rootCA.cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true, clientAuth: true },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: domain },
        { type: 2, value: `*.${domain}` },
      ],
    },
  ]);
  cert.sign(rootCA.key as forge.pki.rsa.PrivateKey, forge.md.sha256.create());
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}
