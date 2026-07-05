"""Shared frame-relay for automation providers.

Streams JPEG screenshots of the browser page to stdout as ``frame`` events and
emits ``progress``/``phase`` events, mirroring the in-app "Browser Logs" live
viewer contract.  It also reads control messages (cancel / captcha answers /
pointer clicks) from stdin so the dashboard can drive the otherwise-headless
browser remotely.

Design goals
------------
* Reused by every automation provider (antigravity first, then the rest).
* No hardcoded product names — generic event shape only.
* Self-contained: a provider only needs ``FrameRelay.start(page)`` /
  ``stop()`` and ``emit_progress`` / ``emit_phase`` / ``request_captcha``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import time
from typing import Any


# ── stdout protocol ──────────────────────────────────────────────────────────

def emit(payload: dict[str, Any]) -> None:
    """Write one JSON event line to stdout (the dashboard reads line-by-line)."""
    try:
        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def emit_progress(provider: str, step: str, message: str) -> None:
    emit({"type": "progress", "provider": provider, "step": step, "message": message})


def emit_phase(step: str, message: str, *, provider: str = "") -> None:
    emit({"type": "phase", "step": step, "message": message, "provider": provider})


# ── frame relay ──────────────────────────────────────────────────────────────

class FrameRelay:
    """Background screenshot loop + stdin control reader for one browser page.

    Lifecycle::

        relay = FrameRelay(provider="antigravity")
        await relay.start(page)        # launches screenshot + stdin tasks
        ...
        emit_progress(...)             # provider drives the flow
        ...
        await relay.stop()             # cancels tasks cleanly
    """

    def __init__(self, provider: str = "", *, fps: float = 3.0, quality: int = 60) -> None:
        self.provider = provider
        self.fps = fps
        self.quality = quality
        self._tasks: list[asyncio.Task[Any]] = []
        self._stop = False
        self._page: Any = None
        # captcha / input coordination
        self._input_queue: asyncio.Queue[dict[str, Any]] | None = None
        self._captcha_pending = False

    # ── public API ───────────────────────────────────────────────────────────

    async def start(self, page: Any) -> None:
        self._page = page
        self._stop = False
        self._input_queue = asyncio.Queue()
        self._tasks.append(asyncio.create_task(self._screenshot_loop()))
        self._tasks.append(asyncio.create_task(self._stdin_loop()))

    async def stop(self) -> None:
        self._stop = True
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks.clear()

    def is_captcha_pending(self) -> bool:
        return self._captcha_pending

    async def wait_input(self, timeout: float | None = None) -> dict[str, Any] | None:
        """Wait for a control message from the dashboard (captcha answer, etc.)."""
        if self._input_queue is None:
            return None
        try:
            if timeout is None:
                return await self._input_queue.get()
            return await asyncio.wait_for(self._input_queue.get(), timeout=timeout)
        except asyncio.TimeoutError:
            return None
        except Exception:
            return None

    # ── screenshot loop ──────────────────────────────────────────────────────

    async def _screenshot_loop(self) -> None:
        """Capture JPEG screenshots of the page and emit ``frame`` events.

        FPS adapts down if encoding is slow, so we never starve the flow.
        """
        min_interval = 1.0 / max(self.fps, 0.5)
        page = self._page
        while not self._stop:
            t0 = time.monotonic()
            try:
                b64 = await self._capture(page)
                if b64:
                    emit({"type": "frame", "format": "jpeg", "base64": b64})
            except Exception:
                pass
            elapsed = time.monotonic() - t0
            interval = max(min_interval, min_interval if elapsed < min_interval else elapsed * 1.2)
            await asyncio.sleep(max(0.05, interval))

    async def _capture(self, page: Any) -> str | None:
        """Capture a JPEG screenshot via CDP and return base64 (no data: prefix).

        ``page`` may be a raw nodriver Tab (has .send()) or a Playwright-shim
        Page (has .tab pointing at the underlying Tab). We resolve to the Tab
        and send the CDP capture_screenshot command directly.
        """
        try:
            from nodriver.cdp import page as cdp_page
            # Resolve the underlying nodriver Tab (the shim wraps it).
            tab = page
            if hasattr(page, "tab") and not hasattr(page, "send"):
                tab = page.tab
            elif hasattr(page, "_tab") and not hasattr(page, "send"):
                tab = page._tab
            data = await tab.send(
                cdp_page.capture_screenshot(format_="jpeg", quality=self.quality)
            )
            if not data:
                return None
            return data
        except Exception:
            return None

    # ── stdin control loop ───────────────────────────────────────────────────

    async def _stdin_loop(self) -> None:
        """Read control messages from stdin, dispatch to the input queue.

        Accepted messages (one JSON per line):
          {"type":"cancel"}                       — abort the flow
          {"type":"captcha","value":"answer"}     — captcha answer
          {"type":"manual_input","value":"text"}  — generic text input
          {"type":"pointer","x":..,"y":..}        — pointer click relay
        """
        loop = asyncio.get_event_loop()
        while not self._stop:
            try:
                line = await loop.run_in_executor(None, _read_stdin_line)
            except Exception:
                await asyncio.sleep(0.5)
                continue
            if not line:
                await asyncio.sleep(0.1)
                continue
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("type") == "cancel":
                self._stop = True
                if self._input_queue:
                    await self._input_queue.put({"type": "cancel"})
                break
            if self._input_queue:
                await self._input_queue.put(msg)


def _read_stdin_line() -> str:
    """Read one line from stdin (blocking; runs in executor)."""
    try:
        return sys.stdin.readline()
    except Exception:
        return ""


# ── CDP screenshot helper ────────────────────────────────────────────────────

def _cdp_screenshot(quality: int = 60) -> Any:
    """Build a CDP ``Page.captureScreenshot`` command for nodriver.

    nodriver exposes cdp page objects; we send the raw command so it works
    regardless of the exact nodriver version.
    """
    try:
        from nodriver.cdp import page as cdp_page  # type: ignore
        return cdp_page.capture_screenshot(
            format_="jpeg",
            quality=quality,
        )
    except Exception:
        # Fallback: raw CDP dict (works with any CDP transport)
        return {
            "method": "Page.captureScreenshot",
            "params": {"format": "jpeg", "quality": quality},
        }


# ── high-level helpers (one-liner per provider) ──────────────────────────────

def relay_enabled() -> bool:
    """Whether the frame relay is active for this run."""
    return os.getenv("BATCHER_FRAME_RELAY", "false").lower() == "true"


def should_run_headless() -> bool:
    """Headless when the frame relay is on (it replaces the visible window)
    or when the legacy headless env is set."""
    return relay_enabled() or os.getenv("BATCHER_CAMOUFOX_HEADLESS", "false").lower() == "true"


async def bootstrap_with_relay(
    provider: str,
    launch_fn,
    *,
    page_timeout: int = 45000,
) -> dict[str, Any]:
    """Launch a browser + start the frame relay in one call.

    Every provider reuses this so the relay wiring is never duplicated.
    ``launch_fn`` is the provider's browser launcher (e.g. ``launch_browser``).
    Returns a session dict ``{"browser", "page", "relay"}`` that the provider
    passes straight back from its own ``bootstrap_session``.
    """
    headless = should_run_headless()
    emit_progress(provider, "browser_launch", "Launching browser...")
    browser, page = await launch_fn(headless=headless)
    page.set_default_timeout(page_timeout)
    emit_progress(provider, "browser_ready", "Browser session ready")

    relay: FrameRelay | None = None
    if relay_enabled():
        relay = FrameRelay(provider=provider)
        await relay.start(page)
        emit_phase("frame_relay_started", "Live frame relay active", provider=provider)
        emit_progress(provider, "frame_relay", "Frame relay started — viewable in Browser Logs")

    return {"browser": browser, "page": page, "relay": relay}


async def cleanup_with_relay(session: dict[str, Any]) -> None:
    """Stop the frame relay + close the browser in the correct order.

    Every provider reuses this from its own ``cleanup_session`` so the
    teardown sequence is never duplicated.
    """
    relay = session.get("relay")
    if relay:
        try:
            await relay.stop()
        except Exception:
            pass
    browser = session.get("browser")
    if browser:
        try:
            await browser.close()
        except Exception:
            pass
