#!/usr/bin/env python3
"""Antigravity bulk import — N concurrent nodriver workers, one Chrome window each.

This is the Python-side concurrency layer for antigravity, mirroring 9router's
worker-queue model (kiroBulkImportManager.js): a shared account queue, N async
workers each launching its own browser, accounts pulled one-at-a-time so none
is processed twice. The TS LoginQueue (src/auth/queue.ts) is left untouched for
the other providers — this runner is antigravity-only and additive.

Output is the same line-delimited JSON event stream login.py emits
({"type":"progress|error|result","provider":"antigravity",...}), one object per
line, so the existing TS runner (src/auth/runner.ts parseScriptEvents) can parse
it unchanged. Per-account results are emitted as separate {"type":"result",...}
lines tagged with the email so the caller can correlate them.

Input: one account per line, `email|password` (the antigravity adapter's parse
format). Lines starting with '#' and blank lines are skipped. Read from
--accounts-file or stdin.

Env:
  AG_BATCH_CONCURRENCY  workers to run in parallel (default 4, clamped 1..8)
  BATCHER_CAMOUFOX_HEADLESS  "true"/"false" — headed by default (Google 500s
                              headless on the password challenge; a manual step
                              relaunches headed via relaunch_as_headed anyway)
  BATCHER_PROXY_URL     optional proxy (passed through to launch_browser)
  BATCHER_DEBUG         "true" for verbose debug lines

Usage:
  .venv/Scripts/python.exe batch_antigravity.py --accounts-file accounts.txt
  echo "a@x.com|pass1" | .venv/Scripts/python.exe batch_antigravity.py
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.errors.codes import ErrorCode
from app.errors.exceptions import BatcherError, NonRetryableBatcherError, RetryableBatcherError
from app.providers.antigravity import AntigravityProviderAdapter
from app.providers.base import NormalizedAccount

# Concurrency bounds — match 9router's Kiro bulk-import defaults (1..8, default 4).
MIN_CONCURRENCY = 1
MAX_CONCURRENCY = 8
DEFAULT_CONCURRENCY = 4

# Per-account safety timeout (antigravity login + token exchange + quota).
# Mirrors login.py's PROVIDER_TIMEOUT (180s); headed manual-step resume can run
# longer, but the in-driver _await_user_completion has its own 300s cap.
ACCOUNT_TIMEOUT_S = 180

# Max retries per account on a RetryableBatcherError (transient Google hiccups).
MAX_RETRIES = 2
BASE_DELAY = 2.0
MAX_DELAY = 15.0


def emit(data: dict) -> None:
    """Emit one JSON event line to stdout (read by runner.ts parseScriptEvents)."""
    try:
        print(json.dumps(data), flush=True)
    except BrokenPipeError:
        pass


def clamp_concurrency(value: int) -> int:
    return max(MIN_CONCURRENCY, min(MAX_CONCURRENCY, value))


def retry_delay(attempt: int) -> float:
    return min(BASE_DELAY * (2 ** attempt), MAX_DELAY)


def parse_accounts(lines: list[str]) -> list[tuple[str, str]]:
    """Parse `email|password` lines. Returns [(email, password), ...].
    Skips blank lines and '#' comments. Passwords may contain '|'.
    """
    out: list[tuple[str, str]] = []
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "|" not in line:
            emit({"type": "error", "provider": "antigravity",
                  "error": f"skipping malformed line (no '|'): {line[:60]}"})
            continue
        email, password = line.split("|", 1)
        email, password = email.strip(), password.strip()
        if not email or not password:
            emit({"type": "error", "provider": "antigravity",
                  "error": f"skipping line with empty email/password: {line[:60]}"})
            continue
        out.append((email, password))
    return out


async def _process_one_account(
    adapter: AntigravityProviderAdapter,
    email: str,
    password: str,
    worker_id: int,
) -> dict[str, Any]:
    """Run the full antigravity flow for one account on this worker's browser.

    Mirrors login.py's _run_provider_once + run_provider (retry loop) but
    antigravity-only and emitting per-account result lines tagged with email.
    """
    account = NormalizedAccount(provider="antigravity", identifier=email, secret=password)
    last_error: str | None = None

    for attempt in range(MAX_RETRIES + 1):
        session: dict[str, Any] | None = None
        try:
            emit({"type": "progress", "provider": "antigravity", "step": "worker_assigned",
                  "message": f"Worker {worker_id} picked up {email}", "email": email,
                  "worker": worker_id, "attempt": attempt + 1})

            async with asyncio.timeout(ACCOUNT_TIMEOUT_S):
                session = await adapter.bootstrap_session(account)
                emit({"type": "progress", "provider": "antigravity", "step": "browser_launch",
                      "message": "Browser session ready", "email": email, "worker": worker_id})

                auth_state = await adapter.authenticate(account, session)
                emit({"type": "progress", "provider": "antigravity", "step": "authenticated",
                      "message": "Authenticated", "email": email, "worker": worker_id})

                tokens = await adapter.fetch_tokens(account, auth_state, session)
                emit({"type": "progress", "provider": "antigravity", "step": "tokens",
                      "message": "Tokens obtained", "email": email, "worker": worker_id})

                # Capture web cookie for billing API access (mirrors login.py).
                page = session.get("page") if isinstance(session, dict) else None
                if page is not None:
                    try:
                        browser_cookies = await page.context.cookies()
                        if browser_cookies:
                            tokens["web_cookie"] = "; ".join(
                                f"{c['name']}={c['value']}" for c in browser_cookies
                            )
                    except Exception:
                        pass

                quota = None
                try:
                    quota = await adapter.fetch_quota(account, tokens, session)
                except Exception as exc:
                    emit({"type": "progress", "provider": "antigravity", "step": "quota_error",
                          "message": f"Quota fetch failed (non-fatal): {exc}",
                          "email": email, "worker": worker_id})

                return {
                    "type": "result",
                    "success": True,
                    "provider": "antigravity",
                    "email": email,
                    "worker": worker_id,
                    "credentials": tokens,
                    "quota": quota,
                }

        except asyncio.TimeoutError:
            last_error = f"timed out after {ACCOUNT_TIMEOUT_S}s"
            emit({"type": "progress", "provider": "antigravity", "step": "retry",
                  "message": f"{email}: {last_error}",
                  "email": email, "worker": worker_id})
        except NonRetryableBatcherError as e:
            # Don't retry hard failures (bad credentials, blocked challenge).
            emit({"type": "error", "provider": "antigravity",
                  "error": f"{email}: {e.message}", "email": email,
                  "worker": worker_id, "code": e.code.value, "no_retry": True})
            return {"type": "result", "success": False, "provider": "antigravity",
                    "email": email, "worker": worker_id, "error": e.message,
                    "code": e.code.value}
        except RetryableBatcherError as e:
            last_error = e.message
            emit({"type": "progress", "provider": "antigravity", "step": "retry",
                  "message": f"{email}: {e.message} (attempt {attempt + 1}/{MAX_RETRIES + 1})",
                  "email": email, "worker": worker_id, "code": e.code.value})
        except BatcherError as e:
            last_error = e.message
            emit({"type": "progress", "provider": "antigravity", "step": "retry",
                  "message": f"{email}: {e.message}", "email": email, "worker": worker_id})
        except Exception as e:
            last_error = str(e)
            emit({"type": "progress", "provider": "antigravity", "step": "retry",
                  "message": f"{email}: {e}", "email": email, "worker": worker_id})

        # Retry backoff (skip after the last attempt).
        if attempt < MAX_RETRIES:
            await asyncio.sleep(retry_delay(attempt))
        # Always close the worker's browser between attempts / after failure so
        # no zombie Chrome lingers; bootstrap_session opens a fresh one next try.
        if session is not None:
            browser = session.get("browser") if isinstance(session, dict) else None
            if browser is not None:
                try:
                    await browser.close()
                except Exception:
                    pass

    emit({"type": "error", "provider": "antigravity",
          "error": f"{email}: {last_error}", "email": email, "worker": worker_id})
    return {"type": "result", "success": False, "provider": "antigravity",
            "email": email, "worker": worker_id, "error": last_error}


async def _worker(
    worker_id: int,
    adapter: AntigravityProviderAdapter,
    queue: asyncio.Queue[tuple[str, str] | None],
    results: list[dict[str, Any]],
) -> None:
    """Pull accounts from the shared queue until None sentinel; one browser per
    account (bootstrap_session opens it, we close it after each account)."""
    while True:
        item = await queue.get()
        if item is None:
            queue.task_done()
            return
        email, password = item
        try:
            result = await _process_one_account(adapter, email, password, worker_id)
            results.append(result)
            emit(result)
        except Exception as e:
            # Defensive: never let a worker die silently on an unexpected error.
            err = {"type": "result", "success": False, "provider": "antigravity",
                   "email": email, "worker": worker_id, "error": f"worker crash: {e}"}
            results.append(err)
            emit(err)
        finally:
            queue.task_done()


async def run_batch(accounts: list[tuple[str, str]], concurrency: int) -> list[dict[str, Any]]:
    """Run all accounts through N workers. Returns the per-account results."""
    if not accounts:
        emit({"type": "progress", "provider": "antigravity", "step": "noop",
              "message": "No accounts to process"})
        return []

    concurrency = clamp_concurrency(concurrency)
    worker_count = min(concurrency, len(accounts))
    emit({"type": "progress", "provider": "antigravity", "step": "batch_start",
          "message": f"Starting {len(accounts)} account(s) with {worker_count} worker(s)",
          "accounts": len(accounts), "concurrency": worker_count})

    queue: asyncio.Queue[tuple[str, str] | None] = asyncio.Queue()
    for account in accounts:
        await queue.put(account)
    # One None sentinel per worker signals shutdown.
    for _ in range(worker_count):
        await queue.put(None)

    results: list[dict[str, Any]] = []
    # One adapter per worker — adapters are stateless beyond config, but keeping
    # one per worker avoids any future shared-state surprises.
    workers = [
        asyncio.create_task(_worker(i + 1, AntigravityProviderAdapter(), queue, results))
        for i in range(worker_count)
    ]
    await asyncio.gather(*workers, return_exceptions=True)

    # Summary line — lets the caller see overall pass/fail at a glance.
    ok = sum(1 for r in results if r.get("success"))
    emit({"type": "progress", "provider": "antigravity", "step": "batch_done",
          "message": f"Batch complete: {ok}/{len(results)} succeeded",
          "succeeded": ok, "failed": len(results) - ok})
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="Antigravity bulk import (N concurrent nodriver workers)")
    parser.add_argument("--accounts-file", "-f", default=None,
                        help="File with one email|password per line (default: stdin)")
    parser.add_argument("--concurrency", "-c", type=int, default=None,
                        help=f"Workers in parallel (default {DEFAULT_CONCURRENCY}, clamped {MIN_CONCURRENCY}..{MAX_CONCURRENCY})")
    args = parser.parse_args()

    concurrency = args.concurrency if args.concurrency is not None else int(
        os.getenv("AG_BATCH_CONCURRENCY", str(DEFAULT_CONCURRENCY))
    )

    # Read accounts.
    if args.accounts_file:
        with open(args.accounts_file, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    else:
        lines = sys.stdin.readlines()

    accounts = parse_accounts(lines)

    try:
        asyncio.run(run_batch(accounts, concurrency))
    except KeyboardInterrupt:
        emit({"type": "error", "provider": "antigravity",
              "error": "batch interrupted by user (Ctrl+C)"})
        # nodriver Chrome processes are reaped by the shim's hard-terminate
        # fallback (atexit + signal handlers); nothing extra to do here.
        raise


if __name__ == "__main__":
    main()
