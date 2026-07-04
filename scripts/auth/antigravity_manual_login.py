#!/usr/bin/env python3
"""Antigravity manual login — visible nodriver 'frame' + dashboard challenge UX.

Ports enowxai's manual-login pattern (qoder_manual_login.py / qoder_common.py)
to etteum antigravity, on nodriver (NOT Camoufox — Google detects Camoufox).

What this is:
  A VISIBLE (headless=False) nodriver Chrome window opens — that window IS the
  'frame'. The script drives Google OAuth (email → password → consent) and
  streams line-JSON events to stdout in the enowxai shape so the etteum
  dashboard can render them like enowxai's browser log:
    - progress (step=browser_launch|browser_host|email_step|password_step|...)
    - manual_challenge (CAPTCHA image as base64 + prompt) — the dashboard shows
      a modal; the user types the answer; it round-trips back here via stdin
      (one JSON line {"answer":"..."}); we type it into the page.
    - result ({"antigravity":{success,credentials,quota,error}})
    - error

The TS side spawns this script (mirroring enowxai's Go server spawning
qoder_manual_login.py) with --cancel-signal-file; if that file appears, we
abort cleanly. The final result event is mapped by runner.ts applyProviderResult.

This is ADDITIVE: it does not replace login.py (single-account direct path) or
batch_login.py (queue path). Those still work unchanged.

Usage:
  python antigravity_manual_login.py --email X --password Y [--cancel-signal-file PATH]

Env (same as login.py):
  BATCHER_CAMOUFOX_HEADLESS  ignored — this script is ALWAYS headed (the frame)
  BATCHER_PROXY_URL          optional proxy
  BATCHER_DEBUG              true for verbose debug lines
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
import time
from typing import Any
from urllib.parse import urlencode, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.providers.antigravity import (
    AG_AUTHORIZE_URL,
    AG_CLIENT_ID,
    AG_SCOPE,
    DEFAULT_CALLBACK_PORT,
    REDIRECT_PATH,
    _CallbackState,
    _debug,
    _drive_google_login,
    _start_callback_server,
)
from app.providers.antigravity import AntigravityProviderAdapter
from app.providers.base import NormalizedAccount
from app.providers.nodriver_browser import launch_browser


def emit(data: dict) -> None:
    """Emit one JSON event line to stdout (enowxai shape, read by runner.ts)."""
    try:
        print(json.dumps(data), flush=True)
    except BrokenPipeError:
        pass


def progress(step: str, message: str, **extra: Any) -> None:
    emit({"type": "progress", "provider": "antigravity", "step": step, "message": message, **extra})


def cancelled(cancel_signal_file: str) -> bool:
    return bool(cancel_signal_file) and os.path.exists(cancel_signal_file)


async def emit_browser_host(page: Any) -> None:
    """Report which host the browser is currently on (enowxai browser_host)."""
    try:
        url = await page.evaluate("location.href") or ""
    except Exception:
        return
    if not url:
        return
    try:
        host = urlparse(url).netloc
    except Exception:
        host = ""
    msg = f"Browser at {host}" if host else f"Browser at {url[:120]}"
    progress("browser_host", msg)


async def capture_captcha_image(page: Any) -> "tuple[str, str]":
    """Capture the Google text-CAPTCHA image as (base64, format).
    Mirrors enowxai _capture_google_text_captcha_image. Returns ("", "") if none.
    """
    try:
        info = await page.evaluate("""() => {
          const img = document.querySelector('img#captchaimg, img[alt*="captcha" i]');
          if (!img) return null;
          return { src: img.src, w: img.getBoundingClientRect().width, h: img.getBoundingClientRect().height };
        }""")
    except Exception:
        return "", ""
    if not info or not info.get("src"):
        return "", ""
    src = info["src"]
    # data: URL → already base64.
    if src.startswith("data:"):
        # data:image/png;base64,XXXX
        try:
            header, b64 = src.split(",", 1)
            fmt = "png"
            if "image/jpeg" in header or "image/jpg" in header:
                fmt = "jpeg"
            return b64, fmt
        except Exception:
            return "", ""
    # http(s) URL → fetch and base64-encode.
    import urllib.request as _urllib
    try:
        with _urllib.urlopen(src, timeout=15) as resp:
            img_bytes = resp.read()
        return base64.b64encode(img_bytes).decode("ascii"), "png"
    except Exception as exc:
        _debug(f"captcha image fetch failed: {exc}")
        return "", ""


async def emit_manual_challenge(page: Any, seq: int) -> "str | None":
    """Emit a manual_challenge event with the CAPTCHA image, then wait for the
    answer on stdin (one JSON line {"answer":"..."}). Returns the answer or None.

    The dashboard renders the image + a text input; the user's answer is written
    to this script's stdin by the TS side. We block here (with a cancel check)
    until an answer arrives or the cancel-signal-file appears.
    """
    image_b64, image_fmt = await capture_captcha_image(page)
    emit({
        "type": "manual_challenge",
        "provider": "antigravity",
        "challenge_type": "captcha",
        "challenge_seq": seq,
        "challenge_image_base64": image_b64,
        "challenge_image_format": image_fmt,
        "message": "Google text CAPTCHA — type the characters you see",
        "prompt": "Type the characters shown in the image",
    })

    # Read the answer from stdin (line-JSON). The TS side writes one line.
    loop = asyncio.get_event_loop()
    deadline = time.monotonic() + 300  # 5 min to answer
    while time.monotonic() < deadline:
        # Non-blocking-ish: read a line from stdin on a thread so we can also
        # poll the cancel-signal-file.
        try:
            line = await loop.run_in_executor(None, sys.stdin.readline)
        except Exception:
            line = ""
        if line:
            line = line.strip()
            if line:
                try:
                    obj = json.loads(line)
                    ans = obj.get("answer")
                    if isinstance(ans, str) and ans:
                        return ans
                except json.JSONDecodeError:
                    # Tolerate a bare-string answer.
                    if line:
                        return line
        await asyncio.sleep(0.5)
    return None


# ── A headed 'frame' driver that surfaces CAPTCHA as a manual_challenge event ─

class _ManualChallengeDriver:
    """Drives Google login on a VISIBLE nodriver window, surfacing CAPTCHA as a
    manual_challenge event (dashboard modal) instead of the tkinter popup.

    This wraps _drive_google_login: we monkeypatch the CAPTCHA solver to call
    emit_manual_challenge. The rest of the flow (email/password/consent) is
    reused verbatim from antigravity.py.
    """

    def __init__(self, cancel_signal_file: str = "") -> None:
        self.cancel_signal_file = cancel_signal_file
        self._challenge_seq = 0

    async def solve_captcha_via_dashboard(self, page: Any) -> bool:
        """Replace _solve_google_captcha_manual: emit a manual_challenge, wait
        for the answer, type it into the page, submit."""
        if cancelled(self.cancel_signal_file):
            return False
        self._challenge_seq += 1
        answer = await emit_manual_challenge(page, self._challenge_seq)
        if not answer:
            progress("captcha_timeout", "CAPTCHA answer not received in time")
            return False
        # Type the answer into the CAPTCHA input and submit.
        try:
            from app.providers.antigravity import _fill_input, _click_button
            sel = 'input#ca, input[name="ca"]'
            present = await page.evaluate(f"!!document.querySelector('{sel}')")
            if not present:
                sel = 'input[type="text"]:not([name="Passwd"]):not([id="identifierId"])'
            await _fill_input(page, sel, answer)
            await _click_button(page, "Next")
            progress("captcha_submitted", "CAPTCHA answer submitted")
            # Wait for the captcha to clear.
            for _ in range(30):
                still = await page.evaluate(
                    "!!(document.querySelector('img#captchaimg, input#ca, input[name=\"ca\"]'))"
                )
                if not still:
                    return True
                await asyncio.sleep(1.0)
            return True
        except Exception as exc:
            _debug(f"captcha submit failed: {exc}")
            return False


async def drive_login_with_frame(
    page: Any,
    email: str,
    password: str,
    session: dict,
    cancel_signal_file: str,
) -> None:
    """Drive Google login on the visible page, surfacing CAPTCHA as a dashboard
    challenge. Reuses _drive_google_login with a patched captcha solver."""
    driver = _ManualChallengeDriver(cancel_signal_file)

    # Patch the module-level captcha solver for the duration of this drive.
    import app.providers.antigravity as ag
    original_solver = ag._solve_google_captcha_manual
    ag._solve_google_captcha_manual = lambda page, is_headless: driver.solve_captcha_via_dashboard(page)
    try:
        # is_headless=False so the existing in-page manual path is the fallback;
        # our patched solver intercepts CAPTCHA regardless of the flag.
        await _drive_google_login(page, email, password, is_headless=False, session=session)
    finally:
        ag._solve_google_captcha_manual = original_solver


async def main() -> int:
    parser = argparse.ArgumentParser(description="Antigravity manual login (visible nodriver frame + dashboard challenge UX)")
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--cancel-signal-file", default="", help="If this file appears, abort cleanly")
    args = parser.parse_args()

    account = NormalizedAccount(provider="antigravity", identifier=args.email, secret=args.password)
    adapter = AntigravityProviderAdapter()
    session: dict[str, Any] = {}
    callback_server = None

    try:
        progress("browser_launch", "Opening secure browser (visible window)...")
        # ALWAYS headed — the visible window IS the frame.
        browser, page = await launch_browser(headless=False)
        page.set_default_timeout(45000)
        session["browser"] = browser
        session["page"] = page
        progress("browser_launch", "Secure browser ready")

        # OAuth callback server + authorize URL (mirrors AntigravityProviderAdapter.authenticate).
        import secrets as _secrets
        state_token = _secrets.token_urlsafe(16)
        cb_state = _CallbackState()
        callback_server = _start_callback_server(cb_state, state_token, DEFAULT_CALLBACK_PORT)
        bound_port = callback_server.server_address[1]
        redirect_uri = f"http://localhost:{bound_port}{REDIRECT_PATH}"
        params = {
            "client_id": AG_CLIENT_ID,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": AG_SCOPE,
            "access_type": "offline",
            "prompt": "consent",
            "state": state_token,
        }
        authorize_url = f"{AG_AUTHORIZE_URL}?{urlencode(params)}"

        progress("navigate", "Opening Google OAuth...")
        await page.goto(authorize_url, wait_until="domcontentloaded", timeout=30000)

        # Background: emit browser_host periodically while the login proceeds.
        async def host_heartbeat() -> None:
            while not cancelled(args.cancel_signal_file):
                await emit_browser_host(page)
                await asyncio.sleep(6.0)

        host_task = asyncio.create_task(host_heartbeat())

        progress("google_login", "Driving Google login flow...")
        await drive_login_with_frame(page, args.email, args.password, session, args.cancel_signal_file)
        progress("waiting_callback", "Waiting for OAuth callback...")

        # Wait for the callback to capture the code (with cancel + timeout).
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and not cancelled(args.cancel_signal_file):
            with cb_state.lock:
                if cb_state.code or cb_state.error:
                    break
            await asyncio.sleep(0.5)
        host_task.cancel()

        with cb_state.lock:
            code = cb_state.code
            err = cb_state.error
        if err:
            raise RuntimeError(f"OAuth callback error: {err}")
        if not code:
            raise RuntimeError("OAuth callback timed out — no code received")
        progress("callback_received", "OAuth code received")

        # Exchange + fetch tokens + quota (reuse the provider's methods).
        auth_state = {"code": code, "redirect_uri": redirect_uri}
        tokens = await adapter.fetch_tokens(account, auth_state, session)
        progress("tokens", "Tokens obtained")
        try:
            quota = await asyncio.wait_for(adapter.fetch_quota(account, tokens, session), timeout=15)
        except Exception as exc:
            _debug(f"quota fetch failed (non-fatal): {exc}")
            quota = None

        # Capture web cookie for billing API (mirrors login.py).
        try:
            browser_cookies = await page.context.cookies()
            if browser_cookies:
                tokens["web_cookie"] = "; ".join(f"{c['name']}={c['value']}" for c in browser_cookies)
        except Exception:
            pass

        emit({"type": "result", "antigravity": {
            "success": True,
            "credentials": tokens,
            "quota": quota or {},
            "error": "",
        }})
        return 0

    except Exception as exc:
        message = str(exc) or "manual antigravity login failed"
        emit({"type": "error", "provider": "antigravity", "error": message})
        emit({"type": "result", "antigravity": {
            "success": False,
            "credentials": {},
            "quota": {},
            "error": message,
        }})
        return 1
    finally:
        if callback_server is not None:
            try:
                callback_server.shutdown()
                callback_server.server_close()
            except Exception:
                pass
        browser = session.get("browser")
        if browser is not None:
            try:
                await browser.close()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
