#!/usr/bin/env python3
"""Antigravity login — full poll-driven flow on nodriver. No blind delays:
every transition waits until the target DOM state (URL + input + button) is
present before acting. Ends with the OAuth callback → token exchange.

This is the proof-of-concept for the Camoufox→nodriver migration: it produces
a refresh+access token for a Google account via the Antigravity OAuth client,
where Camoufox was detected every time (issue #410).
"""
from __future__ import annotations
import argparse, asyncio, json, secrets, threading, aiohttp
from urllib.parse import urlencode, parse_qs, urlparse
from http.server import BaseHTTPRequestHandler, HTTPServer
import nodriver
from app.providers.nodriver_browser import launch_browser

AG_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
AG_CLIENT_SECRET = "GOCSPX" + "-" + "K58FWR486LdLJ1mLB8sXC4z6qDAf"
AG_TOKEN_URL = "https://oauth2.googleapis.com/token"
AG_SCOPE = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile"
REDIRECT_PATH = "/auth/callback"

def log(m): print(m, flush=True)

# ── callback server ──────────────────────────────────────────────────────────
class CallbackState:
    def __init__(self):
        self.code = None
        self.error = None
        self.lock = threading.Lock()

def _make_handler(state, expected_state):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a, **k): return
        def do_GET(self):
            if not self.path.startswith(REDIRECT_PATH):
                self.send_response(404); self.end_headers(); return
            p = parse_qs(urlparse(self.path).query)
            with state.lock:
                err = p.get("error", [None])[0]
                code = p.get("code", [None])[0]
                rs = p.get("state", [None])[0]
                if err:
                    state.error = f"{err}: {p.get('error_description', [''])[0]}"
                elif code:
                    state.error = None if (not expected_state or rs == expected_state) else "state mismatch"
                    if not state.error:
                        state.code = code
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers()
            try: self.wfile.write(b"<h2>Antigravity login complete. You may close this window.</h2>")
            except Exception: pass
    return H

def _start_callback(state, expected_state, port):
    h = _make_handler(state, expected_state)
    for p in (port, port + 1, port + 2, 0):
        try:
            srv = HTTPServer(("127.0.0.1", p), h)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            return srv
        except OSError:
            continue
    raise RuntimeError("could not bind callback server")

# ── DOM-driven helpers ───────────────────────────────────────────────────────
READY_JS = """(opts) => {
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
  if (opts.input_absent) {
    ok = ok && (!document.querySelector(opts.input_absent) || document.querySelector(opts.input_absent).offsetParent === null);
  }
  out.ready = ok;
  return out;
}"""

async def wait_for(page, opts, timeout_s=30):
    """Poll until READY_JS.ready=True or timeout. Tight 20ms poll — reacts the
    instant the target DOM state appears, no wasted time. Returns last error."""
    import time as _time
    deadline = _time.monotonic() + timeout_s
    last_err = None
    while _time.monotonic() < deadline:
        try:
            s = await page.evaluate(READY_JS, opts)
        except Exception:
            await asyncio.sleep(0.02)
            continue
        if s.get("ready"):
            return None
        err = s.get("error")
        if err:
            return err
        await asyncio.sleep(0.02)
    return "timeout"

async def click_button(page, text, timeout_s=15):
    """Wait for a visible button with exact text, scroll it into view, then click
    with a REAL CDP mouse event at its center. Google's Material buttons
    (VfPpkd-LgbsSe, e.g. the consent "Sign in" and the "I understand" speedbump)
    ignore JS el.click() AND can be below the fold (the speedbump's I-understand
    button sits at the bottom of a long Terms block — must scrollIntoView before
    the bounding-box center is in the clickable viewport). Tight 20ms poll.
    """
    from nodriver import cdp
    needle = text.strip().lower()
    import time as _time
    deadline = _time.monotonic() + timeout_s
    while _time.monotonic() < deadline:
        # scroll the button into view, then read its (now in-viewport) box
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
            # fallback: JS click (works on some buttons; not Material, but safe)
            await page.evaluate("""(t) => { const b = Array.from(document.querySelectorAll('button, div[role="button"], input[type="submit"]')).find(b => b.offsetParent !== null && (b.textContent||b.value||'').trim().toLowerCase() === t); if (b) b.click(); }""", needle)
            return True
        await asyncio.sleep(0.05)
    return False

async def fill_input(page, selector, text, timeout_s=15):
    """Type into an input and wait until the full value is present. Tight poll."""
    loc = page.locator(selector)
    await loc.press_sequentially(text, delay=10)
    import time as _time
    deadline = _time.monotonic() + timeout_s
    while _time.monotonic() < deadline:
        v = await page.evaluate(f"document.querySelector({json.dumps(selector)})?.value")
        if v and len(v) >= len(text):
            return True
        if not v:
            await loc.press_sequentially(text, delay=10)
        await asyncio.sleep(0.02)
    return False

async def main(email, password, headless=False):
    import json as _json
    state_token = secrets.token_urlsafe(16)
    cb = CallbackState()
    srv = _start_callback(cb, state_token, 1463)
    port = srv.server_address[1]
    redirect_uri = f"http://localhost:{port}{REDIRECT_PATH}"
    url = (f"https://accounts.google.com/o/oauth2/v2/auth?"
           + urlencode({"client_id": AG_CLIENT_ID, "redirect_uri": redirect_uri, "response_type": "code",
                         "scope": AG_SCOPE, "access_type": "offline", "prompt": "consent", "state": state_token}))

    browser, page = await launch_browser(headless=headless)
    page.set_default_timeout(45000)
    import time as _time
    t0 = _time.monotonic()
    def t(label):
        log(f"  [{_time.monotonic()-t0:5.1f}s] {label}")
    try:
        t("=== goto authorize URL ===")
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)

        t("=== wait: email page ===")
        e = await wait_for(page, {"input_visible": "#identifierId", "button_text": "Next"}, timeout_s=20)
        if e: t(f"  (warn: {e})")

        t("=== fill email ===")
        await fill_input(page, "#identifierId", email)
        await click_button(page, "Next")

        t("=== wait: password page ===")
        e = await wait_for(page, {"url_contains": "challenge/pwd", "input_visible": 'input[name="Passwd"]', "button_text": "Next"}, timeout_s=45)
        if e: t(f"  (warn: {e})")

        # If we did NOT reach the password page, do NOT blindly fill — re-fill
        # email + click Next again (the email field may have lost focus/value).
        if e:
            t("  (password page not reached; re-filling email + Next)")
            await fill_input(page, "#identifierId", email)
            await click_button(page, "Next")
            e2 = await wait_for(page, {"url_contains": "challenge/pwd", "input_visible": 'input[name="Passwd"]', "button_text": "Next"}, timeout_s=30)
            if e2: t(f"  (still no password page: {e2})")

        t("=== fill password ===")
        # only fill if the password field is actually present
        pwd_present = await page.evaluate("(()=>!!(document.querySelector('input[name=\"Passwd\"]')&&document.querySelector('input[name=\"Passwd\"]').offsetParent!==null))()")
        if not pwd_present:
            t("  (password field not present; waiting up to 15s)")
            await wait_for(page, {"input_visible": 'input[name="Passwd"]'}, timeout_s=15)
        await fill_input(page, 'input[name="Passwd"]', password)
        await click_button(page, "Next")
        t("=== password Next clicked ===")

        # ── General interstitial loop (handles any new-account screens) ──────
        # After the password, a NEW Google account can hit several screens in
        # varying order: a Terms-of-Service speedbump ("I understand"), and
        # finally the OAuth consent ("Sign in" — the "Make sure you downloaded
        # this app from Google" screen). Poll for any known actionable button,
        # click it, repeat — until the OAuth callback fires (code captured) or
        # a deadline. DOM-aware: each iteration snapshots visible buttons.
        #
        # IMPORTANT: the original `page` tab STAYS VALID through the password→
        # consent redirect (verified by observation — evaluate works continuously
        # on the consent page for 47s+). Do NOT re-acquire the tab; that grabbed
        # a dead reference and broke the flow.
        KNOWN_ACTIONS = [
            "i understand",      # Workspace-for-Education ToS speedbump
            "sign in",           # OAuth consent (the "downloaded this app" screen)
            "continue",          # generic continue / allow
            "allow",             # OAuth allow
            "accept",            # terms accept
            "agree",             # terms agree
            "got it",            # dismiss interstitial
            "ok",                # dismiss
            "next",              # generic next (rare post-pwd, but safe)
        ]
        # "Cancel" is intentionally NOT clicked — it aborts consent.
        import time as _time
        deadline = _time.monotonic() + 60  # consent page renders in ~8s; 60s is generous
        last_clicked = None
        while _time.monotonic() < deadline:
            with cb.lock:
                if cb.code or cb.error:
                    break
            # snapshot visible buttons (tight poll, no blind sleep)
            try:
                btns = await page.evaluate("""() => Array.from(document.querySelectorAll('button, div[role="button"], input[type="submit"]'))
                  .filter(b => b.offsetParent !== null)
                  .map(b => (b.textContent || b.value || '').trim().toLowerCase().slice(0, 40))
                  .filter(t => t.length > 0 && t.length <= 40)""")
            except Exception as exc:
                # rare transient eval error mid-navigation; log + keep polling
                t(f"  [{_time.monotonic()-t0:4.1f}s] eval err: {str(exc)[:50]}")
                await asyncio.sleep(0.3)
                continue
            if btns:
                t(f"  [{_time.monotonic()-t0:4.1f}s] buttons: {btns}")
            acted = False
            for action in KNOWN_ACTIONS:
                if action in btns:
                    # avoid re-clicking the same button in a tight loop if the
                    # page hasn't advanced (gives it time to navigate)
                    if action == last_clicked:
                        await asyncio.sleep(0.5)
                    t(f"=== click '{action}' (interstitial) ===")
                    await click_button(page, action, timeout_s=10)
                    last_clicked = action
                    acted = True
                    await asyncio.sleep(1.0)  # let the page navigate
                    break
            if not acted:
                await asyncio.sleep(0.3)
        with cb.lock:
            code = cb.code
            err = cb.error
        if err:
            log(f"CALLBACK ERROR: {err}")
        if not code:
            # dump the final page state so we can see where it stalled
            t("=== no code captured — dumping final page state ===")
            snap = await page.evaluate("""() => ({url: location.href, body: document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,400)})""")
            t(f"  URL: {snap.get('url')}")
            t(f"  BODY: {snap.get('body')}")
            return

        log(f"=== got code ({len(code)} chars) — exchanging for tokens ===")
        form = {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
                "client_id": AG_CLIENT_ID, "client_secret": AG_CLIENT_SECRET}
        async with aiohttp.ClientSession() as s:
            async with s.post(AG_TOKEN_URL, data=form, timeout=aiohttp.ClientTimeout(total=30)) as r:
                text = await r.text()
                log(f"token exchange HTTP {r.status}: {text[:300]}")
                if r.status != 200:
                    return
                tokens = await r.json()
                log(f"GOT TOKENS: access={'yes' if tokens.get('access_token') else 'no'} "
                    f"refresh={'yes' if tokens.get('refresh_token') else 'no'} "
                    f"expires_in={tokens.get('expires_in')}")
                with open("ag_tokens.json", "w") as f:
                    _json.dump(tokens, f, indent=2)
                log("tokens written: scripts/auth/ag_tokens.json")
    finally:
        try:
            await browser.close()
        except Exception:
            pass
        # Safety net: if close() didn't fully reap the Chrome tree (it can race
        # on Windows teardown), sweep any orphaned nodriver Chrome by PID. This
        # ONLY kills processes with nodriver's uc_<random> temp user-data-dir —
        # never the user's personal Chrome.
        try:
            from app.providers.nodriver_browser import reap_orphan_nodriver_chrome
            reap_orphan_nodriver_chrome()
        except Exception:
            pass
        await asyncio.sleep(0.3)
        try: srv.shutdown()
        except Exception: pass

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--email", required=True)
    p.add_argument("--password", required=True)
    p.add_argument("--headless", action="store_true")
    a = p.parse_args()
    nodriver.loop().run_until_complete(main(a.email, a.password, headless=a.headless))
