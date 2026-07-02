from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
import time
import uuid
import base64
from typing import Any
from urllib.parse import urlparse

import aiohttp

from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount, ProviderAdapter
from app.providers.kiro import (
    _fill_google_email_step,
    _fill_google_password_step,
    _handle_google_consent_continue,
    _handle_google_gaplustos,
    _is_email_step,
    _is_password_step,
)

_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

QODER_SIGN_IN_URL = "https://qoder.com/users/sign-in"
QODER_INTEGRATIONS_URL = "https://qoder.com/account/integrations"
QODER_DEVICE_AUTH_BASE = "https://qoder.com/device/selectAccounts"
QODER_CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb"
QODER_OPENAPI_BASE = "https://openapi.qoder.sh"
QODER_PAT_EXCHANGE_URL = f"{QODER_OPENAPI_BASE}/api/v1/jobToken/exchange"
QODER_QUOTA_URL = f"{QODER_OPENAPI_BASE}/api/v2/quota/usage"
QODER_PLAN_URL = f"{QODER_OPENAPI_BASE}/api/v2/user/plan"


def _debug(msg: str) -> None:
    if os.getenv("BATCHER_DEBUG", "").lower() == "true":
        print(f"[qoder-debug] {msg}", flush=True)


def _generate_pkce_challenge() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(32)
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return verifier, challenge


async def _drive_qoder_google_auth(page: Any, email: str, password: str) -> None:
    email_transition_deadline = 0.0
    password_transition_deadline = 0.0
    email_step_started_at: float | None = None

    for _ in range(120):
        try:
            cur = page.url
        except Exception:
            return

        try:
            cur_host = urlparse(cur).netloc
        except Exception:
            cur_host = ""

        if cur_host.endswith("qoder.com"):
            _debug("redirected back to Qoder")
            return

        now = time.monotonic()

        if await _handle_google_gaplustos(page):
            await asyncio.sleep(1.0)
            continue

        if await _handle_google_consent_continue(page):
            await asyncio.sleep(1.0)
            continue

        on_google_auth = cur_host.endswith("accounts.google.com")
        if on_google_auth:
            at_password_step = await _is_password_step(page)
            at_email_step = await _is_email_step(page)

            if at_email_step and not at_password_step:
                if email_step_started_at is None:
                    email_step_started_at = now
                elif now - email_step_started_at > 60.0:
                    raise RetryableBatcherError(
                        ErrorCode.browser_challenge_blocked,
                        "qoder captcha suspected: email step stuck > 60s",
                    )
                if now < email_transition_deadline:
                    await asyncio.sleep(0.5)
                    continue
                if await _fill_google_email_step(page, email):
                    email_transition_deadline = time.monotonic() + 6.0
                    await asyncio.sleep(1.5)
                    continue

            if at_password_step:
                email_step_started_at = None
                if now < password_transition_deadline:
                    await asyncio.sleep(0.5)
                    continue
                if await _fill_google_password_step(page, password):
                    password_transition_deadline = time.monotonic() + 8.0
                    await asyncio.sleep(1.5)
                    continue

            await asyncio.sleep(0.7)
            continue

        email_step_started_at = None
        await asyncio.sleep(1.0)


class QoderProviderAdapter(ProviderAdapter):
    name = "qoder"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [p.strip() for p in raw_line.split("|")]
        if len(parts) < 2 or not parts[0] or not parts[1]:
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "qoder account must be email|password",
            )
        email = parts[0]
        password = parts[1]
        if not _EMAIL_PATTERN.match(email):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "qoder account email format is invalid",
            )
        return NormalizedAccount(
            provider=self.name,
            identifier=email,
            secret=password,
            metadata={},
            raw=raw_line,
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        if os.getenv("BATCHER_ENABLE_CAMOUFOX", "false").lower() != "true":
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                "qoder requires camoufox (set BATCHER_ENABLE_CAMOUFOX=true)",
            )

        try:
            from browserforge.fingerprints import Screen
            from camoufox.async_api import AsyncCamoufox
        except Exception as exc:
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                f"camoufox import failed: {exc}",
            ) from exc

        camoufox_kwargs: dict[str, Any] = {
            "headless": os.getenv("BATCHER_CAMOUFOX_HEADLESS", "false").lower() == "true",
            "os": "windows",
            "block_webrtc": True,
            "humanize": False,
            "screen": Screen(max_width=1920, max_height=1080),
        }

        from app.proxy_pool import get_next_proxy

        proxy_url = get_next_proxy() or ""
        if proxy_url:
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

        try:
            manager = AsyncCamoufox(**camoufox_kwargs)
            browser = await manager.__aenter__()
            page = await browser.new_page()
            page.set_default_timeout(120000)
            await page.goto(QODER_SIGN_IN_URL, wait_until="domcontentloaded", timeout=30000)
        except Exception as exc:
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                f"camoufox launch failed: {exc}",
            ) from exc

        return {
            "manager": manager,
            "browser": browser,
            "page": page,
            "proxy_url": proxy_url or None,
        }

    async def authenticate(
        self, account: NormalizedAccount, session: Any
    ) -> dict[str, Any]:
        if session is None:
            raise RetryableBatcherError(
                ErrorCode.browser_unexpected_state, "no session for qoder auth"
            )

        page = session["page"]

        # Wait for sign-in page to fully load
        await asyncio.sleep(2.0)

        # Check if already logged in (redirected to profile/account)
        cur_url = page.url
        if "qoder.com" in cur_url and "/users/sign-in" not in cur_url:
            _debug(f"Already logged in or redirected: {cur_url[:80]}")
            # Need to sign out first if already logged in
            try:
                await page.goto("https://qoder.com/users/sign-in", wait_until="domcontentloaded", timeout=15000)
                await asyncio.sleep(2.0)
            except Exception:
                pass

        # Click "Sign in with Google" — Qoder uses <a> with href /sso/login/google
        try:
            google_btn = page.locator(
                'a[href*="/sso/login/google"], '
                'a:has-text("Google"), '
                'li:has-text("Sign in with Google")'
            ).first
            await asyncio.sleep(1.0)
            if await google_btn.count() > 0:
                await google_btn.click()
                await asyncio.sleep(2.0)
                _debug("Clicked Google sign-in button")
            else:
                _debug("No Google button found, trying direct SSO URL")
                await page.goto(
                    "https://qoder.com/sso/login/google?oauth_callback=https://qoder.com/account/profile",
                    wait_until="domcontentloaded",
                    timeout=30000,
                )
                await asyncio.sleep(2.0)
        except Exception as exc:
            _debug(f"Error clicking Google button, using direct SSO: {exc}")
            await page.goto(
                "https://qoder.com/sso/login/google?oauth_callback=https://qoder.com/account/profile",
                wait_until="domcontentloaded",
                timeout=30000,
            )
            await asyncio.sleep(2.0)

        # Drive Google OAuth
        await _drive_qoder_google_auth(page, account.identifier, account.secret)

        # Wait for redirect back to qoder.com
        timeout_seconds = int(os.getenv("QODER_LOGIN_TIMEOUT", "120"))
        deadline = time.monotonic() + timeout_seconds
        redirected = False
        last_url = ""

        while time.monotonic() < deadline:
            try:
                cur = page.url
                last_url = cur
                cur_host = urlparse(cur).netloc
                if cur_host.endswith("qoder.com") and "/users/sign-in" not in cur:
                    redirected = True
                    break
            except Exception:
                pass
            await asyncio.sleep(1.0)

        if not redirected:
            raise RetryableBatcherError(
                ErrorCode.auth_timeout,
                f"qoder login timed out after {timeout_seconds}s @ url={last_url[:200]}",
            )

        _debug(f"Qoder login successful, landed at: {last_url[:100]}")
        return {"page": page, "logged_in": True}

    async def fetch_tokens(
        self, account: NormalizedAccount, auth_state: Any, session: Any
    ) -> dict[str, Any]:
        page = auth_state["page"]

        # Step 1: Navigate to integrations page and generate PAT
        _debug("Navigating to integrations page to generate PAT")
        await page.goto(QODER_INTEGRATIONS_URL, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(2.0)

        # Click "New Token" button
        new_token_btn = page.locator('button:has-text("New Token")').first
        await new_token_btn.click()
        await asyncio.sleep(1.0)

        # Fill token name
        name_input = page.locator('input[placeholder="Enter access token name"]').first
        await name_input.fill(f"poolprox-{int(time.time())}")
        await asyncio.sleep(0.5)

        # Click date picker and select 1 year from now
        date_input = page.locator('input[placeholder="Set an expiration date"]').first
        await date_input.click()
        await asyncio.sleep(0.5)

        # Navigate to next year
        next_year_btn = page.locator('button[aria-label*="Next year"]').first
        await next_year_btn.click()
        await asyncio.sleep(0.3)

        # Pick day 1 (safe for all months)
        day_cells = page.locator("td").filter(has_text=re.compile(r"^1$"))
        for i in range(await day_cells.count()):
            cell = day_cells.nth(i)
            if await cell.evaluate("el => !el.classList.contains('disabled') && getComputedStyle(el).pointerEvents !== 'none'"):
                await cell.click()
                break
        await asyncio.sleep(0.5)

        # Click Create button
        create_btn = page.locator('button:has-text("Create"):not([disabled])').first
        await create_btn.click()
        await asyncio.sleep(2.0)

        # Extract PAT from dialog
        pat = await page.evaluate("""() => {
            const dialog = document.querySelector('[role="dialog"]');
            if (!dialog) return null;
            const text = dialog.textContent || '';
            const match = text.match(/pt-[A-Za-z0-9_-]+/);
            return match ? match[0] : null;
        }""")

        if not pat:
            raise RetryableBatcherError(
                ErrorCode.auth_token_extraction_failed,
                "failed to extract PAT from integrations page",
            )

        # Remove trailing "I" if regex captured start of "I have securely stored"
        if pat.endswith("I"):
            pat = pat[:-1]

        _debug(f"PAT generated: {pat[:20]}...")

        # Step 2: Approve device OAuth login to trigger trial
        machine_id = str(uuid.uuid4())
        _verifier, challenge = _generate_pkce_challenge()
        nonce = str(uuid.uuid4())

        device_url = (
            f"{QODER_DEVICE_AUTH_BASE}"
            f"?challenge={challenge}"
            f"&challenge_method=S256"
            f"&nonce={nonce}"
            f"&machine_id={machine_id}"
            f"&client_id={QODER_CLIENT_ID}"
        )

        _debug(f"Navigating to device auth: {device_url[:100]}")
        await page.goto(device_url, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(2.0)

        # Click "Continue" to approve device login
        try:
            continue_btn = page.locator('button:has-text("Continue")').first
            if await continue_btn.count() > 0:
                await continue_btn.click()
                await asyncio.sleep(3.0)
                _debug("Device auth approved")
            else:
                _debug("No Continue button found on device auth page")
        except Exception as exc:
            _debug(f"Error approving device auth: {exc}")

        # Step 3: Exchange PAT to verify it works
        async with aiohttp.ClientSession() as http:
            resp = await http.post(
                QODER_PAT_EXCHANGE_URL,
                json={"personal_token": pat},
                headers={"Content-Type": "application/json", "Accept": "application/json"},
            )
            if resp.status != 200:
                body = await resp.text()
                raise RetryableBatcherError(
                    ErrorCode.auth_token_extraction_failed,
                    f"PAT exchange failed: {resp.status} {body[:200]}",
                )
            exchange_data = await resp.json()

        token = exchange_data.get("token", "")
        refresh_token = exchange_data.get("refresh_token", "")

        if not token:
            raise RetryableBatcherError(
                ErrorCode.auth_token_extraction_failed,
                "PAT exchange returned no token",
            )

        return {
            "personalToken": pat,
            "securityOauthToken": token,
            "refreshToken": refresh_token,
            "machineId": machine_id,
            "email": account.identifier,
        }

    async def fetch_quota(
        self, account: NormalizedAccount, tokens: dict[str, Any], session: Any
    ) -> dict[str, Any] | None:
        oauth_token = tokens.get("securityOauthToken", "")
        if not oauth_token:
            return None

        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {oauth_token}",
            "Cosy-ClientType": "5",
            "Cosy-Version": "1.0.8",
            "User-Agent": "qodercli/1.0.8",
        }

        async with aiohttp.ClientSession() as http:
            # Check quota
            resp = await http.get(QODER_QUOTA_URL, headers=headers)
            if resp.status != 200:
                return None
            quota_data = await resp.json()

            # Check plan
            resp2 = await http.get(QODER_PLAN_URL, headers=headers)
            plan_data = await resp2.json() if resp2.status == 200 else {}

        user_quota = quota_data.get("userQuota", {})
        total = user_quota.get("total", 0)
        remaining = user_quota.get("remaining", 0)
        plan_name = plan_data.get("plan_tier_name", "Community")

        _debug(f"Quota: total={total} remaining={remaining} plan={plan_name}")

        return {
            "quotaLimit": total,
            "quotaRemaining": remaining,
            "plan": plan_name,
            "isQuotaExceeded": quota_data.get("isQuotaExceeded", False),
        }

    async def cleanup_session(self, session: Any) -> None:
        if session is None:
            return
        manager = session.get("manager")
        if manager:
            try:
                await manager.__aexit__(None, None, None)
            except Exception:
                pass
