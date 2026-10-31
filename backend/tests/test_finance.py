"""PostgreSQL integration suite in a disposable schema, never the application schema.
Run: .venv/bin/python -m unittest backend.tests.test_finance -v
"""

import os
import re
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from uuid import uuid4
from unittest.mock import patch
from sqlalchemy import create_engine, text, event
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from dotenv import load_dotenv

load_dotenv()
os.environ["SMTP_HOST"] = ""
os.environ["LOCAL_MAILBOX"] = "true"
url = make_url(os.environ["DATABASE_URL"])
if url.get_backend_name() != "postgresql":
    raise RuntimeError("These tests require local PostgreSQL")
bootstrap = create_engine(url)
SCHEMA = "finance_test_" + uuid4().hex
with bootstrap.begin() as conn:
    conn.execute(text(f"CREATE SCHEMA {SCHEMA}"))
os.environ["DATABASE_URL"] = url.update_query_dict(
    {"options": f"-csearch_path={SCHEMA}"}
).render_as_string(hide_password=False)
from fastapi.testclient import TestClient
from backend.app.main import app, Base, engine, SessionLocal, password_hash
from backend.app.models import (
    User,
    Mail,
    Plan,
    Tax,
    Subscription,
    Invoice,
    InvoiceMonthlySummary,
    Discount,
    uid,
)
from backend.app.billing import amounts, period_date


class DatabaseCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with bootstrap.begin() as conn:
            conn.execute(text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}"))
        Base.metadata.create_all(engine)
        cls.hashed = password_hash("Demo-only!2026")

    @classmethod
    def tearDownClass(cls):
        engine.dispose()
        with bootstrap.begin() as conn:
            conn.execute(text(f"DROP SCHEMA {SCHEMA} CASCADE"))
        bootstrap.dispose()

    def setUp(self):
        with engine.begin() as conn:
            for table in reversed(Base.metadata.sorted_tables):
                conn.execute(table.delete())
        from backend.app.migrations import migrate_iam

        migrate_iam(engine)
        self.admin_id, self.customer_id, self.other_id, self.plan_id, self.tax_id = [
            uid() for _ in range(5)
        ]
        with SessionLocal.begin() as db:
            db.add_all(
                [
                    User(
                        id=self.admin_id,
                        name="Admin",
                        email="admin@test.local",
                        password_hash=self.hashed,
                        role="ADMIN",
                    ),
                    User(
                        id=self.customer_id,
                        name="<Kochi & Co>",
                        email="customer@test.local",
                        password_hash=self.hashed,
                        role="CUSTOMER",
                    ),
                    User(
                        id=self.other_id,
                        name="Other",
                        email="other@test.local",
                        password_hash=self.hashed,
                        role="CUSTOMER",
                    ),
                ]
            )
            db.flush()
            db.add_all(
                [
                    Plan(
                        id=self.plan_id,
                        name="Monthly",
                        price=0,
                        interval="MONTHLY",
                        interval_count=1,
                    ),
                    Tax(id=self.tax_id, name="GST", rate_bps=1800),
                ]
            )
        self.client = TestClient(app, raise_server_exceptions=False)
        self.sign_in(self.client, "admin@test.local")

    def sign_in(self, client, email, password="Demo-only!2026"):
        response = client.post(
            "/api/auth/login", json={"email": email, "password": password}
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["require2FA"])
        with SessionLocal() as db:
            mail = (
                db.query(Mail)
                .filter(Mail.recipient == email)
                .order_by(Mail.created_at.desc())
                .first()
            )
            code = re.search(r"sign-in code is: (\d{6})", mail.body).group(1)
        verified = client.post("/api/auth/verify-2fa", json={"token": code})
        self.assertEqual(verified.status_code, 200, verified.text)
        return verified

    def tearDown(self):
        self.client.close()

    def sub(
        self,
        anchor=date(2026, 1, 31),
        quantity=1,
        discount_id=None,
        customer_id=None,
        expires_on=None,
        price=10000,
    ):
        id = uid()
        with SessionLocal.begin() as db:
            db.add(
                Subscription(
                    id=id,
                    number="SUB-" + id[:8],
                    customer_id=customer_id or self.customer_id,
                    plan_id=self.plan_id,
                    state="ACTIVE",
                    starts_on=anchor,
                    expires_on=expires_on,
                    quote_expires_on=anchor + timedelta(days=7),
                    anchor_date=anchor,
                    next_billing_date=anchor,
                    interval="MONTHLY",
                    interval_count=1,
                    payment_days=14,
                    discount_id=discount_id,
                    lines=[
                        {
                            "description": "<Service>",
                            "unit_price": price,
                            "quantity": quantity,
                            "tax_id": self.tax_id,
                        }
                    ],
                )
            )
        return id

    def run_bill(self, day, preview=False):
        r = self.client.post(
            "/api/billing/" + ("preview" if preview else "run"),
            json={"as_of": day.isoformat()},
        )
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def invoice(self):
        return self.client.get("/api/invoices").json()["items"][0]

    def confirm(self, id):
        r = self.client.post(f"/api/invoices/{id}/action", json={"action": "CONFIRM"})
        self.assertEqual(r.status_code, 200, r.text)

    def payment(self, id, amount, ref="PAY-1", **changes):
        payload = {
            "amount": amount,
            "method": "BANK",
            "paid_on": date.today().isoformat(),
            "reference": ref,
            "note": "Bank statement",
        }
        payload.update(changes)
        return self.client.post(f"/api/invoices/{id}/payments", json=payload)


class FinanceTests(DatabaseCase):
    def test_calendar_catchup_preview_repeat_and_snapshot(self):
        self.sub()
        day = date(2026, 3, 31)
        self.assertEqual(
            period_date(date(2026, 1, 31), "MONTHLY", 1, 1), date(2026, 2, 28)
        )
        self.assertEqual(
            period_date(date(2024, 2, 29), "YEARLY", 1, 1), date(2025, 2, 28)
        )
        self.assertEqual(self.run_bill(day, True)["invoices_created"], 3)
        self.assertEqual(self.client.get("/api/invoices").json()["total"], 0)
        self.assertEqual(self.run_bill(day)["invoices_created"], 3)
        self.assertEqual(self.run_bill(day)["invoices_created"], 0)
        with SessionLocal.begin() as db:
            db.get(Tax, self.tax_id).rate_bps = 5000
            sub = db.query(Subscription).one()
            sub.lines = [{**sub.lines[0], "unit_price": 999999}]
        inv = self.invoice()
        self.assertEqual(inv["total"], 11800)
        self.assertEqual(inv["tax"], 1800)
        printable = self.client.get(f"/api/invoices/{inv['id']}/print").text
        self.assertIn("&lt;Service&gt;", printable)
        self.assertIn("&lt;Kochi &amp; Co&gt;", printable)

    def test_discount_limits_preview_expiry_and_allocation(self):
        discount = Discount(
            id=uid(),
            name="Intro",
            kind="PERCENT",
            value=1000,
            min_amount=10000,
            min_quantity=2,
            starts_on=date(2026, 1, 1),
            ends_on=date(2026, 2, 28),
            max_uses=1,
            uses=0,
        )
        with SessionLocal.begin() as db:
            db.add(discount)
        self.sub(quantity=2, discount_id=discount.id)
        self.assertEqual(self.run_bill(date(2026, 3, 31), True)["invoices_created"], 3)
        with SessionLocal() as db:
            self.assertEqual(db.get(Discount, discount.id).uses, 0)
        self.run_bill(date(2026, 3, 31))
        with SessionLocal() as db:
            rows = db.query(Invoice).order_by(Invoice.period_start).all()
            self.assertEqual([i.discount for i in rows], [2000, 0, 0])
            self.assertEqual(rows[0].tax, 3240)
            self.assertEqual(db.get(Discount, discount.id).uses, 1)
            self.assertEqual(rows[-1].discount_reason, "Discount expired")
        lines = [
            {"unit_price": 100, "quantity": 1, "tax_id": self.tax_id},
            {"unit_price": 101, "quantity": 1, "tax_id": self.tax_id},
        ]
        discount.kind = "FIXED"
        discount.value = 101
        discount.min_amount = 0
        discount.min_quantity = 1
        total = amounts(
            lines, discount, date(2026, 1, 1), {self.tax_id: Tax(rate_bps=1800)}, 0
        )
        self.assertEqual(sum(l["discount"] for l in total["lines"]), 101)
        with self.assertRaises(ValueError):
            amounts(lines, None, date.today(), {})
        discount.min_quantity = 3
        with_fee = [
            {"product_id": None, "unit_price": 500, "quantity": 1, "tax_id": None},
            *lines,
        ]
        self.assertEqual(
            amounts(
                with_fee,
                discount,
                date(2026, 1, 1),
                {self.tax_id: Tax(rate_bps=1800)},
                0,
            )["discount"],
            0,
        )

    def test_concurrent_billing_and_unique_constraint(self):
        self.sub()

        def run(_):
            with TestClient(app) as client:
                client.cookies.update(self.client.cookies)
                r = client.post("/api/billing/run", json={"as_of": "2026-01-31"})
                return r.status_code, r.json()

        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(run, range(2)))
        self.assertEqual([r[0] for r in results], [200, 200])
        self.assertEqual(sum(r[1]["invoices_created"] for r in results), 1)
        with SessionLocal() as db:
            inv = db.query(Invoice).one()
            copy = {c.name: getattr(inv, c.name) for c in Invoice.__table__.columns}
            copy.update(id=uid(), number="DUPLICATE")
            db.add(Invoice(**copy))
            with self.assertRaises(IntegrityError):
                db.commit()

    def test_billing_failure_rolls_back_every_period(self):
        sid = self.sub()
        calls = []

        def fail(mapper, connection, target):
            calls.append(target.id)
            if len(calls) == 2:
                raise RuntimeError("Injected storage failure")

        event.listen(Invoice, "before_insert", fail)
        try:
            r = self.client.post("/api/billing/run", json={"as_of": "2026-03-31"})
            self.assertEqual(r.status_code, 500)
        finally:
            event.remove(Invoice, "before_insert", fail)
        with SessionLocal() as db:
            self.assertEqual(db.query(Invoice).count(), 0)
            self.assertEqual(db.get(Subscription, sid).cycle_index, 0)
        self.assertEqual(self.run_bill(date(2026, 3, 31))["invoices_created"], 3)

    def test_partial_payment_idempotency_validation_and_reporting(self):
        self.sub()
        self.run_bill(date(2026, 1, 31))
        inv = self.invoice()
        id = inv["id"]
        self.assertEqual(self.payment(id, 1000).status_code, 400)
        self.confirm(id)
        for amount in [0, -1, 1.5, True, 11801]:
            self.assertIn(self.payment(id, amount).status_code, [400, 422])
        self.assertEqual(self.payment(id, 5000).status_code, 201)
        self.assertTrue(self.payment(id, 5000).json()["duplicate"])
        self.assertEqual(self.payment(id, 4000).status_code, 409)
        self.assertEqual(
            self.payment(
                id,
                1000,
                "FUTURE",
                paid_on=(date.today() + timedelta(days=1)).isoformat(),
            ).status_code,
            400,
        )
        d = self.client.get("/api/dashboard").json()
        self.assertEqual(d["outstanding"], 6800)
        self.assertEqual(d["collected"], 5000)
        self.assertEqual(d["mrr"], 10000)
        self.assertEqual(sum(b["amount"] for b in d["aging"]), d["outstanding"])
        self.assertEqual(
            self.client.post(
                f"/api/invoices/{id}/action",
                json={"action": "CANCEL", "note": "Mistake"},
            ).status_code,
            400,
        )
        self.assertEqual(self.payment(id, 6800, "PAY-2").status_code, 201)
        self.assertEqual(self.client.get("/api/invoices/" + id).json()["state"], "PAID")
        self.assertEqual(
            self.client.get("/api/dashboard?start=2026-01-01&end=2026-01-31").json()[
                "collected"
            ],
            0,
        )

    def test_competing_payments_do_not_overpay(self):
        self.sub()
        self.run_bill(date(2026, 1, 31))
        id = self.invoice()["id"]
        self.confirm(id)

        def pay(i):
            with TestClient(app) as client:
                client.cookies.update(self.client.cookies)
                return client.post(
                    f"/api/invoices/{id}/payments",
                    json={
                        "amount": 8000,
                        "method": "CASH",
                        "paid_on": date.today().isoformat(),
                        "reference": f"RACE-{i}",
                    },
                ).status_code

        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(pay, range(2)))
        self.assertEqual(sorted(results), [201, 400])
        self.assertEqual(self.client.get("/api/invoices/" + id).json()["paid"], 8000)

    def test_customer_ownership_and_invoice_actions(self):
        self.sub()
        self.run_bill(date(2026, 1, 31))
        id = self.invoice()["id"]
        self.assertEqual(
            self.client.post(
                f"/api/invoices/{id}/action", json={"action": "CANCEL"}
            ).status_code,
            400,
        )
        self.confirm(id)
        with (
            patch("backend.app.main.smtplib.SMTP"),
            patch.dict(os.environ, {"SMTP_HOST": "127.0.0.1"}),
        ):
            self.assertEqual(
                self.client.post(
                    f"/api/invoices/{id}/action", json={"action": "SEND"}
                ).json()["delivery_status"],
                "SMTP_ACCEPTED",
            )
        other = TestClient(app)
        self.sign_in(other, "other@test.local")
        self.assertEqual(other.get("/api/invoices").json()["total"], 0)
        self.assertEqual(other.get("/api/invoices/" + id).status_code, 404)
        self.assertEqual(other.get("/api/invoices/" + id + "/print").status_code, 404)
        self.assertEqual(
            other.post("/api/billing/run", json={"as_of": "2026-01-31"}).status_code,
            403,
        )
        other.close()
        self.assertEqual(
            self.client.post(
                f"/api/invoices/{id}/action",
                json={"action": "CANCEL", "note": "Wrong contract"},
            ).status_code,
            200,
        )
        self.assertEqual(self.client.get("/api/dashboard").json()["outstanding"], 0)

    def test_expiration_existing_period_recovery_and_large_money(self):
        sid = self.sub(
            anchor=date(2026, 1, 31), expires_on=date(2026, 2, 28), price=5_000_000_000
        )
        self.run_bill(date(2026, 1, 31))
        with SessionLocal.begin() as db:
            sub = db.get(Subscription, sid)
            sub.cycle_index = 0
            sub.next_billing_date = sub.anchor_date
        result = self.run_bill(date(2026, 3, 31))
        self.assertEqual(result["duplicates_skipped"], 1)
        self.assertEqual(result["invoices_created"], 1)
        with SessionLocal() as db:
            self.assertEqual(db.get(Subscription, sid).state, "CLOSED")
            self.assertEqual(db.query(Invoice).count(), 2)
            self.assertEqual(db.query(Invoice).first().total, 5_900_000_000)

    def test_scheduler_uses_same_engine_and_idempotency(self):
        from backend.scheduler import main

        self.sub()
        argv = ["scheduler", "--actor-id", self.admin_id, "--as-of", "2026-01-31"]
        with patch("sys.argv", argv), patch("builtins.print"):
            main()
            main()
        self.assertEqual(self.client.get("/api/invoices").json()["total"], 1)

    def test_monthly_cache_tracks_confirm_payment_cancel_and_rollback(self):
        self.sub()
        self.run_bill(date(2026, 1, 31))
        id = self.invoice()["id"]
        self.assertEqual(self.client.get("/api/dashboard").json()["revenue_trend"], [])
        self.confirm(id)
        d = self.client.get("/api/dashboard").json()
        self.assertEqual(d["trend_source"], "monthly_summary")
        self.assertEqual(d["revenue_trend"], [{"month": "2026-01", "net": 10000}])
        # Rolled-back invoice updates must not leave the summary changed.
        with SessionLocal() as db:
            db.get(Invoice, id).state = "CANCELLED"
            db.flush()
            self.assertEqual(db.query(InvoiceMonthlySummary).count(), 0)
            db.rollback()
        self.assertEqual(
            self.client.get("/api/dashboard").json()["revenue_trend"],
            d["revenue_trend"],
        )
        self.assertEqual(
            self.client.get("/api/dashboard?start=2026-01-20&end=2026-01-31").json()[
                "trend_source"
            ],
            "invoice_rows",
        )
        self.client.post(
            f"/api/invoices/{id}/action",
            json={"action": "CANCEL", "note": "Correction"},
        )
        self.assertEqual(self.client.get("/api/dashboard").json()["revenue_trend"], [])

    def test_5000_record_dashboard_and_pagination(self):
        day = date.today()
        rows = []
        for i in range(5000):
            id = uid()
            rows.append(
                {
                    "id": id,
                    "number": f"LOAD-{i}",
                    "customer_id": self.customer_id,
                    "plan_id": self.plan_id,
                    "state": "ACTIVE",
                    "starts_on": day,
                    "quote_expires_on": day,
                    "anchor_date": day,
                    "next_billing_date": day,
                    "interval": "MONTHLY",
                    "interval_count": 1,
                    "payment_days": 14,
                    "cycle_index": 0,
                    "lines": [
                        {
                            "description": "Scale",
                            "unit_price": 10000,
                            "quantity": 1,
                            "tax_id": self.tax_id,
                        }
                    ],
                }
            )
        with engine.begin() as conn:
            conn.execute(Subscription.__table__.insert(), rows)
            conn.execute(
                Invoice.__table__.insert(),
                [
                    {
                        "id": uid(),
                        "number": f"LOAD-INV-{i}",
                        "subscription_id": sub["id"],
                        "customer_id": self.customer_id,
                        "period_start": day,
                        "due_date": day - timedelta(days=40),
                        "state": "CONFIRMED",
                        "lines": [],
                        "subtotal": 10000,
                        "discount": 0,
                        "tax": 1800,
                        "total": 11800,
                        "paid": 0,
                        "discount_reason": "No discount",
                    }
                    for i, sub in enumerate(rows)
                ],
            )
        started = time.perf_counter()
        response = self.client.get("/api/dashboard")
        elapsed = time.perf_counter() - started
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["active_subscriptions"], 5000)
        self.assertEqual(response.json()["mrr"], 50000000)
        self.assertEqual(response.json()["outstanding"], 59000000)
        self.assertEqual(response.json()["trend_source"], "monthly_summary")
        self.assertEqual(
            sum(x["net"] for x in response.json()["revenue_trend"]), 50000000
        )
        self.assertEqual(
            self.client.get("/api/invoices?page=200").json()["total"], 5000
        )
        self.assertLess(elapsed, 2, f"Dashboard exceeded target: {elapsed:.3f}s")
        page = self.client.get("/api/subscriptions?page=200").json()
        self.assertEqual(page["total"], 5000)
        self.assertEqual(len(page["items"]), 25)
        print(
            f"\nMeasured local PostgreSQL dashboard, 5000 subscriptions + 5000 invoices: {elapsed * 1000:.1f} ms"
        )


if __name__ == "__main__":
    unittest.main()
