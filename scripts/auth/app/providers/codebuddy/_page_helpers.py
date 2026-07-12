from __future__ import annotations

import asyncio
import hashlib
import json
import time
from pathlib import Path
from typing import Any

from ._config import (
    CODEBUDDY_BASE_URL,
    CODEBUDDY_FORCE_REGION_POST_AUTH,
    CODEBUDDY_USER_RESOURCE_ENDPOINT,
    COOKIES_DIR,
)
from ._utils import _codebuddy_auth_debug


async def _get_codebuddy_login_iframe(page: Any) -> Any | None:
    selectors = [
        'iframe[title="login-iframe"]',
        'iframe[src*="/auth/realms/copilot/protocol/openid-connect/auth"]',
    ]
    for selector in selectors:
        try:
            iframe_el = await page.query_selector(selector)
            if not iframe_el:
                continue
            frame = await iframe_el.content_frame()
            if frame is not None:
                return frame
        except Exception:
            continue
    return None


async def _handle_codebuddy_landing(page: Any) -> bool:
    frame = await _get_codebuddy_login_iframe(page)
    target = frame if frame is not None else page

    clicked_checkbox = False
    clicked_google = False
    try:
        clicked_checkbox = bool(
            await target.evaluate(
                """() => {
                    const el = document.querySelector('div.checkmark');
                    if (!el) return false;
                    if (el.offsetParent === null) return false;
                    el.click();
                    return true;
                }"""
            )
        )
    except Exception:
        pass

    try:
        clicked_google = bool(
            await target.evaluate(
                """() => {
                    const byId = document.querySelector('#social-google');
                    if (byId && byId.offsetParent !== null) {
                        byId.click();
                        return true;
                    }
                    for (const a of document.querySelectorAll('a[href*="/broker/google/login"]')) {
                        const txt = (a.textContent || '').toLowerCase();
                        if (txt.includes('google') && a.offsetParent !== null) {
                            a.click();
                            return true;
                        }
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        pass

    # If still not clicked (e.g. on home page with a top-nav Login button),
    # try to find and click a "Login" / "Sign in with Google" button visible on the page.
    if not clicked_google and not clicked_checkbox:
        try:
            clicked_google = bool(
                await page.evaluate(
                    """() => {
                        // Look for a Google sign-in button anywhere on the page
                        // Covers: "Sign in with Google", "Login with Google", etc.
                        const googlePhrases = ['sign in with google', 'login with google', 'continue with google'];
                        for (const btn of document.querySelectorAll('button, a, div[role="button"]')) {
                            if (btn.offsetParent === null) continue;
                            const txt = (btn.textContent || '').toLowerCase().trim();
                            if (googlePhrases.some(p => txt.includes(p))) {
                                btn.click();
                                return true;
                            }
                        }
                        // Also try: any Login / Sign in link that is visible in top nav
                        const loginPhrases = ['login', 'sign in', 'log in'];
                        for (const a of document.querySelectorAll('a, button')) {
                            if (a.offsetParent === null) continue;
                            const txt = (a.textContent || '').toLowerCase().trim();
                            if (loginPhrases.some(p => txt === p) || loginPhrases.some(p => txt.startsWith(p + ' '))) {
                                a.click();
                                return true;
                            }
                        }
                        return false;
                    }"""
                )
            )
        except Exception:
            pass

    return clicked_checkbox or clicked_google


async def _handle_codebuddy_email_verification(page: Any) -> bool:
    _codebuddy_auth_debug("starting email verification via Gmail (same tab)")

    verify_page_url = page.url
    _codebuddy_auth_debug(f"saved verification page URL: {verify_page_url[:100]}")

    try:
        _codebuddy_auth_debug("navigating to Gmail inbox in same tab")
        await page.goto("https://mail.google.com/mail/u/0/#inbox", wait_until="domcontentloaded", timeout=45000)
        await asyncio.sleep(5)

        gmail_url = page.url
        _codebuddy_auth_debug(f"Gmail page URL: {gmail_url[:100]}")

        if "accounts.google.com" in gmail_url:
            _codebuddy_auth_debug("Gmail redirected to Google login — session not shared, going back")
            await page.goto(verify_page_url, wait_until="domcontentloaded", timeout=15000)
            return False

        email_found = False
        for attempt in range(15):
            _codebuddy_auth_debug(f"searching for verification email (attempt {attempt+1}/15)")

            email_selectors = [
                'tr:has-text("codebuddy")',
                'tr:has-text("Verify email")',
                'tr:has-text("verify your email")',
                'span:has-text("codebuddy")',
                '[data-message-id]:has-text("codebuddy")',
                'div[role="main"] tr:has-text("copilot")',
            ]

            for sel in email_selectors:
                try:
                    el = page.locator(sel).first
                    if await el.count() > 0 and await el.is_visible():
                        _codebuddy_auth_debug(f"found email via: {sel}")
                        await el.click()
                        await asyncio.sleep(3)
                        email_found = True
                        break
                except Exception:
                    continue

            if email_found:
                break

            if attempt >= 5 and attempt % 2 == 0:
                _codebuddy_auth_debug("refreshing Gmail inbox")
                try:
                    await page.reload(wait_until="domcontentloaded", timeout=15000)
                except Exception:
                    pass
            await asyncio.sleep(4)

        if not email_found:
            _codebuddy_auth_debug("verification email not found after 15 attempts, going back")
            await page.goto(verify_page_url, wait_until="domcontentloaded", timeout=15000)
            return False

        _codebuddy_auth_debug("email thread opened, expanding latest message and extracting link")
        await asyncio.sleep(2)

        try:
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await asyncio.sleep(1)
        except Exception:
            pass

        try:
            collapsed = page.locator('div.kv, [data-message-id], div.gs')
            count = await collapsed.count()
            if count > 1:
                _codebuddy_auth_debug(f"thread has {count} messages, clicking last one to expand")
                await collapsed.nth(count - 1).click()
                await asyncio.sleep(2)
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await asyncio.sleep(1)
        except Exception as e:
            _codebuddy_auth_debug(f"expand latest message failed: {e}")

        verify_link = None

        try:
            import re
            body_html = await page.content()
            patterns = [
                r'href="(https?://[^"]*callback\.cloudses\.com/api/webhook\?upn=[^"]*)"',
                r'href="(https?://[^"]*login-actions/required-action\?session_code=[^"]*)"',
                r'href="(https?://[^"]*session_code=[^"]*)"',
                r'href="(https?://[^"]*login-actions/required-action[^"]*)"',
                r'href="(https?://www\.codebuddy\.ai/auth/[^"]*verification[^"]*)"',
            ]
            all_links = []
            for pat in patterns:
                urls = re.findall(pat, body_html)
                for u in urls:
                    cleaned = u.replace("&amp;", "&")
                    if cleaned not in all_links:
                        all_links.append(cleaned)

            if all_links:
                verify_link = all_links[-1]
                _codebuddy_auth_debug(f"found {len(all_links)} verification links, using latest")
        except Exception as e:
            _codebuddy_auth_debug(f"regex search failed: {e}")

        if not verify_link:
            link_selectors = [
                'a:has-text("Link to e-mail address verification")',
                'a:has-text("verification")',
                'a:has-text("verify")',
                'a[href*="login-actions"]',
                'a[href*="session_code"]',
            ]
            for sel in link_selectors:
                try:
                    links = page.locator(sel)
                    count = await links.count()
                    if count > 0:
                        href = await links.nth(count - 1).get_attribute("href")
                        if href and ("login-actions" in href or "session_code" in href or "webhook" in href):
                            verify_link = href.replace("&amp;", "&")
                            _codebuddy_auth_debug(f"found link via selector (last of {count}): {sel}")
                            break
                except Exception:
                    continue

        if not verify_link:
            _codebuddy_auth_debug("could not find verification link, going back")
            await page.goto(verify_page_url, wait_until="domcontentloaded", timeout=15000)
            return False

        _codebuddy_auth_debug(f"navigating to verification link: {verify_link[:80]}...")
        await page.goto(verify_link, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(3)

        final_url = page.url
        _codebuddy_auth_debug(f"verification landed at: {final_url[:100]}")

        for _ in range(5):
            try:
                page_text = await page.text_content("body")
            except Exception:
                page_text = ""

            if page_text and "click here to proceed" in page_text.lower():
                _codebuddy_auth_debug("found 'Click here to proceed' confirmation page, clicking")
                proceed_selectors = [
                    'a:has-text("Click here to proceed")',
                    'a:has-text("click here")',
                    'a:has-text("proceed")',
                    'a[href*="login-actions"]',
                ]
                clicked = False
                for sel in proceed_selectors:
                    try:
                        btn = page.locator(sel).first
                        if await btn.count() > 0 and await btn.is_visible():
                            await btn.click()
                            _codebuddy_auth_debug(f"clicked proceed via: {sel}")
                            clicked = True
                            await asyncio.sleep(3)
                            break
                    except Exception:
                        continue
                if not clicked:
                    try:
                        all_links = page.locator("a")
                        for i in range(await all_links.count()):
                            link_text = await all_links.nth(i).text_content()
                            if link_text and "proceed" in link_text.lower():
                                await all_links.nth(i).click()
                                _codebuddy_auth_debug("clicked proceed link by text scan")
                                clicked = True
                                await asyncio.sleep(3)
                                break
                    except Exception:
                        pass
                if clicked:
                    continue
            break

        final_url2 = page.url
        _codebuddy_auth_debug(f"after proceed: {final_url2[:100]}")
        _codebuddy_auth_debug("email verification complete, auth flow should continue")
        return True

    except Exception as e:
        _codebuddy_auth_debug(f"email verification failed: {e}")
        try:
            await page.goto(verify_page_url, wait_until="domcontentloaded", timeout=15000)
        except Exception:
            pass
        return False


async def _handle_google_something_went_wrong(page: Any) -> bool:
    try:
        return bool(
            await page.evaluate(
                """() => {
                    const body = document.body;
                    if (!body) return false;
                    const text = body.innerText || '';
                    if (!text.includes('Something went wrong') && !text.includes('went wrong')) return false;

                    // Try dialog/overlay elements first
                    const containers = document.querySelectorAll(
                        'div[role="dialog"], div[role="alertdialog"], div[class*="modal"], div[class*="overlay"], div[class*="popup"]'
                    );
                    for (const container of containers) {
                        for (const el of container.querySelectorAll('button, a, div[role="button"], span[role="button"]')) {
                            if (el.offsetParent === null) continue;
                            const txt = (el.textContent || '').trim().toLowerCase();
                            if (txt === 'restart' || txt === 'try again' || txt === 'retry') {
                                el.click();
                                return true;
                            }
                        }
                    }

                    // Fallback: scan entire page for restart/retry buttons
                    for (const el of document.querySelectorAll('button, a, div[role="button"], span[role="button"]')) {
                        if (el.offsetParent === null) continue;
                        const txt = (el.textContent || '').trim().toLowerCase();
                        if (txt === 'restart' || txt === 'try again' || txt === 'retry') {
                            el.click();
                            return true;
                        }
                    }

                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _handle_google_gaplustos(page: Any) -> bool:
    try:
        current_url = page.url
    except Exception:
        current_url = ""

    url_match = "/speedbump/gaplustos" in current_url
    if not url_match:
        try:
            has_element = await page.locator("#gaplustosNext").count() > 0
        except Exception:
            has_element = False
        if not has_element:
            return False

    try:
        _codebuddy_auth_debug(f"gaplustos detected url_match={url_match} url={current_url[:80]}")
        try:
            gaplustos_btn = page.locator("#gaplustosNext button")
            if await gaplustos_btn.count() > 0 and await gaplustos_btn.first.is_visible():
                _codebuddy_auth_debug("gaplustos clicking #gaplustosNext button")
                await gaplustos_btn.first.click(force=True)
                return True
        except Exception as exc:
            _codebuddy_auth_debug(f"gaplustos #gaplustosNext button click failed err={exc}")

        try:
            await page.wait_for_selector(
                '#confirm, input[name="confirm"], input[type="submit"]',
                state="visible",
                timeout=5000,
            )
        except Exception:
            pass
        selectors = ["#confirm", 'input[name="confirm"]', 'input[type="submit"]']
        for selector in selectors:
            locator = page.locator(selector).first
            try:
                if await locator.count() == 0:
                    continue
                if not await locator.is_visible():
                    continue
                value = ""
                try:
                    value = str(await locator.input_value())
                except Exception:
                    value = ""
                _codebuddy_auth_debug(
                    f"gaplustos clicking selector={selector} value={value!r}"
                )
                await locator.click(force=True)
                return True
            except Exception as exc:
                _codebuddy_auth_debug(
                    f"gaplustos click failed selector={selector} err={exc}"
                )

        clicked = bool(
            await page.evaluate(
                """() => {
                    const candidates = [
                        document.querySelector('#confirm'),
                        document.querySelector('input[name="confirm"]'),
                        ...Array.from(document.querySelectorAll('input[type="submit"], button'))
                    ];
                    const keywords = [
                        'confirm', 'understand', 'accept', 'agree', 'continue', 'ok',
                        'mengerti', 'terima',
                        'понятно', 'принимаю', 'принять', 'продолжить',
                        'entendido', 'aceptar', 'continuar',
                        'compris', 'accepter',
                        '了解', '同意', '确认', '接受',
                        '理解', '同意する', '確認',
                        '동의', '확인',
                        'verstanden', 'akzeptieren', 'zustimmen',
                        'anladım', 'kabul',
                        'entendi', 'aceitar',
                        'capisco', 'accetta',
                        'rozumiem', 'akceptuję',
                        'begrijpen', 'accepteren',
                        'เข้าใจ', 'ยอมรับ',
                        'hiểu', 'chấp nhận',
                        'فهمت', 'قبول',
                        'समझ गया', 'स्वीकार',
                    ];
                    for (const el of candidates) {
                        if (!el || el.offsetParent === null) continue;
                        const txt = (el.value || el.textContent || '').toLowerCase().trim();
                        if (keywords.some(k => txt.includes(k))) {
                            el.click();
                            return true;
                        }
                    }
                    // Last resort: click any visible submit button on gaplustos page
                    const submits = document.querySelectorAll('input[type="submit"], button[type="submit"]');
                    for (const el of submits) {
                        if (el.offsetParent !== null) {
                            el.click();
                            return true;
                        }
                    }
                    return false;
                }"""
            )
        )
        _codebuddy_auth_debug(f"gaplustos fallback clicked={clicked}")
        return clicked
    except Exception as exc:
        _codebuddy_auth_debug(f"gaplustos handler error={exc}")
        return False


async def _handle_google_consent_continue(page: Any) -> bool:
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    if "accounts.google.com" not in current_url:
        return False

    if "signin/oauth/consent" in current_url:
        _codebuddy_auth_debug("google consent detected")

    # Copied from the proven kiro handler: target the official consent submit
    # button (#submit_approve_access) first, then fall back to a multi-language
    # keyword scan. JS click only.
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


async def _handle_codebuddy_region_select(page: Any) -> bool:
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    parsed_url = urlparse(current_url) if current_url else None
    current_host = parsed_url.netloc if parsed_url else ""
    current_path = parsed_url.path if parsed_url else ""
    if current_host != urlparse(
        CODEBUDDY_BASE_URL
    ).netloc or not current_path.startswith("/register/user/complete"):
        return False

    try:
        try:
            await page.wait_for_selector(
                'div.t-input input[placeholder="Registration location"]',
                state="visible",
                timeout=2000,
            )
        except Exception:
            return False

        region_value = str(
            await page.evaluate(
                """() => {
                    const box = document.querySelector('div.t-input input[placeholder="Registration location"]');
                    if (!box || box.offsetParent === null) return '';
                    return box.value || '';
                }"""
            )
        ).strip()
        _codebuddy_auth_debug(f"region page value={region_value!r} url={current_url}")

        if region_value.lower() != "singapore":
            opened = bool(
                await page.evaluate(
                    """() => {
                        const box = document.querySelector('div.t-input input[placeholder="Registration location"]');
                        if (!box || box.offsetParent === null) return false;
                        box.click();
                        return true;
                    }"""
                )
            )
            if not opened:
                return False
            await asyncio.sleep(0.3)

            try:
                overlay_search = page.locator(
                    '.dropdown-overlay input[placeholder="Search countries"], .dropdown-search input[placeholder="Search countries"]'
                ).first
                if (
                    await overlay_search.count() > 0
                    and await overlay_search.is_visible()
                ):
                    await overlay_search.click(force=True)
                    await overlay_search.fill("Singapore")
                    await asyncio.sleep(0.25)
            except Exception:
                pass

            selected_visible = False
            option_locators = [
                page.locator(".dropdown-overlay")
                .get_by_text("Singapore", exact=True)
                .first,
                page.locator(".dropdown-overlay")
                .get_by_text("Current region Singapore", exact=False)
                .first,
                page.get_by_text("Current region Singapore", exact=False).first,
                page.get_by_text("Singapore", exact=True).first,
            ]
            for locator in option_locators:
                try:
                    if await locator.count() == 0:
                        continue
                    if not await locator.is_visible():
                        continue
                    await locator.click(force=True)
                    selected_visible = True
                    break
                except Exception:
                    continue

            if not selected_visible:
                selected_visible = bool(
                    await page.evaluate(
                        """() => {
                            const selectors = [
                                '.dropdown-overlay [role="option"]',
                                '.dropdown-overlay .dropdown-item',
                                '.dropdown-overlay li',
                                '.dropdown-overlay div',
                            ];
                            for (const sel of selectors) {
                                for (const el of document.querySelectorAll(sel)) {
                                    const txt = (el.textContent || '').toLowerCase().trim();
                                    if (!txt || el.offsetParent === null) continue;
                                    if (
                                        txt === 'singapore' ||
                                        txt.includes('singapore') ||
                                        txt.includes('current region singapore')
                                    ) {
                                        el.click();
                                        return true;
                                    }
                                }
                            }
                            return false;
                        }"""
                    )
                )
            await asyncio.sleep(0.3)

            try:
                await page.wait_for_function(
                    """() => {
                        const box = document.querySelector('div.t-input input[placeholder="Registration location"]');
                        const value = (box?.value || '').trim().toLowerCase();
                        const text = (document.body?.innerText || '').toLowerCase();
                        return value === 'singapore' || text.includes('current region singapore');
                    }""",
                    timeout=4000,
                )
            except Exception:
                pass

            region_value = str(
                await page.evaluate(
                    """() => {
                        const box = document.querySelector('div.t-input input[placeholder="Registration location"]');
                        const inputValue = box && box.offsetParent !== null ? (box.value || '') : '';
                        if (inputValue) return inputValue;
                        const text = (document.body?.innerText || '').toLowerCase();
                        if (text.includes('current region singapore')) return 'Singapore';
                        return '';
                    }"""
                )
            ).strip()
            _codebuddy_auth_debug(f"region selected value={region_value!r}")

        if region_value.lower() != "singapore":
            return False

        submitted = False
        submit_locators = [
            page.locator('button:has-text("Submit")').first,
            page.locator('[role="button"]:has-text("Submit")').first,
            page.locator('div[class*="cursor-pointer"]:has-text("Submit")').first,
            page.get_by_text("Submit", exact=True).first,
        ]
        for locator in submit_locators:
            try:
                if await locator.count() == 0:
                    continue
                if not await locator.is_visible():
                    continue
                await locator.click(force=True)
                submitted = True
                break
            except Exception:
                continue

        if not submitted:
            submitted = bool(
                await page.evaluate(
                    """() => {
                        for (const el of document.querySelectorAll('button, [role="button"], div[class*="cursor-pointer"]')) {
                            const txt = (el.textContent || '').trim().toLowerCase();
                            if (!txt || el.offsetParent === null) continue;
                            if (txt === 'submit' || txt.includes('submit')) {
                                el.click();
                                return true;
                            }
                        }
                        return false;
                    }"""
                )
            )
        _codebuddy_auth_debug(f"region submit clicked={submitted}")
        if submitted:
            redirect_uri = ""
            try:
                redirect_uri = parse_qs(urlparse(current_url).query).get(
                    "redirect_uri", [""]
                )[0]
            except Exception:
                redirect_uri = ""
            try:
                await page.wait_for_function(
                    """() => {
                        const path = window.location.pathname || '';
                        return path === '/started' || !path.startsWith('/register/user/complete');
                    }""",
                    timeout=4000,
                )
            except Exception:
                redirect_uri = str(redirect_uri or "").strip()
                if redirect_uri.startswith(CODEBUDDY_BASE_URL):
                    try:
                        _codebuddy_auth_debug(
                            f"region redirect fallback goto={redirect_uri}"
                        )
                        await page.goto(redirect_uri, wait_until="domcontentloaded")
                    except Exception as exc:
                        _codebuddy_auth_debug(
                            f"region redirect fallback failed err={exc}"
                        )
                try:
                    await page.wait_for_function(
                        """() => {
                            const path = window.location.pathname || '';
                            return path === '/started' || !path.startsWith('/register/user/complete');
                        }""",
                        timeout=10000,
                    )
                except Exception:
                    pass
        return submitted
    except Exception:
        return False


def _get_cookie_file_path(email: str) -> Path:
    """Get cookie file path for an email (hashed for privacy)"""
    email_hash = hashlib.sha256(email.encode()).hexdigest()[:16]
    return COOKIES_DIR / f"{email_hash}.json"


async def _save_cookies_to_file(page: Any, email: str) -> bool:
    """Save cookies from page to file"""
    try:
        context = page.context
        cookies = await context.cookies([CODEBUDDY_BASE_URL])
        if not cookies:
            return False

        cookie_file = _get_cookie_file_path(email)
        cookie_data = {
            "email": email,
            "saved_at": time.time(),
            "expires_at": time.time() + 3600,  # 1 hour
            "cookies": cookies,
        }

        with open(cookie_file, "w") as f:
            json.dump(cookie_data, f, indent=2)

        _codebuddy_auth_debug(f"cookies saved file={cookie_file.name}")
        return True
    except Exception as exc:
        _codebuddy_auth_debug(f"save cookies failed err={exc}")
        return False


async def _load_cookies_from_file(email: str) -> dict[str, Any] | None:
    """Load cookies from file if not expired"""
    try:
        cookie_file = _get_cookie_file_path(email)
        if not cookie_file.exists():
            return None

        with open(cookie_file, "r") as f:
            cookie_data = json.load(f)

        expires_at = cookie_data.get("expires_at", 0)
        if time.time() > expires_at:
            _codebuddy_auth_debug(f"cookies expired file={cookie_file.name}")
            cookie_file.unlink(missing_ok=True)
            return None

        _codebuddy_auth_debug(f"cookies loaded file={cookie_file.name}")
        return cookie_data
    except Exception as exc:
        _codebuddy_auth_debug(f"load cookies failed err={exc}")
        return None


async def _restore_cookies_to_page(page: Any, cookie_data: dict[str, Any]) -> bool:
    """Restore cookies to page context"""
    try:
        cookies = cookie_data.get("cookies", [])
        if not cookies:
            return False

        await page.context.add_cookies(cookies)
        _codebuddy_auth_debug("cookies restored to page")
        return True
    except Exception as exc:
        _codebuddy_auth_debug(f"restore cookies failed err={exc}")
        return False


def _build_cookie_header_from_dict(cookies: list[dict[str, Any]]) -> str:
    """Build cookie header string from cookie dict list"""
    parts: list[str] = []
    for cookie in cookies:
        name = str(cookie.get("name") or "").strip()
        value = str(cookie.get("value") or "").strip()
        if name and value:
            parts.append(f"{name}={value}")
    return "; ".join(parts)


async def _build_cookie_header_from_page(page: Any, base_url: str) -> str:
    try:
        context = page.context
        cookies = await context.cookies([base_url])
    except Exception:
        return ""

    if not cookies:
        return ""

    return _build_cookie_header_from_dict(cookies)


async def _build_codebuddy_billing_cookie_header(page: Any) -> str:
    return await _build_cookie_header_from_page(page, CODEBUDDY_USER_RESOURCE_ENDPOINT)

