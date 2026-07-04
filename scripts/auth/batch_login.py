#!/usr/bin/env python3
"""Multi-provider bulk login — N concurrent workers, one Chrome window each.

Phase 2 of the the reference design concurrency migration: this is the Python-side
concurrency authority for the QUEUE path. The TS LoginQueue
(src/auth/queue.ts) spawns ONE batch_login.py process per batch and streams
per-account line-JSON events back; TS maps each event to the existing DB /
broadcast / applyProviderResult logic (see runner.ts applyProviderResult). The
per-provider login logic is NOT rewritten here — each worker shells out to the
existing login.py with ENOWX_ALLOWED_PROVIDERS filtered to one provider, so all
provider-specific flows (kiro, codebuddy, canva, codex, gitlab-duo,
antigravity, ...) keep working unchanged.

This does NOT replace login.py (single-account, used by the direct 'login now'
path) or batch_antigravity.py (antigravity-native, uses the adapter directly).
It is the queue-path concurrency layer, additive.

Input (stdin): one JSON object per line — a header then one row per account:
    {"type":"manifest","concurrency":4,"headless":false,"browserEngine":"chromium","maxRetries":3}
    {"type":"account","accountId":12,"email":"a@x.com","password":"pw","provider":"kiro"}
    {"type":"account","accountId":13,"email":"b@x.com","password":"pw","provider":"kiro"}
    ... (stdin stays open; a {"type":"eof"} line or EOF finalizes the manifest)

Output (stdout): line-delimited JSON events the TS runner parses:
    {"type":"progress","provider":"kiro","step":"...","message":"...","accountId":12,"worker":1}
    {"type":"result","success":true,"provider":"kiro","accountId":12,"credentials":{...},"quota":{...}}
    {"type":"result","success":false,"provider":"kiro","accountId":12,"error":"...","noRetry":false}
    {"type":"batch_done","totalProcessed":N,"totalSuccess":S,"totalFailed":F}

Retry + backoff + not_eligible halt mirror src/auth/queue.ts processItem:
  - on failure without noRetry: retry up to maxRetries with min(2000*2^attempt, 15000) ms backoff
  - on noRetry + error contains 'not_eligible' or 'non-zero': halt the whole batch
    (emit batch_halted) — mirrors the TS queue clearing on a global condition
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Concurrency bounds — match TS LoginQueue (1..10) and the reference design (1..8). Use the
# TS bounds since this replaces the TS queue: min 1, max 10.
MIN_CONCURRENCY = 1
MAX_CONCURRENCY = 10
DEFAULT_CONCURRENCY = 2  # matches LoginQueue default

DEFAULT_MAX_RETRIES = 3  # matches LoginQueue.maxRetries
BASE_DELAY = 2.0
MAX_DELAY = 15.0


def emit(data: dict) -> None:
    """Emit one JSON event line to stdout (read by the TS runner)."""
    try:
        print(json.dumps(data), flush=True)
    except BrokenPipeError:
        pass


def clamp_concurrency(value: int) -> int:
    return max(MIN_CONCURRENCY, min(MAX_CONCURRENCY, value))


def retry_delay(attempt: int) -> float:
    return min(BASE_DELAY * (2 ** attempt), MAX_DELAY)


def _is_halt_error(error: str) -> bool:
    """Mirrors queue.ts: halt the whole batch on a global not_eligible condition."""
    low = (error or "").lower()
    return "not_eligible" in low or "non-zero" in low


async def _run_login_py(account: dict, options: dict, worker_id: int, attempt: int) -> dict[str, Any]:
    """Shell out to login.py for ONE account with ONE provider filtered, and
    parse its line-JSON output into a per-account result. Reuses all existing
    per-provider login logic — nothing is rewritten here.

    Returns a result dict shaped like login.py's final result event, tagged
    with accountId so the TS runner can map it to the right account row.
    """
    provider = account["provider"]
    email = account["email"]
    password = account["password"]
    account_id = account["accountId"]

    env = {
        **os.environ,
        "ENOWX_ALLOWED_PROVIDERS": provider,
        "PYTHONUNBUFFERED": "1",
        "BATCHER_CAMOUFOX_HEADLESS": "true" if options.get("headless") else "false",
        "BATCHER_CONCURRENT": "1",
        "BATCHER_PRIORITY": provider,
    }
    proxy = options.get("proxyUrl") or os.getenv("BATCHER_PROXY_URL", "")
    if proxy:
        env["BATCHER_PROXY_URL"] = proxy
        env["HTTP_PROXY"] = proxy
        env["HTTPS_PROXY"] = proxy
    if options.get("browserEngine"):
        env["BATCHER_BROWSER_ENGINE"] = options["browserEngine"]

    # login.py is sibling to this script. AG_BATCH_LOGIN_PY overrides the path
    # (used by tests to point at a stub without launching real browsers).
    login_py = os.getenv("AG_BATCH_LOGIN_PY") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "login.py"
    )
    python = os.getenv("AG_BATCH_PYTHON") or sys.executable
    cmd = [python, login_py, "--email", email, "--password", password]

    emit({"type": "progress", "provider": provider, "step": "worker_assigned",
          "message": f"Worker {worker_id} picked up account #{account_id} ({email}) attempt {attempt}",
          "accountId": account_id, "worker": worker_id, "attempt": attempt})

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=os.path.dirname(os.path.abspath(__file__)),
        )
    except Exception as exc:
        return {"type": "result", "success": False, "provider": provider,
                "accountId": account_id, "error": f"failed to launch login.py: {exc}",
                "noRetry": True}

    # Stream login.py stdout line-by-line, re-emitting progress/error events
    # tagged with accountId so the TS runner can correlate them to the account.
    final_result: dict[str, Any] | None = None
    assert proc.stdout is not None
    try:
        async for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            etype = event.get("type")
            if etype == "result":
                # login.py's final result is keyed by provider; extract this one.
                # Use the LAST result event seen (login.py may emit intermediate
                # result-shaped lines; the final one is authoritative).
                prov_result = event.get(provider) or {}
                final_result = {
                    "type": "result",
                    "success": bool(prov_result.get("success", False)),
                    "provider": provider,
                    "accountId": account_id,
                    "credentials": prov_result.get("credentials"),
                    "quota": prov_result.get("quota"),
                    "error": prov_result.get("error"),
                    "noRetry": bool(prov_result.get("noRetry", False)),
                }
            elif etype == "progress":
                emit({"type": "progress", "provider": event.get("provider", provider),
                      "step": event.get("step", ""), "message": event.get("message", ""),
                      "accountId": account_id, "worker": worker_id, "attempt": attempt})
            elif etype == "error":
                emit({"type": "progress", "provider": provider, "step": "subprocess_error",
                      "message": event.get("error", ""), "accountId": account_id,
                      "worker": worker_id, "attempt": attempt})
            elif etype == "upgrade_card_result":
                # Pass through card results so TS can update VCC status live.
                emit({"type": "upgrade_card_result",
                      "card_last4": event.get("card_last4"),
                      "card_status": event.get("card_status"),
                      "provider": provider, "accountId": account_id, "worker": worker_id})
    except Exception as exc:
        final_result = {"type": "result", "success": False, "provider": provider,
                        "accountId": account_id, "error": f"stdout read failed: {exc}"}

    await proc.wait()

    if final_result is None:
        # login.py exited without a result event — synthesize a failure.
        stderr = ""
        assert proc.stderr is not None
        try:
            err_bytes = await proc.stderr.read()
            stderr = err_bytes.decode("utf-8", "replace").strip()
        except Exception:
            pass
        msg = stderr or f"login.py exited with code {proc.returncode} and no result"
        final_result = {"type": "result", "success": False, "provider": provider,
                        "accountId": account_id, "error": msg}

    return final_result


async def _process_account(
    account: dict, options: dict, worker_id: int, max_retries: int, halt_event: asyncio.Event
) -> dict[str, Any]:
    """Process one account with retry+backoff. Returns the final result dict
    (the caller emits it exactly once). Honors halt_event (set when a
    not_eligible global condition fires). Intermediate retryable failures are
    surfaced as progress events, NOT result events, so each account emits
    exactly one result."""
    if halt_event.is_set():
        return {"type": "result", "success": False, "provider": account["provider"],
                "accountId": account["accountId"],
                "error": "batch halted (global condition) — not started",
                "noRetry": True}

    last_result: dict[str, Any] | None = None
    for attempt in range(1, max_retries + 2):  # max_retries + 1 total attempts
        if halt_event.is_set():
            # A global not_eligible fired while we were retrying. Return a
            # noRetry so TS won't re-queue (mirrors queue.ts clearing the queue).
            return {"type": "result", "success": False, "provider": account["provider"],
                    "accountId": account["accountId"],
                    "error": "batch halted (global condition) — not retried",
                    "noRetry": True}
        result = await _run_login_py(account, options, worker_id, attempt)
        last_result = result
        if result.get("success"):
            return result
        # noRetry → no more attempts for this account.
        if result.get("noRetry"):
            # Global halt condition (mirrors queue.ts clearing the queue).
            if _is_halt_error(result.get("error", "")):
                halt_event.set()
                emit({"type": "batch_halted", "reason": result.get("error", ""),
                      "accountId": account["accountId"], "worker": worker_id})
            return result
        # Retryable intermediate failure: surface as progress, not a result, so
        # the account still emits exactly one final result.
        if attempt <= max_retries:
            emit({"type": "progress", "provider": account["provider"], "step": "retry",
                  "message": f"Account #{account['accountId']} attempt {attempt} failed ({result.get('error', '')}); retrying in {retry_delay(attempt - 1):.0f}s (attempt {attempt + 1}/{max_retries + 1})",
                  "accountId": account["accountId"], "worker": worker_id, "attempt": attempt})
            await asyncio.sleep(retry_delay(attempt - 1))
    return last_result or {"type": "result", "success": False, "provider": account["provider"],
                           "accountId": account["accountId"], "error": "no result"}


async def _worker(
    worker_id: int,
    queue: asyncio.Queue[dict | None],
    options: dict,
    max_retries: int,
    halt_event: asyncio.Event,
    counters: dict[str, int],
) -> None:
    while True:
        item = await queue.get()
        if item is None:
            queue.task_done()
            return
        try:
            result = await _process_account(item, options, worker_id, max_retries, halt_event)
            # Emit the single final result for this account (intermediate
            # failures were streamed as progress events, not results).
            emit(result)
            counters["processed"] += 1
            if result.get("success"):
                counters["success"] += 1
            else:
                counters["failed"] += 1
        except Exception as exc:
            counters["processed"] += 1
            counters["failed"] += 1
            err = {"type": "result", "success": False, "provider": item["provider"],
                   "accountId": item["accountId"], "error": f"worker crash: {exc}",
                   "noRetry": True}
            emit(err)
        finally:
            queue.task_done()


async def run_batch(accounts: list[dict], options: dict) -> None:
    concurrency = clamp_concurrency(options.get("concurrency", DEFAULT_CONCURRENCY))
    max_retries = int(options.get("maxRetries", DEFAULT_MAX_RETRIES))
    halt_event = asyncio.Event()
    counters = {"processed": 0, "success": 0, "failed": 0}

    if not accounts:
        emit({"type": "batch_done", "totalProcessed": 0, "totalSuccess": 0, "totalFailed": 0})
        return

    worker_count = min(concurrency, len(accounts))
    emit({"type": "batch_start", "accounts": len(accounts), "concurrency": worker_count,
          "maxRetries": max_retries, "headless": options.get("headless", False)})

    queue: asyncio.Queue[dict | None] = asyncio.Queue()
    for account in accounts:
        await queue.put(account)
    for _ in range(worker_count):
        await queue.put(None)

    workers = [
        asyncio.create_task(_worker(i + 1, queue, options, max_retries, halt_event, counters))
        for i in range(worker_count)
    ]
    await asyncio.gather(*workers, return_exceptions=True)

    emit({"type": "batch_done", "totalProcessed": counters["processed"],
          "totalSuccess": counters["success"], "totalFailed": counters["failed"],
          "halted": halt_event.is_set()})


def _read_manifest(stdin) -> tuple[list[dict], dict]:
    """Read the line-JSON manifest from stdin. First 'manifest' line sets
    options; subsequent 'account' lines are the work list. Stops at EOF or an
    'eof' line. Returns (accounts, options)."""
    options: dict[str, Any] = {"concurrency": DEFAULT_CONCURRENCY, "headless": False,
                               "maxRetries": DEFAULT_MAX_RETRIES}
    accounts: list[dict] = []
    for raw in stdin:
        line = raw.strip() if isinstance(raw, str) else raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        otype = obj.get("type")
        if otype == "manifest":
            for k in ("concurrency", "headless", "browserEngine", "maxRetries", "proxyUrl"):
                if k in obj:
                    options[k] = obj[k]
        elif otype == "account":
            accounts.append(obj)
        elif otype == "eof":
            break
    return accounts, options


def main() -> None:
    parser = argparse.ArgumentParser(description="Multi-provider bulk login (N concurrent workers, queue-path concurrency authority)")
    parser.add_argument("--concurrency", "-c", type=int, default=None,
                        help=f"Workers in parallel (default {DEFAULT_CONCURRENCY}, clamped {MIN_CONCURRENCY}..{MAX_CONCURRENCY})")
    parser.add_argument("--max-retries", type=int, default=None, help=f"Max retries per account (default {DEFAULT_MAX_RETRIES})")
    args = parser.parse_args()

    accounts, options = _read_manifest(sys.stdin)
    if args.concurrency is not None:
        options["concurrency"] = args.concurrency
    if args.max_retries is not None:
        options["maxRetries"] = args.max_retries

    try:
        asyncio.run(run_batch(accounts, options))
    except KeyboardInterrupt:
        emit({"type": "batch_done", "totalProcessed": 0, "totalSuccess": 0,
              "totalFailed": 0, "halted": True, "reason": "interrupted by user"})


if __name__ == "__main__":
    main()
