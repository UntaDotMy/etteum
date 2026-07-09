#!/usr/bin/env python3
"""
Camoufox flow-runner — runs the FULL login flow in Python (1:1 with enowxai),
streaming progress/frame/manual_challenge events to the TS layer over stdio.

This is the architecture enowxai uses: Python owns the Camoufox browser + the
page-interaction logic (selectors, fills, interstitial recovery). TS calls
run_login(provider, creds) and receives a stream of events + a final result.

Protocol:
  Request:  {"id":1,"method":"run_login","params":{"provider","email","password","proxy","headless"}}
  Events:   {"id":1,"type":"event","event":"progress","step":"navigate","message":"..."}
            {"id":1,"type":"event","event":"frame","data":{"png":"base64..."}}
            {"id":1,"type":"event","event":"manual_challenge","challengeType":"google_2fa","message":"..."}
  Response: {"id":1,"ok":true,"result":{"success":true,"tokens":{...},"quota":{...},"email":"..."}}
            {"id":1,"ok":true,"result":{"success":false,"error":"...","manual":false}}

Supported providers: kiro, codebuddy (others follow the same shape).
"""
from __future__ import annotations
import asyncio
import base64
import json
import random
import re
import sys
import time
from urllib.parse import urlparse, parse_qs, urlencode

from camoufox.async_api import AsyncCamoufox

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# --- Google selectors (1:1 with enowxai _google_oauth.py) ---
GOOGLE_EMAIL_SELECTORS = [
    'input[type="email"]', 'input[name="identifier"]', 'input[id="identifierId"]',
    'input[autocomplete="username"]', 'input[aria-label*="Email" i]',
    'input[aria-label*="email" i]', 'input[placeholder*="Email" i]',
]
GOOGLE_PASSWORD_SELECTORS = [
    'input[type="password"]', 'input[name="Passwd"]', 'input[name="password"]',
    'input[autocomplete="current-password"]', 'input[aria-label*="password" i]',
]
GOOGLE_NEXT_SELECTORS = [
    '#identifierNext', '#passwordNext', 'button:has-text("Next")', 'button:has-text("Continue")',
    'div[role="button"]:has-text("Next")', 'div[role="button"]:has-text("Continue")',
    'button:has-text("继续")', 'button:has-text("下一步")',
]
GOOGLE_CHALLENGE_MARKERS = [
    "captcha", "try again later", "may not be secure", "unusual traffic",
    "verify it's you", "verify it’s you", "confirm it's you", "confirm it’s you",
    "两步验证", "双重验证", "验证您的身份", "确认是您本人", "验证码",
]
RESTRICTED_MARKERS = [
    "restricted", "account has been suspended", "account is disabled",
    "account has been banned", "access denied", "帐号已被封禁", "账号已被封禁",
]
INVALID_MARKERS = [
    "wrong password", "incorrect password", "couldn't find your google account",
    "couldn’t find your google account", "invalid email", "密码错误", "找不到该 google 帐号",
]


class FlowContext:
    """Holds the emit callback + per-login state."""
    def __init__(self, rid, emit):
        self.rid = rid
        self.emit = emit
        self.manual = False

    def progress(self, step, message):
        self.emit({"id": self.rid, "type": "event", "event": "progress", "step": step, "message": message})

    def frame(self, png_b64):
        self.emit({"id": self.rid, "type": "event", "event": "frame", "data": {"png": png_b64}})

    def manual(self_challenge_type, message):
        self.manual = True
        self.emit({"id": self.rid, "type": "event", "event": "manual_challenge", "challengeType": challenge_type, "message": message})

    async def screenshot_loop(self, page, interval=2.0):
        """Background task: emit periodic frame previews for the Browser Log."""
        try:
            while True:
                try:
                    buf = await page.screenshot(type="jpeg", quality=55)
                    self.frame(base64.b64encode(buf).decode("ascii"))
                except Exception:
                    pass
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            pass


async def _click_first_visible(page, selectors):
    for sel in selectors:
        try:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                await el.click(timeout=5000)
                return True
        except Exception:
            continue
    return False


async def _wait_visible(page, selectors, timeout_ms=15000):
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        for sel in selectors:
            try:
                el = await page.query_selector(sel)
                if el and await el.is_visible():
                    return el
            except Exception:
                continue
        await asyncio.sleep(0.5)
    return None


async def _human_fill(page, el, value):
    """Humanized typing 1:1 with enowxai/googleAutomation humanType."""
    await el.click(timeout=5000)
    await asyncio.sleep(0.2 + random.random() * 0.4)
    try:
        await el.press("Control+a"); await asyncio.sleep(0.05)
        await el.press("Delete"); await asyncio.sleep(0.15 + random.random() * 0.3)
    except Exception:
        pass
    for ch in str(value):
        await el.press(ch)
        base = 0.05 + random.random() * 0.13
        long_pause = 0.3 + random.random() * 0.5 if random.random() < 0.06 else 0
        await asyncio.sleep(base + long_pause)
    try:
        return await el.input_value() == str(value)
    except Exception:
        return True


async def _detect_page_state(page):
    try:
        text = (await page.evaluate("() => document.body?.innerText?.toLowerCase() || ''")) or ""
    except Exception:
        return "unknown"
    if any(m in text for m in INVALID_MARKERS): return "invalid"
    if any(m in text for m in GOOGLE_CHALLENGE_MARKERS): return "manual"
    if any(m in text for m in RESTRICTED_MARKERS): return "restricted"
    return "ok"


async def _google_login(page, email, password, ctx, login_url):
    """Stealth Google login + interstitial recovery (1:1 with enowxai)."""
    await page.goto(login_url, wait_until="domcontentloaded", timeout=60000)
    await asyncio.sleep(0.8 + random.random() * 1.2)

    # Click "Continue with Google"
    GOOGLE_BTN = ['#social-google', 'a#social-google', 'button.ButtonContinueWithGoogle',
                   'button:has-text("Continue with Google")', 'button:has-text("Google")',
                   'a:has-text("Google")', '[aria-label*="Google"]']
    if not await _click_first_visible(page, GOOGLE_BTN):
        return {"success": False, "error": "Could not find 'Continue with Google' button"}
    await asyncio.sleep(1 + random.random() * 1.5)

    # Email
    el = await _wait_visible(page, GOOGLE_EMAIL_SELECTORS, 30000)
    if not el:
        state = await _detect_page_state(page)
        return {"success": False, "error": f"Google email field not found (state={state})", "manual": state == "manual"}
    if not await _human_fill(page, el, email):
        return {"success": False, "error": "Failed to type Google email"}
    await asyncio.sleep(0.4 + random.random() * 0.6)
    await _click_first_visible(page, GOOGLE_NEXT_SELECTORS)
    await asyncio.sleep(1.5 + random.random() * 1.5)

    state = await _detect_page_state(page)
    if state == "manual":
        ctx.manual("google_2fa", "Google 2-step verification / challenge required")
        return {"success": False, "error": "Manual assist required (2FA/challenge)", "manual": True}
    if state == "invalid": return {"success": False, "error": "Invalid Google credentials"}
    if state == "restricted": return {"success": False, "error": "Google account restricted"}

    # Password
    el = await _wait_visible(page, GOOGLE_PASSWORD_SELECTORS, 30000)
    if not el: return {"success": False, "error": "Google password field not found"}
    if not await _human_fill(page, el, password):
        return {"success": False, "error": "Failed to type Google password"}
    await asyncio.sleep(0.4 + random.random() * 0.6)
    await _click_first_visible(page, GOOGLE_NEXT_SELECTORS)
    await asyncio.sleep(2 + random.random() * 2)

    state = await _detect_page_state(page)
    if state == "manual":
        ctx.manual("google_2fa", "Google 2-step verification / challenge required after password")
        return {"success": False, "error": "Manual assist required (post-password 2FA)", "manual": True}
    if state == "invalid": return {"success": False, "error": "Invalid Google password"}

    # Approve consent / skip extras
    await _click_first_visible(page, ['button:has-text("Allow")', 'button:has-text("Continue")', 'button:has-text("Approve)'])
    await asyncio.sleep(1)
    await _click_first_visible(page, ['button:has-text("Not now")', 'button:has-text("Skip)'])
    return {"success": True, "email": email}


# ── Provider flows ──────────────────────────────────────────────────────────

KIRO_AUTH_BASE = "https://prod1.kiro.dev"
KIRO_TOKEN_ENDPOINT = "https://prod1.kiro.dev/oauth2/token"
KIRO_USAGE_ENDPOINT = "https://prod1.kiro.dev/ide/api/usage"
KIRO_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

CODEBUDDY_BASE_URL = "https://www.codebuddy.ai"
CODEBUDDY_LOGIN_URL = f"{CODEBUDDY_BASE_URL}/login"
CODEBUDDY_CONSOLE_LOGIN_ENTERPRISE = f"{CODEBUDDY_BASE_URL}/console/login/enterprise"
CODEBUDDY_API_KEYS_ENDPOINT = f"{CODEBUDDY_BASE_URL}/console/api/client/v1/api-keys"
CODEBUDDY_USER_RESOURCE = f"{CODEBUDDY_BASE_URL}/billing/meter/get-user-resource"


async def _kiro_flow(page, email, password, ctx):
    ctx.progress("navigate", "Opening Kiro login…")
    await page.goto(f"{KIRO_AUTH_BASE}/login", wait_until="domcontentloaded", timeout=60000)

    ctx.progress("google_login", "Stealth Google login…")
    r = await _google_login(page, email, password, ctx, f"{KIRO_AUTH_BASE}/login")
    if not r.get("success"):
        return {"success": False, "error": r.get("error", "Kiro Google login failed"), "manual": r.get("manual", False)}

    ctx.progress("await_callback", "Awaiting Kiro OAuth callback…")
    code = None
    deadline = time.time() + 90
    while time.time() < deadline:
        url = page.url or ""
        if url.startswith("kiro://") and "?" in url:
            params = parse_qs(url.split("?", 1)[1])
            code = params.get("code", [None])[0]
            if code: break
        await asyncio.sleep(0.5)
    if not code:
        return {"success": False, "error": "Kiro callback (kiro://) not received after Google login"}

    ctx.progress("token_exchange", "Exchanging OAuth code for tokens…")
    # Token exchange happens server-side (no cookies needed) — see _kiro_fetch_tokens.
    return await _kiro_fetch_tokens(code, ctx)


async def _kiro_fetch_tokens(code, ctx):
    """Exchange the Kiro auth code for tokens via HTTP (not page.evaluate)."""
    import urllib.request, urllib.parse, json as _json
    body = _json.dumps({
        "grantType": "authorization_code", "code": code,
        "redirectUri": "kiro://kiro.kiroAgent/authenticate-success",
        "codeVerifier": "verifier-placeholder", "clientId": KIRO_CLIENT_ID, "clientOS": "mac-arm64",
    }).encode()
    req = urllib.request.Request(KIRO_TOKEN_ENDPOINT, data=body, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            j = _json.loads(resp.read())
    except Exception as e:
        return {"success": False, "error": f"kiro token endpoint rejected request: {e}"}
    tokens = {
        "access_token": j.get("accessToken") or j.get("access_token", ""),
        "refresh_token": j.get("refreshToken") or j.get("refresh_token", ""),
        "id_token": j.get("idToken") or j.get("id_token", ""),
        "profile_arn": j.get("profileArn") or j.get("profile_arn", ""),
        "expires_at": (time.time() + j.get("expiresIn", 0)) if j.get("expiresIn") else None,
    }
    ctx.progress("tokens", "Tokens obtained")
    quota = await _kiro_quota(tokens)
    return {"success": True, "tokens": tokens, "quota": quota, "email": None}


async def _kiro_quota(tokens):
    try:
        import urllib.request, json as _json
        access = tokens["access_token"]
        if not access or access.startswith("stub-"): return None
        url = KIRO_USAGE_ENDPOINT
        if tokens.get("profile_arn"):
            url += f"?profileArn={urllib.parse.quote(tokens['profile_arn'])}"
        req = urllib.request.Request(url, headers={"authorization": f"Bearer {access}", "content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            p = _json.loads(resp.read())
        free = p.get("freeCredits") or p.get("free_credits") or {}
        cap = p.get("accountCapacity") or p.get("account_capacity") or {}
        return {
            "remaining_credits": free.get("remaining", cap.get("remain", 0)),
            "total_credits": free.get("total", cap.get("size", 0)),
            "credit_capacity_remain": cap.get("remain", 0),
            "credit_capacity_size": cap.get("size", 0),
        }
    except Exception:
        return None


async def _codebuddy_flow(page, email, password, ctx):
    ctx.progress("navigate", "Opening CodeBuddy login…")
    await page.goto(CODEBUDDY_LOGIN_URL, wait_until="domcontentloaded", timeout=60000)

    # 1. Landing: terms checkbox + "Continue with Google" (iframe-aware).
    ctx.progress("landing", "Handling CodeBuddy landing (terms + Google)…")
    landed = await _codebuddy_handle_landing(page)
    if not landed:
        await asyncio.sleep(1.5)
        landed = await _codebuddy_handle_landing(page)
    if not landed:
        return {"success": False, "error": "Could not find CodeBuddy login iframe or 'Continue with Google' button"}

    # 2. Google login + interstitial recovery.
    ctx.progress("google_login", "Stealth Google login…")
    r = await _google_login(page, email, password, ctx, CODEBUDDY_LOGIN_URL)
    if not r.get("success"):
        return {"success": False, "error": r.get("error", "CodeBuddy Google login failed"), "manual": r.get("manual", False)}

    # 3. Region select (Singapore).
    ctx.progress("region", "Setting region (Singapore)…")
    await _codebuddy_region_select(page)

    # 4. Trial activation.
    ctx.progress("trial", "Activating trial…")
    try:
        await page.evaluate("""async () => {
            await fetch('BILLING_TRIAL', {method:'POST', credentials:'include', headers:{Accept:'application/json','X-Requested-With':'XMLHttpRequest'}})
        }""".replace("BILLING_TRIAL", f"{CODEBUDDY_BASE_URL}/billing/ide/trial"))
    except Exception:
        pass

    # 5. Capture the codebuddy:// callback state.
    ctx.progress("await_callback", "Awaiting CodeBuddy OAuth callback…")
    state = await _codebuddy_capture_state(page)
    if not state:
        return {"success": False, "error": "CodeBuddy callback (codebuddy://) not received"}

    # 6. console-login-enterprise: exchange state → accessToken.
    ctx.progress("token_exchange", "Exchanging state for accessToken…")
    res = await page.evaluate("""async (state) => {
        const resp = await fetch('CONSOLE_LOGIN?state=' + encodeURIComponent(state), {
            method:'POST', credentials:'include',
            headers:{Accept:'application/json','X-Requested-With':'XMLHttpRequest'},
        });
        const text = await resp.text(); let json = null; try { json = JSON.parse(text); } catch {}
        return {status: resp.status, json};
    }""".replace("CONSOLE_LOGIN", CODEBUDDY_CONSOLE_LOGIN_ENTERPRISE), state)
    if res.get("status") != 200 or res.get("json", {}).get("code") != 0:
        return {"success": False, "error": f"codebuddy console-login-enterprise failed ({res.get('status')})"}
    access_token = (res.get("json", {}).get("data") or {}).get("accessToken", "")
    if not access_token:
        return {"success": False, "error": "codebuddy console-login-enterprise returned no accessToken"}

    # 7. Create an API key.
    ctx.progress("create_api_key", "Creating API key…")
    import random as _r
    key_name = f"enowx-{int(100000 + _r.random()*900000)}"
    keyres = await page.evaluate("""async (body) => {
        const resp = await fetch('API_KEYS', {
            method:'POST', credentials:'include',
            headers:{Accept:'application/json','Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'},
            body: JSON.stringify(body),
        });
        const text = await resp.text(); let json = null; try { json = JSON.parse(text); } catch {}
        return {status: resp.status, json};
    }""".replace("API_KEYS", CODEBUDDY_API_KEYS_ENDPOINT), {"name": key_name, "expire_in_days": -1, "user_enterprise_id": "personal-edition-user-id"})
    api_key = ((keyres.get("json") or {}).get("data") or {}).get("key", "") if keyres.get("status") == 200 else ""

    ctx.progress("tokens", "Tokens + API key obtained")
    quota = await _codebuddy_quota(page)
    return {"success": True, "tokens": {"access_token": api_key or access_token, "refresh_token": access_token, "id_token": ""}, "quota": quota, "email": email}


async def _codebuddy_handle_landing(page):
    """Click terms checkbox + 'Continue with Google' (iframe-aware). 1:1 enowxai."""
    # Find the login iframe (Keycloak openid-connect).
    frame = None
    for sel in ['iframe[title="login-iframe"]', 'iframe[src*="/auth/realms/copilot/protocol/openid-connect/auth"]']:
        try:
            el = await page.query_selector(sel)
            if el:
                frame = await el.content_frame()
                if frame: break
        except Exception:
            continue
    target = frame or page

    clicked = False
    try:
        clicked = bool(await target.evaluate("""() => {
            const el = document.querySelector('div.checkmark');
            if (!el || el.offsetParent === null) return false;
            el.click(); return true;
        }"""))
    except Exception:
        pass
    try:
        clicked = clicked or bool(await target.evaluate("""() => {
            const byId = document.querySelector('#social-google');
            if (byId && byId.offsetParent !== null) { byId.click(); return true; }
            for (const a of Array.from(document.querySelectorAll('a[href*="/broker/google/login"]'))) {
                if (a.offsetParent !== null) { a.click(); return true; }
            }
            return false;
        }"""))
    except Exception:
        pass
    if not clicked:
        try:
            clicked = bool(await page.evaluate("""() => {
                const phrases = ["sign in with google","login with google","continue with google"];
                for (const btn of Array.from(document.querySelectorAll('button, a, div[role="button"]'))) {
                    if (btn.offsetParent === null) continue;
                    const txt = (btn.textContent||'').toLowerCase().trim();
                    if (phrases.some(p => txt.includes(p))) { btn.click(); return true; }
                }
                for (const a of Array.from(document.querySelectorAll('a, button'))) {
                    if (a.offsetParent === null) continue;
                    const txt = (a.textContent||'').toLowerCase().trim();
                    if (txt === 'login' || txt === 'sign in' || txt === 'log in') { a.click(); return true; }
                }
                return false;
            }"""))
        except Exception:
            pass
    return clicked


async def _codebuddy_region_select(page):
    """Singapore region dropdown. 1:1 with enowxai _page_helpers.handle_codebuddy_region_select."""
    try:
        url = page.url
        parsed = urlparse(url)
        if parsed.netloc != urlparse(CODEBUDDY_BASE_URL).netloc or not parsed.path.startswith("/register/user/complete"):
            return False
        try:
            await page.wait_for_selector('div.t-input input[placeholder="Registration location"]', state="visible", timeout=2000)
        except Exception:
            return False
        # open dropdown + search Singapore
        await page.evaluate("""() => {
            const box = document.querySelector('div.t-input input[placeholder="Registration location"]');
            if (box) box.click();
        }""")
        await asyncio.sleep(0.3)
        try:
            ov = page.locator('.dropdown-overlay input[placeholder="Search countries"]').first
            if await ov.count() > 0:
                await ov.click(force=True); await ov.fill("Singapore"); await asyncio.sleep(0.25)
        except Exception:
            pass
        # select Singapore option
        await page.evaluate("""() => {
            const sels = ['.dropdown-overlay [role="option"]', '.dropdown-overlay .dropdown-item', '.dropdown-overlay li', '.dropdown-overlay div'];
            for (const sel of sels) for (const el of Array.from(document.querySelectorAll(sel))) {
                const txt = (el.textContent||'').toLowerCase().trim();
                if (txt === 'singapore' || txt.includes('singapore')) { el.click(); return true; }
            }
            return false;
        }""")
        await asyncio.sleep(0.3)
        # submit
        try:
            sub = page.locator('button:has-text("Submit")').first
            if await sub.count() > 0 and await sub.is_visible(): await sub.click(force=True)
        except Exception:
            await page.evaluate("""() => {
                for (const el of Array.from(document.querySelectorAll('button, [role="button"]'))) {
                    const txt = (el.textContent||'').toLowerCase();
                    if (txt.includes('submit')) { el.click(); return; }
                }
            }""")
        try:
            await page.wait_for_function("() => { const p = location.pathname; return p === '/started' || !p.startsWith('/register/user/complete'); }", timeout=8000)
        except Exception:
            pass
        return True
    except Exception:
        return False


async def _codebuddy_capture_state(page):
    """Wait for codebuddy://?state= callback. 1:1 with enowxai."""
    try:
        await page.goto(f"{CODEBUDDY_BASE_URL}/started", wait_until="domcontentloaded", timeout=15000)
    except Exception:
        pass
    deadline = time.time() + 60
    while time.time() < deadline:
        url = page.url or ""
        if url.startswith("codebuddy://") and "?" in url:
            params = parse_qs(url.split("?", 1)[1])
            s = params.get("state", [None])[0]
            if s: return s
        await asyncio.sleep(0.5)
    return None


async def _codebuddy_quota(page):
    """Fetch user-resource credit via the logged-in page. 1:1 with enowxai _api."""
    try:
        from datetime import datetime, timedelta
        now = datetime.utcnow()
        end = now + timedelta(days=365*20)
        body = {
            "PageNumber": 1, "PageSize": 100, "ProductCode": "p_tcaca", "Status": [0, 3],
            "PackageEndTimeRangeBegin": now.strftime("%Y-%m-%d %H:%M:%S"),
            "PackageEndTimeRangeEnd": end.strftime("%Y-%m-%d %H:%M:%S"),
        }
        res = await page.evaluate("""async (body) => {
            const resp = await fetch('USER_RES', {method:'POST', credentials:'include',
                headers:{Accept:'application/json','Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'},
                body: JSON.stringify(body)});
            const text = await resp.text(); let json=null; try{json=JSON.parse(text)}catch{}
            return {status: resp.status, json};
        }""".replace("USER_RES", CODEBUDDY_USER_RESOURCE), body)
        if res.get("status") != 200 or res.get("json", {}).get("code") != 0:
            return None
        data = (res.get("json", {}).get("data") or {}).get("Response", {}).get("Data", {})
        accounts = data.get("Accounts") or []
        remain = sum(a.get("CapacityRemain", 0) for a in accounts)
        size = sum(a.get("CapacitySize", 0) for a in accounts)
        total = data.get("TotalDosage", 0)
        return {"remaining_credits": max(total, remain), "total_credits": max(total, size),
                "credit_capacity_remain": max(total, remain), "credit_capacity_size": max(total, size)}
    except Exception:
        return None


# ── Driver ─────────────────────────────────────────────────────────────────

FLOWS = {"kiro": _kiro_flow, "codebuddy": _codebuddy_flow}


async def run_login(rid, emit, params):
    provider = params.get("provider")
    email = (params.get("email") or "").strip().lower()
    password = params.get("password") or ""
    if not email or not password:
        return {"success": False, "error": "email and password required"}
    if not EMAIL_RE.match(email):
        return {"success": False, "error": f"invalid email: {email}"}
    flow = FLOWS.get(provider)
    if not flow:
        return {"success": False, "error": f"unsupported provider: {provider}"}

    ctx = FlowContext(rid, emit)
    ctx.progress("init", f"Initializing {provider} login (enowxai + Camoufox)…")

    opts = {"headless": params.get("headless", True), "block_webrtc": True, "humanize": False}
    if params.get("proxy"):
        opts["proxy"] = params["proxy"]; opts["geoip"] = True

    cm = AsyncCamoufox(**opts)
    browser = None
    shot_task = None
    try:
        browser = await cm.__aenter__()
        ctx.progress("browser_launch", "Browser session ready")
        context = await browser.new_context()
        page = await context.new_page()
        # Start the frame-preview stream for the Browser Log (1:1 enowxai emit frame).
        shot_task = asyncio.create_task(ctx.screenshot_loop(page))
        result = await flow(page, email, password, ctx)
        if shot_task: shot_task.cancel()
        return result
    except Exception as e:
        if shot_task: shot_task.cancel()
        return {"success": False, "error": str(e)}
    finally:
        try:
            if browser: await cm.__aexit__(None, None, None)
        except Exception:
            pass


def emit(obj, out=sys.stdout):
    out.write(json.dumps(obj) + "\n"); out.flush()


async def reader_loop():
    loop = asyncio.get_event_loop()
    emit({"type": "event", "event": "ready"})
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line: break
        line = line.strip()
        if not line: continue
        try:
            req = json.loads(line)
        except Exception as e:
            emit({"id": None, "ok": False, "error": f"bad json: {e}"}); continue
        rid = req.get("id")
        method = req.get("method")
        try:
            if method == "run_login":
                result = await run_login(rid, emit, req.get("params") or {})
                emit({"id": rid, "ok": True, "result": result})
            elif method == "ping":
                emit({"id": rid, "ok": True, "result": "pong"})
            elif method == "shutdown":
                emit({"id": rid, "ok": True, "result": {"ok": True}}); break
            else:
                emit({"id": rid, "ok": False, "error": f"unknown method: {method}"})
        except Exception as e:
            emit({"id": rid, "ok": False, "error": str(e)})


def main():
    asyncio.run(reader_loop())


if __name__ == "__main__":
    main()
