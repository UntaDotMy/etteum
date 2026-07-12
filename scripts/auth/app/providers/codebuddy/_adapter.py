"""CodeBuddy provider adapter — Camoufox Google login → tokens + API key.

Reconstructed from the readable companion modules (_api, _config, _google_oauth,
_page_helpers, _utils). Implements the shared ProviderAdapter contract.
"""
from __future__ import annotations

import os
import time
from typing import Any
from urllib.parse import parse_qs, urlparse

from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount, ProviderAdapter

from ._api import (
    _console_login_enterprise_via_page,
    _create_api_key_via_page,
    _fetch_user_resource_credit_via_page,
)
from ._config import (
    CODEBUDDY_BASE_URL,
    CODEBUDDY_REDIRECT_SCHEME,
    _EMAIL_PATTERN,
)
from ._google_oauth import (
    _detect_google_text_captcha,
    _fill_google_email_anywhere,
    _fill_google_password_anywhere,
    _is_email_step,
    _is_password_step,
)
from ._page_helpers import (
    _detect_google_blocking_challenge,
    _handle_codebuddy_landing,
    _handle_codebuddy_region_select,
    _handle_google_consent_continue,
    _handle_google_gaplustos,
    _handle_google_something_went_wrong,
    _save_cookies_to_file,
)
from ._utils import _get_proxy_url


def _enable_camoufox() -> bool:
    # Default ON for production logins (unlike the kiro stub default).
    return os.getenv("BATCHER_ENABLE_CAMOUFOX", "true").lower() == "true"


class CodeBuddyProviderAdapter(ProviderAdapter):
    name = "codebuddy"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [p.strip() for p in raw_line.split("|")]
        if len(parts) < 2:
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "codebuddy account must be email|password",
            )
        email, password = parts[0], parts[1]
        if not email or not password:
            raise NonRetryableBatcherError(
                ErrorCode.input_missing_required_field,
                "codebuddy account requires email and password",
            )
        if not _EMAIL_PATTERN.match(email):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "codebuddy account email format is invalid",
            )
        return NormalizedAccount(
            provider=self.name,
            identifier=email,
            secret=password,
            raw=raw_line,
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        if not _enable_camoufox():
            return {"stub": True}

        try:
            from browserforge.fingerprints import Screen
            from camoufox.async_api import AsyncCamoufox

            # Reuse kiro cache repair when available.
            try:
                from app.providers.kiro._camoufox import _repair_camoufox_cache_version
                _repair_camoufox_cache_version()
            except Exception:
                pass

            kwargs: dict[str, Any] = {
                "headless": os.getenv("BATCHER_CAMOUFOX_HEADLESS", "true").lower() == "true",
                "block_webrtc": True,
                "humanize": False,
                "screen": Screen(max_width=1920, max_height=1080),
            }
            proxy_url = _get_proxy_url() or os.getenv("BATCHER_PROXY_URL", "")
            if proxy_url:
                from urllib.parse import urlparse as _urlparse

                parsed = _urlparse(proxy_url)
                proxy_cfg: dict[str, Any] = {
                    "server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
                }
                if parsed.username:
                    proxy_cfg["username"] = parsed.username
                if parsed.password:
                    proxy_cfg["password"] = parsed.password
                kwargs["proxy"] = proxy_cfg
                kwargs["geoip"] = True

            manager = AsyncCamoufox(**kwargs)
            browser = await manager.__aenter__()
            page = await browser.new_page()
            page.set_default_timeout(20000)
            login_url = f"{CODEBUDDY_BASE_URL}/login"
            await page.goto(login_url, wait_until="domcontentloaded", timeout=60000)
            return {
                "stub": False,
                "manager": manager,
                "browser": browser,
                "page": page,
                "account": account.identifier,
                "oauth_state": None,
                "access_token": None,
                "api_key": None,
            }
        except Exception as exc:
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                str(exc) or "camoufox bootstrap failed",
            ) from exc

    async def authenticate(
        self, account: NormalizedAccount, session: Any
    ) -> dict[str, Any]:
        if session is None or session.get("stub"):
            return {"authenticated": True, "state": "stub-state"}

        page = session.get("page")
        if page is None:
            raise RetryableBatcherError(
                ErrorCode.browser_unexpected_state, "missing browser page"
            )

        # Landing: terms + Continue with Google.
        landed = await _handle_codebuddy_landing(page)
        if not landed:
            await page.wait_for_timeout(1500)
            landed = await _handle_codebuddy_landing(page)
        if not landed:
            raise RetryableBatcherError(
                ErrorCode.browser_unexpected_state,
                "Could not complete CodeBuddy landing (Google button)",
            )

        # Google email/password with interstitial recovery.
        deadline = time.time() + 120
        email_done = False
        password_done = False
        while time.time() < deadline:
            try:
                url = page.url or ""
            except Exception:
                raise RetryableBatcherError(
                    ErrorCode.browser_unexpected_state, "browser page lost"
                )

            # Captured OAuth callback scheme?
            if url.startswith(CODEBUDDY_REDIRECT_SCHEME):
                break

            challenge = await _detect_google_blocking_challenge(page)
            if challenge:
                raise NonRetryableBatcherError(
                    ErrorCode.browser_challenge_blocked,
                    f"Google challenge required: {challenge}",
                )
            captcha = await _detect_google_text_captcha(page)
            if captcha:
                raise NonRetryableBatcherError(
                    ErrorCode.browser_challenge_blocked,
                    "Google text captcha required",
                )

            await _handle_google_something_went_wrong(page)
            await _handle_google_gaplustos(page)
            await _handle_google_consent_continue(page)

            if not email_done and await _is_email_step(page):
                if await _fill_google_email_anywhere(page, account.identifier):
                    email_done = True
                    await page.wait_for_timeout(800)
                    continue

            if not password_done and await _is_password_step(page):
                if await _fill_google_password_anywhere(page, account.secret):
                    password_done = True
                    await page.wait_for_timeout(1200)
                    continue

            # Region select may appear after Google.
            await _handle_codebuddy_region_select(page)
            await page.wait_for_timeout(500)

        # Capture oauth state from redirect or page URL query.
        state = await self._capture_oauth_state(page, session)
        if not state:
            raise RetryableBatcherError(
                ErrorCode.provider_token_exchange_failed,
                "CodeBuddy OAuth state/callback not received",
            )
        session["oauth_state"] = state
        await _save_cookies_to_file(page, account.identifier)
        return {"authenticated": True, "state": state}

    async def _capture_oauth_state(self, page: Any, session: Any) -> str | None:
        deadline = time.time() + 90
        while time.time() < deadline:
            try:
                url = page.url or ""
            except Exception:
                return None
            if url.startswith(CODEBUDDY_REDIRECT_SCHEME) and "?" in url:
                params = parse_qs(url.split("?", 1)[1])
                for key in ("state", "code"):
                    val = (params.get(key) or [None])[0]
                    if val:
                        return val
            # Some flows put state on the current page query.
            try:
                parsed = urlparse(url)
                params = parse_qs(parsed.query)
                if params.get("state"):
                    return params["state"][0]
            except Exception:
                pass
            await page.wait_for_timeout(400)
        return session.get("oauth_state")

    async def fetch_tokens(
        self,
        account: NormalizedAccount,
        auth_state: dict[str, Any],
        session: Any,
    ) -> dict[str, str]:
        if session is None or session.get("stub"):
            return {
                "access_token": "stub-api-key",
                "refresh_token": "stub-access-token",
                "id_token": "",
            }

        page = session.get("page")
        state = auth_state.get("state") or session.get("oauth_state")
        if not page or not state:
            raise RetryableBatcherError(
                ErrorCode.provider_token_exchange_failed, "missing page or oauth state"
            )

        enterprise = await _console_login_enterprise_via_page(page, state)
        if not enterprise:
            raise RetryableBatcherError(
                ErrorCode.provider_token_exchange_failed,
                "console-login-enterprise failed",
            )
        bearer = ""
        try:
            bearer = str(((enterprise or {}).get("data") or {}).get("accessToken") or "")
        except Exception:
            bearer = ""

        api_key, reason = await _create_api_key_via_page(page, "personal-edition-user-id")
        access_token = (api_key or bearer or "").strip()
        session["api_key"] = access_token
        if not access_token:
            raise RetryableBatcherError(
                ErrorCode.provider_token_exchange_failed,
                reason or "failed to create CodeBuddy API key",
            )
        return {
            "access_token": access_token,
            "refresh_token": bearer or access_token,
            "id_token": "",
        }

    async def fetch_quota(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
    ) -> dict[str, Any] | None:
        if session is None or session.get("stub"):
            return {"remaining_credits": 0, "total_credits": 0}
        page = session.get("page")
        if not page:
            return None
        try:
            credits = await _fetch_user_resource_credit_via_page(page)
            if not credits:
                return None
            return {
                "remaining_credits": float(credits.get("remaining") or credits.get("remain") or 0),
                "total_credits": float(credits.get("total") or credits.get("size") or 0),
            }
        except Exception:
            return None

    async def cleanup_session(self, session: Any) -> None:
        if not session or session.get("stub"):
            return
        manager = session.get("manager")
        browser = session.get("browser")
        try:
            if manager is not None:
                await manager.__aexit__(None, None, None)
            elif browser is not None:
                await browser.close()
        except Exception:
            pass
