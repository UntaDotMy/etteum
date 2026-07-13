#!/usr/bin/env python3
"""Unit tests for pure farm helpers (no Camoufox / no network)."""
from __future__ import annotations

import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path

# Allow `python -m unittest` from repo root
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import farm_helpers as fh  # noqa: E402


class TestProxyNormalize(unittest.TestCase):
    def test_scheme_passthrough(self):
        self.assertEqual(
            fh.normalize_proxy_url("http://u:p@h:8080"),
            "http://u:p@h:8080",
        )

    def test_host_port(self):
        self.assertEqual(fh.normalize_proxy_url("1.2.3.4:8080"), "http://1.2.3.4:8080")

    def test_reseller_format(self):
        self.assertEqual(
            fh.normalize_proxy_url("host.com:9999:user:pass:with:colons"),
            "http://user:pass:with:colons@host.com:9999",
        )

    def test_user_pass_at(self):
        self.assertEqual(
            fh.normalize_proxy_url("user:pass@host:3128"),
            "http://user:pass@host:3128",
        )

    def test_reject_bare_host(self):
        self.assertIsNone(fh.normalize_proxy_url("onlyhost"))

    def test_parse_entry_with_id(self):
        url, pid = fh.parse_proxy_entry("http://h:1#nodeA")
        self.assertEqual(url, "http://h:1")
        self.assertEqual(pid, "nodeA")

    def test_playwright_dict(self):
        d = fh.parse_proxy_for_playwright("http://u:p@h:8080")
        self.assertEqual(d["server"], "http://h:8080")
        self.assertEqual(d["username"], "u")
        self.assertEqual(d["password"], "p")


class TestOtp(unittest.TestCase):
    def test_plausible_mixed(self):
        self.assertTrue(fh.is_plausible_xai_otp("K35-1QR"))

    def test_plausible_alpha(self):
        self.assertTrue(fh.is_plausible_xai_otp("WGJ-HKA"))

    def test_reject_css(self):
        self.assertFalse(fh.is_plausible_xai_otp("PER-100"))
        self.assertFalse(fh.is_plausible_xai_otp("RGB-255"))

    def test_extract_from_subject(self):
        code = fh.extract_xai_code("K35-1QR xAI confirmation code", "")
        self.assertEqual(code, "K35-1QR")

    def test_extract_skips_css_in_body(self):
        body = "<style>.x{margin:PER-100}</style> Your code is Y34-FHY thanks"
        code = fh.extract_xai_code("xAI confirmation code", body)
        self.assertEqual(code, "Y34-FHY")


class TestJwtAndCredits(unittest.TestCase):
    def test_decode_claims(self):
        payload = base64.urlsafe_b64encode(
            json.dumps({"sub": "abc12345xyz", "scope": "openid grok-cli:access"}).encode()
        ).decode().rstrip("=")
        token = f"hdr.{payload}.sig"
        claims = fh.decode_access_jwt_claims(token)
        self.assertEqual(claims.get("sub"), "abc12345xyz")
        bits = fh.claim_bits(token)
        self.assertTrue(any("scopes=ok" in b for b in bits))

    def test_email_domain(self):
        self.assertEqual(fh.email_domain("a@B.COM"), "b.com")
        self.assertEqual(fh.email_domain("bad"), "")


class TestBatchMeta(unittest.TestCase):
    def test_finalize_interrupted(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "batch_meta.json"
            p.write_text('{"batch_id":"t1","max_accounts":5}\n', encoding="utf-8")
            meta = fh.finalize_batch_meta(
                p,
                created=2,
                failed=1,
                elapsed_s=42,
                interrupted=True,
            )
            self.assertTrue(meta["interrupted"])
            self.assertEqual(meta["status"], "interrupted")
            self.assertEqual(meta["created"], 2)
            self.assertEqual(meta["failed"], 1)
            self.assertIn("finished_at", meta)
            # original fields preserved
            self.assertEqual(meta["batch_id"], "t1")


if __name__ == "__main__":
    unittest.main()
