from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlparse

import aiohttp

from ._config import (
    CODEBUDDY_API_KEYS_ENDPOINT,
    CODEBUDDY_BASE_URL,
    CODEBUDDY_CONSOLE_ACCOUNTS_ENDPOINT,
    CODEBUDDY_CONSOLE_AUTH_LOGIN_ENDPOINT,
    CODEBUDDY_CONSOLE_LOGIN_ACCOUNT_ENDPOINT,
    CODEBUDDY_CONSOLE_LOGIN_ENTERPRISE_ENDPOINT,
    CODEBUDDY_CONSOLE_VALIDATE_REFRESH_TOKEN_ENDPOINT,
    CODEBUDDY_PLATFORM,
    CODEBUDDY_REDIRECT_SCHEME,
    CODEBUDDY_USER_RESOURCE_ENDPOINT,
    WEB_HEADERS,
)
from ._utils import (
    _codebuddy_auth_debug,
    _codebuddy_auth_debug_enabled,
    _get_proxy_url,
    _make_session,
    _req_proxy,
)
from ._page_helpers import (
    _build_cookie_header_from_dict,
    _build_codebuddy_billing_cookie_header,
    _handle_codebuddy_region_select,
    _load_cookies_from_file,
    _restore_cookies_to_page,
    _save_cookies_to_file,
)


def _summarize_create_key_status(status: int) -> str:
    """Human-readable hint for the most common create-API-key HTTP statuses."""
    if status in (401, 403):
        return "session expired or not authorized — re-login needed"
    if status == 429:
        return "rate limited by CodeBuddy — slow down or retry later"
    if status == 400:
        return "bad request — account/enterprise id may be invalid"
    if status in (500, 502, 503, 504):
        return "CodeBuddy server error — temporary, retry later"
    if status == 0:
        return "network/browser error — request never reached CodeBuddy"
    return "unexpected response"


async def _create_api_key_attempt(
    page: Any, user_enterprise_id: str
) -> tuple[str | None, int, str]:
    """Single create-API-key attempt. Returns (api_key, status, reason)."""
    import random as _rng

    key_name = f"pool-{_rng.randint(100000, 999999)}"

    try:
        result = await page.evaluate(
            """async ({ url, body }) => {
                try {
                    const resp = await fetch(url, {
                        method: 'POST',
                        credentials: 'include',
                        headers: {
                            'Accept': 'application/json, text/plain, */*',
                            'Content-Type': 'application/json',
                            'X-Requested-With': 'XMLHttpRequest',
                        },
                        body: JSON.stringify(body),
                    });
                    const text = await resp.text();
                    let json = null;
                    try { json = JSON.parse(text); } catch {}
                    return { status: resp.status, text, json };
                } catch (err) {
                    return { status: 0, text: String(err), json: null };
                }
            }""",
            {
                "url": CODEBUDDY_API_KEYS_ENDPOINT,
                "body": {
                    "name": key_name,
                    "expire_in_days": -1,
                    "user_enterprise_id": user_enterprise_id,
                },
            },
        )
    except Exception as exc:
        _codebuddy_auth_debug(f"create api key via page error={exc}")
        return None, 0, f"browser request failed: {exc}"

    status = int(result.get("status") or 0)
    payload = result.get("json")
    body_text = str(result.get("text") or "")

    if _codebuddy_auth_debug_enabled():
        code = payload.get("code") if isinstance(payload, dict) else None
        _codebuddy_auth_debug(f"create api key via page status={status} code={code}")

    if status != 200 or not isinstance(payload, dict):
        hint = _summarize_create_key_status(status)
        snippet = body_text.strip().replace("\n", " ")[:120]
        reason = f"HTTP {status} ({hint})"
        if snippet:
            reason += f": {snippet}"
        if status and body_text:
            _codebuddy_auth_debug(f"create api key via page body={body_text[:160]}")
        return None, status, reason

    code = payload.get("code")
    if code != 0:
        message = str(payload.get("message") or payload.get("msg") or "").strip()
        reason = f"CodeBuddy rejected the request (code={code})"
        if message:
            reason += f": {message}"
        return None, status, reason

    data = payload.get("data") or {}
    api_key = str(data.get("key") or "").strip()

    if api_key:
        _codebuddy_auth_debug(f"api key created key={api_key[:15]}...")
        return api_key, status, ""

    return None, status, "CodeBuddy returned success but no API key was present"


async def _create_api_key_via_page(
    page: Any, user_enterprise_id: str = "personal-edition-user-id"
) -> tuple[str | None, str]:
    """Create a CodeBuddy API key via the logged-in page, with retries.

    Returns (api_key, reason). On success reason is "". On failure api_key is
    None and reason is a specific, log-friendly explanation.

    The api-keys POST is sometimes rejected at the gateway (nginx 401) when the
    in-page request lacks the right Origin/Referer — typically because the page
    drifted off the codebuddy.ai origin. Between attempts we re-navigate to
    /profile to restore the origin, mirroring the Go flow, before retrying.
    """
    last_reason = "no attempt made"
    for attempt in range(3):
        if attempt > 0:
            try:
                await page.goto(
                    f"{CODEBUDDY_BASE_URL}/profile",
                    wait_until="domcontentloaded",
                    timeout=15000,
                )
                await asyncio.sleep(2.0)
            except Exception as exc:
                _codebuddy_auth_debug(
                    f"create api key retry navigation failed: {exc}"
                )

        api_key, status, reason = await _create_api_key_attempt(
            page, user_enterprise_id
        )
        if api_key:
            return api_key, ""

        last_reason = reason
        _codebuddy_auth_debug(
            f"create api key attempt {attempt + 1}/3 failed: {reason}"
        )
        # 400 bad-request won't fix itself with a retry; fail fast.
        if status == 400:
            break
        await asyncio.sleep(1.5)

    return None, last_reason


async def _set_region_with_cookies(cookie_data: dict[str, Any]) -> bool:
    """Set region (Singapore) via HTTP request using cookies"""
    cookies = cookie_data.get("cookies", [])
    if not cookies:
        return False

    cookie_header = _build_cookie_header_from_dict(cookies)
    if not cookie_header:
        return False

    headers = {
        **WEB_HEADERS,
        "Cookie": cookie_header,
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
    }

    payload_body = {
        "attributes": {
            "countryCode": ["65"],
            "countryFullName": ["Singapore"],
            "countryName": ["SG"],
        }
    }

    timeout = aiohttp.ClientTimeout(total=20)
    try:
        async with _make_session(timeout, headers) as client:
            async with client.post(
                CODEBUDDY_CONSOLE_LOGIN_ACCOUNT_ENDPOINT,
                json=payload_body,
                proxy=_req_proxy(client),
            ) as resp:
                status = int(resp.status)
                body_text = await resp.text()

                if status != 200:
                    _codebuddy_auth_debug(
                        f"set region with cookies status={status} body={body_text[:160]}"
                    )
                    return False

                payload = await resp.json()
                code = payload.get("code") if isinstance(payload, dict) else None
                _codebuddy_auth_debug(
                    f"set region with cookies status={status} code={code}"
                )

                return status == 200 and code == 0
    except Exception as exc:
        _codebuddy_auth_debug(f"set region with cookies error={exc}")
        return False


async def _create_api_key_with_cookies(
    cookie_data: dict[str, Any], user_enterprise_id: str = "personal-edition-user-id"
) -> str | None:
    import time

    cookies = cookie_data.get("cookies", [])
    if not cookies:
        return None

    cookie_header = _build_cookie_header_from_dict(cookies)
    if not cookie_header:
        return None

    headers = {
        **WEB_HEADERS,
        "Cookie": cookie_header,
        "Content-Type": "application/json",
    }

    import random as _rng

    key_name = f"pool-{_rng.randint(100000, 999999)}"

    payload_body = {
        "name": key_name,
        "expire_in_days": -1,
        "user_enterprise_id": user_enterprise_id,
    }

    timeout = aiohttp.ClientTimeout(total=20)
    try:
        async with _make_session(timeout, headers) as client:
            async with client.post(
                CODEBUDDY_API_KEYS_ENDPOINT, json=payload_body, proxy=_req_proxy(client)
            ) as resp:
                status = int(resp.status)
                body_text = await resp.text()

                if status != 200:
                    _codebuddy_auth_debug(
                        f"create api key with cookies status={status} body={body_text[:160]}"
                    )
                    return None

                payload = await resp.json()
    except Exception as exc:
        _codebuddy_auth_debug(f"create api key with cookies error={exc}")
        return None

    if payload.get("code") != 0:
        return None

    data = payload.get("data") or {}
    api_key = str(data.get("key") or "").strip()

    if api_key:
        _codebuddy_auth_debug(f"api key created with cookies key={api_key[:15]}...")
        return api_key

    return None


async def _ensure_region_with_retry(
    page: Any, account_email: str, max_retries: int = 3
) -> bool:
    for attempt in range(1, max_retries + 1):
        _codebuddy_auth_debug(f"region selection attempt={attempt}/{max_retries}")

        await _submit_region_via_page(page)
        await asyncio.sleep(2.0)

        is_profile, current_url = await _open_profile_and_check_region(page)
        if is_profile:
            _codebuddy_auth_debug(f"region verified via /profile/keys attempt={attempt}")
            return True

        if "/register/user/complete" in (current_url or ""):
            _codebuddy_auth_debug(f"still on region page, retrying attempt={attempt}")
            region_ok = await _handle_codebuddy_region_select(page)
            if region_ok:
                await asyncio.sleep(2.0)
                is_profile, _ = await _open_profile_and_check_region(page)
                if is_profile:
                    return True

        if attempt < max_retries:
            cookie_data = await _load_cookies_from_file(account_email)
            if cookie_data:
                _codebuddy_auth_debug(
                    f"restoring cookies for retry attempt={attempt + 1}"
                )
                await _restore_cookies_to_page(page, cookie_data)
                await asyncio.sleep(1.0)

                try:
                    await page.goto(
                        f"{CODEBUDDY_BASE_URL}/register/user/complete",
                        wait_until="domcontentloaded",
                        timeout=10000,
                    )
                    await asyncio.sleep(1.0)
                except Exception as exc:
                    _codebuddy_auth_debug(f"region page navigation failed err={exc}")
            else:
                _codebuddy_auth_debug(
                    f"no cookies found for retry attempt={attempt + 1}"
                )
                break

    _codebuddy_auth_debug(f"region selection failed after {max_retries} attempts")
    return False


async def _open_codebuddy_usage_page(page: Any) -> bool:
    if page is None:
        return False

    usage_url = f"{CODEBUDDY_BASE_URL}/profile/usage"
    try:
        _codebuddy_auth_debug(f"usage page goto={usage_url}")
        await page.goto(usage_url, wait_until="domcontentloaded")
        try:
            await page.wait_for_load_state("networkidle", timeout=8000)
        except Exception:
            pass
        await asyncio.sleep(1.0)
        return True
    except Exception as exc:
        _codebuddy_auth_debug(f"usage page goto failed err={exc}")
        return False


async def _claim_bonus(page: Any) -> bool:
    try:
        btn = page.locator("button", has_text="Claim Now")
        if await btn.count() == 0:
            _codebuddy_auth_debug("claim button not found — may already be claimed")
            return False

        is_disabled = await btn.get_attribute("disabled")
        if is_disabled is not None:
            _codebuddy_auth_debug("claim button is disabled — already claimed")
            return False

        await btn.click()
        _codebuddy_auth_debug("clicked Claim Now")
        return True
    except Exception as exc:
        _codebuddy_auth_debug(f"claim bonus click failed err={exc}")
        return False


async def _wait_activity_credits(page: Any, timeout: float = 30.0) -> bool:
    try:
        for _ in range(int(timeout / 2)):
            result = await page.evaluate(
                """() => {
                    const allDivs = document.querySelectorAll('div');
                    for (const div of allDivs) {
                        const text = div.textContent || '';
                        if (text.includes('Activity Credits') && text.includes('Active')) {
                            return true;
                        }
                    }
                    return false;
                }"""
            )
            if result:
                _codebuddy_auth_debug("activity credits card detected")
                return True
            await asyncio.sleep(2.0)

        _codebuddy_auth_debug("activity credits card not found after timeout")
        return False
    except Exception as exc:
        _codebuddy_auth_debug(f"wait activity credits failed err={exc}")
        return False


async def _scrape_usage_credits_from_html(page: Any) -> dict[str, float] | None:
    if page is None:
        return None

    for attempt in range(4):
        if attempt > 0:
            await asyncio.sleep(2.0 + attempt * 1.0)

        try:
            result = await page.evaluate(
                """() => {
                    let activityLeft = null;
                    let planLeft = null;
                    const body = document.body ? document.body.innerText : '';

                    const allDivs = document.querySelectorAll('div');
                    for (const div of allDivs) {
                        const rows = div.querySelectorAll('.flex.justify-between');
                        if (rows.length === 0) continue;

                        const cardText = div.textContent || '';
                        for (const row of rows) {
                            const cells = row.querySelectorAll('div');
                            for (const cell of cells) {
                                const t = cell.textContent.trim();
                                const match = t.match(/([\\d.]+)\\s*left/i);
                                if (!match) continue;
                                const val = parseFloat(match[1]);

                                if (cardText.includes('Activity Credits') && activityLeft === null) {
                                    activityLeft = val;
                                } else if ((cardText.includes('Expiration Date') || cardText.includes('Pro Plan') || cardText.includes('Plan Trial')) && planLeft === null) {
                                    planLeft = val;
                                }
                            }
                        }
                    }

                    return { activityLeft, planLeft, bodyLen: body.length };
                }"""
            )
        except Exception as exc:
            _codebuddy_auth_debug(
                f"scrape usage credits attempt={attempt + 1} err={exc}"
            )
            continue

        _codebuddy_auth_debug(
            f"scrape attempt={attempt + 1} activity={result.get('activityLeft')} plan={result.get('planLeft')} bodyLen={result.get('bodyLen')}"
        )

        if result.get("planLeft") is not None:
            break
    else:
        result = {"activityLeft": None, "planLeft": None}

    activity_left = result.get("activityLeft")
    plan_left = result.get("planLeft")

    if plan_left is None:
        _codebuddy_auth_debug("pro plan credit not found on usage page")
        return None

    activity_val = float(activity_left) if activity_left is not None else 0.0
    plan_val = float(plan_left)
    total = activity_val + plan_val

    _codebuddy_auth_debug(
        f"scraped credits activity={activity_val} plan={plan_val} total={total}"
    )

    return {
        "credit_capacity_size": total,
        "credit_capacity_remain": total,
        "credit_capacity_used": 0.0,
    }


async def _fetch_user_resource_credit_via_page(page: Any) -> dict[str, float] | None:
    if page is None:
        return None

    now = datetime.utcnow()
    payload_body = {
        "PageNumber": 1,
        "PageSize": 100,
        "ProductCode": "p_tcaca",
        "Status": [0, 3],
        "PackageEndTimeRangeBegin": now.strftime("%Y-%m-%d %H:%M:%S"),
        "PackageEndTimeRangeEnd": (now + timedelta(days=365 * 20)).strftime(
            "%Y-%m-%d %H:%M:%S"
        ),
    }

    try:
        result = await page.evaluate(
            """async ({ url, body }) => {
                try {
                    const resp = await fetch(url, {
                        method: 'POST',
                        credentials: 'include',
                        headers: {
                            'Accept': 'application/json, text/plain, */*',
                            'Content-Type': 'application/json',
                            'X-Requested-With': 'XMLHttpRequest',
                        },
                        body: JSON.stringify(body),
                    });
                    const text = await resp.text();
                    let json = null;
                    try { json = JSON.parse(text); } catch {}
                    return { status: resp.status, text, json };
                } catch (err) {
                    return { status: 0, text: String(err), json: null };
                }
            }""",
            {"url": CODEBUDDY_USER_RESOURCE_ENDPOINT, "body": payload_body},
        )
    except Exception as exc:
        _codebuddy_auth_debug(f"credit via page error={exc}")
        return None

    status = int(result.get("status") or 0)
    payload = result.get("json")
    if _codebuddy_auth_debug_enabled():
        code = payload.get("code") if isinstance(payload, dict) else None
        _codebuddy_auth_debug(f"credit via page status={status} code={code}")
    if status != 200 or not isinstance(payload, dict):
        return None
    return _credit_from_resource_payload(payload)


async def _fetch_console_accounts_via_page(page: Any) -> dict[str, Any] | None:
    try:
        result = await page.evaluate(
            """async (url) => {
                try {
                    const resp = await fetch(url, {
                        method: 'GET',
                        credentials: 'include',
                        headers: {
                            'Accept': 'application/json, text/plain, */*',
                            'X-Requested-With': 'XMLHttpRequest',
                        },
                    });
                    const text = await resp.text();
                    let json = null;
                    try { json = JSON.parse(text); } catch {}
                    return { status: resp.status, text, json };
                } catch (err) {
                    return { status: 0, text: String(err), json: null };
                }
            }""",
            CODEBUDDY_CONSOLE_ACCOUNTS_ENDPOINT,
        )
    except Exception as exc:
        _codebuddy_auth_debug(f"console accounts via page error={exc}")
        return None

    status = int(result.get("status") or 0)
    payload = result.get("json")
    if _codebuddy_auth_debug_enabled():
        code = payload.get("code") if isinstance(payload, dict) else None
        _codebuddy_auth_debug(f"console accounts via page status={status} code={code}")
    if status != 200 or not isinstance(payload, dict):
        return None

    data = payload.get("data") or {}
    accounts = data.get("accounts") or []
    if payload.get("code") != 0 or not accounts:
        return None
    return payload


async def _codebuddy_request_via_page(
    page: Any,
    method: str,
    url: str,
    *,
    body: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any] | None, str]:
    try:
        result = await page.evaluate(
            """async ({ url, method, body }) => {
                try {
                    const headers = {
                        'Accept': 'application/json, text/plain, */*',
                        'X-Requested-With': 'XMLHttpRequest',
                    };
                    const init = {
                        method,
                        credentials: 'include',
                        headers,
                    };
                    if (body !== null) {
                        headers['Content-Type'] = 'application/json';
                        init.body = JSON.stringify(body);
                    }
                    const resp = await fetch(url, init);
                    const text = await resp.text();
                    let json = null;
                    try { json = JSON.parse(text); } catch {}
                    return { status: resp.status, text, json };
                } catch (err) {
                    return { status: 0, text: String(err), json: null };
                }
            }""",
            {"url": url, "method": method.upper(), "body": body},
        )
    except Exception as exc:
        _codebuddy_auth_debug(
            f"page request error method={method.upper()} url={url} err={exc}"
        )
        return 0, None, ""

    status = int(result.get("status") or 0)
    payload = result.get("json")
    body_text = str(result.get("text") or "")
    if not isinstance(payload, dict):
        payload = None
    return status, payload, body_text


async def _submit_region_via_page(page: Any) -> bool:
    status, payload, body = await _codebuddy_request_via_page(
        page,
        "POST",
        CODEBUDDY_CONSOLE_LOGIN_ACCOUNT_ENDPOINT,
        body={
            "attributes": {
                "countryCode": ["65"],
                "countryFullName": ["Singapore"],
                "countryName": ["SG"],
            }
        },
    )
    code = payload.get("code") if isinstance(payload, dict) else None
    _codebuddy_auth_debug(f"force region via page status={status} code={code}")
    if not (status == 200 and isinstance(payload, dict) and payload.get("code") == 0):
        if status and body:
            _codebuddy_auth_debug(f"force region via page body={body[:160]}")
        return False

    accounts_payload = await _fetch_console_accounts_via_page(page)
    user_id = ""
    if accounts_payload:
        accounts_data = accounts_payload.get("data") or {}
        accounts = accounts_data.get("accounts") or []
        if accounts:
            user_id = str(accounts[0].get("uid") or "")

    if user_id:
        register_url = f"{CODEBUDDY_BASE_URL}/auth/realms/copilot/overseas/user/register?userId={user_id}"
        reg_status, reg_payload, _ = await _codebuddy_request_via_page(page, "GET", register_url)
        _codebuddy_auth_debug(f"register user status={reg_status} payload={reg_payload}")

    trial_url = f"{CODEBUDDY_BASE_URL}/billing/ide/trial"
    trial_status, trial_payload, _ = await _codebuddy_request_via_page(page, "POST", trial_url)
    _codebuddy_auth_debug(f"activate trial status={trial_status} payload={trial_payload}")

    return True


async def _open_profile_and_check_region(page: Any) -> tuple[bool, str]:
    profile_url = f"{CODEBUDDY_BASE_URL}/profile/keys"
    try:
        await page.goto(profile_url, wait_until="domcontentloaded", timeout=15000)
        try:
            await page.wait_for_load_state("networkidle", timeout=6000)
        except Exception:
            pass
        await asyncio.sleep(1.0)
    except Exception as exc:
        _codebuddy_auth_debug(f"profile/keys probe goto failed err={exc}")
        return False, ""

    try:
        current_url = str(page.url or "")
    except Exception:
        current_url = ""
    parsed = urlparse(current_url) if current_url else None
    path = parsed.path if parsed else ""

    # If redirected to /auth/, /login, or /broker/ → session expired
    if any(seg in path for seg in ("/auth/", "/login", "/broker/")):
        _codebuddy_auth_debug(
            f"profile/keys probe session expired redirect={current_url[:100]}"
        )
        return False, current_url

    is_profile = bool(path.startswith("/profile"))
    _codebuddy_auth_debug(
        f"profile/keys probe url={current_url or '-'} is_profile={is_profile}"
    )
    return is_profile, current_url


async def _ensure_region_profile_access(page: Any, *, max_attempts: int = 2) -> bool:
    for attempt in range(1, max_attempts + 1):
        is_profile, _ = await _open_profile_and_check_region(page)
        if is_profile:
            return True
        forced = await _submit_region_via_page(page)
        _codebuddy_auth_debug(f"region retry attempt={attempt} forced={forced}")
        await asyncio.sleep(2.0)
    is_profile, _ = await _open_profile_and_check_region(page)
    return is_profile


async def _submit_region_with_bearer_via_page(page: Any, bearer: str) -> bool:
    token = str(bearer or "").strip()
    if not token:
        return False
    try:
        result = await page.evaluate(
            """async ({ url, token, body }) => {
                try {
                    const resp = await fetch(url, {
                        method: 'POST',
                        credentials: 'include',
                        headers: {
                            'Accept': 'application/json, text/plain, */*',
                            'Content-Type': 'application/json',
                            'X-Requested-With': 'XMLHttpRequest',
                            'Authorization': `Bearer ${token}`,
                        },
                        body: JSON.stringify(body),
                    });
                    const text = await resp.text();
                    let json = null;
                    try { json = JSON.parse(text); } catch {}
                    return { status: resp.status, text, json };
                } catch (err) {
                    return { status: 0, text: String(err), json: null };
                }
            }""",
            {
                "url": CODEBUDDY_CONSOLE_LOGIN_ACCOUNT_ENDPOINT,
                "token": token,
                "body": {
                    "attributes": {
                        "countryCode": ["65"],
                        "countryFullName": ["Singapore"],
                        "countryName": ["SG"],
                    }
                },
            },
        )
    except Exception as exc:
        _codebuddy_auth_debug(f"force region with bearer error={exc}")
        return False

    status = int(result.get("status") or 0)
    payload = result.get("json")
    body = str(result.get("text") or "")
    code = payload.get("code") if isinstance(payload, dict) else None
    _codebuddy_auth_debug(f"force region with bearer status={status} code={code}")
    if status == 200 and isinstance(payload, dict) and payload.get("code") == 0:
        return True
    if status and body:
        _codebuddy_auth_debug(f"force region with bearer body={body[:160]}")
    return False


async def _ensure_region_after_token(
    page: Any, bearer: str, *, max_attempts: int = 2
) -> bool:
    for attempt in range(1, max_attempts + 1):
        forced = await _submit_region_with_bearer_via_page(page, bearer)
        if not forced:
            forced = await _submit_region_via_page(page)
        _codebuddy_auth_debug(f"region post-token attempt={attempt} forced={forced}")
        await asyncio.sleep(0.8)
        is_profile, _ = await _open_profile_and_check_region(page)
        if is_profile:
            return True
    is_profile, _ = await _open_profile_and_check_region(page)
    return is_profile


async def _validate_refresh_token_via_page(page: Any) -> bool:
    status, payload, body = await _codebuddy_request_via_page(
        page,
        "GET",
        CODEBUDDY_CONSOLE_VALIDATE_REFRESH_TOKEN_ENDPOINT,
    )
    code = payload.get("code") if isinstance(payload, dict) else None
    _codebuddy_auth_debug(
        f"validate refresh-token via page status={status} code={code}"
    )
    if status == 200 and isinstance(payload, dict) and payload.get("code") == 0:
        return True
    if status and body:
        _codebuddy_auth_debug(f"validate refresh-token via page body={body[:160]}")
    return False


async def _console_login_enterprise_via_page(
    page: Any, state: str
) -> dict[str, Any] | None:
    state = str(state or "").strip()
    if not state:
        return None

    status, payload, body = await _codebuddy_request_via_page(
        page,
        "POST",
        f"{CODEBUDDY_CONSOLE_LOGIN_ENTERPRISE_ENDPOINT}?state={state}",
    )
    code = payload.get("code") if isinstance(payload, dict) else None
    has_token = bool(((payload or {}).get("data") or {}).get("accessToken"))
    _codebuddy_auth_debug(
        f"console login enterprise via page status={status} code={code} has_token={has_token}"
    )
    if status == 200 and isinstance(payload, dict) and payload.get("code") == 0:
        return payload
    if status and body:
        _codebuddy_auth_debug(f"console login enterprise via page body={body[:160]}")
    return None


async def _fetch_console_accounts(
    cookie_header: str, referer: str = ""
) -> dict[str, Any] | None:
    cookie_header = str(cookie_header or "").strip()
    if not cookie_header:
        return None

    headers = {
        **WEB_HEADERS,
        "Cookie": cookie_header,
    }
    if referer:
        headers["Referer"] = referer

    timeout = aiohttp.ClientTimeout(total=15)
    try:
        async with _make_session(timeout, headers) as client:
            async with client.get(
                CODEBUDDY_CONSOLE_ACCOUNTS_ENDPOINT,
                allow_redirects=False,
                proxy=_req_proxy(client),
            ) as resp:
                if resp.status != 200:
                    return None
                payload = await resp.json()
    except Exception as exc:
        _codebuddy_auth_debug(f"console accounts fetch failed err={exc}")
        return None

    data = payload.get("data") or {}
    accounts = data.get("accounts") or []
    if payload.get("code") != 0 or not accounts:
        return None
    return payload


async def _codebuddy_console_request(
    method: str,
    url: str,
    cookie_header: str,
    *,
    referer: str = "",
    params: dict[str, str] | None = None,
    allow_redirects: bool = False,
) -> tuple[int, dict[str, Any] | None, str, str]:
    cookie_header = str(cookie_header or "").strip()
    if not cookie_header:
        return 0, None, "", ""

    headers = {
        **WEB_HEADERS,
        "Cookie": cookie_header,
        "Origin": CODEBUDDY_BASE_URL,
    }
    if referer:
        headers["Referer"] = referer

    timeout = aiohttp.ClientTimeout(total=20)
    try:
        async with _make_session(timeout, headers) as client:
            async with client.request(
                method.upper(),
                url,
                params=params,
                allow_redirects=allow_redirects,
                proxy=_req_proxy(client),
            ) as resp:
                status = int(resp.status)
                final_url = str(resp.url)
                body = await resp.text()
    except Exception as exc:
        _codebuddy_auth_debug(
            f"console request failed method={method.upper()} url={url} err={exc}"
        )
        return 0, None, "", ""

    payload: dict[str, Any] | None = None
    try:
        parsed = json.loads(body)
        if isinstance(parsed, dict):
            payload = parsed
    except Exception:
        payload = None

    return status, payload, body, final_url


async def _validate_refresh_token(cookie_header: str, referer: str = "") -> bool:
    status, payload, body, _ = await _codebuddy_console_request(
        "GET",
        CODEBUDDY_CONSOLE_VALIDATE_REFRESH_TOKEN_ENDPOINT,
        cookie_header,
        referer=referer,
    )
    code = payload.get("code") if isinstance(payload, dict) else None
    _codebuddy_auth_debug(f"validate refresh-token status={status} code={code}")
    if status == 200 and isinstance(payload, dict) and payload.get("code") == 0:
        return True
    if status and body:
        _codebuddy_auth_debug(f"validate refresh-token body={body[:160]}")
    return False


async def _console_login_enterprise(
    cookie_header: str,
    state: str,
    *,
    referer: str = "",
    enterprise_id: str = "",
) -> dict[str, Any] | None:
    state = str(state or "").strip()
    if not state:
        return None

    endpoint = CODEBUDDY_CONSOLE_LOGIN_ENTERPRISE_ENDPOINT
    enterprise_id = str(enterprise_id or "").strip()
    if enterprise_id:
        endpoint = f"{endpoint.rstrip('/')}/{enterprise_id}"

    status, payload, body, _ = await _codebuddy_console_request(
        "POST",
        endpoint,
        cookie_header,
        referer=referer,
        params={"state": state},
    )
    code = payload.get("code") if isinstance(payload, dict) else None
    has_token = bool(((payload or {}).get("data") or {}).get("accessToken"))
    _codebuddy_auth_debug(
        f"console login enterprise status={status} code={code} has_token={has_token}"
    )
    if status == 200 and isinstance(payload, dict) and payload.get("code") == 0:
        return payload
    if status and body:
        _codebuddy_auth_debug(f"console login enterprise body={body[:160]}")
    return None


async def _console_auth_login(
    cookie_header: str,
    state: str,
    *,
    referer: str = "",
    platform: str = CODEBUDDY_PLATFORM,
    domain: str = "",
) -> bool:
    state = str(state or "").strip()
    domain = str(domain or "").strip() or urlparse(CODEBUDDY_BASE_URL).netloc
    if not state:
        return False

    status, payload, body, final_url = await _codebuddy_console_request(
        "GET",
        CODEBUDDY_CONSOLE_AUTH_LOGIN_ENDPOINT,
        cookie_header,
        referer=referer,
        params={"platform": platform, "state": state, "domain": domain},
        allow_redirects=False,
    )
    code = payload.get("code") if isinstance(payload, dict) else None
    _codebuddy_auth_debug(
        f"console auth login status={status} code={code} final_url={final_url or '-'}"
    )
    if status in (200, 302):
        return True
    if status and body:
        _codebuddy_auth_debug(f"console auth login body={body[:160]}")
    return False


async def _complete_started_with_cookie(
    cookie_header: str, state: str, referer: str = ""
) -> bool:
    cookie_header = str(cookie_header or "").strip()
    if not cookie_header or not state:
        return False

    started_url = (
        f"{CODEBUDDY_BASE_URL}/started?platform={CODEBUDDY_PLATFORM}&state={state}"
    )
    headers = {
        **WEB_HEADERS,
        "Cookie": cookie_header,
    }
    if referer:
        headers["Referer"] = referer

    try:
        _codebuddy_auth_debug(f"started request={started_url}")
        timeout = aiohttp.ClientTimeout(total=20)
        async with _make_session(timeout, headers) as client:
            async with client.get(
                started_url, allow_redirects=True, proxy=_req_proxy(client)
            ) as resp:
                final_url = str(resp.url)
                status = int(resp.status)
                body = await resp.text()
        _codebuddy_auth_debug(f"started status={status} final_url={final_url}")
        if status >= 500:
            return False
        if status == 404:
            _codebuddy_auth_debug(f"started body={body[:160]}")
            return False
        return True
    except Exception as exc:
        _codebuddy_auth_debug(f"started request failed err={exc}")
        return False


async def _complete_started_in_browser(page: Any, state: str) -> bool:
    if not state:
        return False

    started_url = (
        f"{CODEBUDDY_BASE_URL}/started?platform={CODEBUDDY_PLATFORM}&state={state}"
    )
    try:
        _codebuddy_auth_debug(f"started browser goto={started_url}")
        await page.goto(started_url, wait_until="domcontentloaded", timeout=15000)
    except Exception as exc:
        _codebuddy_auth_debug(f"started browser goto failed err={exc}")

    for _ in range(20):
        try:
            current_url = str(page.url)
        except Exception:
            current_url = ""
        if current_url.startswith(CODEBUDDY_REDIRECT_SCHEME):
            _codebuddy_auth_debug(f"started browser redirect url={current_url}")
            return True
        parsed = urlparse(current_url) if current_url else None
        if (
            parsed
            and parsed.netloc == urlparse(CODEBUDDY_BASE_URL).netloc
            and parsed.path == "/started"
        ):
            _codebuddy_auth_debug(f"started browser landed url={current_url}")
            return True
        await asyncio.sleep(0.5)
    return False


def _credit_from_resource_payload(
    resource_payload: dict[str, Any],
) -> dict[str, float] | None:
    if resource_payload.get("code") != 0:
        return None

    response_data = ((resource_payload.get("data") or {}).get("Response") or {}).get(
        "Data"
    ) or {}
    total_dosage = float(response_data.get("TotalDosage") or 0)
    accounts_list = response_data.get("Accounts") or []
    summary: dict[str, float] = {"credit_total_dosage": total_dosage}
    if not accounts_list:
        return summary

    total_remain = 0.0
    total_used = 0.0
    total_size = 0.0
    for acct in accounts_list:
        total_remain += float(acct.get("CapacityRemain") or 0)
        total_used += float(acct.get("CapacityUsed") or 0)
        total_size += float(acct.get("CapacitySize") or 0)

    summary["credit_capacity_remain"] = (
        total_dosage if total_dosage > total_remain else total_remain
    )
    summary["credit_capacity_used"] = total_used
    summary["credit_capacity_size"] = (
        total_dosage if total_dosage > total_size else total_size
    )
    return summary


