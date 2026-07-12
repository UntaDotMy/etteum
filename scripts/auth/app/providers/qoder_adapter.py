"""Qoder provider adapter — device-flow + Camoufox Google login."""
from __future__ import annotations

import asyncio
import os
import re
import time
from typing import Any

from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount, ProviderAdapter

# qoder_common lives next to camoufox_flow.py (scripts/auth/)
import sys
from pathlib import Path

_AUTH_ROOT = Path(__file__).resolve().parents[2]
if str(_AUTH_ROOT) not in sys.path:
    sys.path.insert(0, str(_AUTH_ROOT))

from qoder_common import (  # type: ignore
    cleanup_session,
    complete_google_oauth,
    describe_login_surface,
    fetch_user_info,
    initiate_device_flow,
    launch_camoufox,
    poll_device_token,
    wait_and_click_google_button,
)

_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class QoderProviderAdapter(ProviderAdapter):
    name = "qoder"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [p.strip() for p in raw_line.split("|")]
        if len(parts) < 2:
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "qoder account must be email|password",
            )
        email, password = parts[0], parts[1]
        if not email or not password:
            raise NonRetryableBatcherError(
                ErrorCode.input_missing_required_field,
                "qoder account requires email and password",
            )
        if not _EMAIL_PATTERN.match(email):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "qoder account email format is invalid",
            )
        return NormalizedAccount(
            provider=self.name, identifier=email, secret=password, raw=raw_line
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        try:
            flow = initiate_device_flow()
            headless = os.getenv("BATCHER_CAMOUFOX_HEADLESS", "true").lower() == "true"
            session = await launch_camoufox(headless=headless)
            page = session["page"]
            await page.goto(
                flow.verification_uri_complete,
                wait_until="domcontentloaded",
                timeout=20000,
            )
            await page.wait_for_timeout(2000)
            session["device_flow"] = flow
            session["account"] = account.identifier
            return session
        except Exception as exc:
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                str(exc) or "qoder camoufox bootstrap failed",
            ) from exc

    async def authenticate(
        self, account: NormalizedAccount, session: Any
    ) -> dict[str, Any]:
        page = session.get("page")
        if not page:
            raise RetryableBatcherError(
                ErrorCode.browser_unexpected_state, "missing browser page"
            )

        def _noop(step: str, message: str) -> None:
            return None

        clicked = await wait_and_click_google_button(page, _noop)
        if not clicked:
            surface = await describe_login_surface(page)
            raise RetryableBatcherError(
                ErrorCode.browser_element_not_found,
                f"failed to find Qoder Google sign-in button"
                + (f" (surface: {surface})" if surface else ""),
            )

        # Drive Google OAuth in background while we poll device token.
        google_task = asyncio.create_task(
            complete_google_oauth(
                page,
                account.identifier,
                account.secret,
                _noop,
                session,
            )
        )
        session["google_task"] = google_task
        return {"authenticated": True, "device_flow": session.get("device_flow")}

    async def fetch_tokens(
        self,
        account: NormalizedAccount,
        auth_state: dict[str, Any],
        session: Any,
    ) -> dict[str, str]:
        flow = session.get("device_flow") or auth_state.get("device_flow")
        google_task = session.get("google_task")
        if not flow:
            raise RetryableBatcherError(
                ErrorCode.provider_token_exchange_failed, "missing device flow"
            )

        deadline = time.monotonic() + (8 * 60)
        try:
            while time.monotonic() < deadline:
                creds = await poll_device_token(flow.nonce, flow.code_verifier)
                if creds:
                    if google_task:
                        google_task.cancel()
                    creds["machine_id"] = flow.machine_id
                    user_info = await fetch_user_info(creds.get("access_token", ""))
                    if isinstance(user_info, dict):
                        creds.update(user_info)
                    return {
                        "access_token": str(creds.get("access_token") or ""),
                        "refresh_token": str(creds.get("refresh_token") or ""),
                        "id_token": str(creds.get("id_token") or ""),
                        **{
                            k: v
                            for k, v in creds.items()
                            if k not in ("access_token", "refresh_token", "id_token")
                            and isinstance(v, (str, int, float, bool))
                        },
                    }
                await asyncio.sleep(2.0)
        finally:
            if google_task and not google_task.done():
                google_task.cancel()

        raise RetryableBatcherError(
            ErrorCode.provider_token_exchange_failed,
            "Qoder device authorization timed out",
        )

    async def fetch_quota(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
    ) -> dict[str, Any] | None:
        return None

    async def cleanup_session(self, session: Any) -> None:
        try:
            await cleanup_session(session)
        except Exception:
            pass
