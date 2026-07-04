"""
Kiro Pro provider adapter — separate bot from Kiro Free.

Features:
- Login and token fetch only (upgrade disabled)
- Browser automation pending nodriver migration
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from typing import Any
from urllib.parse import urlencode

from app.providers.kiro import (
    KiroProviderAdapter,
    KIRO_LOGIN_ENDPOINT,
    KIRO_REDIRECT_URI,
    _generate_pkce_pair,
    _kiro_auth_debug,
)
from app.providers.base import NormalizedAccount


def _emit(data: dict) -> None:
    try:
        print(json.dumps(data), flush=True)
    except BrokenPipeError:
        pass


def _debug(msg: str) -> None:
    _kiro_auth_debug(msg)


class KiroProProviderAdapter(KiroProviderAdapter):
    name = "kiro-pro"

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        from app.providers.browser_utils import raise_browser_unavailable
        raise_browser_unavailable("kiro-pro")

    async def fetch_tokens(
        self,
        account: NormalizedAccount,
        auth_state: dict[str, Any],
        session: Any = None,
    ) -> dict[str, str]:
        # Get tokens from parent (HTTP token exchange, doesn't need browser)
        return await super().fetch_tokens(account, auth_state, session)

    async def post_login_hook(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
        existing_quota: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """Auto-upgrade to Pro tier after successful login."""
        upgrade_flag = os.getenv("BATCHER_KIRO_PRO_UPGRADE", "")
        _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_check",
               "message": f"BATCHER_KIRO_PRO_UPGRADE={upgrade_flag!r}"})
        if upgrade_flag.lower() != "true":
            return None

        from app.providers.kiro_pro_upgrade import (
            generate_stripe_url,
            run_stripe_autopay,
        )
        from app.providers.vcc_pool import VCCPool

        # Check if already Pro tier using existing quota or fresh fetch
        pre_quota = existing_quota
        if pre_quota is None:
            try:
                pre_quota = await self.fetch_quota(account, tokens, session)
            except Exception:
                pass

        if isinstance(pre_quota, dict):
            pre_tier = pre_quota.get("account_tier", "")
            if "pro" in pre_tier.lower():
                _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_complete",
                       "message": f"Already Pro tier ({pre_tier}), skipping upgrade"})
                return {
                    "upgrade_success": True,
                    "upgrade_tier": pre_tier,
                    "card_last4": "",
                    "quota": pre_quota,
                }

        _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_start",
               "message": "Starting Pro upgrade..."})

        access_token = tokens.get("access_token", "")
        profile_arn = tokens.get("profile_arn", "")

        # Step 1: Generate Stripe URL
        _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_generating_url",
               "message": "Generating Stripe checkout URL..."})
        stripe_url = await generate_stripe_url(access_token, profile_arn)
        if not stripe_url:
            return {"upgrade_success": False, "upgrade_error": "stripe_url_generation_failed"}

        _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_url_ok",
               "message": "Stripe URL obtained"})

        # Step 2: Get card from VCC pool
        pool = VCCPool.from_env()
        if pool.remaining() == 0:
            _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_no_cards",
                   "message": "No VCC cards available in pool"})
            return {"upgrade_success": False, "upgrade_error": "no_cards_available"}

        address = json.loads(os.getenv("BATCHER_BILLING_ADDRESS", "{}"))
        page = session.get("page") if isinstance(session, dict) else None
        if not page:
            return {"upgrade_success": False, "upgrade_error": "no_browser_page_for_upgrade"}

        # Step 3: Iterate cards until success or pool exhausted
        last_error = "no_cards_tried"
        for card in pool:
            card_dict = {
                "number": card.number,
                "exp_month": card.exp_month,
                "exp_year": card.exp_year,
                "cvv": card.cvv,
                "name": card.name,
            }

            success, message, card_status = await run_stripe_autopay(
                page, stripe_url, card_dict, address
            )

            _emit({"type": "upgrade_card_result", "provider": "kiro-pro",
                   "card_last4": card.last4, "card_status": card_status})

            if success:
                pool.mark_success(card)
                # Step 4: Verify Pro tier (with retry — Kiro API may take time to propagate)
                _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_verifying",
                       "message": "Payment complete, verifying Pro tier..."})
                for verify_attempt in range(5):
                    try:
                        if verify_attempt > 0:
                            await asyncio.sleep(3.0)
                        quota = await self.fetch_quota(account, tokens, session)
                        tier = (quota or {}).get("account_tier", "")
                        if "pro" in tier.lower():
                            _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_complete",
                                   "message": f"Upgraded to {tier}"})
                            return {
                                "upgrade_success": True,
                                "upgrade_tier": tier,
                                "card_last4": card.last4,
                                "quota": quota,
                            }
                    except Exception:
                        pass
                # Payment succeeded but tier not reflected yet — still count as success
                _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_complete",
                       "message": "Payment succeeded (tier propagation pending)"})
                return {
                    "upgrade_success": True,
                    "upgrade_tier": "Pro (pending)",
                    "card_last4": card.last4,
                }

            if card_status == "declined":
                pool.mark_declined(card)
                _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_card_declined",
                       "message": f"Card ****{card.last4} declined, trying next..."})
                last_error = message
                continue
            else:
                # If error suggests trying different payment method, treat as declined and try next card
                msg_lower = (message or "").lower()
                if any(kw in msg_lower for kw in ["different payment method", "try again", "processing your payment"]):
                    pool.mark_declined(card)
                    _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_card_declined",
                           "message": f"Card ****{card.last4} payment error, trying next..."})
                    last_error = message
                    continue
                last_error = message
                break

        _emit({"type": "progress", "provider": "kiro-pro", "step": "upgrade_failed",
               "message": f"Upgrade failed: {last_error}"})
        return {"upgrade_success": False, "upgrade_error": last_error}

    async def cleanup_session(self, session: Any) -> None:
        """Clean up browser session."""
        if not isinstance(session, dict):
            return
        await super().cleanup_session(session)
