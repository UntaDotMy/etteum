from __future__ import annotations

import asyncio
import os
from typing import Any

from app.providers.base import NormalizedAccount

# Default behavior when a captcha is detected mid-login. Can be overridden via
# the BATCHER_CAPTCHA_MODE env var so the dashboard automation modal can pick
# "skip" (fail fast) or "handle" (60s manual-input popup).
_CAPTCHA_DEFAULT_MODE = "skip"
_CAPTCHA_DEFAULT_TIMEOUT_SECONDS = 60.0


def _captcha_mode() -> str:
    raw = (os.getenv("BATCHER_CAPTCHA_MODE") or "").strip().lower()
    if raw == "handle":
        return "handle"
    if raw == "skip":
        return "skip"
    return _CAPTCHA_DEFAULT_MODE


def _captcha_timeout_seconds() -> float:
    try:
        value = float(os.getenv("BATCHER_CAPTCHA_TIMEOUT_SECONDS") or "")
    except ValueError:
        return _CAPTCHA_DEFAULT_TIMEOUT_SECONDS
    if value <= 0:
        return _CAPTCHA_DEFAULT_TIMEOUT_SECONDS
    return value

from ._config import EMAIL_SELECTORS, PASSWORD_SELECTORS
from ._utils import (
    _all_targets,
    _codebuddy_auth_debug,
    _fill_input,
    _fill_input_anywhere,
    _read_input_value,
    _read_input_value_anywhere,
)


async def _target_url(target: Any) -> str:
    try:
        return str(target.url)
    except Exception:
        return ""


async def _active_element_snapshot(target: Any) -> str:
    try:
        return str(
            await target.evaluate(
                """() => {
                    const el = document.activeElement;
                    if (!el) return 'none';
                    const tag = (el.tagName || '').toLowerCase();
                    const id = el.id ? `#${el.id}` : '';
                    const name = el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : '';
                    return `${tag}${id}${name}`;
                }"""
            )
        )
    except Exception:
        return "unknown"


async def _fill_google_email_step(target: Any, email: str) -> bool:
    selectors = ["#identifierId"]
    for selector in selectors:
        try:
            target_url = await _target_url(target)
            _codebuddy_auth_debug(
                f"email step target={target_url or 'n/a'} selector={selector}"
            )

            try:
                await target.wait_for_selector(selector, state="visible", timeout=3000)
            except Exception:
                _codebuddy_auth_debug(
                    f"selector not visible target={target_url or 'n/a'} selector={selector}"
                )
                pass

            locator = target.locator(selector).first
            if await locator.count() == 0:
                _codebuddy_auth_debug(
                    f"selector missing target={target_url or 'n/a'} selector={selector}"
                )
                continue

            if not await locator.is_visible():
                _codebuddy_auth_debug(
                    f"selector hidden target={target_url or 'n/a'} selector={selector}"
                )
                continue

            await locator.scroll_into_view_if_needed()
            await locator.click(force=True)
            await asyncio.sleep(0.2)
            _codebuddy_auth_debug(
                f"after click target={target_url or 'n/a'} active={await _active_element_snapshot(target)}"
            )

            try:
                await locator.press("Control+a")
                await locator.press("Backspace")
            except Exception:
                pass

            try:
                await locator.press_sequentially(email, delay=60)
            except Exception as exc:
                _codebuddy_auth_debug(
                    f"press_sequentially failed target={target_url or 'n/a'} err={exc}"
                )
                continue

            await asyncio.sleep(0.5)
            val = await locator.input_value()
            _codebuddy_auth_debug(
                f"typed value target={target_url or 'n/a'} value={val!r}"
            )

            if email.lower() == str(val).lower().strip():
                await asyncio.sleep(0.3)
                clicked = await _click_google_next(target)
                if not clicked:
                    await locator.press("Enter")
                await _wait_for_google_email_transition(target)
                _codebuddy_auth_debug(f"email accepted target={target_url or 'n/a'}")
                return True

        except Exception as exc:
            _codebuddy_auth_debug(f"email fill error selector={selector} err={exc}")
            continue
    return False


async def _fill_google_password_step(target: Any, password: str) -> bool:
    selectors = ['input[name="Passwd"]', 'input[type="password"]']
    for selector in selectors:
        try:
            target_url = await _target_url(target)
            _codebuddy_auth_debug(
                f"password step target={target_url or 'n/a'} selector={selector}"
            )

            try:
                await target.wait_for_selector(selector, state="visible", timeout=3000)
            except Exception:
                _codebuddy_auth_debug(
                    f"selector not visible target={target_url or 'n/a'} selector={selector}"
                )
                pass

            locator = target.locator(selector).first
            if await locator.count() == 0:
                _codebuddy_auth_debug(
                    f"selector missing target={target_url or 'n/a'} selector={selector}"
                )
                continue
            if not await locator.is_visible():
                _codebuddy_auth_debug(
                    f"selector hidden target={target_url or 'n/a'} selector={selector}"
                )
                continue

            await locator.scroll_into_view_if_needed()
            await locator.click(force=True)
            await asyncio.sleep(0.2)
            _codebuddy_auth_debug(
                f"after click target={target_url or 'n/a'} active={await _active_element_snapshot(target)}"
            )

            try:
                await locator.press("Control+a")
                await locator.press("Backspace")
            except Exception:
                pass

            try:
                await locator.press_sequentially(password, delay=70)
            except Exception as exc:
                _codebuddy_auth_debug(
                    f"press_sequentially failed target={target_url or 'n/a'} err={exc}"
                )
                continue

            await asyncio.sleep(0.5)
            typed_len = 0
            try:
                val = await locator.input_value()
                typed_len = len(str(val))
            except Exception:
                pass
            if typed_len == 0:
                try:
                    typed_len = int(
                        await target.evaluate(
                            "(sel) => { const el = document.querySelector(sel); return el ? el.value.length : 0; }",
                            selector,
                        )
                    )
                except Exception:
                    typed_len = 0
            _codebuddy_auth_debug(
                f"typed password length target={target_url or 'n/a'} length={typed_len}"
            )
            if typed_len >= len(password):
                clicked = await _click_google_next(target)
                if not clicked:
                    await locator.press("Enter")
                await _wait_for_google_password_transition(target)
                _codebuddy_auth_debug(f"password accepted target={target_url or 'n/a'}")
                return True

        except Exception as exc:
            _codebuddy_auth_debug(f"password fill error selector={selector} err={exc}")
            continue
    return False


async def _fill_google_email_anywhere(
    page: Any, preferred: Any | None, email: str
) -> bool:
    for target in await _all_targets(page, preferred):
        if await _fill_google_email_step(target, email):
            return True
    return False


async def _fill_google_password_anywhere(
    page: Any, preferred: Any | None, password: str
) -> bool:
    for target in await _all_targets(page, preferred):
        if await _fill_google_password_step(target, password):
            return True
    return False





async def _wait_for_google_email_transition(target: Any) -> bool:
    try:
        await target.wait_for_function(
            """() => {
                const host = window.location.host || '';
                const path = window.location.pathname || '';
                const visible = (selectors) => selectors.some((sel) =>
                    Array.from(document.querySelectorAll(sel)).some((el) => el.offsetParent !== null)
                );
                const hasEmail = visible(['#identifierId', 'input[name="identifier"]', 'input[type="email"]']);
                const hasPassword = visible(['input[name="Passwd"]', 'input[type="password"]']);
                if (!host.includes('accounts.google.com')) return true;
                if (hasPassword) return true;
                if (path.includes('/signin/challenge/pwd')) return true;
                return !hasEmail && !path.includes('/signin/identifier');
            }""",
            timeout=10000,
        )
        return True
    except Exception:
        return False


async def _wait_for_google_password_transition(target: Any) -> bool:
    try:
        await target.wait_for_function(
            """() => {
                const host = window.location.host || '';
                const path = window.location.pathname || '';
                const hasPassword = Array.from(
                    document.querySelectorAll('input[name="Passwd"], input[type="password"]')
                ).some((el) => el.offsetParent !== null);
                if (!host.includes('accounts.google.com')) return true;
                if (!path.includes('/challenge/pwd')) return true;
                return !hasPassword;
            }""",
            timeout=12000,
        )
        return True
    except Exception:
        return False


async def _is_password_step(target: Any) -> bool:
    try:
        return bool(
            await target.evaluate(
                """() => {
                    for (const el of document.querySelectorAll('input[type="password"], input[name="Passwd"]')) {
                        if (el.offsetParent !== null) return true;
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _is_email_step(target: Any) -> bool:
    try:
        return bool(
            await target.evaluate(
                """() => {
                    for (const el of document.querySelectorAll('input[type="email"], input[name="identifier"], #identifierId')) {
                        if (el.offsetParent !== null) return true;
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _is_google_account_picker(target: Any) -> bool:
    try:
        return bool(
            await target.evaluate(
                """() => {
                    // If a password field is visible, we're on the password step, not the picker
                    const hasPassword = Array.from(
                        document.querySelectorAll('input[type="password"], input[name="Passwd"]')
                    ).some(el => el.offsetParent !== null);
                    if (hasPassword) return false;
                    // If an email/identifier input is visible, we're on the email step, not the picker
                    const hasEmailInput = Array.from(
                        document.querySelectorAll('#identifierId, input[name="identifier"], input[type="email"]')
                    ).some(el => el.offsetParent !== null);
                    if (hasEmailInput) return false;
                    // Check for actual account picker elements (specific selectors only)
                    const selectors = [
                        'div[data-identifier]',
                        'div[data-email]',
                        'li[data-identifier]',
                        'div.BHzsHc'
                    ];
                    for (const sel of selectors) {
                        const els = document.querySelectorAll(sel);
                        for (const el of els) {
                            const text = (el.textContent || '').toLowerCase();
                            if (text.includes('@') && el.offsetParent !== null) {
                                return true;
                            }
                        }
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _click_google_account_in_picker(target: Any, email: str) -> bool:
    try:
        clicked = bool(
            await target.evaluate(
                """(email) => {
                    const lowerEmail = email.toLowerCase();
                    const selectors = [
                        'div[data-identifier]',
                        'div[data-email]',
                        'li[data-identifier]',
                        'div.BHzsHc'
                    ];
                    
                    for (const sel of selectors) {
                        const els = document.querySelectorAll(sel);
                        for (const el of els) {
                            const identifier = (el.getAttribute('data-identifier') || el.getAttribute('data-email') || '').toLowerCase();
                            const textContent = (el.textContent || '').toLowerCase();
                            
                            if (identifier === lowerEmail || textContent.includes(lowerEmail)) {
                                if (el.offsetParent !== null) {
                                    el.click();
                                    return true;
                                }
                                const parent = el.closest('div[role="link"], li, button');
                                if (parent && parent.offsetParent !== null) {
                                    parent.click();
                                    return true;
                                }
                            }
                        }
                    }
                    return false;
                }""",
                email,
            )
        )
        if clicked:
            await asyncio.sleep(1.0)
        return clicked
    except Exception:
        return False


async def _click_google_next(target: Any) -> bool:
    try:
        return bool(
            await target.evaluate(
                """() => {
                    // Only click the specific Next buttons Google provides — never generic buttons
                    const btn = document.querySelector(
                        '#identifierNext button, #passwordNext button, #identifierNext, #passwordNext'
                    );
                    if (btn && btn.offsetParent !== null) {
                        btn.click();
                        return true;
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _click_continue_button(target: Any) -> None:
    # Copied from the proven kiro handler: try the known submit-button IDs first
    # (covers gaplustos / Workspace "Welcome to your new account" interstitials),
    # then a broad multi-language keyword scan.
    await target.evaluate(
        """() => {
            for (const sel of ['#gaplustosNext button', '#identifierNext button', '#passwordNext button', '#submit', '#confirm']) {
                const el = document.querySelector(sel);
                if (el && el.offsetParent !== null) { el.click(); return; }
            }
            for (const btn of document.querySelectorAll('button, div[role="button"], input[type="submit"]')) {
                if (!btn.offsetParent) continue;
                const txt = (btn.textContent || btn.value || '').toLowerCase().trim();
                if (!txt) continue;
                const keywords = ['next','continue','accept','understand','agree','ok','got it','login','sign in',
                    'mengerti','lanjutkan','setuju','masuk','lewati','berikutnya',
                    'далее','продолжить','принять','понятно','войти','пропустить',
                    'зрозуміло','далі','продовжити','прийняти','увійти','пропустити',
                    'weiter','akzeptieren','verstanden','anmelden',
                    'suivant','continuer','accepter','compris',
                    'siguiente','continuar','aceptar','entendido',
                    'avanti','continua','accetta','capito',
                    'próximo','aceitar','entendi',
                    '次へ','続行','同意','ログイン',
                    '다음','계속','동의','로그인',
                    '下一步','继续','同意','登录',
                    'ถัดไป','ดำเนินการต่อ','ยอมรับ','เข้าสู่ระบบ'];
                if (keywords.some((k) => txt.includes(k))) { btn.click(); return; }
            }
        }"""
    )


async def _detect_google_text_captcha(page: Any) -> str | None:
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    if "accounts.google.com" not in current_url:
        return None

    try:
        marker = str(
            await page.evaluate(
                """() => {
                    const text = (document.body?.innerText || '').toLowerCase();
                    const hasVisibleTextInput = Array.from(document.querySelectorAll('input')).some((el) => {
                        if (el.offsetParent === null) return false;
                        const type = String(el.type || '').toLowerCase();
                        const name = String(el.name || '');
                        const id = String(el.id || '');
                        if (type === 'password' || type === 'email' || type === 'hidden') return false;
                        if (name === 'Passwd' || name === 'identifier') return false;
                        if (id === 'identifierId') return false;
                        return type === 'text' || type === 'tel' || type === '';
                    });
                    if (!hasVisibleTextInput) return '';
                    const markers = [
                        'type the text you hear or see',
                        'type the text you hear',
                        'enter the characters you see',
                        'enter the characters you hear',
                        'listen and type',
                        'captcha',
                    ];
                    for (const candidate of markers) {
                        if (text.includes(candidate)) return candidate;
                    }
                    if ((window.location.pathname || '').includes('/challenge/')) {
                        return 'google text captcha';
                    }
                    return '';
                }"""
            )
        ).strip()
        return marker or None
    except Exception:
        return None


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
            clicked = await _click_google_next(page)
            if not clicked:
                await locator.press("Enter")
            return True
        except Exception:
            continue
    return False


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
        screenshot_bytes = await element.screenshot(type="png")
        import base64

        return base64.b64encode(screenshot_bytes).decode(), "png"
    except Exception:
        return "", ""


async def _emit_manual_challenge(
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
            "provider": "codebuddy",
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


async def _wait_for_google_text_captcha_input(
    page: Any,
    session: dict[str, Any],
    marker: str,
    challenge_step: str,
    account: NormalizedAccount,
) -> bool:
    queue = session.get("manual_challenge_queue")
    if queue is None:
        return False

    mode = _captcha_mode()
    if mode == "skip":
        # Operator opted out of manual captcha handling. Emit an error event
        # only (no manual_challenge popup) so the batch logs explain the
        # failure, then bail with False — the adapter raises
        # browser_challenge_blocked from there which marks the account failed.
        callback = session.get("manual_challenge_callback")
        if callable(callback):
            result = callback(
                {
                    "type": "error",
                    "provider": "codebuddy",
                    "step": "captcha_skipped",
                    "message": "captcha_skipped: user disabled captcha handling",
                    "error": "captcha_skipped: user disabled captcha handling",
                }
            )
            if asyncio.iscoroutine(result):
                await result
        session["_manual_challenge_pending"] = False
        return False

    image_b64, image_format = await _capture_google_text_captcha_image(page)
    timeout_seconds = _captcha_timeout_seconds()
    await _emit_manual_challenge(
        session,
        "google_text_captcha",
        f"Google captcha detected \u2014 enter the text within {int(timeout_seconds)}s to continue",
        "Type the text you hear or see",
        image_b64=image_b64,
        image_format=image_format,
    )

    deadline = asyncio.get_event_loop().time() + timeout_seconds
    while True:
        if session.get("cancel_requested"):
            return False
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            callback = session.get("manual_challenge_callback")
            if callable(callback):
                result = callback(
                    {
                        "type": "error",
                        "provider": "codebuddy",
                        "step": "captcha_timeout",
                        "message": f"captcha_timeout: {int(timeout_seconds)}s elapsed without user input",
                        "error": f"captcha_timeout: {int(timeout_seconds)}s elapsed without user input",
                    }
                )
                if asyncio.iscoroutine(result):
                    await result
            session["_manual_challenge_pending"] = False
            return False
        try:
            payload = await asyncio.wait_for(queue.get(), timeout=min(1.0, remaining))
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
                await _fill_google_email_step(page, account.identifier)
            elif challenge_step == "password":
                await _fill_google_password_step(page, account.secret)
            session["_manual_challenge_pending"] = False
            return True

