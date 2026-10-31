"""IAM regressions and real finance authorization, using the same isolated PG schema."""

import os
import re
import time
from datetime import timedelta
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from cryptography.fernet import Fernet
import pyotp
from fastapi.testclient import TestClient
from backend.tests import test_finance as fixture
from backend.app.models import (
    LoginChallenge,
    SecondFactor,
    Mail,
    PasswordReset,
    now,
)


class IAMTests(fixture.DatabaseCase):
    def setUp(self):
        super().setUp()
        self.key_patch = patch.dict(
            os.environ, {"MFA_ENCRYPTION_KEY": Fernet.generate_key().decode()}
        )
        self.key_patch.start()
        self.addCleanup(self.key_patch.stop)

    def latest_code(self, email):
        with fixture.SessionLocal() as db:
            mail = (
                db.query(Mail)
                .filter(
                    Mail.recipient == email,
                    Mail.subject == "Your Brightloop sign-in code",
                )
                .order_by(Mail.created_at.desc())
                .first()
            )
            return re.search(r"sign-in code is: ([0-9]{6})", mail.body).group(1)

    def reset_link(self, email):
        response = self.client.post("/api/auth/forgot-password", json={"email": email})
        self.assertEqual(response.status_code, 200, response.text)
        with fixture.SessionLocal() as db:
            mail = (
                db.query(Mail)
                .filter(
                    Mail.recipient == email,
                    Mail.subject == "Reset your Brightloop password",
                )
                .order_by(Mail.created_at.desc())
                .first()
            )
            return re.search(r"/#reset=([^\s]+)", mail.body).group(1)

    def test_upgrade_revokes_only_legacy_sessions_and_preserves_finance(self):
        from backend.app.models import SchemaMigration
        from backend.app.migrations import migrate_iam
        from datetime import date

        self.sub()
        self.run_bill(date(2026, 1, 31))
        with fixture.SessionLocal.begin() as db:
            db.query(SchemaMigration).delete()
        migrate_iam(fixture.engine)
        self.assertEqual(self.client.get("/api/auth/me").status_code, 401)
        with fixture.SessionLocal() as db:
            self.assertEqual(db.query(fixture.Invoice).count(), 1)
        self.sign_in(self.client, "admin@test.local")
        migrate_iam(fixture.engine)
        self.assertEqual(self.client.get("/api/auth/me").status_code, 200)

    def test_signup_validation_duplicate_roles_and_no_fake_invoices(self):
        anonymous = TestClient(fixture.app)
        for email in ["not-an-email", "bad@@example.com", "bad @example.com"]:
            self.assertEqual(
                anonymous.post(
                    "/api/auth/signup",
                    json={
                        "email": email,
                        "name": "Example",
                        "password": "StrongReview!2026",
                    },
                ).status_code,
                422,
            )
        for password in [
            "Short1!",
            "aaaaaaaaaaa",
            "UPPERCASE!!",
            "lowercase!!",
            "NoSpecial1234",
        ]:
            self.assertEqual(
                anonymous.post(
                    "/api/auth/signup",
                    json={
                        "email": "new@example.com",
                        "name": "Example",
                        "password": password,
                    },
                ).status_code,
                422,
            )
        good = {
            "email": "new@example.com",
            "name": "New Customer",
            "password": "StrongReview!2026",
        }
        result = anonymous.post("/api/auth/signup", json=good)
        self.assertEqual(result.status_code, 201, result.text)
        self.assertEqual(result.json()["role"], "CUSTOMER")
        self.assertNotIn("password_hash", result.json())
        self.assertEqual(anonymous.get("/api/dashboard").status_code, 401)
        self.assertEqual(anonymous.post("/api/auth/signup", json=good).status_code, 409)
        self.assertEqual(
            anonymous.post(
                "/api/auth/signup",
                json={**good, "email": "elevated@example.com", "role": "ADMIN"},
            ).status_code,
            422,
        )
        with fixture.SessionLocal() as db:
            self.assertEqual(db.query(fixture.Invoice).count(), 0)
        anonymous.close()

    def test_password_stage_has_no_session_email_code_one_use_and_single_device(self):
        other = TestClient(fixture.app)
        login = other.post(
            "/api/auth/login",
            json={"email": "admin@test.local", "password": "Demo-only!2026"},
        )
        self.assertTrue(login.json()["require2FA"])
        self.assertEqual(login.json()["method"], "EMAIL")
        self.assertNotIn("qr_code", login.json())
        self.assertNotIn("secret", login.json())
        self.assertEqual(other.get("/api/users").status_code, 401)
        challenge = other.cookies.get("brightloop_challenge")
        code = self.latest_code("admin@test.local")
        verified = other.post("/api/auth/verify-2fa", json={"token": code})
        self.assertEqual(verified.status_code, 200, verified.text)
        self.assertNotEqual(other.cookies.get("brightloop_session"), challenge)
        self.assertIn("HttpOnly", verified.headers["set-cookie"])
        self.assertIn("SameSite=strict", verified.headers["set-cookie"])
        self.assertEqual(self.client.get("/api/users").status_code, 401)
        self.assertEqual(
            other.post("/api/auth/verify-2fa", json={"token": code}).status_code, 401
        )
        self.assertEqual(other.get("/api/users").status_code, 200)
        other.post("/api/auth/logout")
        self.assertEqual(other.get("/api/users").status_code, 401)
        other.close()

    def test_attempt_limits_persist_and_expiry_is_enforced(self):
        client = TestClient(fixture.app)
        client.post(
            "/api/auth/login",
            json={"email": "other@test.local", "password": "Demo-only!2026"},
        )
        actual = self.latest_code("other@test.local")
        wrong = "000000" if actual != "000000" else "111111"
        for _ in range(5):
            self.assertEqual(
                client.post("/api/auth/verify-2fa", json={"token": wrong}).status_code,
                400,
            )
        self.assertEqual(
            client.post("/api/auth/verify-2fa", json={"token": actual}).status_code, 429
        )
        with fixture.SessionLocal.begin() as db:
            challenge = (
                db.query(LoginChallenge)
                .filter(LoginChallenge.user_id == self.other_id)
                .one()
            )
            self.assertEqual(challenge.attempts, 5)
            challenge.expires_at = now() - timedelta(seconds=1)
        self.assertEqual(
            client.post("/api/auth/verify-2fa", json={"token": actual}).status_code, 401
        )
        self.assertEqual(
            client.post("/api/auth/verify-2fa", json={"token": "١٢٣٤٥٦"}).status_code,
            422,
        )
        for _ in range(10):
            self.assertEqual(
                client.post(
                    "/api/auth/login",
                    json={"email": "missing@test.local", "password": "Wrong!password"},
                ).status_code,
                401,
            )
        self.assertEqual(
            client.post(
                "/api/auth/login",
                json={"email": "missing@test.local", "password": "Wrong!password"},
            ).status_code,
            429,
        )
        client.close()

    def test_password_reset_revokes_sessions_and_pending_challenges_and_token_replay(
        self,
    ):
        pending = TestClient(fixture.app)
        pending.post(
            "/api/auth/login",
            json={"email": "admin@test.local", "password": "Demo-only!2026"},
        )
        old_code = self.latest_code("admin@test.local")
        token = self.reset_link("admin@test.local")
        reset = TestClient(fixture.app)
        self.assertEqual(
            reset.post(
                "/api/auth/reset-password", json={"token": token, "password": "weak"}
            ).status_code,
            422,
        )
        good = {"token": token, "password": "ChangedReview!2026"}
        self.assertEqual(
            reset.post("/api/auth/reset-password", json=good).status_code, 200
        )
        self.assertEqual(self.client.get("/api/users").status_code, 401)
        self.assertEqual(
            pending.post("/api/auth/verify-2fa", json={"token": old_code}).status_code,
            401,
        )
        self.assertEqual(
            reset.post("/api/auth/reset-password", json=good).status_code, 400
        )
        self.assertEqual(
            reset.post(
                "/api/auth/login",
                json={"email": "admin@test.local", "password": "Demo-only!2026"},
            ).status_code,
            401,
        )
        self.sign_in(reset, "admin@test.local", "ChangedReview!2026")
        pending.close()
        reset.close()

    def test_reset_tokens_expire_are_hashed_and_forgot_does_not_enumerate(self):
        token = self.reset_link("other@test.local")
        with fixture.SessionLocal.begin() as db:
            item = (
                db.query(PasswordReset)
                .filter(PasswordReset.user_id == self.other_id)
                .one()
            )
            self.assertNotEqual(item.token_hash, token)
            item.expires_at = now() - timedelta(seconds=1)
        self.assertEqual(
            self.client.post(
                "/api/auth/reset",
                json={"token": token, "password": "ChangedReview!2026"},
            ).status_code,
            400,
        )
        known = self.client.post(
            "/api/auth/forgot", json={"email": "other@test.local"}
        ).json()
        missing = self.client.post(
            "/api/auth/forgot", json={"email": "missing@test.local"}
        ).json()
        self.assertEqual(known, missing)

    def test_authenticator_enrollment_no_secret_redisclosure_and_replay(self):
        setup = self.client.post(
            "/api/auth/2fa/setup", json={"password": "Demo-only!2026"}
        )
        self.assertEqual(setup.status_code, 200, setup.text)
        secret = setup.json()["secret"]
        self.assertTrue(
            setup.json()["qr_code"].startswith("data:image/svg+xml;base64,")
        )
        with fixture.SessionLocal() as db:
            self.assertNotIn(
                secret, db.get(SecondFactor, self.admin_id).pending_encrypted
            )
        step = int(time.time()) // 30
        with patch("backend.app.iam.time.time", return_value=step * 30 + 1):
            code = pyotp.TOTP(secret).at(step * 30)
            self.assertEqual(
                self.client.post(
                    "/api/auth/2fa/enable", json={"token": code}
                ).status_code,
                200,
            )
        with fixture.SessionLocal() as db:
            factor = db.get(SecondFactor, self.admin_id)
            self.assertTrue(factor.enabled)
            self.assertNotIn(secret, factor.secret_encrypted)
            self.assertIsNone(factor.pending_encrypted)
        self.assertEqual(
            self.client.post(
                "/api/auth/2fa/setup", json={"password": "Demo-only!2026"}
            ).status_code,
            409,
        )
        fresh = TestClient(fixture.app)
        response = fresh.post(
            "/api/auth/login",
            json={"email": "admin@test.local", "password": "Demo-only!2026"},
        )
        self.assertEqual(response.json()["method"], "TOTP")
        for name in ["secret", "qrCode", "qr_code", "otpauth_uri"]:
            self.assertNotIn(name, response.json())
        with patch("backend.app.iam.time.time", return_value=step * 30 + 1):
            self.assertEqual(
                fresh.post("/api/auth/verify-2fa", json={"token": code}).status_code,
                400,
            )
        with patch("backend.app.iam.time.time", return_value=(step + 1) * 30 + 1):
            next_code = pyotp.TOTP(secret).at((step + 1) * 30)
            self.assertEqual(
                fresh.post(
                    "/api/auth/verify-2fa", json={"token": next_code}
                ).status_code,
                200,
            )
        self.assertTrue(fresh.get("/api/auth/me").json()["two_factor_enabled"])
        with patch("backend.app.iam.time.time", return_value=(step + 2) * 30 + 1):
            disable = fresh.post(
                "/api/auth/2fa/disable",
                json={
                    "password": "Demo-only!2026",
                    "token": pyotp.TOTP(secret).at((step + 2) * 30),
                },
            )
            self.assertEqual(disable.status_code, 200, disable.text)
        self.assertFalse(fresh.get("/api/auth/me").json()["two_factor_enabled"])
        fresh.close()

    def test_otp_delivery_failure_cannot_authenticate(self):
        client = TestClient(fixture.app)
        with (
            patch.dict(os.environ, {"SMTP_HOST": "127.0.0.1"}),
            patch(
                "backend.app.main.smtplib.SMTP",
                side_effect=OSError("Injected mail failure"),
            ),
        ):
            response = client.post(
                "/api/auth/login",
                json={"email": "other@test.local", "password": "Demo-only!2026"},
            )
        self.assertEqual(response.status_code, 503, response.text)
        self.assertIsNone(client.cookies.get("brightloop_challenge"))
        with fixture.SessionLocal() as db:
            self.assertEqual(
                db.query(LoginChallenge)
                .filter(LoginChallenge.user_id == self.other_id)
                .count(),
                0,
            )
        client.close()

    def test_staff_policy_and_authorization_against_real_finance_routes(self):
        weak = {"name": "Staff", "email": "staff@test.local", "password": "aaaaaaaaaaa"}
        self.assertEqual(
            self.client.post("/api/users/staff", json=weak).status_code, 422
        )
        staff = {**weak, "password": "StrongReview!2026"}
        created = self.client.post("/api/users/staff", json=staff)
        self.assertEqual(created.status_code, 201, created.text)
        self.assertEqual(
            self.client.post("/api/users/staff", json=staff).status_code, 409
        )
        worker = TestClient(fixture.app)
        self.sign_in(worker, "staff@test.local", "StrongReview!2026")
        self.assertEqual(worker.get("/api/invoices").status_code, 200)
        self.assertEqual(
            worker.post(
                "/api/billing/preview", json={"as_of": "2026-01-31"}
            ).status_code,
            200,
        )
        for path, payload in [
            ("/api/users/staff", staff),
            ("/api/taxes", {"name": "Tax", "rate_bps": 1800}),
            ("/api/products", {"name": "Product", "price": 1000}),
            ("/api/discounts", {}),
        ]:
            self.assertIn(worker.post(path, json=payload).status_code, [403, 422])
        # Valid discount body must also reach and fail the authorization check.
        discount = {
            "name": "Test",
            "kind": "FIXED",
            "value": 100,
            "starts_on": "2026-01-01",
            "ends_on": "2026-12-31",
            "max_uses": 10,
        }
        self.assertEqual(worker.post("/api/discounts", json=discount).status_code, 403)
        self.assertTrue(
            all(u["role"] == "CUSTOMER" for u in worker.get("/api/users").json())
        )
        worker.close()

    def test_payment_preferences_owner_isolation_and_no_card_credentials(self):
        customer = TestClient(fixture.app)
        self.sign_in(customer, "customer@test.local")
        one = customer.post(
            "/api/payment-methods",
            json={"kind": "CARD", "label": "Company card", "last_four": "1234"},
        )
        self.assertEqual(one.status_code, 201, one.text)
        self.assertEqual(
            customer.post(
                "/api/payment-methods",
                json={
                    "kind": "CARD",
                    "label": "Bad",
                    "card_number": "4111111111111111",
                },
            ).status_code,
            422,
        )
        self.assertEqual(self.client.get("/api/payment-methods").json(), [])
        self.assertEqual(
            self.client.delete("/api/payment-methods/" + one.json()["id"]).status_code,
            404,
        )
        self.assertEqual(
            customer.delete("/api/payment-methods/" + one.json()["id"]).status_code, 200
        )
        self.assertEqual(customer.get("/api/payment-methods").json(), [])
        customer.close()

    def test_same_origin_guard_and_concurrent_code_consumption(self):
        self.assertEqual(
            self.client.post(
                "/api/auth/login",
                headers={"Origin": "https://untrusted.example"},
                json={"email": "admin@test.local", "password": "Demo-only!2026"},
            ).status_code,
            403,
        )
        pending = TestClient(fixture.app)
        pending.post(
            "/api/auth/login",
            json={"email": "other@test.local", "password": "Demo-only!2026"},
        )
        code = self.latest_code("other@test.local")

        def verify(_):
            client = TestClient(fixture.app)
            client.cookies.update(pending.cookies)
            result = client.post("/api/auth/verify-2fa", json={"token": code})
            client.close()
            return result.status_code

        with ThreadPoolExecutor(2) as pool:
            result = list(pool.map(verify, range(2)))
        self.assertEqual(sorted(result), [200, 401])
        pending.close()
