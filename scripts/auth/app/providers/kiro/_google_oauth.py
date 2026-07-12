from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from typing import Any

from ._helpers import _extract_code_from_kiro_url, _kiro_auth_debug, _kiro_auth_debug_enabled


# Default behavior when a captcha is detected mid-login. Overridden via the
# BATCHER_CAPTCHA_MODE env var so the dashboard automation modal can pick
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


async def _click_google_next(target: Any) -> bool:
    try:
        return bool(
            await target.evaluate(
                """() => {
                    const bySubmit = document.querySelector('#identifierNext button, #passwordNext button');
                    if (bySubmit && bySubmit.offsetParent !== null) {
                        bySubmit.click();
                        return true;
                    }
                    for (const el of document.querySelectorAll('div.VfPpkd-RLmnJb, button, div[role="button"]')) {
                        const parentBtn = el.closest('button, div[role="button"]') || el;
                        if (parentBtn && parentBtn.offsetParent !== null) {
                            parentBtn.click();
                            return true;
                        }
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _fill_google_email_step(target: Any, email: str) -> bool:
    for selector in ["#identifierId"]:
        try:
            target_url = await _target_url(target)
            _kiro_auth_debug(
                f"email step target={target_url or 'n/a'} selector={selector}"
            )

            try:
                await target.wait_for_selector(selector, state="visible", timeout=3000)
            except Exception:
                pass

            locator = target.locator(selector).first
            if await locator.count() == 0 or not await locator.is_visible():
                continue

            await locator.scroll_into_view_if_needed()
            await locator.click(force=True)
            await asyncio.sleep(0.2)
            _kiro_auth_debug(f"email active={await _active_element_snapshot(target)}")

            try:
                await locator.press("Control+a")
                await locator.press("Backspace")
            except Exception:
                pass

            try:
                await locator.press_sequentially(email, delay=60)
            except Exception as exc:
                _kiro_auth_debug(f"email type failed err={exc}")
                continue

            await asyncio.sleep(0.5)
            value = await locator.input_value()
            _kiro_auth_debug(f"email typed value={value!r}")
            if email.lower() != str(value).lower().strip():
                continue

            clicked = await _click_google_next(target)
            if not clicked:
                await locator.press("Enter")
            await _wait_for_google_email_transition(target)
            return True
        except Exception as exc:
            _kiro_auth_debug(f"email fill error err={exc}")
            continue
    return False


async def _fill_google_password_step(target: Any, password: str) -> bool:
    for selector in ['input[name="Passwd"]', 'input[type="password"]']:
        try:
            target_url = await _target_url(target)
            _kiro_auth_debug(
                f"password step target={target_url or 'n/a'} selector={selector}"
            )

            try:
                await target.wait_for_selector(selector, state="visible", timeout=3000)
            except Exception:
                pass

            locator = target.locator(selector).first
            if await locator.count() == 0 or not await locator.is_visible():
                continue

            await locator.scroll_into_view_if_needed()
            await locator.click(force=True)
            await asyncio.sleep(0.2)
            _kiro_auth_debug(
                f"password active={await _active_element_snapshot(target)}"
            )

            try:
                await locator.press("Control+a")
                await locator.press("Backspace")
            except Exception:
                pass

            try:
                await locator.press_sequentially(password, delay=70)
            except Exception as exc:
                _kiro_auth_debug(f"password type failed err={exc}")
                continue

            await asyncio.sleep(0.5)
            value = await locator.input_value()
            _kiro_auth_debug(f"password typed length={len(str(value))}")
            if len(str(value)) < len(password):
                continue

            clicked = await _click_google_next(target)
            if not clicked:
                await locator.press("Enter")
            await _wait_for_google_password_transition(target)
            return True
        except Exception as exc:
            _kiro_auth_debug(f"password fill error err={exc}")
            continue
    return False


async def _click_continue_button(page: Any) -> None:
    await page.evaluate(
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


async def _handle_google_gaplustos(page: Any) -> bool:
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    if "/speedbump/gaplustos" not in current_url:
        return False

    try:
        try:
            await page.wait_for_selector(
                '#confirm, input[name="confirm"], input[type="submit"]',
                state="visible",
                timeout=5000,
            )
        except Exception:
            pass

        for selector in ["#gaplustosNext button", "#confirm", 'input[name="confirm"]', 'input[type="submit"]']:
            locator = page.locator(selector).first
            try:
                if await locator.count() == 0 or not await locator.is_visible():
                    continue
                await locator.click(force=True)
                _kiro_auth_debug(f"gaplustos clicked selector={selector}")
                return True
            except Exception:
                continue

        return bool(
            await page.evaluate(
                """() => {
                    const el = document.querySelector('#gaplustosNext button');
                    if (el && el.offsetParent !== null) { el.click(); return true; }
                    for (const btn of document.querySelectorAll('button, input[type="submit"]')) {
                        if (!btn.offsetParent) continue;
                        btn.click();
                        return true;
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _handle_google_consent_continue(page: Any) -> bool:
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    if "accounts.google.com" not in current_url:
        return False

    try:
        return bool(
            await page.evaluate(
                """() => {
                    const el = document.querySelector('#submit_approve_access button, #submit_approve_access');
                    if (el && el.offsetParent !== null) { el.click(); return true; }
                    const keywords = ['continue','allow','lanjut','продолжить','разрешить','продовжити','дозволити',
                        'weiter','erlauben','continuer','autoriser','continuar','permitir','続行','허용','继续','允许'];
                    for (const btn of document.querySelectorAll('button, div[role="button"]')) {
                        const txt = (btn.textContent || '').trim().toLowerCase();
                        if (!txt || btn.offsetParent === null) continue;
                        if (keywords.some(k => txt.includes(k))) { btn.click(); return true; }
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _handle_google_account_chooser(page: Any, email: str) -> bool:
    try:
        current_url = page.url
    except Exception:
        current_url = ""

    url_lower = current_url.lower()
    if "accounts.google.com" not in url_lower:
        return False

    chooser_patterns = [
        "accountchooser",
        "oauthchooseaccount",
        "selectaccount",
        "/chooser",
    ]
    if not any(pattern in url_lower for pattern in chooser_patterns):
        return False

    try:
        result = await page.evaluate(
            """(targetEmail) => {
                const normalizedEmail = String(targetEmail || '').trim().toLowerCase();
                const isVisible = (el) => {
                    if (!el) return false;
                    const rect = el.getBoundingClientRect();
                    return el.offsetParent !== null && rect.width > 0 && rect.height > 0;
                };
                const walkText = (el) => String(el?.innerText || el?.textContent || '').trim();
                const blockedPhrases = [
                    'use another account',
                    'gunakan akun lain',
                    'pakai akun lain',
                    'add account',
                    'tambahkan akun',
                ];
                const matchesBlockedPhrase = (text) => {
                    const normalizedText = String(text || '').trim().toLowerCase();
                    return blockedPhrases.some((phrase) => normalizedText.includes(phrase));
                };
                const chooserRoot = (() => {
                    const headingCandidates = Array.from(document.querySelectorAll('h1, h2, [role="heading"]'));
                    const chooserHeading = headingCandidates.find((el) => {
                        const text = walkText(el).toLowerCase();
                        return text.includes('choose an account') || text.includes('pilih akun');
                    });
                    if (chooserHeading) {
                        return (
                            chooserHeading.closest('[role="main"], main, form, section, div[data-view-id]') ||
                            chooserHeading.parentElement ||
                            document.body
                        );
                    }
                    return document.querySelector('[role="main"], main, form') || document.body;
                })();
                const clickTarget = (el) => {
                    if (!el) return false;
                    const target =
                        el.closest(
                            '[data-identifier], [data-email], div.BHzsHc, li[role="link"], div[role="link"], [role="listitem"], li, a, button, [role="button"]'
                        ) || el;
                    if (!isVisible(target)) return false;
                    try {
                        target.scrollIntoView({ block: 'center', inline: 'center' });
                    } catch (_) {}
                    try {
                        target.click();
                    } catch (_) {}
                    try {
                        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    } catch (_) {}
                    return true;
                };

                const rawCandidates = Array.from(
                    chooserRoot.querySelectorAll(
                        [
                            'div[data-identifier]',
                            'div[data-email]',
                            'li[data-identifier]',
                            'li[data-email]',
                            'div.BHzsHc',
                            'li[role="link"]',
                            'div[role="link"]',
                            '[role="listitem"]',
                        ].join(', ')
                    )
                );
                const accountCandidates = [];
                for (const candidate of rawCandidates) {
                    if (!isVisible(candidate)) continue;
                    const rect = candidate.getBoundingClientRect();
                    const looksLikeHeaderChip =
                        rect.top < 120 &&
                        rect.right > window.innerWidth * 0.55 &&
                        !candidate.closest('[role="main"], main, form');
                    if (looksLikeHeaderChip) continue;
                    if (candidate.closest('header')) continue;
                    const text = walkText(candidate);
                    if (matchesBlockedPhrase(text)) continue;
                    if (!chooserRoot.contains(candidate)) continue;

                    const identifier =
                        String(candidate.getAttribute('data-identifier') || '')
                        || String(candidate.getAttribute('data-email') || '')
                        || (() => {
                            const emailNode = candidate.querySelector('[data-identifier], [data-email]');
                            if (!emailNode) return '';
                            return String(emailNode.getAttribute('data-identifier') || emailNode.getAttribute('data-email') || '');
                        })();

                    const normalizedIdentifier = identifier.trim().toLowerCase();
                    const emailLikeText = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/ig) || [];
                    const textHasTarget = normalizedEmail && text.toLowerCase().includes(normalizedEmail);
                    const emailMatch = normalizedEmail && (
                        normalizedIdentifier === normalizedEmail
                        || emailLikeText.some((value) => String(value).trim().toLowerCase() === normalizedEmail)
                        || textHasTarget
                    );

                    if (normalizedIdentifier || emailLikeText.length || textHasTarget) {
                        accountCandidates.push({
                            element: candidate,
                            emailMatch,
                            normalizedIdentifier,
                            text,
                            top: rect.top || 0,
                        });
                    }
                }

                accountCandidates.sort((a, b) => a.top - b.top);
                const matchingCandidate = accountCandidates.find((candidate) => candidate.emailMatch);
                if (matchingCandidate) {
                    return clickTarget(matchingCandidate.element)
                        ? 'matched'
                        : '';
                }

                if (accountCandidates.length === 1) {
                    return clickTarget(accountCandidates[0].element)
                        ? 'single'
                        : '';
                }

                return '';
            }""",
            email,
        )
        if result:
            _kiro_auth_debug(f"account chooser clicked mode={result}")
        return bool(result)
    except Exception as exc:
        _kiro_auth_debug(f"account chooser handler error err={exc}")
        return False


def _should_probe_google_account_chooser(
    current_host: str,
    current_url: str,
    now: float,
    deadline: float,
) -> bool:
    normalized_host = str(current_host or "").strip().lower()
    normalized_url = str(current_url or "").strip().lower()
    if "accounts.google.com" not in normalized_host:
        return False
    # Match all known account chooser URL patterns
    chooser_patterns = [
        "accountchooser",
        "oauthchooseaccount",
        "selectaccount",
        "/chooser",
    ]
    if any(pattern in normalized_url for pattern in chooser_patterns):
        return True
    return now < deadline


async def _detect_google_blocking_challenge(page: Any) -> str | None:
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
                    const markers = [
                        'captcha',
                        'try again later',
                        'this browser or app may not be secure',
                        'this browser may not be secure',
                        'unusual traffic',
                        "verify it's you",
                        'verify it’s you',
                        "confirm it's you",
                        'confirm it’s you',
                    ];
                    for (const candidate of markers) {
                        if (text.includes(candidate)) return candidate;
                    }
                    if ((window.location.pathname || '').includes('/challenge/')) {
                        return 'google challenge';
                    }
                    return '';
                }"""
            )
        ).strip()
        return marker or None
    except Exception:
        return None


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
            "provider": "kiro",
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
        # Operator opted out of manual captcha handling. Emit error event
        # only so the batch logs explain the failure, then bail with False —
        # the adapter raises browser_challenge_blocked from there.
        callback = session.get("manual_challenge_callback")
        if callable(callback):
            result = callback(
                {
                    "type": "error",
                    "provider": "kiro",
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
        f"Google captcha detected — enter the text within {int(timeout_seconds)}s to continue",
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
                        "provider": "kiro",
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


async def _poll_kiro_callback(page: Any, session: dict[str, Any]) -> str | None:
    code = str(session.get("auth_code") or "").strip()
    if code:
        return code
    try:
        current_url = page.url
    except Exception:
        return None
    extracted = _extract_code_from_kiro_url(current_url)
    if extracted:
        session["auth_code"] = extracted
        return extracted
    return None


