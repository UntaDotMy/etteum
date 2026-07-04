"""Playwright-compatibility browser layer over nodriver.

This module replaces the old Camoufox (Firefox) + Playwright/Chromium stacks
with a single nodriver-based engine. nodriver is CDP-native (no
`navigator.webdriver` leak), ~80-120MB, and — unlike Camoufox — is not
currently detected by Google on accounts.google.com (camoufox issue #410).

The provider login state machines (gitlab_duo's Google-login helpers, codex's
OAuth flow, kiro's route-based capture, etc.) were written against the
Playwright `Page`/`Locator` API. Rather than rewrite thousands of lines of
battle-tested selector/JS logic, this module exposes a Playwright-shaped
`Page`/`Locator`/`Browser`/`Context` surface that translates to nodriver Tab
+ CDP calls under the hood.

Verified API facts (nodriver 0.50.3):
  - `nodriver.start(headless=..., browser_executable_path=..., browser_args=...) -> Browser`
  - `browser.get(url) -> Tab` (opens/returns the first tab)
  - `browser.tabs`, `browser.stop()`, `browser.cookies()`
  - `tab.select(css, timeout) -> Element`, `tab.find(text)`, `tab.query_selector_all(css)`
  - `tab.send(cdp.runtime.evaluate(expr, return_by_value=True, await_promise=...))`
      returns (RemoteObject, ExceptionDetails); the plain-Python value is on
      `RemoteObject.value`. (The ergonomic `tab.evaluate()` does NOT unwrap
      `.value`, so we use the raw CDP path here.)
  - `tab.add_handler(EventClass, callback)` for CDP events
  - CDP domains used: cdp.runtime, cdp.network, cdp.fetch, cdp.page,
      cdp.storage, cdp.target, cdp.input_
"""

from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from typing import Any, Callable
from urllib.parse import urlparse

# Set on import so providers don't trip on Windows console codecs.
for _stream in (__import__("sys").stdout, __import__("sys").stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass


def _debug(msg: str) -> None:
    if os.getenv("BATCHER_DEBUG", "").lower() == "true":
        print(f"[nodriver-browser] {msg}", flush=True)


# ── process cleanup (no zombies) ─────────────────────────────────────────────

def _kill_process_tree(pid: int) -> None:
    """Force-kill a process and its children. OS-portable.

    nodriver's Browser.stop() can leak the spawned Chrome on Windows when the
    event loop is mid-teardown; this is the belt-and-suspenders fallback that
    guarantees the Chrome we started actually dies. Used by Browser.close() and
    by the atexit/signal hard-kill hook on interpreter shutdown / Ctrl+C.
    """
    import signal
    import subprocess
    if pid <= 0:
        return
    try:
        if os.name == "nt":
            # taskkill /T kills the whole tree, /F forces. Silenced.
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=10,
            )
        else:
            # kill the process group (children included) via SIGKILL
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                os.kill(pid, signal.SIGKILL)
    except Exception:
        # best-effort — never raise from cleanup
        pass


def reap_orphan_nodriver_chrome() -> int:
    """Kill any orphaned Chrome that nodriver spawned (from a previous crash),
    WITHOUT touching the user's personal Chrome.

    Identifies nodriver's Chrome by its temp user-data-dir flag
    (`--user-data-dir=...\\Temp\\uc_<random>`) which nodriver creates — the
    user's own Chrome uses their real profile path. Returns the count killed.

    NEVER use `taskkill /IM chrome.exe` — it kills the user's Chrome too.
    """
    import subprocess
    killed = 0
    try:
        if os.name == "nt":
            # WMIC gives command lines; find nodriver's by the uc_ temp profile.
            out = subprocess.run(
                ["wmic", "process", "where", "name='chrome.exe'", "get", "processid,commandline"],
                capture_output=True, text=True, timeout=15,
            )
            for line in out.stdout.splitlines():
                if "uc_" in line and "user-data-dir" in line:
                    # last token is the PID
                    parts = line.split()
                    if parts:
                        try:
                            pid = int(parts[-1])
                        except ValueError:
                            continue
                        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
                        killed += 1
        else:
            # posix: pgrep for the nodriver temp profile marker
            out = subprocess.run(["pgrep", "-f", "user-data-dir.*uc_"], capture_output=True, text=True, timeout=10)
            for pid_s in out.stdout.split():
                try:
                    pid = int(pid_s)
                except ValueError:
                    continue
                _kill_process_tree(pid)
                killed += 1
    except Exception:
        pass
    return killed


def _register_hard_kill(browser: "Browser") -> None:
    """Install atexit + signal handlers that force-kill the browser's Chrome on
    crash, Ctrl+C, or normal shutdown. Idempotent-ish: each Browser registers
    its own PID kill. Signal handlers run the same kill then re-raise/default.
    """
    import atexit
    import signal

    def _hard_kill(*_args: object) -> None:
        pid = getattr(browser._b, "_process_pid", None) or getattr(getattr(browser._b, "_process", None), "pid", None)
        if pid:
            _kill_process_tree(int(pid))

    atexit.register(_hard_kill)

    # Only the main thread can install signal handlers; no-op otherwise.
    try:
        for sig in (signal.SIGINT, getattr(signal, "SIGTERM", None)):
            if sig is None:
                continue
            prev = signal.getsignal(sig)
            if prev in (None, signal.SIG_DFL, signal.SIG_IGN):
                signal.signal(sig, lambda signum, frame: (_hard_kill(), _exit(130)))
            else:
                # chain: run our kill, then call the previous handler
                _prev = prev
                def _chain(signum, frame, _prev=_prev, _hk=_hard_kill):
                    _hk()
                    if callable(_prev):
                        _prev(signum, frame)
                    _exit(128 + signum)
                signal.signal(sig, _chain)
    except (ValueError, RuntimeError):
        # not main thread — atexit still covers normal shutdown
        pass


def _exit(code: int) -> None:
    import os as _os
    _os._exit(code)


# ── launch ───────────────────────────────────────────────────────────────────

async def launch_browser(
    *,
    headless: bool | None = None,
    proxy_url: str = "",
    browser_executable_path: str = "",
    extra_args: list[str] | None = None,
) -> "tuple[Browser, Page]":
    """Start nodriver and return (Browser shim, first Page shim).

    `headless` defaults to the BATCHER_CAMOUFOX_HEADLESS env var (kept for ops
    continuity). `proxy_url` defaults to BATCHER_PROXY_URL.
    """
    import nodriver

    if headless is None:
        headless = os.getenv("BATCHER_CAMOUFOX_HEADLESS", "false").lower() == "true"
    resolved_proxy = proxy_url or os.getenv("BATCHER_PROXY_URL", "").strip()

    browser_args: list[str] = [
        # Core stealth: strip the AutomationControlled blink feature so
        # navigator.webdriver doesn't auto-set to true.
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        # Realistic UA — the default headless UA is a bot-detection tell.
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        # Strip the Chrome/Playwright flags that signal "automated browser"
        # to Google's bot detector. Based on patchright's chromiumSwitchesPatch
        # (github.com/Kaliiiiiiiiii-Vinyzu/patchright) which successfully
        # passes Google, Cloudflare, and DataDome bot mitigation.
        "--disable-popup-blocking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-client-side-phishing-detection",
        "--disable-component-extensions-with-background-pages",
        "--disable-ipc-flooding-protection",
        "--metrics-recording-only",
        "--disable-back-forward-cache",
        # Disable features that leak headless/automated signals. The
        # default Chrome feature set includes tracking protections, media
        # router, and certificate transparency components that are
        # absent in normal user Chrome and trigger anomaly detection.
        "--disable-features=ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls,DestroyProfileOnBrowserClose,MediaRouter,DialMediaRouteProvider,AcceptCHFrame,AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,AvoidUnnecessaryBeforeUnloadCheckSync,Translate,HttpsUpgrades,PaintHolding,ThirdPartyStoragePartitioning,LensOverlay,PlzDedicatedWorker,IsolateOrigins,site-per-process",
        "--disable-infobars",
    ]
    if extra_args:
        browser_args.extend(extra_args)

    config_kwargs: dict[str, Any] = {
        "headless": headless,
        "browser_args": browser_args,
        "sandbox": False,
    }
    if browser_executable_path:
        config_kwargs["browser_executable_path"] = browser_executable_path
    if resolved_proxy:
        # nodriver accepts a proxy via browser arg --proxy-server=...
        parsed = urlparse(resolved_proxy)
        server = f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
        config_kwargs["browser_args"].append(f"--proxy-server={server}")
        if parsed.username or parsed.password:
            # CDP Fetch.authrequired would be needed for authenticated proxies;
            # most deployments use unauthenticated pool proxies. Wire auth via
            # the Network.setExtraHTTPHeaders / Fetch auth challenge path when
            # needed — flag for now.
            _debug(f"proxy has credentials; authenticated proxy auth not yet wired for {parsed.hostname}")

    try:
        browser = await nodriver.start(**config_kwargs)
    except Exception as exc:
        from app.errors.codes import ErrorCode
        from app.errors.exceptions import RetryableBatcherError
        raise RetryableBatcherError(
            ErrorCode.browser_start_failed,
            f"nodriver launch failed: {exc}",
        ) from exc

    shim = Browser(browser)
    # Register a hard-kill fallback so a Python crash / Ctrl+C can never leave
    # the spawned Chrome running as a zombie (the user explicitly flagged this).
    # atexit runs on normal interpreter shutdown; SIGINT/SIGTERM are covered by
    # the signal handlers installed in _register_hard_kill below.
    _register_hard_kill(shim)
    page = await shim.new_page()

    # Inject stealth init script to strip bot-detection signals.
    # Google's login page checks navigator.webdriver, CDP artifacts, and
    # several other fingerprinting signals. --disable-blink-features alone
    # is not enough — we need to actively patch the JS context BEFORE the
    # page's scripts run. addScriptToEvaluateOnNewDocument fires on every
    # new document/navigation in every target.
    try:
        from nodriver import cdp
        import nodriver.cdp.page as _cdp_page
        await shim._b.send(
            _cdp_page.add_script_to_evaluate_on_new_document(source=_STEALTH_INIT_SCRIPT)
        )
    except Exception as exc:
        _debug(f"stealth init script injection failed (non-fatal): {exc}")

    return shim, page


# Stealth init script — runs before any page script on every navigation.
# Patches the browser fingerprint to remove the most common bot-detection
# signals that trigger Google's CAPTCHA:
#   1. navigator.webdriver → false (Chrome sets this true for CDP-controlled browsers)
#   2. navigator.plugins → non-empty (headless Chrome has 0 plugins)
#   3. navigator.languages → realistic
#   4. WebGL vendor/renderer → masked
#   5. Notification.permission → 'default' (headless leaks 'denied')
#   6. Chrome runtime object → present (headless strips it)
_STEALTH_INIT_SCRIPT = """
(function() {
  // 1. Strip navigator.webdriver
  Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });

  // 2. Patch navigator.plugins to look like a real browser
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const arr = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      arr.item = (i) => arr[i] || null;
      arr.namedItem = (n) => arr.find(p => p.name === n) || null;
      arr.refresh = () => {};
      return arr;
    },
    configurable: true,
  });

  // 3. Realistic languages
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });

  // 4. Mask WebGL vendor/renderer
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Intel Inc.';
    if (param === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter.call(this, param);
  };

  // 5. Notification permission default
  Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });

  // 6. Chrome runtime
  if (!window.chrome) window.chrome = {};
  window.chrome.runtime = window.chrome.runtime || {};
  window.chrome.csi = window.chrome.csi || (() => ({}));
  window.chrome.loadTimes = window.chrome.loadTimes || (() => ({}));

  // 7. Permissions query — hide notification prompt artifacts
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (params) =>
    params.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission, onchange: null })
      : originalQuery(params);
})();
"""


# ── Browser shim ─────────────────────────────────────────────────────────────

class Browser:
    """Playwright-shaped Browser over a nodriver Browser."""

    def __init__(self, browser: Any) -> None:
        self._b = browser
        self._context: "BrowserContext | None" = None

    @property
    def context(self) -> "BrowserContext":
        if self._context is None:
            self._context = BrowserContext(self._b)
        return self._context

    async def new_page(self) -> "Page":
        # nodriver: opening "about:blank" yields a fresh tab we fully control.
        tab = await self._b.get("about:blank")
        return Page(tab, self)

    async def close(self) -> None:
        """Stop the browser AND force-kill the Chrome process by PID.

        nodriver's stop() can leak the Chrome subprocess on Windows if the
        event loop is mid-teardown; the explicit taskkill/kill fallback
        guarantees no zombies even on crash or interrupt.
        """
        pid = getattr(self._b, "_process_pid", None) or getattr(getattr(self._b, "_process", None), "pid", None)
        try:
            self._b.stop()
        except Exception:
            pass
        # Hard-kill fallback: if stop() didn't reap the process, kill it.
        if pid:
            _kill_process_tree(int(pid))

    # Playwright providers sometimes call browser.__aexit__ via the manager
    # pattern; expose a no-op async exit so cleanup_session keeps working.
    async def __aenter__(self) -> "Browser":
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()


# ── Context shim (cookies + init scripts) ────────────────────────────────────

class BrowserContext:
    """Playwright-shaped BrowserContext over a nodriver Browser.

    Implements cookies() / add_cookies() / add_init_script() via CDP
    Network/Storage/Page domains.
    """

    def __init__(self, browser: Any) -> None:
        self._b = browser
        self._init_scripts: list[str] = []

    async def _tabs(self) -> list[Any]:
        try:
            return list(self._b.tabs)
        except Exception:
            return []

    async def cookies(self, urls: "list[str] | str | None" = None) -> list[dict[str, Any]]:
        from nodriver import cdp
        out: list[dict[str, Any]] = []
        for tab in await self._tabs():
            try:
                # Network.getCookies returns (cookies,)
                res = await tab.send(cdp.network.get_cookies([url] if isinstance(url, str) and url else None))
                cookies = res[0] if res else []
                for c in cookies:
                    out.append(_cdp_cookie_to_dict(c))
            except Exception:
                continue
        # dedupe by (name, domain, path)
        seen: set[tuple] = set()
        deduped: list[dict[str, Any]] = []
        for c in out:
            k = (c.get("name"), c.get("domain"), c.get("path"))
            if k in seen:
                continue
            seen.add(k)
            deduped.append(c)
        return deduped

    async def add_cookies(self, cookies: list[dict[str, Any]]) -> None:
        from nodriver import cdp
        for tab in await self._tabs():
            try:
                params = [_dict_to_cdp_cookie(c) for c in cookies]
                await tab.send(cdp.network.set_cookies(params))
            except Exception:
                continue

    async def add_init_script(self, script: str) -> None:
        from nodriver import cdp
        self._init_scripts.append(script)
        for tab in await self._tabs():
            try:
                await tab.send(cdp.page.add_script_to_evaluate_on_new_document(source=script))
            except Exception:
                continue

    async def _apply_init_scripts_to(self, tab: Any) -> None:
        from nodriver import cdp
        for script in self._init_scripts:
            try:
                await tab.send(cdp.page.add_script_to_evaluate_on_new_document(source=script))
            except Exception:
                pass


def _cdp_cookie_to_dict(c: Any) -> dict[str, Any]:
    return {
        "name": getattr(c, "name", ""),
        "value": getattr(c, "value", ""),
        "domain": getattr(c, "domain", "") or "",
        "path": getattr(c, "path", "") or "/",
        "expires": getattr(c, "expires", -1),
        "httpOnly": bool(getattr(c, "http_only", False)),
        "secure": bool(getattr(c, "secure", False)),
        "sameSite": _samesite_to_pw(getattr(c, "same_site", None)),
    }


def _samesite_to_pw(ss: Any) -> str:
    # Playwright uses "Strict"|"Lax"|"None"; CDP uses an enum whose str is e.g. "INCLUDE"
    s = str(ss) if ss is not None else "None"
    if "STRICT" in s:
        return "Strict"
    if "LAX" in s:
        return "Lax"
    return "None"


def _dict_to_cdp_cookie(c: dict[str, Any]) -> Any:
    from nodriver import cdp
    same = c.get("sameSite", "None")
    ss = cdp.network.CookieSameSite.INCLUDE
    if same == "Strict":
        ss = cdp.network.CookieSameSite.STRICT
    elif same == "Lax":
        ss = cdp.network.CookieSameSite.LAX
    return cdp.network.CookieParam(
        name=c.get("name", ""),
        value=c.get("value", ""),
        domain=c.get("domain", ""),
        path=c.get("path", "/"),
        secure=bool(c.get("secure", False)),
        http_only=bool(c.get("httpOnly", False)),
        same_site=ss,
        expires=c.get("expires", -1) if c.get("expires") is not None else -1,
    )


# ── Page shim ────────────────────────────────────────────────────────────────

class Page:
    """Playwright-shaped Page over a nodriver Tab."""

    def __init__(self, tab: Any, browser: "Browser") -> None:
        self._tab = tab
        self._browser = browser
        self._default_timeout_ms = 30000
        self._popup_waiters: list[asyncio.Future] = []
        # network
        self._response_handlers: list[Callable] = []
        self._route_handlers: list[tuple[str, Callable]] = []
        self._network_enabled = False

    # -- internals --
    @property
    def tab(self) -> Any:
        return self._tab

    async def _reacquire_tab(self) -> None:
        """Re-grab the active tab if our CDP session went stale.

        After some Google navigations the tab target is destroyed and a new one
        created, invalidating `self._tab`'s session (errors: 'Session with
        given id not found'). Pick the newest page-type tab from the browser.
        """
        b = self._browser._b
        try:
            await b.update_targets()
        except Exception:
            pass
        # Refresh the target list, then pick the most recent page-type target.
        try:
            targets = list(b.targets)
        except Exception:
            targets = []
        page_targets = []
        for t in targets:
            try:
                if getattr(t.target, "type_", "") == "page":
                    page_targets.append(t)
            except Exception:
                continue
        if page_targets:
            self._tab = page_targets[-1]
            return
        try:
            self._tab = b.main_tab
        except Exception:
            try:
                tabs = list(b.tabs)
                if tabs:
                    self._tab = tabs[-1]
            except Exception:
                pass

    @property
    def context(self) -> BrowserContext:
        return self._browser.context

    def set_default_timeout(self, ms: int) -> None:
        self._default_timeout_ms = int(ms)

    async def _ensure_network(self) -> None:
        if self._network_enabled:
            return
        from nodriver import cdp
        await self._tab.send(cdp.network.enable())
        # response listeners
        await self._tab.add_handler(cdp.network.ResponseReceived, self._on_response_received)
        # route (Fetch) listeners — only if a route handler is registered
        await self._tab.add_handler(cdp.fetch.RequestPaused, self._on_request_paused)
        self._network_enabled = True

    # -- navigation --
    async def goto(self, url: str, *, wait_until: str = "domcontentloaded", timeout: int | None = None) -> "Page | None":
        to = (timeout if timeout is not None else self._default_timeout_ms) / 1000
        try:
            await asyncio.wait_for(self._tab.get(url), timeout=to)
        except asyncio.TimeoutError:
            raise TimeoutError(f"goto timeout after {to}s: {url}")
        # best-effort wait for domcontentloaded / load; nodriver has no direct
        # event wait, so poll location.href stability + readyState.
        if wait_until in ("domcontentloaded", "load", "networkidle"):
            await self._wait_load(wait_until)
        return self

    async def _wait_load(self, mode: str, timeout_s: float | None = None) -> None:
        """Wait for the page to reach the requested load state.

        Polls `document.readyState` at 20ms (not a fixed sleep) so we react the
        instant the browser signals readiness — no wasted time. CDP
        Page.lifecycleEvent would be ideal but nodriver 0.50.3 doesn't deliver
        those events via add_handler reliably, so readyState is the trusted
        signal. For SPA navigations (readyState stays 'complete' across
        client-side route changes), the caller should use wait_for_selector /
        wait_for_element_visible which poll the actual target element.
        """
        to = timeout_s if timeout_s is not None else self._default_timeout_ms / 1000
        deadline = asyncio.get_event_loop().time() + to
        want = "complete" if mode in ("load", "networkidle") else "interactive"
        while asyncio.get_event_loop().time() < deadline:
            try:
                rs = await self.evaluate("document.readyState")
                if rs and (rs == want or (want == "interactive" and rs == "complete")):
                    return
            except Exception:
                # mid-navigation: document briefly unavailable; keep polling
                pass
            await asyncio.sleep(0.02)
        # not fatal — callers wait on the specific elements they need

    async def reload(self, *, timeout: int | None = None) -> "Page":
        await self._tab.reload()
        return self

    async def go_back(self) -> "Page | None":
        await self._tab.back()
        return self

    # -- evaluate (the keystone) --
    async def evaluate(self, expression: str, arg: Any = None) -> Any:
        """Run JS and return a plain Python value (dict/list/primitive).

        Mirrors Playwright semantics: the expression is evaluated as a JS value.
        If it's a function/arrow expression and `arg` is provided, it is CALLED
        with `arg` (Playwright passes args out-of-band; nodriver can't, so we
        inline-serialize and invoke). arg must be JSON-serializable.
        """
        from nodriver import cdp
        expr = expression
        stripped = expression.strip()
        if arg is not None:
            payload = json.dumps(arg)
            # If expression is a function/arrow (starts with ( or "function"/"async"),
            # call it with the arg. Otherwise wrap as an IIFE that binds __arg__.
            if stripped.startswith("(") or stripped.startswith("function") or stripped.startswith("async"):
                expr = f"({expression})({payload})"
            else:
                expr = f"(()=>{{const __arg__={payload};return (function(){{{expression}}})();}})()"
        else:
            # No arg. Playwright auto-invokes function/arrow expressions; we must
            # too, otherwise `() => ({...})` returns the function object, not its
            # result. BUT only invoke if it isn't already self-invoking — a
            # self-invoking IIFE ends with '()' (a call), e.g. `(()=>{...})()`.
            # `()=>({url:1})` ends with ')' but NOT '()' — the trailing ')' is
            # the object literal's paren, so it still needs invoking.
            already_invoked = stripped.endswith("()")
            is_fn = stripped.startswith("(") or stripped.startswith("function") or stripped.startswith("async")
            if is_fn and not already_invoked:
                expr = f"({expression})()"
            else:
                expr = expression
        try:
            res = await self._tab.send(cdp.runtime.evaluate(expr, return_by_value=True, await_promise=True))
        except Exception as exc:
            # Stale CDP session after a navigation that destroyed our tab target
            # (Google does this on the password→consent transition). Re-acquire
            # the active tab and retry once.
            if "Session with given id not found" in str(exc) or "Target closed" in str(exc):
                await self._reacquire_tab()
                try:
                    res = await self._tab.send(cdp.runtime.evaluate(expr, return_by_value=True, await_promise=True))
                except Exception as exc2:
                    raise RuntimeError(f"evaluate failed (after reacquire): {exc2}\nexpr: {expr[:200]}") from exc2
            else:
                raise RuntimeError(f"evaluate failed: {exc}\nexpr: {expr[:200]}") from exc
        remote, exc_details = (res + (None,))[:2] if not isinstance(res, tuple) else res
        if exc_details:
            msg = getattr(exc_details, "exception", None)
            text = getattr(msg, "description", None) or getattr(exc_details, "text", "") or str(exc_details)
            raise RuntimeError(f"evaluate JS error: {text}\nexpr: {expr[:200]}")
        if remote is None:
            return None
        # return_by_value=True puts the deserialized value in .value
        val = getattr(remote, "value", None)
        if val is None:
            # primitives sometimes come back as a string in .value; fall back to
            # unserializable_value / description.
            val = getattr(remote, "unserializable_value", None) or getattr(remote, "description", None)
        return val

    async def eval_on_selector(self, selector: str, expression: str, arg: Any = None) -> Any:
        # providers use page.evaluate with document.querySelector inside the
        # script; we don't need a separate eval_on_selector for the current
        # codebase. Provided for completeness.
        js = f"(()=>{{const el=document.querySelector({json.dumps(selector)});if(!el) return null;return (function(){{{expression}}})();}})()"
        return await self.evaluate(js, arg)

    # -- url / content --
    async def _url(self) -> str:
        try:
            return (await self.evaluate("location.href")) or ""
        except Exception:
            return ""

    @property
    def url(self) -> str:
        # Playwright .url is a sync property; nodriver needs async. Providers
        # sometimes read page.url in conditions. We return the last cached
        # value (updated by url_async / goto); use url_async() for an accurate
        # live read.
        return getattr(self, "_url_cache", "") or ""

    async def url_async(self) -> str:
        u = await self._url()
        self._url_cache = u
        return u

    async def content(self) -> str:
        try:
            return await self._tab.get_content()
        except Exception:
            return await self.evaluate("document.documentElement.outerHTML") or ""

    async def title(self) -> str:
        return (await self.evaluate("document.title")) or ""

    # -- locators / selectors --
    def locator(self, selector: str) -> "Locator":
        return Locator(self, selector)

    async def click_button_by_text(self, text: str, *, timeout: int | None = None) -> bool:
        """Click the first visible button whose trimmed text matches `text`
        (case-insensitive, exact match). Uses a real CDP mouse click at the
        button's center — required for Google's signin buttons, which ignore
        JS el.click() and have no stable id/jsname (Next/Continue are shared
        across multiple buttons by jsname).
        """
        from nodriver import cdp
        to = (timeout if timeout is not None else self._default_timeout_ms) / 1000
        deadline = asyncio.get_event_loop().time() + to
        needle = text.strip().lower()
        while asyncio.get_event_loop().time() < deadline:
            try:
                box = await self.evaluate(
                    f"""(() => {{ const needle = {json.dumps(needle)}; const b = Array.from(document.querySelectorAll('button, div[role=\"button\"], input[type=\"submit\"]')).find(b => b.offsetParent !== null && (b.textContent || b.value || '').trim().toLowerCase() === needle); if (!b) return null; const r = b.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return null; return {{x: r.x + r.width/2, y: r.y + r.height/2}}; }})()"""
                )
                if box:
                    x, y = box["x"], box["y"]
                    await self._tab.send(cdp.input_.dispatch_mouse_event(type_="mouseMoved", x=x, y=y))
                    await asyncio.sleep(0.08)
                    await self._tab.send(cdp.input_.dispatch_mouse_event(type_="mousePressed", x=x, y=y, button=cdp.input_.MouseButton.LEFT, click_count=1))
                    await asyncio.sleep(0.06)
                    await self._tab.send(cdp.input_.dispatch_mouse_event(type_="mouseReleased", x=x, y=y, button=cdp.input_.MouseButton.LEFT, click_count=1))
                    return True
            except Exception:
                pass
            await asyncio.sleep(0.2)
        return False


    async def query_selector(self, selector: str) -> "ElementHandle | None":
        from nodriver import cdp
        try:
            res = await self._tab.send(cdp.dom.query_selector(node_id=None, selector=selector))
            # returns (node_id,) or (None,)
            nid = res[0] if res else None
            if not nid:
                return None
            return ElementHandle(self, nid)
        except Exception:
            return None

    async def wait_for_selector(self, selector: str, *, state: str = "visible", timeout: int | None = None) -> "ElementHandle | None":
        # Tight 20ms poll — reacts the instant the element appears, no wasted
        # time. Uses a single evaluate (offsetParent check) per iteration.
        to = (timeout if timeout is not None else self._default_timeout_ms) / 1000
        deadline = asyncio.get_event_loop().time() + to
        vis_js = f"(()=>{{const e=document.querySelector({json.dumps(selector)});return e?e.offsetParent!==null:false;}})()"
        while asyncio.get_event_loop().time() < deadline:
            try:
                if state == "hidden":
                    v = await self.evaluate(vis_js)
                    if not v:
                        return None
                else:
                    v = await self.evaluate(vis_js)
                    if v:
                        el = await self._tab.select(selector, timeout=1)
                        if el is not None:
                            return ElementHandle.from_nodriver(self, el)
            except Exception:
                if state == "hidden":
                    return None
            await asyncio.sleep(0.02)
        if state == "hidden":
            return None
        raise TimeoutError(f"wait_for_selector timeout: {selector}")

    async def wait_for_element_visible(self, selector: str, *, timeout_s: float = 15.0) -> bool:
        """Wait until a CSS-selected element is visible (offsetParent != null).
        Tight 20ms poll. Returns True when visible, False on timeout.
        """
        vis_js = f"(()=>{{const e=document.querySelector({json.dumps(selector)});return e?e.offsetParent!==null:false;}})()"
        deadline = asyncio.get_event_loop().time() + timeout_s
        while asyncio.get_event_loop().time() < deadline:
            try:
                if await self.evaluate(vis_js):
                    return True
            except Exception:
                pass
            await asyncio.sleep(0.02)
        return False

    async def wait_for_button_text(self, text: str, *, timeout_s: float = 15.0) -> bool:
        """Wait until a visible button/div[role=button]/submit with exact text
        (case-insensitive) is present. Tight 20ms poll.
        """
        needle = text.strip().lower()
        js = f"""(()=>{{const n={json.dumps(needle)};return Array.from(document.querySelectorAll('button, div[role="button"], input[type="submit"]')).some(b=>b.offsetParent!==null&&(b.textContent||b.value||'').trim().toLowerCase()===n);}})()"""
        deadline = asyncio.get_event_loop().time() + timeout_s
        while asyncio.get_event_loop().time() < deadline:
            try:
                if await self.evaluate(js):
                    return True
            except Exception:
                pass
            await asyncio.sleep(0.02)
        return False

    async def wait_for_url(self, url: str | None = None, *, timeout: int | None = None) -> None:
        to = (timeout if timeout is not None else self._default_timeout_ms) / 1000
        deadline = asyncio.get_event_loop().time() + to
        import re as _re
        pat = _re.compile(url) if url else None
        while asyncio.get_event_loop().time() < deadline:
            cur = await self._url()
            if pat:
                if pat.search(cur):
                    return
            elif cur:
                return
            await asyncio.sleep(0.2)

    # -- popups --
    @asynccontextmanager
    async def expect_popup(self):
        """Yield a Page shim for a popup/new tab opened during the block."""
        from nodriver import cdp
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._popup_waiters.append(fut)

        async def _on_target_created(evt: Any) -> None:
            if not fut.done():
                tab = getattr(evt, "target_info", None)
                # nodriver fires this with a TargetInfo; resolve with the new tab
                try:
                    new_tab = await self._browser._b.get(getattr(tab, "url", None) or "about:blank") if False else None
                except Exception:
                    new_tab = None
                # We can't directly get the Tab object from the event cheaply;
                # instead, snapshot browser.tabs and pick the one not seen.
                fut.set_result(evt)

        try:
            await self._tab.add_handler(cdp.target.TargetCreated, _on_target_created)
        except Exception:
            pass
        yield self  # providers run the clicking code here; popup captured below
        # After the yielding block, find the newest tab that isn't us.
        popup = await self._find_popup_tab()
        if popup is not None:
            yield_popup = Page(popup, self._browser)
            self._popup_waiters.remove(fut)
            return
        # Fallback: expose via attribute
        self._popup_waiters.remove(fut)

    async def _find_popup_tab(self) -> Any:
        try:
            tabs = list(self._browser._b.tabs)
        except Exception:
            return None
        # the popup is the tab that isn't our main tab
        for t in tabs:
            if t is not self._tab:
                try:
                    if t.target and t.target.type_ == "page":
                        return t
                except Exception:
                    return t
        return None

    # -- network: response observation --
    async def on(self, event: str, callback: Callable) -> None:
        if event == "response":
            await self._ensure_network()
            self._response_handlers.append(callback)
        elif event in ("request", "requestfinished", "requestfailed"):
            await self._ensure_network()
            # map to network events best-effort
            from nodriver import cdp
            if event == "request":
                async def _req(evt: Any) -> None:
                    try:
                        await callback(_shim_request(evt))
                    except Exception:
                        pass
                await self._tab.add_handler(cdp.network.RequestWillBeSent, _req)
            elif event == "requestfinished":
                async def _fin(evt: Any) -> None:
                    try:
                        await callback(_shim_request(evt))
                    except Exception:
                        pass
                await self._tab.add_handler(cdp.network.LoadingFinished, _fin)
            elif event == "requestfailed":
                async def _fail(evt: Any) -> None:
                    try:
                        await callback(_shim_request(evt))
                    except Exception:
                        pass
                await self._tab.add_handler(cdp.network.LoadingFailed, _fail)
        else:
            _debug(f"page.on({event}) not implemented")

    async def _on_response_received(self, evt: Any) -> None:
        if not self._response_handlers:
            return
        try:
            resp = await _shim_response(self._tab, evt)
            for cb in list(self._response_handlers):
                try:
                    res = cb(resp)
                    if asyncio.iscoroutine(res):
                        await res
                except Exception as exc:
                    _debug(f"response handler error: {exc}")
        except Exception as exc:
            _debug(f"_on_response_received error: {exc}")

    # -- network: request interception (route) --
    async def route(self, pattern: str, handler: Callable) -> None:
        from nodriver import cdp
        await self._ensure_network()
        self._route_handlers.append((pattern, handler))
        # Enable Fetch domain with a wildcard pattern. Only the first route()
        # call enables it; subsequent handlers share the paused-event flow.
        try:
            pat = cdp.fetch.RequestPattern(url_pattern=pattern or "*", request_stage=cdp.fetch.RequestStage.REQUEST)
            await self._tab.send(cdp.fetch.enable(patterns=[pat]))
        except Exception as exc:
            _debug(f"fetch.enable failed: {exc}")

    async def _on_request_paused(self, evt: Any) -> None:
        from nodriver import cdp
        rid = getattr(evt, "request_id", None)
        req = getattr(evt, "request", None)
        url = getattr(req, "url", "") if req else ""
        # find first matching handler
        for pat, handler in self._route_handlers:
            if _url_matches(pat, url):
                route = Route(self._tab, rid)
                try:
                    res = handler(route, _shim_request(evt))
                    if asyncio.iscoroutine(res):
                        await res
                except Exception as exc:
                    _debug(f"route handler error: {exc}; continuing request")
                    try:
                        await self._tab.send(cdp.fetch.continue_request(rid))
                    except Exception:
                        pass
                return
        # no handler matched — continue
        try:
            await self._tab.send(cdp.fetch.continue_request(rid))
        except Exception:
            pass

    # -- close --
    async def close(self) -> None:
        try:
            await self._tab.close()
        except Exception:
            pass


# ── Locator shim ─────────────────────────────────────────────────────────────

class Locator:
    """Playwright-shaped Locator over nodriver select/evaluate."""

    def __init__(self, page: Page, selector: str) -> None:
        self._page = page
        self._sel = selector

    @property
    def first(self) -> "Locator":
        return self  # nodriver select() returns the first match

    @property
    def page(self) -> Page:
        return self._page

    @property
    def selector(self) -> str:
        return self._sel

    async def count(self) -> int:
        try:
            n = await self._page.evaluate(f"document.querySelectorAll({json.dumps(self._sel)}).length")
            return int(n) if n is not None else 0
        except Exception:
            return 0

    async def is_visible(self) -> bool:
        try:
            v = await self._page.evaluate(
                f"(()=>{{const el=document.querySelector({json.dumps(self._sel)});if(!el)return false;return el.offsetParent!==null;}})()"
            )
            return bool(v)
        except Exception:
            return False

    async def is_enabled(self) -> bool:
        try:
            v = await self._page.evaluate(
                f"(()=>{{const el=document.querySelector({json.dumps(self._sel)});return el?!el.disabled:false;}})()"
            )
            return bool(v)
        except Exception:
            return False

    async def scroll_into_view_if_needed(self) -> None:
        try:
            await self._page.evaluate(
                f"(()=>{{const el=document.querySelector({json.dumps(self._sel)});if(el)el.scrollIntoView({{block:'center'}});}})()"
            )
        except Exception:
            pass

    async def click(self, *, timeout: int | None = None, no_wait_after: bool = False, force: bool = False, **_kw: Any) -> None:
        # no_wait_after is a Firefox/Camoufox-driver workaround; irrelevant on
        # nodriver (Chrome) — accepted and ignored.
        #
        # Google's signin buttons (and many SPA buttons) ignore JS el.click()
        # — they require a real trusted mouse event. So the primary path here
        # is a CDP Input.dispatchMouseEvent at the element's bounding-box
        # center, which is indistinguishable from a real user click. JS click
        # is kept only as a last-resort fallback.
        from nodriver import cdp
        to = (timeout if timeout is not None else self._page._default_timeout_ms) / 1000
        deadline = asyncio.get_event_loop().time() + to
        last_exc: Exception | None = None
        while asyncio.get_event_loop().time() < deadline:
            try:
                box = await self._page.evaluate(
                    f"(()=>{{const el=document.querySelector({json.dumps(self._sel)});if(!el)return null;if(el.offsetParent===null && {str(force).lower()}===false)return null;const r=el.getBoundingClientRect();if(r.width===0||r.height===0)return null;return {{x:r.x+r.width/2,y:r.y+r.height/2}};}})()"
                )
                if box:
                    x, y = box["x"], box["y"]
                    await self._page._tab.send(cdp.input_.dispatch_mouse_event(type_="mouseMoved", x=x, y=y))
                    await self._page._tab.send(cdp.input_.dispatch_mouse_event(type_="mousePressed", x=x, y=y, button=cdp.input_.MouseButton.LEFT, click_count=1))
                    await self._page._tab.send(cdp.input_.dispatch_mouse_event(type_="mouseReleased", x=x, y=y, button=cdp.input_.MouseButton.LEFT, click_count=1))
                    return
            except Exception as exc:
                last_exc = exc
            await asyncio.sleep(0.2)
        # fallback: nodriver native select + click
        try:
            el = await self._page._tab.select(self._sel, timeout=max(1, int(to)))
            if el is not None:
                await el.click()
                return
        except Exception as exc:
            last_exc = exc
        # final fallback: JS click
        try:
            clicked = await self._page.evaluate(
                f"(()=>{{const el=document.querySelector({json.dumps(self._sel)});if(!el)return false;el.click();return true;}})()"
            )
            if clicked:
                return
        except Exception as exc:
            last_exc = exc
        raise TimeoutError(f"click timeout: {self._sel} ({last_exc})")

    async def _focus_via_cdp_click(self) -> bool:
        """Focus the element via a real CDP mouse click at its center.

        Google's #identifierId / #password inputs need a trusted mouse event to
        accept focus for Input.insertText; nodriver's el.click() and JS focus()
        are both unreliable here. Minimal sleeps — just enough for the event to
        register, no ceremony.
        """
        from nodriver import cdp
        box = await self._page.evaluate(
            f"(()=>{{const el=document.querySelector({json.dumps(self._sel)});if(!el||el.offsetParent===null)return null;const r=el.getBoundingClientRect();if(r.width===0||r.height===0)return null;return {{x:r.x+r.width/2,y:r.y+r.height/2}};}})()"
        )
        if not box:
            return False
        x, y = box["x"], box["y"]
        try:
            await self._page._tab.send(cdp.input_.dispatch_mouse_event(type_="mouseMoved", x=x, y=y))
            await self._page._tab.send(cdp.input_.dispatch_mouse_event(type_="mousePressed", x=x, y=y, button=cdp.input_.MouseButton.LEFT, click_count=1))
            await self._page._tab.send(cdp.input_.dispatch_mouse_event(type_="mouseReleased", x=x, y=y, button=cdp.input_.MouseButton.LEFT, click_count=1))
            await asyncio.sleep(0.03)
            return True
        except Exception:
            return False

    async def _type_human(self, text: str, *, delay_ms: int = 60, clear_first: bool = True) -> None:
        """Type text char-by-char with realistic human pacing.

        Uses the native HTMLInputElement.prototype.value setter (bypasses
        React/framework overrides that swallow el.value= and Input.insertText)
        + a composed InputEvent per char. Proven on Google's #identifierId and
        #password inputs, which reject both insert_text and plain el.value=.

        delay_ms per char + small jitter = human-like, not machine-gun. This
        both works on framework inputs AND avoids bot-detection heuristics that
        flag instant/inhuman typing.
        """
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
        payload = {"selector": self._sel, "value": ""}
        if clear_first:
            await self._page.evaluate(setter_js, {**payload, "value": ""})
            await asyncio.sleep(0.05)
        for i in range(1, len(text) + 1):
            await self._page.evaluate(setter_js, {**payload, "value": text[:i]})
            # human pacing: base delay + small jitter
            await asyncio.sleep(delay_ms / 1000 + random.uniform(0, 0.03))

    async def fill(self, text: str, *, timeout: int | None = None, **_kw: Any) -> None:
        # Human-paced char-by-char via native setter (works on Google's
        # framework inputs that reject insert_text / plain el.value=).
        to = (timeout if timeout is not None else self._page._default_timeout_ms) / 1000
        deadline = asyncio.get_event_loop().time() + to
        last_exc: Exception | None = None
        while asyncio.get_event_loop().time() < deadline:
            try:
                # focus first (best-effort; the setter works even without focus
                # on most inputs, but focus helps some frameworks)
                await self._focus_via_cdp_click()
                await self._type_human(text, clear_first=True)
                return
            except Exception as exc:
                last_exc = exc
            await asyncio.sleep(0.1)
        raise TimeoutError(f"fill timeout: {self._sel} ({last_exc})")

    async def press_sequentially(self, text: str, *, delay: int = 60, **_kw: Any) -> None:
        # Human-paced char-by-char typing via native setter. `delay` is per-char
        # ms (Playwright-compatible kwarg name). Works on Google's framework
        # inputs; insert_text was silently swallowed there.
        to_s = self._page._default_timeout_ms / 1000
        deadline = asyncio.get_event_loop().time() + to_s
        while asyncio.get_event_loop().time() < deadline:
            try:
                await self._focus_via_cdp_click()
                break
            except Exception:
                await asyncio.sleep(0.05)
        await self._type_human(text, delay_ms=delay, clear_first=False)

    async def press(self, key: str) -> None:
        from nodriver import cdp
        KEY_MAP = {
            "Enter": "Enter", "Tab": "Tab", "Escape": "Escape",
            "Backspace": "Backspace", "Control+a": "a",
        }
        try:
            if key == "Control+a":
                await self._page._tab.send(cdp.input_.dispatch_key(type_="keyDown", key="ControlLeft"))
                await self._page._tab.send(cdp.input_.dispatch_key(type_="keyDown", key="a"))
                await self._page._tab.send(cdp.input_.dispatch_key(type_="keyUp", key="a"))
                await self._page._tab.send(cdp.input_.dispatch_key(type_="keyUp", key="ControlLeft"))
            else:
                k = KEY_MAP.get(key, key)
                await self._page._tab.send(cdp.input_.dispatch_key(type_="keyDown", key=k))
                await self._page._tab.send(cdp.input_.dispatch_key(type_="keyUp", key=k))
        except Exception:
            await self._page.evaluate(
                f"(()=>{{const el=document.querySelector({json.dumps(self._sel)});if(!el)return;el.focus();el.dispatchEvent(new KeyboardEvent('keydown',{{key:{json.dumps(key)}}}));}})()"
            )

    async def input_value(self) -> str:
        try:
            v = await self._page.evaluate(
                f"(()=>{{const el=document.querySelector({json.dumps(self._sel)});return el?(el.value||''):'';}})()"
            )
            return str(v) if v is not None else ""
        except Exception:
            return ""

    async def text_content(self) -> str | None:
        try:
            v = await self._page.evaluate(
                f"(()=>{{const el=document.querySelector({json.dumps(self._sel)});return el?el.textContent:null;}})()"
            )
            return v
        except Exception:
            return None

    async def inner_text(self) -> str:
        v = await self.text_content()
        return v or ""

    async def get_attribute(self, name: str) -> str | None:
        try:
            v = await self._page.evaluate(
                f"(()=>{{const el=document.querySelector({json.dumps(self._sel)});return el?el.getAttribute({json.dumps(name)}):null;}})()"
            )
            return v
        except Exception:
            return None

    async def wait_for(self, *, state: str = "visible", timeout: int | None = None) -> None:
        await self._page.wait_for_selector(self._sel, state=state, timeout=timeout)

    async def select_option(self, value: str) -> None:
        await self._page.evaluate(
            f"(()=>{{const el=document.querySelector({json.dumps(self._sel)});if(!el)return;el.value={json.dumps(value)};el.dispatchEvent(new Event('change',{{bubbles:true}}));}})()"
        )


# ── ElementHandle / Route / Response / Request shims ─────────────────────────

class ElementHandle:
    """Minimal element handle over a nodriver Element or CDP node id."""

    def __init__(self, page: Page, node_id: Any) -> None:
        self._page = page
        self._node_id = node_id

    @classmethod
    def from_nodriver(cls, page: Page, el: Any) -> "ElementHandle":
        h = cls(page, None)
        h._el = el
        return h

    async def click(self, **_kw: Any) -> None:
        el = getattr(self, "_el", None)
        if el is not None:
            try:
                await el.click()
                return
            except Exception:
                pass
        await self._page.evaluate(
            f"(()=>{{const el=document.querySelector('[data-eh=\"1\"]');if(el)el.click();}})()"
        )

    async def text_content(self) -> str | None:
        el = getattr(self, "_el", None)
        if el is not None:
            try:
                return await el.get_attribute("textContent") or getattr(el, "text", None)
            except Exception:
                pass
        return None


class Route:
    """Playwright-shaped Route over CDP Fetch.requestPaused."""

    def __init__(self, tab: Any, request_id: Any) -> None:
        self._tab = tab
        self._rid = request_id

    async def continue_(self, **_kw: Any) -> None:
        from nodriver import cdp
        try:
            await self._tab.send(cdp.fetch.continue_request(self._rid))
        except Exception:
            pass

    async def fulfill(self, *, status: int = 200, body: str = "", content_type: str = "text/plain", **_kw: Any) -> None:
        from nodriver import cdp
        try:
            await self._tab.send(cdp.fetch.fulfill_request(
                request_id=self._rid,
                response_code=status,
                body=body,
                response_headers=[cdp.fetch.HeaderEntry(name="Content-Type", value=content_type)],
            ))
        except Exception as exc:
            _debug(f"route.fulfill error: {exc}")


class _ShimResponse:
    def __init__(self, tab: Any, request_id: Any, url: str, status: int, headers: dict[str, str]):
        self._tab = tab
        self._rid = request_id
        self.url = url
        self.status = status
        self._headers = headers
        self._body: str | None = None

    async def text(self) -> str:
        if self._body is None:
            from nodriver import cdp
            try:
                res = await self._tab.send(cdp.network.get_response_body(self._rid))
                self._body = res[0] if res else ""
            except Exception:
                self._body = ""
        return self._body

    async def json(self) -> Any:
        body = await self.text()
        if not body:
            return None
        try:
            return json.loads(body)
        except Exception:
            return None

    def header_value(self, name: str) -> str | None:
        return self._headers.get(name.lower())


class _ShimRequest:
    def __init__(self, evt: Any):
        self._evt = evt
        req = getattr(evt, "request", None)
        self.url = getattr(req, "url", "") if req else ""
        self.method = getattr(req, "method", "") if req else ""
        self.resource_type = str(getattr(evt, "type_", "") or "")

    async def all_headers(self) -> dict[str, str]:
        req = getattr(self._evt, "request", None)
        headers = getattr(req, "headers", None) if req else None
        out: dict[str, str] = {}
        if headers:
            for h in headers:
                k = getattr(h, "name", "")
                v = getattr(h, "value", "")
                if k:
                    out[k.lower()] = v
        return out

    def post_data_json(self) -> Any:
        req = getattr(self._evt, "request", None)
        pd = getattr(req, "post_data", None) if req else None
        if not pd:
            return None
        try:
            return json.loads(pd)
        except Exception:
            return None


async def _shim_response(tab: Any, evt: Any) -> _ShimResponse:
    rid = getattr(evt, "request_id", None)
    resp = getattr(evt, "response", None)
    url = getattr(resp, "url", "") if resp else ""
    status = int(getattr(resp, "status", 0) or 0) if resp else 0
    headers: dict[str, str] = {}
    if resp is not None:
        for h in getattr(resp, "headers", None) or []:
            k = getattr(h, "name", "")
            v = getattr(h, "value", "")
            if k:
                headers[k.lower()] = v
    return _ShimResponse(tab, rid, url, status, headers)


def _shim_request(evt: Any) -> _ShimRequest:
    return _ShimRequest(evt)


# ── helpers ──────────────────────────────────────────────────────────────────

def _url_matches(pattern: str, url: str) -> bool:
    import fnmatch
    return fnmatch.fnmatch(url, pattern)


def is_browser_crash(exc: BaseException) -> bool:
    """Engine-agnostic crash heuristic (preserved from browser_utils.py)."""
    s = str(exc).lower()
    return (
        "connection closed" in s
        or "target closed" in s
        or "browser has been closed" in s
        or "browser.close" in s
        or "not connected" in s
        or "execution context was destroyed" in s
        or "context was destroyed" in s
        or "nodriver" in s and ("closed" in s or "stopped" in s)
    )
