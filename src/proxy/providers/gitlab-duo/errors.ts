/**
 * GitLab Duo workflow executor errors and status mapping.
 */
import { WorkflowStatusCode } from "./protocol";

export function cryptoRandom(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Structured workflow executor error — mirrors
 * `lib_workflow_api/src/workflow_executor_error.ts:WorkflowExecutorError`.
 *
 * Carries:
 *   - `statusCode` — the upstream `WorkflowStatusCode` (USAGE_QUOTA_EXCEEDED,
 *     LOCKED_SOCKET, etc.) so `classifyError()` doesn't need regex heuristics.
 *   - `httpStatus` — when the error originated from a REST call.
 *   - `wsCloseCode` — when it originated from a WebSocket abnormal close.
 *
 * Backwards-compatible: existing throw sites that emit `Error` with
 * `{ httpStatus }` still work — `classifyError()` falls back to the legacy
 * heuristic when `e instanceof WorkflowExecutorError === false`.
 */
export class WorkflowExecutorError extends Error {
  readonly statusCode: WorkflowStatusCode;
  readonly httpStatus?: number;
  readonly wsCloseCode?: number;

  constructor(
    message: string,
    statusCode: WorkflowStatusCode,
    opts?: { httpStatus?: number; wsCloseCode?: number; cause?: unknown },
  ) {
    super(message);
    this.name = "WorkflowExecutorError";
    this.statusCode = statusCode;
    this.httpStatus = opts?.httpStatus;
    this.wsCloseCode = opts?.wsCloseCode;
    if (opts?.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
    Error.captureStackTrace?.(this, WorkflowExecutorError);
  }
}

/** Classify an HTTP status from a REST throw → WorkflowStatusCode. Used by
 *  `createWorkflow` so we can build a proper WorkflowExecutorError. */
export function statusCodeForHttp(httpStatus: number, body: string): WorkflowStatusCode {
  if (httpStatus === 401 || httpStatus === 407) return WorkflowStatusCode.AUTH_TOKEN_ERROR;
  if (httpStatus === 402) return WorkflowStatusCode.USAGE_QUOTA_EXCEEDED;
  if (httpStatus === 403) {
    // 403 with a quota body string is the trial-exhausted case; otherwise it's
    // an auth / permission problem.
    if (/quota|credits|usage|wallet|exhausted|trial.*expired/i.test(body)) {
      return WorkflowStatusCode.USAGE_QUOTA_EXCEEDED;
    }
    return WorkflowStatusCode.AUTH_TOKEN_ERROR;
  }
  if (httpStatus === 423) return WorkflowStatusCode.LOCKED_SOCKET;
  if (httpStatus === 429) return WorkflowStatusCode.SERVICE_CONNECTION_FAILED;
  if (httpStatus === 502) return WorkflowStatusCode.SERVICE_CONNECTION_BAD_GATEWAY;
  if (httpStatus >= 500) return WorkflowStatusCode.SERVICE_CONNECTION_INTERNAL_ERROR;
  return WorkflowStatusCode.GENERAL_FAILURE;
}

/** Map a WS close code → WorkflowStatusCode. RFC 6455 codes:
 *   1006 = abnormal closure (no Close frame) → DROPPED
 *   1011 = server error                      → INTERNAL_ERROR
 *   1012 = service restart                   → DROPPED
 *   1013 = try again later                   → SERVICE_CONNECTION_FAILED */
export function statusCodeForWsClose(code: number): WorkflowStatusCode {
  switch (code) {
    case 1006: return WorkflowStatusCode.SERVICE_CONNECTION_DROPPED;
    case 1011: return WorkflowStatusCode.SERVICE_CONNECTION_INTERNAL_ERROR;
    case 1012: return WorkflowStatusCode.SERVICE_CONNECTION_DROPPED;
    case 1013: return WorkflowStatusCode.SERVICE_CONNECTION_FAILED;
    default:   return WorkflowStatusCode.SERVICE_CONNECTION_FAILED;
  }
}
