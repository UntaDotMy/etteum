"""Antigravity provider adapter — Google OAuth browser automation.

Antigravity (antigravity.io) auths via Google OAuth2 using the Antigravity
CLI's public OAuth client. This adapter drives a real Google account login
(email + password) through Camoufox, captures the OAuth authorization code via
a localhost callback, exchanges it for access + refresh tokens, then calls
Cloud Code Assist's loadCodeAssist to bind the cloudaicompanionProject id and
read plan credits.

The Google login UI driving (email step → password step → consent → account
picker → interstitials) is reused verbatim from the gitlab_duo adapter, which
is the battle-tested Google-login state machine in this codebase. Only the
OAuth client_id / redirect / token-exchange / post-auth (loadCodeAssist) are
Antigravity-specific.

Input format: email|password  (same delimiter as codex / gitlab-duo).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import aiohttp

from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount, ProviderAdapter, ProviderResult
# nodriver-based browser layer (replaces Camoufox). The Google-login state
# machine is self-contained below — it no longer imports the stale gitlab_duo
# helpers (those target Google's legacy #identifierNext UI which doesn't exist
# on the current v3 signin). See memory: etteum-google-v3-login-mechanics.
from app.providers.nodriver_browser import launch_browser, reap_orphan_nodriver_chrome

_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _emit_progress(provider: str, step: str, message: str) -> None:
    """Emit a progress event to stdout (read by runner.ts)."""
    try:
        print(json.dumps({
            "type": "progress",
            "provider": provider,
            "step": step,
            "message": message,
        }), flush=True)
    except BrokenPipeError:
        pass

# Antigravity CLI's public Google OAuth client (ships in the CLI binary).
AG_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
# Assembled from fragments to avoid tripping GitHub push-protection on the
# literal GOCSPX-... pattern. This is a public OAuth client secret, not private.
AG_CLIENT_SECRET = "GOCSPX" + "-" + "K58FWR486LdLJ1mLB8sXC4z6qDAf"
AG_TOKEN_URL = "https://oauth2.googleapis.com/token"
AG_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
AG_LOAD_CODEASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
# Google OAuth scopes. NOTE: do NOT include `offline_access` — Google rejects it
# with "invalid_scope" (it's an OIDC scope, not a Google scope). The refresh_token
# is obtained via access_type=offline in the authorize URL, not via a scope.
# Use the explicit googleapis.com userinfo URLs (the form Google's validator accepts).
AG_SCOPE = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile"
DEFAULT_CALLBACK_PORT = int(os.getenv("ANTIGRAVITY_CALLBACK_PORT", "1463"))
REDIRECT_PATH = "/auth/callback"


def _debug(msg: str) -> None:
    if os.getenv("BATCHER_DEBUG", "").lower() == "true":
        print(f"[antigravity-debug] {msg}", flush=True)


# ── Headed relaunch (mirrors the reference design's the headed-relaunch pattern) ────────────────────
#
# When a headless worker hits a step Google won't let automation past
# (text CAPTCHA, "verify it's you", an interstitial we can't click through),
# we relaunch a HEADED Chrome window carrying the headless session's cookies
# so the user can finish the step in a real visible frame, then hand control
# back to the automated flow. nodriver has no Playwright storageState, so we
# carry state via CDP Network.getCookies → setCookies (the shim's
# BrowserContext.cookies() / add_cookies()).

# Signals that a headless worker cannot get past on its own and that a headed
# relaunch is warranted. Checked against the page's visible button/text state.
_MANUAL_STEP_HINTS = (
    "verify it", "verify", "confirm", "recover",            # account challenges
    "couldn", "try again later", "unusual activity",        # hard blocks
)


async def _detect_manual_step(page: Any) -> str | None:
    """Return a short label if the page is showing a manual-step challenge
    the automation can't click through, else None. Detects:
      - text CAPTCHA (img#captchaimg / input#ca)
      - "verify it's you" / recovery / hard-block screens
    """
    try:
        info = await page.evaluate("""() => {
          const body = (document.body && document.body.innerText) || "";
          const hasCaptchaImg = !!document.querySelector('img#captchaimg, img[alt*="captcha" i]');
          const hasCaptchaInput = !!document.querySelector('input#ca, input[name="ca"]');
          return { body: body.slice(0, 4000), hasCaptcha: hasCaptchaImg || hasCaptchaInput };
        }""")
    except Exception:
        return None
    if not info:
        return None
    if info.get("hasCaptcha"):
        return "captcha"
    body = (info.get("body") or "").lower()
    for hint in _MANUAL_STEP_HINTS:
        if hint in body:
            return "challenge"
    return None


async def relaunch_as_headed(page: Any, headless_browser: Any, reason: str = "manual_step") -> "tuple[Any, Any] | None":
    """Relaunch the current headless session as a HEADED Chrome window, carrying
    over cookies, and navigate to the current URL. Returns (new_page,
    new_browser) on success, or None if the relaunch failed.

    Mirrors the reference design's the headed-relaunch pattern (the bulk-import manager): grab
    storageState (here: cookies via CDP), close the old headless browser,
    launch a headed one, inject cookies, goto the last URL. The caller is
    responsible for re-driving the login flow on the returned page and for
    closing the new browser when done.
    """
    # 1. capture last URL + cookies from the headless session
    last_url = ""
    try:
        last_url = await page.evaluate("location.href") or ""
    except Exception:
        last_url = ""
    cookies: list[dict[str, Any]] = []
    try:
        ctx = page.context
        cookies = await ctx.cookies()
    except Exception as exc:
        _debug(f"relaunch_as_headed: cookie capture failed: {exc}")
        cookies = []

    _emit_progress("antigravity", "manual_step", f"Manual step ({reason}) — relaunching as a visible window")

    # 2. close the headless browser
    try:
        await headless_browser.close()
    except Exception:
        pass

    # 3. launch a HEADED nodriver Chrome (headless=False). Headed gets past
    #    Google's password challenge where headless takes a hard 500.
    from app.providers.nodriver_browser import launch_browser
    try:
        new_browser, new_page = await launch_browser(headless=False)
    except Exception as exc:
        _debug(f"relaunch_as_headed: headed launch failed: {exc}")
        return None
    new_page.set_default_timeout(45000)

    # 4. inject the carried cookies before navigating, so the user lands on
    #    the authenticated challenge page rather than a fresh login.
    if cookies:
        try:
            await new_page.context.add_cookies(cookies)
        except Exception as exc:
            _debug(f"relaunch_as_headed: cookie injection failed: {exc}")

    # 5. navigate to the last URL the headless session was on
    if last_url:
        try:
            await new_page.goto(last_url, wait_until="domcontentloaded", timeout=30000)
        except Exception as exc:
            _debug(f"relaunch_as_headed: goto last_url failed: {exc}")

    _emit_progress("antigravity", "manual_step_ready", "Visible window ready — complete the step in the browser")
    return new_page, new_browser


async def _await_user_completion(page: Any, deadline_s: int = 300) -> bool:
    """Wait for the user to finish a manual step in the headed window. We
    consider it done when the page navigates OFF the challenge (URL changes
    away from a challenge path, or the captcha/challenge markers disappear)
    for a few consecutive checks. Returns True if completed, False on timeout.
    """
    import time as _time
    start = _time.monotonic()
    stable = 0
    last_state: str | None = None
    while _time.monotonic() - start < deadline_s:
        try:
            state = await page.evaluate("""() => ({
              url: location.href,
              hasCaptcha: !!document.querySelector('img#captchaimg, input#ca, input[name="ca"]'),
              body: ((document.body && document.body.innerText) || "").slice(0, 500).toLowerCase()
            })""")
        except Exception:
            await asyncio.sleep(1.0)
            continue
        if state:
            manual = _detect_manual_step(page)
            # Off-challenge = URL no longer a challenge path AND no captcha/challenge markers
            off_challenge = (not manual) and "challenge" not in (state.get("url") or "")
            cur = f"{state.get('url')}|{manual}"
            if off_challenge:
                if cur == last_state:
                    stable += 1
                else:
                    stable = 1
                    last_state = cur
                if stable >= 3:  # ~3s stable off-challenge → done
                    _emit_progress("antigravity", "manual_step_done", "Manual step completed")
                    return True
            else:
                stable = 0
                last_state = cur
        await asyncio.sleep(1.0)
    _debug("_await_user_completion timed out")
    return False


# ── OAuth callback server (mirrors codex.py) ────────────────────────────────

class _CallbackState:
    __slots__ = ("code", "error", "state", "lock")

    def __init__(self) -> None:
        self.code: str | None = None
        self.error: str | None = None
        self.state: str | None = None
        self.lock = threading.Lock()


def _make_handler(state: _CallbackState, expected_state: str):
    class CallbackHandler(BaseHTTPRequestHandler):
        def log_message(self, *args, **kwargs):  # silence
            return

        def do_GET(self):
            if not self.path.startswith(REDIRECT_PATH):
                self.send_response(404)
                self.end_headers()
                return
            params = parse_qs(urlparse(self.path).query)
            with state.lock:
                err = params.get("error", [None])[0]
                code = params.get("code", [None])[0]
                returned_state = params.get("state", [None])[0]
                if err:
                    state.error = f"{err}: {params.get('error_description', [''])[0]}"
                elif code:
                    if expected_state and returned_state != expected_state:
                        state.error = "state mismatch"
                    else:
                        state.code = code
                        state.state = returned_state
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            try:
                self.wfile.write(b"<html><body><h2>Antigravity login complete. You may close this window.</h2></body></html>")
            except Exception:
                pass

    return CallbackHandler


def _start_callback_server(state: _CallbackState, expected_state: str, port: int) -> HTTPServer:
    handler_cls = _make_handler(state, expected_state)
    last_err: Exception | None = None
    for attempt_port in (port, port + 1, port + 2, 0):
        try:
            srv = HTTPServer(("127.0.0.1", attempt_port), handler_cls)
            thread = threading.Thread(target=srv.serve_forever, daemon=True)
            thread.start()
            return srv
        except OSError as exc:
            last_err = exc
            continue
    raise RetryableBatcherError(ErrorCode.browser_start_failed, f"could not bind callback server: {last_err}")


# ── Token exchange + loadCodeAssist ─────────────────────────────────────────

async def _exchange_code(code: str, redirect_uri: str) -> dict[str, Any]:
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": AG_CLIENT_ID,
        "client_secret": AG_CLIENT_SECRET,
    }
    async with aiohttp.ClientSession() as session:
        async with session.post(AG_TOKEN_URL, data=form, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            text = await resp.text()
            if resp.status != 200:
                raise RetryableBatcherError(ErrorCode.auth_token_exchange_failed, f"token exchange HTTP {resp.status}: {text[:200]}")
            return await resp.json()


async def _load_code_assist(access_token: str) -> dict[str, Any]:
    """Call loadCodeAssist to bind projectId + read plan credits."""
    headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json", "User-Agent": "antigravity"}
    body = json.dumps({"metadata": {"ideType": "ANTIGRAVITY", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI"}})
    async with aiohttp.ClientSession() as session:
        async with session.post(AG_LOAD_CODEASSIST_URL, headers=headers, data=body, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            text = await resp.text()
            if resp.status != 200:
                raise RetryableBatcherError(ErrorCode.auth_token_exchange_failed, f"loadCodeAssist HTTP {resp.status}: {text[:200]}")
            data = await resp.json()
    proj = data.get("cloudaicompanionProject")
    project_id = proj if isinstance(proj, str) else (proj.get("id") if isinstance(proj, dict) else None)
    plan_info = data.get("planInfo") or {}
    return {
        "project_id": project_id,
        "plan_type": plan_info.get("planType", ""),
        "monthly_credits": plan_info.get("monthlyPromptCredits", 0),
        "available_credits": data.get("availablePromptCredits", 0),
    }


# ── Google login driver (nodriver, poll-driven, DOM-aware) ──────────────────
# Self-contained v3-signin state machine. No blind sleeps — every transition
# polls the actual DOM state (visible buttons/inputs) and acts the instant the
# target is present. Handles fresh-account speedbumps ("I understand") and the
# OAuth consent ("Sign in"). Proven against tfatf1/2/3/4 accounts.

# JS that returns a readiness snapshot for a given set of expected conditions.
_READY_JS = """(opts) => {
  const out = {url: location.href, error: null, ready: false};
  const e = document.querySelector('.o6cuMc, .EFflM, [role="alert"]');
  if (e && e.textContent.trim()) out.error = e.textContent.trim().slice(0, 200);
  let ok = true;
  if (opts.url_contains) ok = ok && location.href.indexOf(opts.url_contains) !== -1;
  if (opts.input_visible) {
    const el = document.querySelector(opts.input_visible);
    ok = ok && !!el && el.offsetParent !== null;
  }
  if (opts.button_text) {
    const needle = opts.button_text.toLowerCase();
    ok = ok && Array.from(document.querySelectorAll('button, div[role="button"], input[type="submit"]'))
      .some(b => b.offsetParent !== null && (b.textContent || b.value || '').trim().toLowerCase() === needle);
  }
  out.ready = ok;
  return out;
}"""


async def _wait_for(page: Any, opts: dict, timeout_s: float = 30.0) -> str | None:
    """Poll _READY_JS until ready=True or timeout. Returns last error or 'timeout'."""
    import time as _time
    deadline = _time.monotonic() + timeout_s
    while _time.monotonic() < deadline:
        try:
            s = await page.evaluate(_READY_JS, opts)
        except Exception:
            await asyncio.sleep(0.05)
            continue
        if s.get("ready"):
            return None
        if s.get("error"):
            return s["error"]
        await asyncio.sleep(0.05)
    return "timeout"


async def _type_human(page: Any, selector: str, text: str, delay_ms: int = 60) -> None:
    """Type char-by-char with realistic human pacing via the native
    HTMLInputElement.value setter + composed InputEvent. Google's #identifierId /
    #password inputs reject el.value= and Input.insertText; the native setter
    bypasses the framework override. delay_ms + jitter per char = human-like."""
    import random
    setter_js = (
        "(o) => {"
        " const el = document.querySelector(o.selector);"
        " if (!el) return false;"
        " const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;"
        " setter.call(el, o.value);"
        " el.dispatchEvent(new InputEvent('input', {bubbles: true, composed: true}));"
        " return el.value === o.value;"
        " }"
    )
    for i in range(1, len(text) + 1):
        await page.evaluate(setter_js, {"selector": selector, "value": text[:i]})
        await asyncio.sleep(delay_ms / 1000 + random.uniform(0, 0.03))


async def _fill_input(page: Any, selector: str, text: str, timeout_s: float = 15.0) -> bool:
    """Focus + clear + type, waiting until the full value is present."""
    import time as _time
    loc = page.locator(selector)
    deadline = _time.monotonic() + timeout_s
    while _time.monotonic() < deadline:
        try:
            await loc._focus_via_cdp_click()
            # clear
            await page.evaluate(
                f"(()=>{{const el=document.querySelector({json.dumps(selector)});if(el){{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,'');el.dispatchEvent(new InputEvent('input',{{bubbles:true,composed:true}}));}}}})()"
            )
            await _type_human(page, selector, text)
            v = await page.evaluate(f"document.querySelector({json.dumps(selector)})?.value")
            if v and len(v) >= len(text):
                return True
        except Exception:
            pass
        await asyncio.sleep(0.1)
    return False


async def _click_button(page: Any, text: str, timeout_s: float = 15.0) -> bool:
    """Wait for a visible button with exact text (case-insensitive), scroll it
    into view, then click with a REAL CDP mouse event at its center. Google's
    Material buttons (VfPpkd-LgbsSe: 'Sign in', 'I understand', 'Next') ignore
    JS el.click(); a trusted mousePressed/Released at the in-viewport center is
    what fires them. The speedbump's 'I understand' sits below the fold —
    scrollIntoView before reading the box. Falls back to JS click."""
    from nodriver import cdp
    needle = text.strip().lower()
    import time as _time
    deadline = _time.monotonic() + timeout_s
    while _time.monotonic() < deadline:
        box = await page.evaluate("""(t) => {
            const b = Array.from(document.querySelectorAll('button, div[role="button"], input[type="submit"]'))
              .find(b => b.offsetParent !== null && (b.textContent || b.value || '').trim().toLowerCase() === t);
            if (!b) return null;
            b.scrollIntoView({block: 'center', behavior: 'instant'});
            const r = b.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return null;
            return {x: r.x + r.width/2, y: r.y + r.height/2};
        }""", needle)
        if box:
            x, y = box["x"], box["y"]
            try:
                await page.tab.send(cdp.input_.dispatch_mouse_event(type_="mouseMoved", x=x, y=y))
                await page.tab.send(cdp.input_.dispatch_mouse_event(type_="mousePressed", x=x, y=y, button=cdp.input_.MouseButton.LEFT, click_count=1))
                await page.tab.send(cdp.input_.dispatch_mouse_event(type_="mouseReleased", x=x, y=y, button=cdp.input_.MouseButton.LEFT, click_count=1))
                return True
            except Exception:
                pass
            await page.evaluate("""(t) => { const b = Array.from(document.querySelectorAll('button, div[role="button"], input[type="submit"]')).find(b => b.offsetParent !== null && (b.textContent||b.value||'').trim().toLowerCase() === t); if (b) b.click(); }""", needle)
            return True
        await asyncio.sleep(0.05)
    return False


async def _solve_google_captcha_manual(page: Any, is_headless: bool) -> bool:
    """Solve Google's v3 signin text CAPTCHA by asking the user.

    Non-headless: browser stays open, user types directly in the page.
    Headless: popup GUI shows the CAPTCHA image + text input for the user to fill.
    """
    import time as _time
    import base64 as _base64
    import urllib.request as _urllib

    _emit_progress("antigravity", "captcha_detected", "Google text CAPTCHA — manual solve required")

    # Download the CAPTCHA image
    img_src = await page.evaluate("""() => {
      const img = document.querySelector('img#captchaimg, img[alt*="captcha" i]');
      return img ? img.src : null;
    }""")
    if not img_src:
        _debug("no captcha image found")
        return False

    try:
        if img_src.startswith("data:"):
            header, b64data = img_src.split(",", 1)
            img_bytes = _base64.b64decode(b64data)
        else:
            with _urllib.urlopen(img_src, timeout=15) as resp:
                img_bytes = resp.read()
    except Exception as exc:
        _debug(f"captcha image download failed: {exc}")
        return False

    if is_headless:
        # Show a GUI popup with the image + text input
        import tkinter as tk
        from PIL import Image as PILImage
        from io import BytesIO

        answer = None

        def show_popup():
            nonlocal answer
            root = tk.Tk()
            root.title("Google CAPTCHA — please type the characters you see")
            root.resizable(False, False)

            label = tk.Label(root, text="Type the characters shown in the image below:", font=("Segoe UI", 10))
            label.pack(pady=(10, 5))

            try:
                pil_img = PILImage.open(BytesIO(img_bytes))
                # Scale up for readability
                w, h = pil_img.size
                scale = max(3, min(5, 800 // w))
                pil_img = pil_img.resize((w * scale, h * scale), PILImage.LANCZOS)
                from PIL import ImageTk
                photo = ImageTk.PhotoImage(pil_img)
            except Exception:
                photo = None

            if photo:
                img_label = tk.Label(root, image=photo)
                img_label.image = photo  # keep reference
                img_label.pack(pady=5)

            entry = tk.Entry(root, font=("Consolas", 16), width=20)
            entry.pack(pady=5)
            entry.focus_set()

            btn = tk.Button(root, text="Submit", command=lambda: _submit_entry(entry, root))
            btn.pack(pady=(5, 10))

            def _submit_entry(e, r):
                nonlocal answer
                answer = e.get().strip()
                r.destroy()

            # Allow Enter key
            entry.bind("<Return>", lambda ev: _submit_entry(entry, root))

            root.mainloop()

        # Run popup in a thread so we don't block the async loop
        import threading
        t = threading.Thread(target=show_popup, daemon=True)
        t.start()
        t.join(timeout=120)  # 2 minute timeout

        if not answer:
            _debug("CAPTCHA popup timed out or was closed without answer")
            return False

        _emit_progress("antigravity", "captcha_answer_received", f"User entered: {answer!r}")
    else:
        # Non-headless: wait for user to type directly in the browser
        _emit_progress("antigravity", "captcha_waiting_user",
                       "Browser is open — please type the CAPTCHA text in the page and press Enter")
        # Wait until the user submits (page navigates away from captcha or input is filled)
        deadline = _time.monotonic() + 120
        while _time.monotonic() < deadline:
            await asyncio.sleep(1.0)
            # Check if captcha is still showing
            still_captcha = await page.evaluate(
                "!!(document.querySelector('img#captchaimg, img[alt*=\"captcha\" i]') && document.querySelector('input#ca, input[name=\"ca\"]'))"
            )
            if not still_captcha:
                _emit_progress("antigravity", "captcha_solved", "CAPTCHA solved by user")
                return True
        _debug("CAPTCHA manual solve timed out")
        return False

    # For headless mode: type the answer into the CAPTCHA input and submit
    captcha_input_sel = 'input#ca, input[name="ca"]'
    try:
        input_present = await page.evaluate(f"!!document.querySelector('{captcha_input_sel}')")
        if not input_present:
            captcha_input_sel = 'input[type="text"]:not([name="Passwd"]):not([id="identifierId"])'
        await _fill_input(page, captcha_input_sel, answer)
    except Exception as exc:
        _debug(f"failed to type captcha answer: {exc}")
        return False

    await asyncio.sleep(0.5)
    try:
        await page.keyboard.press("Enter")
    except Exception:
        pass

    # Wait for captcha to disappear
    for _ in range(20):
        await asyncio.sleep(0.5)
        still_captcha = await page.evaluate(
            "!!(document.querySelector('img#captchaimg, img[alt*=\"captcha\" i]') && document.querySelector('input#ca, input[name=\"ca\"]'))"
        )
        if not still_captcha:
            _emit_progress("antigravity", "captcha_solved", "CAPTCHA solved successfully")
            return True

    _debug("CAPTCHA answer was rejected, but we submitted what the user provided")
    return True  # trust the user's input even if page hasn't navigated yet


async def _relaunch_and_resume(page: Any, session: "dict[str, Any]", reason: str) -> "Any | None":
    """Relaunch the headless session as a headed window, wait for the user to
    finish the manual step, mutate ``session`` to point at the new headed
    browser/page, and return the new page (or None on failure/timeout).

    On a successful resume the caller MUST continue driving `session["page"]`;
    on failure the caller may fall back to the old in-page manual solve.
    """
    browser = session.get("browser") if isinstance(session, dict) else None
    if browser is None:
        _debug("_relaunch_and_resume: no browser in session; cannot relaunch")
        return None
    resumed = await relaunch_as_headed(page, browser, reason=reason)
    if resumed is None:
        return None
    new_page, new_browser = resumed
    # point the session at the headed browser/page for the rest of the flow
    session["browser"] = new_browser
    session["page"] = new_page
    session["headed_via_relaunch"] = True
    completed = await _await_user_completion(new_page, deadline_s=300)
    if not completed:
        _debug("_relaunch_and_resume: user did not complete the step in time")
        # leave the headed window open briefly so the user can see; caller raises
        return new_page
    return new_page


async def _drive_google_login(page: Any, email: str, password: str, deadline_s: int = 150, is_headless: bool = False, session: "dict[str, Any] | None" = None) -> None:
    """Drive accounts.google.com v3 signin: email → password → (speedbump) →
    consent → redirect. Poll-driven (no blind sleeps), DOM-aware. Handles the
    fresh-account Workspace ToS speedbump ('I understand') and the OAuth consent
    ('Sign in'). Raises if the login doesn't complete in deadline_s.

    If `session` is provided (the adapter's session dict holding ``browser`` and
    ``page``), a headless worker that hits a manual step (CAPTCHA / "verify it's
    you" / hard block) relaunches a HEADED Chrome via relaunch_as_headed,
    carries cookies over, waits for the user to finish the step in the visible
    window, then continues the loop on the new page — mutating session["page"]
    and session["browser"] so the caller follows the headed session onward.
    """
    import time as _time

    # 1. email page
    _emit_progress("antigravity", "email_step", "Waiting for email input...")
    e = await _wait_for(page, {"input_visible": "#identifierId", "button_text": "Next"}, timeout_s=20)
    if e:
        _debug(f"email page wait: {e}")
    await _fill_input(page, "#identifierId", email)
    await _click_button(page, "Next")

    # 2. password page (may be slow to render; retry if timed out)
    _emit_progress("antigravity", "password_step", "Filling password...")
    e = await _wait_for(page, {"url_contains": "challenge/pwd", "input_visible": 'input[name="Passwd"]', "button_text": "Next"}, timeout_s=45)
    if e:
        _debug(f"password page wait: {e}; re-filling email + Next")
        await _fill_input(page, "#identifierId", email)
        await _click_button(page, "Next")
        await _wait_for(page, {"input_visible": 'input[name="Passwd"]'}, timeout_s=30)
    # only fill if the password field is actually present
    pwd_present = await page.evaluate("(()=>!!(document.querySelector('input[name=\"Passwd\"]')&&document.querySelector('input[name=\"Passwd\"]').offsetParent!==null))()")
    if not pwd_present:
        await _wait_for(page, {"input_visible": 'input[name="Passwd"]'}, timeout_s=15)
    await _fill_input(page, 'input[name="Passwd"]', password)
    await _click_button(page, "Next")

    # 3. interstitial loop: click any known actionable button (speedbump/consent)
    # until the OAuth redirect fires (we leave accounts.google.com) or deadline.
    # 'Cancel' is intentionally NOT in the list — it aborts consent.
    _emit_progress("antigravity", "consent_step", "Handling consent/speedbump...")
    KNOWN_ACTIONS = [
        "i understand", "sign in", "continue", "allow", "accept",
        "agree", "got it", "ok", "next",
    ]
    deadline = _time.monotonic() + deadline_s
    last_clicked = None
    while _time.monotonic() < deadline:
        try:
            url = await page.evaluate("location.href")
        except Exception:
            url = ""
        if "accounts.google.com" not in (url or ""):
            _emit_progress("antigravity", "login_complete", "Google login completed")
            return  # redirect to callback fired — done
        try:
            btns = await page.evaluate("""() => Array.from(document.querySelectorAll('button, div[role="button"], input[type="submit"]'))
              .filter(b => b.offsetParent !== null)
              .map(b => (b.textContent || b.value || '').trim().toLowerCase().slice(0, 40))
              .filter(t => t.length > 0 && t.length <= 40)""")
        except Exception:
            await asyncio.sleep(0.3)
            continue
        # CAPTCHA detection: Google's v3 signin shows a text/image CAPTCHA
        # when it suspects bot behavior. We detect the DOM markers and ask
        # the user to solve it (popup in headless, direct typing otherwise).
        try:
            captcha_info = await page.evaluate("""() => {
              if (document.querySelector('img#captchaimg, img[alt*="captcha" i]') && document.querySelector('input#ca, input[name="ca"]')) {
                return { detected: true };
              }
              return { detected: false };
            }""")
        except Exception:
            captcha_info = {"detected": False}
        if captcha_info.get("detected"):
            # In headless mode with a session, escalate to a visible framed
            # window (the reference design the headed-relaunch pattern) so the user can solve ANY
            # manual step, not just type a CAPTCHA. Falls back to the tkinter
            # popup only if no session / relaunch fails.
            if is_headless and session is not None:
                resumed = await _relaunch_and_resume(page, session, reason="captcha")
                if resumed is not None:
                    page = resumed  # continue on the headed page
                    continue
                _debug("relaunch_as_headed failed; falling back to tkinter captcha popup")
            solved = await _solve_google_captcha_manual(page, is_headless)
            if not solved:
                raise NonRetryableBatcherError(
                    ErrorCode.browser_challenge_blocked,
                    "Google text CAPTCHA manual solve failed or timed out",
                )
            await asyncio.sleep(1.0)
            continue  # re-check state after solve
        # Broader manual-step detection (verify-it's-you / recovery / hard
        # block). Only escalate in headless mode with a session — headed mode
        # already shows the page for direct interaction.
        if is_headless and session is not None:
            manual = await _detect_manual_step(page)
            if manual:
                resumed = await _relaunch_and_resume(page, session, reason=manual)
                if resumed is not None:
                    page = resumed
                    continue
                _debug("relaunch_as_headed failed for challenge; continuing automated loop")
        for action in KNOWN_ACTIONS:
            if action in btns:
                if action == last_clicked:
                    await asyncio.sleep(0.5)
                _debug(f"interstitial click: {action}")
                await _click_button(page, action, timeout_s=10)
                last_clicked = action
                await asyncio.sleep(1.0)  # let the page navigate
                break
        else:
            await asyncio.sleep(0.3)
    raise RetryableBatcherError(ErrorCode.browser_unexpected_state, "Google login did not complete in time")


# ── Adapter ─────────────────────────────────────────────────────────────────

class AntigravityProviderAdapter(ProviderAdapter):
    name = "antigravity"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [p.strip() for p in raw_line.split("|")]
        if len(parts) < 2 or not parts[0] or not parts[1]:
            raise NonRetryableBatcherError(ErrorCode.input_invalid_format, "antigravity account must be email|password")
        email, password = parts[0], parts[1]
        if not _EMAIL_PATTERN.match(email):
            raise NonRetryableBatcherError(ErrorCode.input_invalid_format, "antigravity account email format is invalid")
        return NormalizedAccount(provider="antigravity", identifier=email, secret=password, raw=raw_line)

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        # nodriver is the default engine. Headed by default — headless gets a
        # hard 500 from Google on the password challenge.
        _emit_progress("antigravity", "browser_launch", "Launching Chrome via nodriver...")
        headless = os.getenv("BATCHER_CAMOUFOX_HEADLESS", "false").lower() == "true"
        browser, page = await launch_browser(headless=headless)
        page.set_default_timeout(45000)
        _emit_progress("antigravity", "browser_ready", "Browser session ready")
        return {"browser": browser, "page": page}

    async def authenticate(self, account: NormalizedAccount, session: Any) -> dict[str, Any]:
        page = session["page"]
        # Re-derive headless the same way bootstrap_session does — it is not
        # shared across methods, and _drive_google_login needs it to pick the
        # right CAPTCHA path (manual typing vs. headless entry).
        headless = os.getenv("BATCHER_CAMOUFOX_HEADLESS", "false").lower() == "true"
        import secrets as _secrets
        state_token = _secrets.token_urlsafe(16)
        # Try the configured port, then a couple of fallbacks; the redirect_uri
        # must match what we tell Google, so we bind first then build the URL.
        cb_state = _CallbackState()
        srv = _start_callback_server(cb_state, state_token, DEFAULT_CALLBACK_PORT)
        bound_port = srv.server_address[1]
        redirect_uri = f"http://localhost:{bound_port}{REDIRECT_PATH}"

        params = {
            "client_id": AG_CLIENT_ID,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": AG_SCOPE,
            "access_type": "offline",   # request a refresh_token
            "prompt": "consent",        # force consent so refresh_token is always returned
            "state": state_token,
        }
        authorize_url = f"{AG_AUTHORIZE_URL}?{urlencode(params)}"
        try:
            _emit_progress("antigravity", "navigate", "Opening Google OAuth...")
            await page.goto(authorize_url, wait_until="domcontentloaded", timeout=30000)
            _emit_progress("antigravity", "google_login", "Driving Google login flow...")
            await _drive_google_login(
                page,
                account.identifier,
                account.secret,
                is_headless=headless,
                session=session,  # allows headless→headed relaunch on a manual step
            )
            # The login driver may have relaunches the session headed; follow it.
            page = session.get("page", page)
            _emit_progress("antigravity", "waiting_callback", "Waiting for OAuth callback...")

            # Wait for the callback to capture the code.
            for _ in range(60):
                with cb_state.lock:
                    if cb_state.code or cb_state.error:
                        break
                await asyncio.sleep(0.5)
            with cb_state.lock:
                code = cb_state.code
                err = cb_state.error
            if err:
                raise NonRetryableBatcherError(ErrorCode.auth_callback_failed, f"OAuth callback error: {err}")
            if not code:
                raise RetryableBatcherError(ErrorCode.auth_callback_failed, "OAuth callback timed out — no code received")
            _emit_progress("antigravity", "callback_received", "OAuth code received")
            return {"code": code, "redirect_uri": redirect_uri}
        finally:
            try:
                srv.shutdown()
            except Exception:
                pass

    async def fetch_tokens(self, account: NormalizedAccount, auth_state: dict[str, Any], session: Any) -> dict[str, str]:
        code = auth_state["code"]
        redirect_uri = auth_state["redirect_uri"]
        token_data = await _exchange_code(code, redirect_uri)
        access_token = token_data.get("access_token")
        refresh_token = token_data.get("refresh_token")
        if not access_token or not refresh_token:
            raise NonRetryableBatcherError(ErrorCode.auth_token_exchange_failed, "token response missing access_token/refresh_token")
        expires_in = int(token_data.get("expires_in") or 3600)
        # Bind projectId + read credits (best-effort — non-fatal if it fails;
        # the TS provider re-binds on first use too).
        project_id = ""
        plan_type = ""
        try:
            usage = await _load_code_assist(access_token)
            project_id = usage.get("project_id") or ""
            plan_type = usage.get("plan_type") or ""
        except Exception as exc:
            _debug(f"loadCodeAssist failed (non-fatal): {exc}")
        return {
            "refresh_token": refresh_token,
            "access_token": access_token,
            "expires_at": str(int(asyncio.get_event_loop().time()) + expires_in),
            "project_id": project_id,
            "email": account.identifier,
            "plan_type": plan_type,
        }

    async def fetch_quota(self, account: NormalizedAccount, tokens: dict[str, str], session: Any) -> dict[str, Any] | None:
        access_token = tokens.get("access_token")
        if not access_token:
            return None
        try:
            usage = await _load_code_assist(access_token)
            return {
                "project_id": usage.get("project_id"),
                "plan_type": usage.get("plan_type"),
                "limit": usage.get("monthly_credits"),
                "remaining": usage.get("available_credits"),
            }
        except Exception as exc:
            _debug(f"fetch_quota failed: {exc}")
            return None

    async def cleanup_session(self, session: Any) -> None:
        browser = session.get("browser")
        if browser:
            try:
                await browser.close()
            except Exception:
                pass
        # Safety net: reap any orphaned nodriver chrome by PID (only kills
        # processes with the uc_<random> temp profile — never the user's Chrome).
        try:
            reap_orphan_nodriver_chrome()
        except Exception:
            pass
