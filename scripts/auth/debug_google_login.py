"""Debug Google login step by step. No retry, no abstraction.

Goes through: GitLab sign_up → click Google → fill email → see what page comes
next → fill password → see what page comes next. Logs every URL change,
every input typed length, every button text we see.

Usage:
    .venv/bin/python debug_google_login.py <email> <password>
"""
from __future__ import annotations
import asyncio, os, sys, time
from pathlib import Path
from camoufox.async_api import AsyncCamoufox
from browserforge.fingerprints import Screen

DEBUG_DIR = Path("/tmp/duo-debug")
DEBUG_DIR.mkdir(parents=True, exist_ok=True)
SIGN_UP_URL = "https://gitlab.com/users/sign_up"


def log(m): print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)
async def snap(p, l):
    path = DEBUG_DIR / f"glogin-{int(time.time()*1000)}-{l}.png"
    try: await p.screenshot(path=str(path)); log(f"  📸 {path.name}")
    except Exception as e: log(f"  ⚠️ {e}")


async def dump_buttons(page, label):
    """Log every visible button/role=button text on the page."""
    try:
        btns = await page.evaluate("""() => {
            const out = [];
            for (const el of document.querySelectorAll('button, div[role="button"], input[type="submit"]')) {
                if (el.offsetParent === null) continue;
                const txt = (el.textContent || el.value || '').trim().slice(0, 60);
                const id = el.id ? `#${el.id}` : '';
                const tag = el.tagName.toLowerCase();
                out.push(`${tag}${id}: "${txt}"`);
            }
            return out;
        }""")
        log(f"  visible buttons ({label}): {btns}")
    except Exception as e:
        log(f"  button dump failed: {e}")


async def dump_inputs(page, label):
    try:
        inps = await page.evaluate("""() => {
            const out = [];
            for (const el of document.querySelectorAll('input')) {
                if (el.offsetParent === null) continue;
                const id = el.id ? `#${el.id}` : '';
                const name = el.name ? `[name=${el.name}]` : '';
                const type = el.type || '';
                const val_len = (el.value || '').length;
                out.push(`input${id}${name} type=${type} val_len=${val_len}`);
            }
            return out;
        }""")
        log(f"  visible inputs ({label}): {inps}")
    except Exception as e:
        log(f"  input dump failed: {e}")


async def main(email, password):
    log(f"Email: {email}")
    log(f"Password length: {len(password)}")

    proxy = os.getenv("BATCHER_PROXY_URL") or None
    manager = AsyncCamoufox(
        headless=False, humanize=True, os=("windows",),
        screen=Screen(max_width=1920, max_height=1080),
        proxy={"server": proxy} if proxy else None,
        i_know_what_im_doing=True,
    )
    browser = await manager.__aenter__()
    try:
        page = await browser.new_page()

        # === STEP 1: GitLab sign_up ===
        log(f"→ goto {SIGN_UP_URL}")
        await page.goto(SIGN_UP_URL, wait_until="domcontentloaded", timeout=60_000)
        await asyncio.sleep(3)
        log(f"  URL={page.url}")
        log(f"  TITLE={await page.title()!r}")
        await snap(page, "01-signup")

        # === STEP 2: Click Google button ===
        log("→ Clicking Google sign-in button...")
        try:
            await page.locator('button[data-provider="google_oauth2"]').first.click(no_wait_after=True)
            log("  clicked")
        except Exception as e:
            log(f"  CLICK FAILED: {e}")
            return 1

        # Wait for redirect to Google
        try:
            await page.wait_for_url("**accounts.google.com/**", timeout=20_000)
            log(f"  redirected to: {page.url}")
        except Exception as e:
            log(f"  did not reach Google: {e}; current url={page.url}")
            return 2

        await asyncio.sleep(2)
        log(f"  URL={page.url}")
        log(f"  TITLE={await page.title()!r}")
        await snap(page, "02-google-arrived")
        await dump_inputs(page, "02-google-arrived")
        await dump_buttons(page, "02-google-arrived")

        # === STEP 3: Email step ===
        log("→ Email step")
        try:
            await page.locator('#identifierId').first.wait_for(state="visible", timeout=15_000)
            log("  #identifierId visible")
        except Exception as e:
            log(f"  #identifierId not visible: {e}")
            return 3

        loc = page.locator('#identifierId').first
        await loc.click(force=True)
        await asyncio.sleep(0.3)
        log(f"  typing email char by char (len={len(email)})...")
        await loc.press_sequentially(email, delay=70)
        await asyncio.sleep(0.5)

        val = await loc.input_value()
        log(f"  typed value length: {len(val)} (matches: {val == email})")
        await snap(page, "03-email-typed")

        # Click Next
        log("→ Clicking #identifierNext...")
        clicked = await page.evaluate("""() => {
            const btn = document.querySelector('#identifierNext button, #identifierNext');
            if (!btn || btn.offsetParent === null) return false;
            btn.click();
            return true;
        }""")
        log(f"  clicked: {clicked}")
        await snap(page, "04-after-email-next")

        # Wait for transition: password input visible OR url change
        log("→ Waiting for password input to appear (up to 20s)...")
        for i in range(20):
            await asyncio.sleep(1)
            try:
                pw_visible = await page.evaluate("""() => {
                    const el = document.querySelector('input[type="password"], input[name="Passwd"]');
                    return el && el.offsetParent !== null;
                }""")
                if pw_visible:
                    log(f"  ✓ password input visible after {i+1}s")
                    break
                if i in (3, 7, 12):
                    log(f"  t+{i+1}s: url={page.url}")
                    await dump_inputs(page, f"wait-pw-{i+1}s")
            except Exception as e:
                log(f"  poll error: {e}")
        else:
            log("  ❌ password input NEVER appeared in 20s")
            log(f"  final url: {page.url}")
            log(f"  final title: {await page.title()!r}")
            await snap(page, "05-no-password")
            await dump_inputs(page, "no-password")
            await dump_buttons(page, "no-password")
            await asyncio.sleep(15)
            return 4

        await snap(page, "05-password-step")
        log(f"  URL={page.url}")
        log(f"  TITLE={await page.title()!r}")
        await dump_inputs(page, "password-step")

        # === STEP 4: Password step ===
        log("→ Password step")
        try:
            pw_loc = page.locator('input[name="Passwd"], input[type="password"]').first
            await pw_loc.wait_for(state="visible", timeout=10_000)
            await pw_loc.click(force=True)
            await asyncio.sleep(0.3)
            log(f"  typing password char by char (len={len(password)})...")
            await pw_loc.press_sequentially(password, delay=70)
            await asyncio.sleep(0.5)
            val = await pw_loc.input_value()
            log(f"  typed value length: {len(val)} (matches: {len(val) == len(password)})")
            await snap(page, "06-password-typed")
        except Exception as e:
            log(f"  password type failed: {e}")
            await snap(page, "06-pw-fail")
            return 5

        # Click password Next
        log("→ Clicking #passwordNext...")
        clicked = await page.evaluate("""() => {
            const btn = document.querySelector('#passwordNext button, #passwordNext');
            if (!btn || btn.offsetParent === null) return false;
            btn.click();
            return true;
        }""")
        log(f"  clicked: {clicked}")
        await asyncio.sleep(3)
        log(f"  URL={page.url}")
        log(f"  TITLE={await page.title()!r}")
        await snap(page, "07-after-password-next")

        # Wait for outcome
        log("→ Waiting for outcome (up to 60s)...")
        last_url = ""
        for i in range(60):
            await asyncio.sleep(1)
            url = page.url
            if url != last_url:
                log(f"  t+{i+1}s URL CHANGED: {url}")
                last_url = url
            if "gitlab.com" in url and "accounts.google" not in url:
                log(f"  ✅ RETURNED TO GITLAB after {i+1}s: {url}")
                await snap(page, "08-gitlab-returned")
                await asyncio.sleep(20)
                return 0
            if i in (5, 15, 30):
                await snap(page, f"08-poll-{i+1}s")
                await dump_buttons(page, f"poll-{i+1}s")

        log("  ❌ Did not return to GitLab in 60s")
        await snap(page, "09-final-stuck")
        await dump_buttons(page, "final-stuck")
        await asyncio.sleep(20)
        return 6

    finally:
        log("Closing in 5s")
        await asyncio.sleep(5)
        try: await manager.__aexit__(None, None, None)
        except Exception: pass


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: debug_google_login.py <email> <password>")
        sys.exit(1)
    sys.exit(asyncio.run(main(sys.argv[1], sys.argv[2])))
