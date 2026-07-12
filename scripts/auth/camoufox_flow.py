#!/usr/bin/env python3
"""
Camoufox flow-runner — JSON-RPC over stdio.

Protocol (line-delimited JSON):
  Request:  {"id":1,"method":"run_login","params":{"provider","email","password","proxy","headless"}}
  Events:   {"id":1,"type":"event","event":"progress","step":"...","message":"..."}
            {"id":1,"type":"event","event":"frame","data":{"png":"..."}}
            {"id":1,"type":"event","event":"manual_challenge","challengeType":"...","message":"..."}
  Response: {"id":1,"ok":true,"result":{"success":true,"tokens":{...},"quota":{...},"email":"..."}}
            {"id":1,"ok":true,"result":{"success":false,"error":"...","manual":false}}

Drives ProviderAdapter implementations under app/providers/* (Camoufox + Google login).
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Callable

# Ensure scripts/auth is on sys.path so `app.*` imports resolve.
_AUTH_ROOT = Path(__file__).resolve().parent
if str(_AUTH_ROOT) not in sys.path:
    sys.path.insert(0, str(_AUTH_ROOT))

from app.errors.exceptions import BatcherError, NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount
from app.providers.kiro import KiroProviderAdapter
from app.providers.codebuddy import CodeBuddyProviderAdapter
from app.providers.canva import CanvaProviderAdapter
from app.providers.qoder_adapter import QoderProviderAdapter

MAX_RETRIES = 3
BASE_DELAY = 2.0
MAX_DELAY = 15.0
PROVIDER_TIMEOUT = 180

ADAPTERS: dict[str, Callable[[], Any]] = {
    "kiro": KiroProviderAdapter,
    "kiro-pro": KiroProviderAdapter,
    "codebuddy": CodeBuddyProviderAdapter,
    "canva": CanvaProviderAdapter,
    "qoder": QoderProviderAdapter,
}


def emit_line(obj: dict) -> None:
    try:
        print(json.dumps(obj, ensure_ascii=False), flush=True)
    except BrokenPipeError:
        pass


def retry_delay(attempt: int) -> float:
    return min(BASE_DELAY * (2**attempt), MAX_DELAY)


def _apply_env(params: dict) -> None:
    """Map request params into BATCHER_* env used by adapters."""
    # Always enable real Camoufox for production logins.
    os.environ.setdefault("BATCHER_ENABLE_CAMOUFOX", "true")

    if "headless" in params:
        os.environ["BATCHER_CAMOUFOX_HEADLESS"] = "true" if params.get("headless", True) else "false"

    proxy = params.get("proxy")
    if isinstance(proxy, dict) and proxy.get("server"):
        server = str(proxy["server"])
        user = proxy.get("username") or ""
        pw = proxy.get("password") or ""
        if user:
            # inject user:pass into server URL if possible
            if "://" in server:
                scheme, rest = server.split("://", 1)
                server = f"{scheme}://{user}:{pw}@{rest}" if pw else f"{scheme}://{user}@{rest}"
        os.environ["BATCHER_PROXY_URL"] = server
    elif isinstance(proxy, str) and proxy.strip():
        os.environ["BATCHER_PROXY_URL"] = proxy.strip()


async def _run_provider_once(adapter, account: NormalizedAccount, rid: int) -> dict:
    provider_name = adapter.name
    session = None

    def progress(step: str, message: str) -> None:
        emit_line(
            {
                "id": rid,
                "type": "event",
                "event": "progress",
                "step": step,
                "message": message,
                "provider": provider_name,
            }
        )

    frame_task: asyncio.Task | None = None
    try:
        session = await adapter.bootstrap_session(account)
        progress("browser_launch", "Browser session ready")

        page = session.get("page") if isinstance(session, dict) else None
        if page is not None:
            frame_task = asyncio.create_task(_screenshot_loop(page, rid, provider_name))

        auth_state = await adapter.authenticate(account, session)
        progress("authenticated", "Authenticated")

        tokens = await adapter.fetch_tokens(account, auth_state, session)
        progress("tokens", "Tokens obtained")

        quota = None
        try:
            quota = await adapter.fetch_quota(account, tokens, session)
            progress("quota", "Quota fetched")
        except Exception as e:
            progress("quota_skip", f"Quota fetch skipped: {e}")

        return {
            "success": True,
            "provider": provider_name,
            "tokens": tokens,
            "credentials": tokens,
            "quota": quota,
            "email": account.identifier,
        }
    finally:
        if frame_task is not None:
            frame_task.cancel()
            try:
                await frame_task
            except Exception:
                pass
        if session is not None:
            try:
                await adapter.cleanup_session(session)
            except Exception:
                pass


async def _screenshot_loop(page: Any, rid: int, provider: str) -> None:
    try:
        while True:
            try:
                buf = await page.screenshot(type="jpeg", quality=55)
                emit_line(
                    {
                        "id": rid,
                        "type": "event",
                        "event": "frame",
                        "provider": provider,
                        "data": {"png": base64.b64encode(buf).decode("ascii")},
                    }
                )
            except Exception:
                pass
            await asyncio.sleep(2.0)
    except asyncio.CancelledError:
        return


async def run_provider(adapter, account: NormalizedAccount, rid: int) -> dict:
    provider_name = adapter.name
    last_error: Exception | None = None

    emit_line(
        {
            "id": rid,
            "type": "event",
            "event": "progress",
            "step": "init",
            "message": "Initializing...",
            "provider": provider_name,
        }
    )

    for attempt in range(MAX_RETRIES):
        try:
            return await asyncio.wait_for(
                _run_provider_once(adapter, account, rid),
                timeout=PROVIDER_TIMEOUT,
            )
        except asyncio.TimeoutError:
            last_error = TimeoutError(f"provider timed out after {PROVIDER_TIMEOUT}s")
            if attempt < MAX_RETRIES - 1:
                delay = retry_delay(attempt)
                emit_line(
                    {
                        "id": rid,
                        "type": "event",
                        "event": "progress",
                        "step": "retry",
                        "message": f"Timeout — retrying in {delay:.0f}s ({attempt + 2}/{MAX_RETRIES})",
                        "provider": provider_name,
                    }
                )
                await asyncio.sleep(delay)
            else:
                return {
                    "success": False,
                    "provider": provider_name,
                    "error": f"timed out after {PROVIDER_TIMEOUT}s",
                }
        except NonRetryableBatcherError as e:
            manual = "challenge" in (e.message or "").lower() or "captcha" in (e.message or "").lower()
            if manual:
                emit_line(
                    {
                        "id": rid,
                        "type": "event",
                        "event": "manual_challenge",
                        "challengeType": "google_challenge",
                        "message": e.message,
                        "provider": provider_name,
                    }
                )
            return {
                "success": False,
                "provider": provider_name,
                "error": e.message,
                "manual": manual,
            }
        except RetryableBatcherError as e:
            last_error = e
            if attempt < MAX_RETRIES - 1:
                delay = retry_delay(attempt)
                emit_line(
                    {
                        "id": rid,
                        "type": "event",
                        "event": "progress",
                        "step": "retry",
                        "message": f"{e.message} — retrying in {delay:.0f}s ({attempt + 2}/{MAX_RETRIES})",
                        "provider": provider_name,
                    }
                )
                await asyncio.sleep(delay)
            else:
                return {"success": False, "provider": provider_name, "error": e.message}
        except BatcherError as e:
            return {"success": False, "provider": provider_name, "error": e.message}
        except Exception as e:
            last_error = e
            if attempt < MAX_RETRIES - 1:
                delay = retry_delay(attempt)
                emit_line(
                    {
                        "id": rid,
                        "type": "event",
                        "event": "progress",
                        "step": "retry",
                        "message": f"Error: {e} — retrying in {delay:.0f}s ({attempt + 2}/{MAX_RETRIES})",
                        "provider": provider_name,
                    }
                )
                await asyncio.sleep(delay)
            else:
                return {"success": False, "provider": provider_name, "error": str(e)}

    return {
        "success": False,
        "provider": provider_name,
        "error": str(last_error) if last_error else "unknown error",
    }


async def handle_run_login(rid: int, params: dict) -> dict:
    provider = str(params.get("provider") or "").strip().lower()
    email = str(params.get("email") or "").strip()
    password = str(params.get("password") or "")
    if not provider or not email or not password:
        return {"success": False, "error": "provider, email, and password are required"}

    factory = ADAPTERS.get(provider)
    if not factory:
        return {
            "success": False,
            "error": f"unsupported browser-login provider: {provider}. Supported: {', '.join(sorted(set(ADAPTERS)))}",
        }

    _apply_env(params)
    adapter = factory()
    # Kiro-pro uses the same adapter; keep name for logging.
    if provider == "kiro-pro":
        adapter.name = "kiro"  # type: ignore[misc]
    account = NormalizedAccount(provider=provider, identifier=email, secret=password)
    return await run_provider(adapter, account, rid)


async def main_loop() -> None:
    emit_line({"type": "event", "event": "ready", "message": "camoufox_flow ready"})
    loop = asyncio.get_event_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        rid = req.get("id", 0)
        method = str(req.get("method") or "")
        params = req.get("params") or {}

        if method == "shutdown":
            emit_line({"id": rid, "ok": True, "result": {"shutdown": True}})
            break

        if method != "run_login":
            emit_line({"id": rid, "ok": False, "error": f"unknown method: {method}"})
            continue

        try:
            result = await handle_run_login(rid, params if isinstance(params, dict) else {})
            emit_line({"id": rid, "ok": True, "result": result})
        except Exception as e:
            emit_line({"id": rid, "ok": False, "error": str(e)})


if __name__ == "__main__":
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        pass
