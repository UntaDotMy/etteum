from __future__ import annotations

import os
from typing import Any

import aiohttp


def _get_proxy_url() -> str | None:
    return (
        os.getenv("BATCHER_PROXY_URL")
        or os.getenv("HTTPS_PROXY")
        or os.getenv("HTTP_PROXY")
        or None
    )


def _make_proxy_connector() -> Any:
    url = _get_proxy_url()
    if not url:
        return None
    if url.startswith("socks"):
        try:
            from aiohttp_socks import ProxyConnector

            return ProxyConnector.from_url(url)
        except ImportError:
            return None
    return None


def _make_session(timeout: Any, headers: dict[str, str]) -> "aiohttp.ClientSession":
    connector = _make_proxy_connector()
    proxy_url = _get_proxy_url()
    kwargs: dict[str, Any] = {"timeout": timeout, "headers": headers}
    if connector:
        kwargs["connector"] = connector
    session = aiohttp.ClientSession(**kwargs)
    session._proxy_url = proxy_url if not connector else None  # type: ignore[attr-defined]
    return session


def _req_proxy(session: "aiohttp.ClientSession") -> str | None:
    return getattr(session, "_proxy_url", None)



async def _fill_input(target: Any, selectors: list[str], value: str) -> bool:
    for selector in selectors:
        try:
            handle = await target.query_selector(selector)
            if not handle:
                continue
            if not await handle.is_visible():
                continue

            # Focus and clear current value.
            try:
                await handle.click(timeout=1200)
            except Exception:
                pass
            try:
                await handle.press("Control+a")
                await handle.press("Backspace")
            except Exception:
                pass

            # Try direct value injection + input/change events.
            try:
                await target.evaluate(
                    """({sel, val}) => {
                        const el = document.querySelector(sel);
                        if (!el) return;
                        el.focus();
                        const proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
                        const setter = proto
                          ? Object.getOwnPropertyDescriptor(proto, 'value')?.set
                          : null;
                        if (setter) {
                            setter.call(el, val);
                        } else {
                            el.value = val;
                        }
                        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                    }""",
                    {"sel": selector, "val": value},
                )
            except Exception:
                pass

            current = await _read_input_value(target, [selector])
            if current.strip() == value.strip():
                return True

            # Fallback: real key typing (slower, but tends to work on guarded inputs).
            try:
                await handle.click(timeout=1200)
                await handle.press("Control+a")
                await handle.press("Backspace")
                await target.keyboard.type(value, delay=35)
            except Exception:
                continue

            current = await _read_input_value(target, [selector])
            if current.strip() == value.strip():
                return True

            # Last resort for guarded inputs.
            try:
                await handle.click(timeout=1200)
                await target.keyboard.insert_text(value)
            except Exception:
                continue
            current = await _read_input_value(target, [selector])
            if current.strip() == value.strip():
                return True
        except Exception:
            continue
    return False


async def _all_targets(page: Any, preferred: Any | None) -> list[Any]:
    targets: list[Any] = []
    seen: set[int] = set()

    def add(obj: Any) -> None:
        if obj is None:
            return
        key = id(obj)
        if key in seen:
            return
        seen.add(key)
        targets.append(obj)

    add(preferred)
    add(page)
    try:
        for frame in page.frames:
            add(frame)
    except Exception:
        pass
    return targets


async def _fill_input_anywhere(
    page: Any, preferred: Any | None, selectors: list[str], value: str
) -> bool:
    for target in await _all_targets(page, preferred):
        if await _fill_input(target, selectors, value):
            return True
    return False


def _codebuddy_auth_debug_enabled() -> bool:
    return os.getenv("BATCHER_CODEBUDDY_AUTH_DEBUG", "false").lower() == "true"


def _codebuddy_auth_debug(message: str) -> None:
    if _codebuddy_auth_debug_enabled():
        print(f"[codebuddy-auth] {message}", flush=True)



async def _read_input_value(target: Any, selectors: list[str]) -> str:
    for selector in selectors:
        try:
            handle = await target.query_selector(selector)
            if not handle:
                continue
            value = await handle.input_value()
            if value is not None:
                return str(value)
        except Exception:
            continue
    return ""


async def _read_input_value_anywhere(
    page: Any, preferred: Any | None, selectors: list[str]
) -> str:
    for target in await _all_targets(page, preferred):
        value = await _read_input_value(target, selectors)
        if value:
            return value
    return ""
