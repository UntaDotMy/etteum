#!/usr/bin/env python3

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import secrets
import time
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import aiohttp

from app.providers.kiro import (
    _click_continue_button,
    _detect_google_text_captcha,
    _fill_google_email_step,
    _fill_google_password_step,
    _handle_google_account_chooser,
    _handle_google_consent_continue,
    _handle_google_gaplustos,
    _is_email_step,
    _is_password_step,
    _repair_camoufox_cache_version,
    _should_probe_google_account_chooser,
)

QODER_OPENAPI_BASE = "https://openapi.qoder.sh"
QODER_LOGIN_URL = "https://qoder.com/device/selectAccounts"
QODER_DEVICE_TOKEN_URL = QODER_OPENAPI_BASE + "/api/v1/deviceToken/poll"
QODER_USERINFO_URL = QODER_OPENAPI_BASE + "/api/v1/userinfo"
QODER_DEFAULT_TIMEOUT_SECONDS = 12 * 60


@dataclass
class QoderDeviceFlow:
    verification_uri_complete: str
    code_verifier: str
    nonce: str
    machine_id: str
    expires_at: str


def proxy_url() -> str:
    return (
        os.getenv("BATCHER_PROXY_URL")
        or os.getenv("HTTPS_PROXY")
        or os.getenv("HTTP_PROXY")
        or ""
    ).strip()


def device_flow_expiry() -> str:
    return time.strftime(
        "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + QODER_DEFAULT_TIMEOUT_SECONDS)
    )


def initiate_device_flow() -> QoderDeviceFlow:
    verifier = secrets.token_urlsafe(32)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    nonce = str(uuid.uuid4())
    machine_id = str(uuid.uuid4())
    params = (
        f"challenge={challenge}"
        f"&challenge_method=S256"
        f"&machine_id={machine_id}"
        f"&nonce={nonce}"
    )
    return QoderDeviceFlow(
        verification_uri_complete=f"{QODER_LOGIN_URL}?{params}",
        code_verifier=verifier,
        nonce=nonce,
        machine_id=machine_id,
        expires_at=device_flow_expiry(),
    )


async def poll_device_token(nonce: str, code_verifier: str) -> dict[str, Any] | None:
    req_url = (
        f"{QODER_DEVICE_TOKEN_URL}?nonce={nonce}"
        f"&verifier={code_verifier}"
        f"&challenge_method=S256"
    )
    timeout = aiohttp.ClientTimeout(total=15)
    async with aiohttp.ClientSession(timeout=timeout) as client:
        async with client.get(
            req_url,
            headers={"Accept": "application/json", "User-Agent": "Go-http-client/2.0"},
            proxy=proxy_url() or None,
        ) as resp:
            if resp.status in (202, 404):
                return None
            body = await resp.text()
            if resp.status < 200 or resp.status >= 300:
                try:
                    payload = json.loads(body)
                    message = str(payload.get("message") or "").strip()
                except Exception:
                    message = ""
                if message:
                    raise RuntimeError(f"Qoder device token poll failed: {message}")
                raise RuntimeError(f"Qoder device token poll failed: HTTP {resp.status}")
            payload = json.loads(body)
            token = str(payload.get("token") or "").strip()
            if not token:
                raise RuntimeError("Qoder device token poll returned 200 but no token")
            creds = {
                "access_token": token,
                "refresh_token": str(payload.get("refresh_token") or "").strip(),
                "user_id": str(payload.get("user_id") or "").strip(),
            }
            expires_at = str(payload.get("expires_at") or "").strip()
            if not expires_at:
                expires_in = payload.get("expires_in")
                if isinstance(expires_in, (int, float)) and float(expires_in) > 0:
                    expires_at = time.strftime(
                        "%Y-%m-%dT%H:%M:%SZ",
                        time.gmtime(time.time() + float(expires_in)),
                    )
            if expires_at:
                creds["expires_at"] = expires_at
            return creds


async def fetch_user_info(access_token: str) -> dict[str, str]:
    token = str(access_token or "").strip()
    if not token:
        return {}
    timeout = aiohttp.ClientTimeout(total=15)
    async with aiohttp.ClientSession(timeout=timeout) as client:
        async with client.get(
            QODER_USERINFO_URL,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "User-Agent": "Go-http-client/2.0",
            },
            proxy=proxy_url() or None,
        ) as resp:
            if resp.status < 200 or resp.status >= 300:
                return {}
            payload = await resp.json()
            result: dict[str, str] = {}
            for source, target in (
                ("email", "email"),
                ("name", "display_name"),
                ("organization_id", "organization_id"),
                ("organizationId", "organization_id"),
            ):
                value = str(payload.get(source) or "").strip()
                if value:
                    result[target] = value
            return result


async def launch_camoufox(headless: bool) -> dict[str, Any]:
    from browserforge.fingerprints import Screen
    from camoufox.async_api import AsyncCamoufox

    camoufox_kwargs: dict[str, Any] = {
        "headless": headless,
        "os": "windows",
        "block_webrtc": True,
        "humanize": False,
        "screen": Screen(max_width=1920, max_height=1080),
    }
    proxy = proxy_url()
    if proxy:
        parsed = urlparse(proxy)
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
    return {"manager": manager, "browser": browser, "page": page}


async def cleanup_session(session: dict[str, Any] | None) -> None:
    if not session:
        return
    manager = session.get("manager")
    if manager is None:
        return
    try:
        await manager.__aexit__(None, None, None)
    except Exception:
        pass


async def click_google_button(page: Any) -> bool:
    try:
        return bool(
            await page.evaluate(
                """() => {
                    const phrases = [
                        'sign in with google',
                        'login with google',
                        'continue with google',
                    ];
                    for (const el of document.querySelectorAll('button, a, div[role="button"]')) {
                        if (!el || el.offsetParent === null) continue;
                        const txt = (el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                        if (phrases.some((phrase) => txt.includes(phrase))) {
                            el.click();
                            return true;
                        }
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def describe_login_surface(page: Any) -> str:
    try:
        items = await page.evaluate(
            """() => {
                const values = [];
                for (const el of document.querySelectorAll('button, a, div[role="button"], input, h1, h2, p, span')) {
                    if (!el || el.offsetParent === null) continue;
                    const txt = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
                      .replace(/\\s+/g, ' ')
                      .trim();
                    if (!txt) continue;
                    values.push(txt);
                    if (values.length >= 12) break;
                }
                return values;
            }"""
        )
    except Exception:
        return ""
    if not items:
        return ""
    return " | ".join(str(item).strip() for item in items if str(item).strip())


async def wait_and_click_google_button(page: Any, emit_progress=None, timeout_seconds: int = 25) -> bool:
    deadline = time.monotonic() + timeout_seconds
    announced_wait = False
    while time.monotonic() < deadline:
        if await click_google_button(page):
            return True
        target = await current_google_target(page)
        if target is not page and await click_google_button(target):
            return True
        if emit_progress and not announced_wait:
            announced_wait = True
            emit_progress("qoder_surface", "Waiting for Qoder login buttons to appear")
        await asyncio.sleep(0.75)
    return False


async def current_google_target(page: Any) -> Any:
    try:
        pages = list(page.context.pages)
    except Exception:
        return page
    for candidate in reversed(pages):
        try:
            url = candidate.url or ""
        except Exception:
            continue
        if "accounts.google.com" in url:
            return candidate
    for candidate in reversed(pages):
        try:
            _ = candidate.url
            return candidate
        except Exception:
            continue
    return page


async def emit_browser_position(page: Any, emit_progress) -> None:
    target = await current_google_target(page)
    try:
        url = target.url or ""
    except Exception:
        return
    if not url:
        return
    try:
        host = urlparse(url).netloc
    except Exception:
        host = ""
    message = f"Browser at {host}" if host else f"Browser at {url[:120]}"
    emit_progress("browser_host", message)


async def _emit_manual_challenge_qoder(
    session: dict[str, Any],
    challenge_type: str,
    message: str,
    prompt: str,
    image_b64: str = "",
    image_format: str = "",
) -> None:
    callback = session.get("manual_challenge_callback")
    if not callable(callback):
        return
    session["_manual_challenge_pending"] = True
    seq = int(session.get("_manual_challenge_seq") or 0) + 1
    session["_manual_challenge_seq"] = seq
    result = callback(
        {
            "type": "manual_challenge",
            "provider": "qoder",
            "challenge_type": challenge_type,
            "challenge_seq": seq,
            "challenge_image_base64": image_b64,
            "challenge_image_format": image_format,
            "message": message,
            "prompt": prompt,
        }
    )
    if asyncio.iscoroutine(result):
        await result


async def _capture_google_text_captcha_image(page: Any) -> tuple[str, str]:
    try:
        handle = await page.evaluate_handle(
            """() => {
                const candidates = Array.from(document.querySelectorAll('img, canvas')).filter((el) => {
                    if (el.offsetParent === null) return false;
                    const r = el.getBoundingClientRect();
                    if (r.width < 70 || r.height < 24) return false;
                    const alt = String(el.getAttribute?.('alt') || '').toLowerCase();
                    if (alt.includes('google')) return false;
                    return true;
                });
                if (!candidates.length) return null;
                candidates.sort((a, b) => {
                    const ra = a.getBoundingClientRect();
                    const rb = b.getBoundingClientRect();
                    return (rb.width * rb.height) - (ra.width * ra.height);
                });
                return candidates[0];
            }"""
        )
        element = handle.as_element()
        if element is None:
            return "", ""
        bbox = await element.bounding_box()
        if not bbox or bbox.get("width", 0) < 70 or bbox.get("height", 0) < 24:
            return "", ""

        viewport = page.viewport_size or {"width": 1280, "height": 720}
        vp_w = int(viewport.get("width") or 1280)
        vp_h = int(viewport.get("height") or 720)
        x = max(0.0, float(bbox["x"]))
        y = max(0.0, float(bbox["y"]))
        w = max(1.0, min(float(bbox["width"]), vp_w - x))
        h = max(1.0, min(float(bbox["height"]), vp_h - y))
        shot = await page.screenshot(
            type="jpeg",
            quality=85,
            clip={"x": x, "y": y, "width": w, "height": h},
        )
        if not shot:
            return "", ""
        return base64.b64encode(shot).decode("ascii"), "jpeg"
    except Exception:
        return "", ""


async def _submit_google_text_captcha(page: Any, text: str) -> bool:
    clean = str(text or "").strip()
    if not clean:
        return False

    selectors = [
        "input[aria-label*='hear or see' i]",
        "input[type='text']",
        "input[type='tel']",
        "input:not([type])",
    ]
    for selector in selectors:
        try:
            locator = page.locator(selector).first
            if await locator.count() == 0 or not await locator.is_visible():
                continue
            input_type = str(await locator.get_attribute("type") or "").lower()
            input_name = str(await locator.get_attribute("name") or "")
            input_id = str(await locator.get_attribute("id") or "")
            if input_type in {"password", "email", "hidden"}:
                continue
            if input_name in {"Passwd", "identifier"} or input_id == "identifierId":
                continue

            await locator.scroll_into_view_if_needed()
            await locator.click(force=True)
            try:
                await locator.press("Control+a")
                await locator.press("Backspace")
            except Exception:
                pass
            await locator.press_sequentially(clean, delay=50)
            await asyncio.sleep(0.3)
            clicked = await _click_continue_button(page)
            if not clicked:
                await locator.press("Enter")
            return True
        except Exception:
            continue
    return False


async def _wait_for_google_text_captcha_input_qoder(
    page: Any,
    session: dict[str, Any],
    marker: str,
    challenge_step: str,
    email: str,
    password: str,
) -> bool:
    queue = session.get("manual_challenge_queue")
    if queue is None:
        return False

    image_b64, image_format = await _capture_google_text_captcha_image(page)
    await _emit_manual_challenge_qoder(
        session,
        "google_text_captcha",
        "Google captcha detected — enter the text in the modal to continue",
        "Type the text you hear or see",
        image_b64=image_b64,
        image_format=image_format,
    )

    while True:
        if session.get("cancel_requested"):
            return False
        try:
            payload = await asyncio.wait_for(queue.get(), timeout=1.0)
        except asyncio.TimeoutError:
            still_visible = await _detect_google_text_captcha(page)
            if not still_visible:
                session["_manual_challenge_pending"] = False
                return True
            continue

        text = str((payload or {}).get("text") or "").strip()
        if not text:
            continue
        submitted = await _submit_google_text_captcha(page, text)
        if submitted:
            await asyncio.sleep(0.6)
            if challenge_step == "email":
                await _fill_google_email_step(page, email)
            elif challenge_step == "password":
                await _fill_google_password_step(page, password)
            session["_manual_challenge_pending"] = False
            return True


async def complete_google_oauth(
    page: Any,
    email: str,
    password: str,
    emit_progress,
    session: dict[str, Any] | None = None,
) -> None:
    email_transition_deadline = 0.0
    password_transition_deadline = 0.0
    account_chooser_deadline = 0.0
    email_step_started_at: float | None = None
    last_host = ""

    for _ in range(180):
        target = await current_google_target(page)
        try:
            current_url = target.url or ""
        except Exception:
            await asyncio.sleep(1.0)
            continue
        current_host = urlparse(current_url).netloc if current_url else ""
        on_google = "accounts.google.com" in current_host
        now = time.monotonic()

        if current_host and current_host != last_host:
            last_host = current_host
            emit_progress("browser_host", f"Browser at {current_host}")

        if "SetSID" in current_url or "/accounts/set" in current_url.lower():
            await asyncio.sleep(0.5)
            continue

        if on_google and await _handle_google_gaplustos(target):
            emit_progress("challenge", "Google needs one more confirmation")
            await asyncio.sleep(0.8)
            continue

        if on_google and await _handle_google_consent_continue(target):
            emit_progress("consent", "Continuing Google consent")
            await asyncio.sleep(0.8)
            continue

        if on_google:
            if _should_probe_google_account_chooser(
                current_host,
                current_url,
                now,
                account_chooser_deadline,
            ):
                if await _handle_google_account_chooser(target, email):
                    emit_progress("account_chooser", f"Choosing Google account {email}")
                    account_chooser_deadline = 0.0
                    await asyncio.sleep(1.0)
                    continue

            text_captcha_marker = await _detect_google_text_captcha(target)
            if text_captcha_marker:
                challenge_step = ""
                if await _is_password_step(target):
                    challenge_step = "password"
                elif await _is_email_step(target):
                    challenge_step = "email"
                if session is not None:
                    handled = await _wait_for_google_text_captcha_input_qoder(
                        target,
                        session,
                        text_captcha_marker,
                        challenge_step,
                        email,
                        password,
                    )
                    if handled:
                        await asyncio.sleep(1.0)
                        continue

            at_password_step = await _is_password_step(target)
            at_email_step = await _is_email_step(target)

            if at_email_step and not at_password_step:
                if email_step_started_at is None:
                    email_step_started_at = now
                if now < email_transition_deadline:
                    await asyncio.sleep(0.4)
                    continue
                emit_progress("email", f"Filling Google email for {email}")
                if await _fill_google_email_step(target, email):
                    email_transition_deadline = time.monotonic() + 6.0
                    account_chooser_deadline = time.monotonic() + 10.0
                    await asyncio.sleep(1.0)
                    continue

            if at_password_step:
                email_step_started_at = None
                if now < password_transition_deadline:
                    await asyncio.sleep(0.4)
                    continue
                emit_progress("password", "Filling Google password")
                if await _fill_google_password_step(target, password):
                    password_transition_deadline = time.monotonic() + 8.0
                    account_chooser_deadline = time.monotonic() + 10.0
                    await asyncio.sleep(1.0)
                    continue

            if at_email_step or at_password_step:
                await asyncio.sleep(0.6)
                continue
        else:
            email_step_started_at = None

        await _click_continue_button(target)
        if target is not page:
            await _click_continue_button(page)
        await asyncio.sleep(1.0)


def progress_event(provider: str, step: str, message: str, **extra: Any) -> dict[str, Any]:
    payload = {
        "type": "progress",
        "provider": provider,
        "step": step,
        "message": message,
    }
    payload.update(extra)
    return payload
