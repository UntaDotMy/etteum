/**
 * Browser-login automation event protocol (stdio JSON → WebSocket bridge).
 * Shared types for the Python Camoufox flow-runner and the TS runner.
 */

/** Tokens returned by a successful browser login. */
export interface AdapterTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_at?: number;
  profile_arn?: string;
  [key: string]: unknown;
}

/** Quota snapshot returned after login. */
export interface QuotaSnapshot {
  remaining_credits?: number;
  total_credits?: number;
  remaining?: number;
  limit?: number;
  credit_capacity_remain?: number;
  credit_capacity_size?: number;
  gift_claimed?: boolean;
  gift_credits?: number;
  [key: string]: unknown;
}

/** A browser-log event emitted during a login. */
export type AutomationEvent =
  | { type: "progress"; provider: string; step: string; message: string }
  | { type: "manual_challenge"; provider: string; challengeType: string; message: string; imageData?: string }
  | { type: "error"; provider: string; error: string; fatal?: boolean }
  | { type: "result"; provider: string; success: boolean; credentials?: AdapterTokens; quota?: QuotaSnapshot | null; email?: string; error?: string }
  | { type: "frame"; provider: string; png: string };

export type EmitFn = (event: AutomationEvent) => void;
