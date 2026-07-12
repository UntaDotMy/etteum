from __future__ import annotations

import base64
import hashlib
import json
import os
import random
import secrets
import time
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import aiohttp


def _kiro_auth_debug_enabled() -> bool:
    return os.getenv("BATCHER_KIRO_AUTH_DEBUG", "false").lower() == "true"


def _kiro_auth_debug(message: str) -> None:
    if _kiro_auth_debug_enabled():
        print(f"[kiro-auth] {message}", flush=True)


from ._config import (
    _SSL_CTX,
    KIRO_REFRESH_ENDPOINT,
    KIRO_REGION,
    KIRO_USAGE_ENDPOINT,
    KIRO_CLIENT_OS_POOL,
    KIRO_FALLBACK_USER_AGENTS,
)


def _generate_pkce_pair() -> tuple[str, str]:
    code_verifier = secrets.token_urlsafe(32)
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge


def _extract_code_from_kiro_url(url: str) -> str | None:
    if not url.startswith("kiro://"):
        return None
    params = parse_qs(urlparse(url).query)
    values = params.get("code")
    if not values:
        return None
    return values[0]


def _map_kiro_region(region: str) -> str:
    mapping = {
        "us-east-1": "us-east-1",
        "us-west-1": "us-east-1",
        "us-west-2": "us-east-1",
        "eu-west-1": "us-east-1",
        "eu-central-1": "us-east-1",
        "ap-southeast-1": "us-east-1",
        "ap-southeast-2": "us-east-1",
        "ap-northeast-1": "us-east-1",
    }
    normalized = str(region or "").strip().lower()
    if not normalized:
        return "us-east-1"
    return mapping.get(normalized, "us-east-1")


def _build_kiro_usage_url(profile_arn: str) -> str:
    if os.getenv("BATCHER_KIRO_USAGE_ENDPOINT"):
        base = KIRO_USAGE_ENDPOINT
    else:
        base = f"https://q.{_map_kiro_region(KIRO_REGION)}.amazonaws.com/getUsageLimits"

    params = ["origin=AI_EDITOR", "resourceType=AGENTIC_REQUEST"]
    if profile_arn:
        params.append(f"profileArn={quote(profile_arn, safe='')}")
    separator = "&" if "?" in base else "?"
    return base + separator + "&".join(params)


def _normalize_kiro_client_os(value: str) -> str:
    normalized = str(value or "").strip().lower()
    aliases = {
        "windows": "windows",
        "win": "windows",
        "mac": "macos",
        "macos": "macos",
        "osx": "macos",
        "darwin": "macos",
        "linux": "linux",
        "lin": "linux",
    }
    return aliases.get(normalized, "")


def _fallback_kiro_user_agent(client_os: str) -> str:
    normalized = _normalize_kiro_client_os(client_os)
    if normalized and normalized in KIRO_FALLBACK_USER_AGENTS:
        return KIRO_FALLBACK_USER_AGENTS[normalized]
    return KIRO_FALLBACK_USER_AGENTS["windows"]


def _select_kiro_client_os() -> str:
    forced = _normalize_kiro_client_os(os.getenv("BATCHER_KIRO_CLIENT_OS", ""))
    if forced:
        return forced

    raw_pool = os.getenv("BATCHER_KIRO_CLIENT_OS_POOL", "")
    if raw_pool:
        pool = [
            normalized
            for normalized in (
                _normalize_kiro_client_os(item) for item in raw_pool.split(",")
            )
            if normalized
        ]
        if pool:
            return random.choice(pool)

    return random.choice(KIRO_CLIENT_OS_POOL)


async def _capture_page_user_agent(page: Any) -> str:
    try:
        return str(await page.evaluate("() => navigator.userAgent")).strip()
    except Exception:
        return ""


def _session_user_agent(session: Any) -> str:
    if isinstance(session, dict):
        user_agent = str(session.get("user_agent") or "").strip()
        if user_agent:
            return user_agent
        return _fallback_kiro_user_agent(str(session.get("client_os") or ""))
    return _fallback_kiro_user_agent("")


def _parse_kiro_usage_payload(payload: dict[str, Any]) -> dict[str, Any]:
    usage_breakdown = payload.get("usageBreakdownList") or []
    if not usage_breakdown:
        return {"limit": 0.0, "remaining": 0.0}

    usage = usage_breakdown[0] or {}
    subscription_type = str(
        payload.get("subscriptionType") or payload.get("subscription_type") or ""
    ).strip()
    subscription_title = str(
        payload.get("subscriptionTitle") or payload.get("subscription_title") or ""
    ).strip()
    subscription_info = payload.get("subscriptionInfo") or payload.get("subscription_info") or {}
    subscription_info_title = str(
        (subscription_info or {}).get("subscriptionTitle")
        or (subscription_info or {}).get("subscription_title")
        or ""
    ).strip()
    subscription_info_type = str((subscription_info or {}).get("type") or "").strip()
    usage_limit = float(usage.get("usageLimit") or 0)
    current_usage = float(usage.get("currentUsage") or 0)
    extra_bonus_credits = 0.0
    extra_bonus_usage = 0.0
    free_trial_limit = 0.0
    free_trial_usage = 0.0
    free_trial_status = str(
        ((usage.get("freeTrialInfo") or {}).get("freeTrialStatus")) or ""
    ).strip()
    total_credits = usage_limit
    total_usage = current_usage

    free_trial = usage.get("freeTrialInfo") or {}
    if str(free_trial.get("freeTrialStatus") or "").upper() == "ACTIVE":
        free_trial_limit = float(free_trial.get("usageLimit") or 0)
        free_trial_usage = float(free_trial.get("currentUsage") or 0)
        total_credits += free_trial_limit
        total_usage += free_trial_usage

    for bonus in usage.get("bonuses") or []:
        extra_bonus_credits += float((bonus or {}).get("usageLimit") or 0)
        extra_bonus_usage += float((bonus or {}).get("currentUsage") or 0)

    total_credits += extra_bonus_credits
    total_usage += extra_bonus_usage

    remaining = total_credits - total_usage
    if remaining < 0:
        remaining = 0.0
    bonus_credits = free_trial_limit + extra_bonus_credits
    account_tier = (
        subscription_info_title
        or subscription_title
        or subscription_info_type
        or subscription_type
        or "free"
    )
    return {
        "subscription_type": subscription_type,
        "subscription_title": subscription_title or subscription_info_title,
        "subscription_info_type": subscription_info_type,
        "account_tier": account_tier,
        "limit": total_credits,
        "total_credits": total_credits,
        "remaining": remaining,
        "remaining_credits": remaining,
        "subscription_credits": usage_limit,
        "bonus_credits": bonus_credits,
        "usage_limit": usage_limit,
        "current_usage": current_usage,
        "total_usage": total_usage,
        "free_trial_status": free_trial_status,
        "free_trial_limit": free_trial_limit,
        "free_trial_usage": free_trial_usage,
        "days_until_reset": int(
            payload.get("daysUntilReset") or payload.get("days_until_reset") or 0
        ),
        "next_reset_date": payload.get("nextResetDate")
        or payload.get("next_reset_date"),
    }


async def _refresh_kiro_access_token(tokens: dict[str, str]) -> dict[str, str] | None:
    refresh_token = str(tokens.get("refresh_token") or "").strip()
    if not refresh_token:
        return None

    try:
        timeout = aiohttp.ClientTimeout(total=20)
        async with aiohttp.ClientSession(timeout=timeout) as client:
            async with client.post(
                KIRO_REFRESH_ENDPOINT,
                json={"refreshToken": refresh_token},
                headers={"Content-Type": "application/json"},
                ssl=_SSL_CTX,
            ) as resp:
                body = await resp.text()
                if resp.status != 200:
                    _kiro_auth_debug(
                        f"refresh failed status={resp.status} body={body[:200]}"
                    )
                    return None
                payload = json.loads(body)
    except Exception as exc:
        _kiro_auth_debug(f"refresh request error={exc}")
        return None

    access_token = str(payload.get("accessToken") or "").strip()
    if not access_token:
        return None

    tokens["access_token"] = access_token
    next_refresh = str(payload.get("refreshToken") or "").strip()
    if next_refresh:
        tokens["refresh_token"] = next_refresh
    if payload.get("expiresIn") is not None:
        tokens["expires_in"] = str(payload.get("expiresIn"))
    if payload.get("expiresAt") is not None:
        tokens["expires_at"] = str(payload.get("expiresAt"))
    return tokens


