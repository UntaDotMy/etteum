from __future__ import annotations

import asyncio
import os
import random
import time
import uuid
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse, quote

import aiohttp

from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount, ProviderAdapter

from ._config import (
    _EMAIL_PATTERN,
    _SSL_CTX,
    KIRO_AUTH_BASE,
    KIRO_CLIENT_OS_POOL,
    KIRO_LOGIN_ENDPOINT,
    KIRO_REDIRECT_URI,
    KIRO_REGION,
    KIRO_TOKEN_ENDPOINT,
    KIRO_USAGE_ENDPOINT,
)
from ._camoufox import (
    _camoufox_cache_candidates,
    _repair_camoufox_cache_version,
)
from ._helpers import (
    _build_kiro_usage_url,
    _generate_pkce_pair,
    _extract_code_from_kiro_url,
    _kiro_auth_debug,
    _kiro_auth_debug_enabled,
    _map_kiro_region,
    _normalize_kiro_client_os,
    _parse_kiro_usage_payload,
    _refresh_kiro_access_token,
    _select_kiro_client_os,
    _session_user_agent,
    _capture_page_user_agent,
    _fallback_kiro_user_agent,
)
from ._google_oauth import (
    _click_continue_button,
    _click_google_next,
    _detect_google_blocking_challenge,
    _detect_google_text_captcha,
    _fill_google_email_step,
    _fill_google_password_step,
    _handle_google_account_chooser,
    _handle_google_consent_continue,
    _handle_google_gaplustos,
    _is_email_step,
    _is_password_step,
    _poll_kiro_callback,
    _should_probe_google_account_chooser,
    _submit_google_text_captcha,
    _capture_google_text_captcha_image,
    _emit_manual_challenge,
    _wait_for_google_text_captcha_input,
)


class KiroProviderAdapter(ProviderAdapter):
    name = "kiro"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [part.strip() for part in raw_line.split("|")]

        if len(parts) not in (2, 3):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "kiro account must be email|password or email|password|totp_secret",
            )

        email = parts[0]
        password = parts[1]
        totp_secret = parts[2] if len(parts) == 3 else ""

        if not email or not password:
            raise NonRetryableBatcherError(
                ErrorCode.input_missing_required_field,
                "kiro account requires email and password",
            )

        if not _EMAIL_PATTERN.match(email):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "kiro account email format is invalid",
            )

        metadata: dict[str, str] = {}
        if totp_secret:
            metadata["totp_secret"] = totp_secret

        return NormalizedAccount(
            provider=self.name,
            identifier=email,
            secret=password,
            metadata=metadata,
            raw=raw_line,
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        # Default ON so production logins never silently return stub tokens.
        if os.getenv("BATCHER_ENABLE_CAMOUFOX", "true").lower() != "true":
            return {"stub": True}

        try:
            from browserforge.fingerprints import Screen
            from camoufox.async_api import AsyncCamoufox

            code_verifier, code_challenge = _generate_pkce_pair()
            state: dict[str, Any] = {
                "auth_code": None,
                "code_verifier": code_verifier,
                "stub": False,
            }
            client_os = _select_kiro_client_os()

            camoufox_kwargs: dict[str, Any] = {
                "headless": os.getenv("BATCHER_CAMOUFOX_HEADLESS", "true").lower() == "true",
                "os": client_os,
                "block_webrtc": True,
                "humanize": False,
                "screen": Screen(max_width=1920, max_height=1080),
            }
            proxy_url = os.getenv("BATCHER_PROXY_URL", "")
            if proxy_url:
                from urllib.parse import urlparse

                parsed = urlparse(proxy_url)
                proxy_cfg: dict[str, Any] = {
                    "server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
                }
                if parsed.username:
                    proxy_cfg["username"] = parsed.username
                if parsed.password:
                    proxy_cfg["password"] = parsed.password
                camoufox_kwargs["proxy"] = proxy_cfg
                camoufox_kwargs["geoip"] = True
            _repair_camoufox_cache_version()
            manager = AsyncCamoufox(**camoufox_kwargs)
            browser = await manager.__aenter__()
            page = await browser.new_page()
            page.set_default_timeout(15000)

            def on_response(response: Any) -> None:
                if state.get("auth_code"):
                    return
                try:
                    location = response.headers.get("location", "")
                    code = _extract_code_from_kiro_url(location)
                    if code:
                        state["auth_code"] = code
                except Exception:
                    return

            page.on("response", on_response)

            manual_mode = (
                os.getenv("BATCHER_KIRO_MANUAL", "false").lower() == "true"
            )
            if not manual_mode:
                async def route_handler(route: Any) -> None:
                    if state.get("auth_code"):
                        await route.continue_()
                        return

                    request_url = route.request.url
                    code = _extract_code_from_kiro_url(request_url)
                    if code:
                        state["auth_code"] = code
                        await route.abort()
                        return
                    await route.continue_()

                await page.route("**/*", route_handler)

            auth_url = f"{KIRO_LOGIN_ENDPOINT}?" + urlencode(
                {
                    "idp": "Google",
                    "redirect_uri": KIRO_REDIRECT_URI,
                    "code_challenge": code_challenge,
                    "code_challenge_method": "S256",
                    "state": str(uuid.uuid4()),
                }
            )
            await page.goto(auth_url, wait_until="domcontentloaded", timeout=20000)
            browser_user_agent = await _capture_page_user_agent(page)

            state.update(
                {
                    "manager": manager,
                    "browser": browser,
                    "page": page,
                    "account": account.identifier,
                    "client_os": client_os,
                    "user_agent": browser_user_agent or _fallback_kiro_user_agent(client_os),
                }
            )
            return state
        except Exception as exc:
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                str(exc) or "camoufox bootstrap failed",
            ) from exc

    async def authenticate(
        self, account: NormalizedAccount, session: Any
    ) -> dict[str, Any]:
        if session is None or session.get("stub"):
            if "rate-limit" in account.identifier:
                raise RetryableBatcherError(
                    ErrorCode.auth_rate_limited, "kiro rate limited"
                )
            if "invalid" in account.identifier:
                raise NonRetryableBatcherError(
                    ErrorCode.auth_invalid_credentials,
                    "kiro invalid credentials",
                )
            return {
                "authenticated": True,
                "authorization_code": "stub-auth-code",
                "code_verifier": "stub-code-verifier",
            }

        page = session.get("page")
        if page is None:
            raise RetryableBatcherError(
                ErrorCode.browser_unexpected_state, "missing browser page"
            )

        email_transition_deadline = 0.0
        password_transition_deadline = 0.0
        account_chooser_deadline = 0.0
        email_step_started_at: float | None = None

        for _ in range(90):
            code = await _poll_kiro_callback(page, session)
            if code:
                return {
                    "authenticated": True,
                    "authorization_code": code,
                    "code_verifier": session.get("code_verifier", ""),
                }

            try:
                current_url = page.url
            except Exception:
                raise RetryableBatcherError(
                    ErrorCode.browser_unexpected_state, "kiro browser page lost"
                )

            parsed_url = urlparse(current_url) if current_url else None
            current_host = parsed_url.netloc if parsed_url else ""
            current_path = parsed_url.path if parsed_url else ""
            now = time.monotonic()

            if "SetSID" in current_url or "/accounts/set" in current_url.lower():
                await asyncio.sleep(0.5)
                continue

            if await _handle_google_gaplustos(page):
                await asyncio.sleep(0.8)
                continue

            if await _handle_google_consent_continue(page):
                await asyncio.sleep(0.8)
                continue

            on_google_auth = "accounts.google.com" in current_host
            if on_google_auth:
                if _should_probe_google_account_chooser(
                    current_host,
                    current_url,
                    now,
                    account_chooser_deadline,
                ):
                    if await _handle_google_account_chooser(page, account.identifier):
                        account_chooser_deadline = 0.0
                        await asyncio.sleep(1.0)
                        continue

                text_captcha_marker = await _detect_google_text_captcha(page)
                if text_captcha_marker:
                    challenge_step = ""
                    if await _is_password_step(page):
                        challenge_step = "password"
                    elif await _is_email_step(page):
                        challenge_step = "email"
                    handled = await _wait_for_google_text_captcha_input(
                        page, session, text_captcha_marker, challenge_step, account
                    )
                    if handled:
                        await asyncio.sleep(1.0)
                        continue
                    # Manual handler bailed (skip-mode opt-out, 60s timeout,
                    # or cancel). Fail the account immediately so the batch
                    # moves on instead of waiting for the email-step stuck
                    # guard below.
                    captcha_mode_env = (
                        os.getenv("BATCHER_CAPTCHA_MODE") or "skip"
                    ).strip().lower()
                    if captcha_mode_env == "handle":
                        reason = "captcha_timeout: 60s elapsed without user input"
                    else:
                        reason = "captcha_skipped: user disabled captcha handling"
                    raise RetryableBatcherError(
                        ErrorCode.browser_challenge_blocked,
                        reason,
                    )

                at_password_step = await _is_password_step(page)
                at_email_step = await _is_email_step(page)

                if at_email_step and not at_password_step:
                    if email_step_started_at is None:
                        email_step_started_at = now
                    elif now - email_step_started_at > 60.0:
                        raise RetryableBatcherError(
                            ErrorCode.browser_challenge_blocked,
                            "kiro captcha suspected: email step stuck > 60s",
                        )
                    if now < email_transition_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    if await _fill_google_email_step(page, account.identifier):
                        email_transition_deadline = time.monotonic() + 6.0
                        account_chooser_deadline = time.monotonic() + 10.0
                        await asyncio.sleep(1.0)
                        continue

                if at_password_step:
                    email_step_started_at = None
                    if now < password_transition_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    if await _fill_google_password_step(page, account.secret):
                        password_transition_deadline = time.monotonic() + 8.0
                        account_chooser_deadline = time.monotonic() + 10.0
                        await asyncio.sleep(1.0)
                        continue

                if at_email_step or at_password_step:
                    await asyncio.sleep(0.6)
                    continue
            else:
                email_step_started_at = None

            _kiro_auth_debug(
                f"generic continue host={current_host} path={current_path or '/'}"
            )
            await _click_continue_button(page)
            await asyncio.sleep(1.0)

        raise RetryableBatcherError(
            ErrorCode.auth_temporary_failure,
            "kiro authorization code not received",
        )

    async def fetch_tokens(
        self,
        account: NormalizedAccount,
        auth_state: dict[str, Any],
        session: Any,
    ) -> dict[str, str]:
        _ = account
        _ = session

        code = auth_state.get("authorization_code", "")
        code_verifier = auth_state.get("code_verifier", "")
        if not code or not code_verifier:
            raise NonRetryableBatcherError(
                ErrorCode.provider_unsupported_response,
                "missing authorization code or code verifier",
            )

        if code == "stub-auth-code":
            return {
                "access_token": "stub-access-token",
                "refresh_token": "stub-refresh-token",
            }

        try:
            timeout = aiohttp.ClientTimeout(total=20)
            async with aiohttp.ClientSession(timeout=timeout) as client:
                async with client.post(
                    KIRO_TOKEN_ENDPOINT,
                    json={
                        "code": code,
                        "code_verifier": code_verifier,
                        "redirect_uri": KIRO_REDIRECT_URI,
                    },
                    headers={"Content-Type": "application/json"},
                    ssl=_SSL_CTX,
                ) as resp:
                    if resp.status == 200:
                        payload = await resp.json()
                        access_token = payload.get("accessToken", "")
                        refresh_token = payload.get("refreshToken", "")
                        id_token = str(payload.get("idToken") or "").strip()
                        profile_arn = str(
                            payload.get("profileArn")
                            or payload.get("profile_arn")
                            or ""
                        ).strip()
                        expires_at = payload.get("expiresAt")
                        expires_in = payload.get("expiresIn")
                        if not access_token:
                            raise NonRetryableBatcherError(
                                ErrorCode.provider_unsupported_response,
                                "kiro token response missing accessToken",
                            )
                        tokens = {
                            "access_token": access_token,
                            "refresh_token": refresh_token,
                        }
                        if id_token:
                            tokens["id_token"] = id_token
                        if profile_arn:
                            tokens["profile_arn"] = profile_arn
                        if expires_at is not None:
                            tokens["expires_at"] = str(expires_at)
                        if expires_in is not None:
                            tokens["expires_in"] = str(expires_in)
                        return tokens

                    if resp.status == 429:
                        raise RetryableBatcherError(
                            ErrorCode.http_429, "kiro token endpoint rate limited"
                        )

                    if resp.status >= 500:
                        raise RetryableBatcherError(
                            ErrorCode.http_5xx,
                            f"kiro token endpoint server error ({resp.status})",
                        )

                    body = await resp.text()
                    raise NonRetryableBatcherError(
                        ErrorCode.provider_unsupported_response,
                        f"kiro token endpoint rejected request ({resp.status}): {body[:120]}",
                    )
        except aiohttp.ServerTimeoutError as exc:
            raise RetryableBatcherError(
                ErrorCode.network_timeout, "kiro token timeout"
            ) from exc
        except aiohttp.ClientConnectionError as exc:
            raise RetryableBatcherError(
                ErrorCode.network_connection_error, "kiro token connection error"
            ) from exc

    async def fetch_quota(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
    ) -> dict[str, Any] | None:
        _ = account
        user_agent = _session_user_agent(session)

        access_token = str(tokens.get("access_token") or "").strip()
        if access_token.startswith("stub-"):
            return {"limit": 0, "remaining": 0}

        profile_arn = str(
            tokens.get("profile_arn") or tokens.get("profileArn") or ""
        ).strip()
        usage_url = _build_kiro_usage_url(profile_arn)

        for attempt in range(2):
            access_token = str(tokens.get("access_token") or "").strip()
            if not access_token:
                refreshed = await _refresh_kiro_access_token(tokens)
                if not refreshed:
                    return None
                access_token = str(tokens.get("access_token") or "").strip()

            try:
                timeout = aiohttp.ClientTimeout(total=20)
                async with aiohttp.ClientSession(timeout=timeout) as client:
                    async with client.get(
                        usage_url,
                        headers={
                            "Authorization": f"Bearer {access_token}",
                            "Content-Type": "application/json",
                            "User-Agent": user_agent,
                        },
                        ssl=_SSL_CTX,
                    ) as resp:
                        if resp.status == 200:
                            payload = await resp.json()
                            return _parse_kiro_usage_payload(payload)

                        if resp.status in (401, 403) and attempt == 0:
                            refreshed = await _refresh_kiro_access_token(tokens)
                            if refreshed:
                                continue

                        if resp.status == 429:
                            raise RetryableBatcherError(
                                ErrorCode.http_429, "kiro quota endpoint rate limited"
                            )

                        if resp.status >= 500:
                            raise RetryableBatcherError(
                                ErrorCode.http_5xx,
                                f"kiro quota endpoint server error ({resp.status})",
                            )

                        body = await resp.text()
                        raise RetryableBatcherError(
                            ErrorCode.provider_quota_fetch_failed,
                            f"kiro quota endpoint failed ({resp.status}): {body[:200]}",
                        )
            except aiohttp.ServerTimeoutError as exc:
                raise RetryableBatcherError(
                    ErrorCode.network_timeout, "kiro quota timeout"
                ) from exc
            except aiohttp.ClientConnectionError as exc:
                raise RetryableBatcherError(
                    ErrorCode.network_connection_error, "kiro quota connection error"
                ) from exc

        return None

    async def cleanup_session(self, session: Any) -> None:
        if not isinstance(session, dict):
            return

        manager = session.get("manager")
        if manager is None:
            return

        try:
            await manager.__aexit__(None, None, None)
        except Exception:
            return
