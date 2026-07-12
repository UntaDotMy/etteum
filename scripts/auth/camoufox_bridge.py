#!/usr/bin/env python3
"""
Camoufox bridge — a JSON-RPC-over-stdio server that owns the Camoufox browser
session and exposes page-interaction commands to the TS automation layer.

This is how reference runs Camoufox: via the Python `camoufox[geoip]` package's
AsyncCamoufox, which launches the patched-Fingerprint Firefox reliably on this
host (the JS camoufox-js binding hangs here; the Python one does not).

Protocol (one JSON request per line on stdin, one JSON response per line on
stdout; unsolicited "event" lines for progress/screenshots):
  Request:  {"id": 1, "method": "launch", "params": {...}}
  Response: {"id": 1, "ok": true, "result": ...}
  Event:    {"type": "event", "event": "frame", "data": {...}}   (no id — unsolicited)

Methods:
  launch({headless, proxy, os, humanize, block_webrtc}) -> {ok}
  new_page() -> {url}
  goto({url, waitUntil}) -> {ok}
  click({selector}) -> {ok}
  fill({selector, value}) -> {ok}
  press({selector, key}) -> {ok}
  evaluate({script}) -> result
  wait_for_selector({selector, timeout}) -> {ok}
  is_visible({selector}) -> bool
  screenshot() -> base64 png
  url() -> str
  close_page() -> {ok}
  shutdown() -> {ok} (closes browser + exits)
"""
from __future__ import annotations
import asyncio
import base64
import json
import sys

from camoufox.async_api import AsyncCamoufox

browser = None
context = None
page = None


def emit(obj):
    """Write one JSON object to stdout."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


async def handle(method, params):
    global browser, context, page
    params = params or {}

    if method == "launch":
        opts = {
            "headless": params.get("headless", True),
            "block_webrtc": params.get("block_webrtc", True),
            "humanize": params.get("humanize", False),
        }
        if params.get("proxy"):
            p = params["proxy"]
            opts["proxy"] = p  # {server, username?, password?}
            opts["geoip"] = True
        if params.get("os"):
            opts["os"] = params["os"]
        if params.get("screen"):
            opts["screen"] = params["screen"]
        # AsyncCamoufox as a context manager starts AND stops the browser.
        # We want long-lived control, so use the start/stop form instead.
        cm = AsyncCamoufox(**opts)
        browser = await cm.__aenter__()
        # Stash the cm so we can __aexit__ on shutdown.
        handle._cm = cm
        return {"ok": True}

    if browser is None:
        raise RuntimeError("browser not launched; call launch first")

    if method == "new_page":
        context = await browser.new_context()
        page = await context.new_page()
        return {"ok": True}

    if page is None:
        raise RuntimeError("no page; call new_page first")

    if method == "goto":
        await page.goto(params["url"], wait_until=params.get("waitUntil", "domcontentloaded"), timeout=params.get("timeout", 60000))
        return {"ok": True}

    if method == "url":
        return page.url

    if method == "click":
        await page.click(params["selector"], timeout=params.get("timeout", 5000))
        return {"ok": True}

    if method == "fill":
        await page.fill(params["selector"], params["value"], timeout=params.get("timeout", 15000))
        return {"ok": True}

    if method == "press":
        await page.press(params["selector"], params["key"])
        return {"ok": True}

    if method == "evaluate":
        return await page.evaluate(params["script"])

    if method == "wait_for_selector":
        await page.wait_for_selector(params["selector"], state=params.get("state", "visible"), timeout=params.get("timeout", 15000))
        return {"ok": True}

    if method == "is_visible":
        try:
            el = await page.query_selector(params["selector"])
            return bool(el and await el.is_visible())
        except Exception:
            return False

    if method == "query_selector_all":
        els = await page.query_selector_all(params["selector"])
        # Return text content of each (best-effort for click-first-visible logic).
        out = []
        for el in els:
            try:
                out.append({"text": await el.text_content(), "visible": await el.is_visible()})
            except Exception:
                out.append({"text": None, "visible": False})
        return out

    if method == "click_first_visible":
        selectors = params.get("selectors", [])
        for sel in selectors:
            try:
                el = await page.query_selector(sel)
                if el and await el.is_visible():
                    await el.click(timeout=5000)
                    return True
            except Exception:
                continue
        return False

    if method == "fill_resilient":
        # humanized fill: click, select-all, delete, type char-by-char w/ delays
        sel = params["selector"]
        val = str(params["value"])
        el = await page.query_selector(sel)
        if not el:
            return False
        await el.click(timeout=5000)
        await asyncio.sleep(0.2 + 0.0001 * (hash(val) % 400))
        try:
            await el.press("Control+a")
            await asyncio.sleep(0.05)
            await el.press("Delete")
        except Exception:
            pass
        for ch in val:
            await el.press(ch)
            import random
            await asyncio.sleep(0.05 + random.random() * 0.13 + (0.3 if random.random() < 0.06 else 0))
        try:
            observed = await el.input_value()
            return observed == val
        except Exception:
            return True

    if method == "screenshot":
        fmt = params.get("format", "png")
        buf = await page.screenshot(type=fmt)
        return base64.b64encode(buf).decode("ascii")

    if method == "close_page":
        if context:
            await context.close()
            context = None
            page = None
        return {"ok": True}

    if method == "shutdown":
        if handle._cm:
            await handle._cm.__aexit__(None, None, None)
        return {"ok": True}

    raise ValueError(f"unknown method: {method}")


async def reader_loop():
    """Read JSON-RPC requests from stdin, dispatch, write responses."""
    loop = asyncio.get_event_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            emit({"id": None, "ok": False, "error": f"bad json: {e}"})
            continue
        rid = req.get("id")
        try:
            result = await handle(req["method"], req.get("params"))
            emit({"id": rid, "ok": True, "result": result})
        except Exception as e:
            emit({"id": rid, "ok": False, "error": str(e)})
        if req["method"] == "shutdown":
            break


def main():
    emit({"type": "event", "event": "ready"})
    asyncio.run(reader_loop())


if __name__ == "__main__":
    main()
