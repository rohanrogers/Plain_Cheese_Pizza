"""Business acceptance rehearsal and measured PostgreSQL page/batch performance."""

import json
import time
from datetime import date, timedelta
from pathlib import Path
from fastapi.testclient import TestClient
from backend.tests.test_finance import DatabaseCase
from backend.app.main import SessionLocal, engine
from backend.app.models import Subscription, Invoice, Product, Discount, uid
from backend.app.billing import period_date


class CompletionTests(DatabaseCase):
    def create(self, route, payload):
        response = self.client.post("/api/" + route, json=payload)
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def setup_quote(self):
        tax = self.create("taxes", {"name": "Acceptance GST", "rate_bps": 1800})
        plan = self.create(
            "plans",
            {
                "name": "Acceptance monthly",
                "price": 1000,
                "interval": "MONTHLY",
                "min_quantity": 5,
            },
        )
        products = [
            self.create("products", {"name": name, "price": price, "tax_id": tax["id"]})
            for name, price in [("Core", 5000), ("Seats", 3000)]
        ]
        discount = self.create(
            "discounts",
            {
                "name": "SEATS10",
                "kind": "PERCENT",
                "value": 1000,
                "min_amount": 20000,
                "min_quantity": 5,
                "starts_on": date.today().isoformat(),
                "ends_on": (date.today() + timedelta(days=90)).isoformat(),
                "max_uses": 10,
            },
        )
        payload = {
            "customer_id": self.customer_id,
            "plan_id": plan["id"],
            "discount_id": discount["id"],
            "starts_on": date.today().isoformat(),
            "expires_on": (date.today() + timedelta(days=60)).isoformat(),
            "payment_days": 21,
            "validity_days": 14,
            "lines": [
                {"product_id": products[0]["id"], "quantity": 2},
                {"product_id": products[1]["id"], "quantity": 3},
            ],
        }
        return payload, discount

    def test_full_configure_quote_bill_collect_report_rehearsal(self):
        payload, discount = self.setup_quote()
        preview = self.client.post("/api/subscriptions/preview", json=payload)
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(
            (
                preview.json()["subtotal"],
                preview.json()["discount"],
                preview.json()["tax"],
                preview.json()["total"],
            ),
            (20000, 2000, 3078, 21078),
        )
        self.assertEqual(self.client.get("/api/subscriptions").json()["total"], 0)
        # Whole-contract rules include the base plan value, but not a fake extra seat.
        coupon = self.client.post(
            "/api/discounts/validate",
            json={
                "code": "SEATS10",
                "lines": payload["lines"],
                "plan_id": payload["plan_id"],
            },
        )
        self.assertEqual(coupon.status_code, 200, coupon.text)
        self.assertEqual(coupon.json()["discount_amount"], 2000)
        with SessionLocal() as db:
            self.assertEqual(db.get(Discount, discount["id"]).uses, 0)
        sub = self.create("subscriptions", payload)
        self.assertEqual(sub["payment_days"], 21)
        self.assertEqual(sub["expires_on"], payload["expires_on"])
        self.assertEqual(len(sub["lines"]), 3)
        for action in ("QUOTE", "CONFIRM", "ACTIVATE"):
            response = self.client.post(
                "/api/subscriptions/" + sub["id"] + "/transition",
                json={"action": action},
            )
            self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            self.client.put(
                "/api/subscriptions/" + sub["id"], json=payload
            ).status_code,
            400,
        )
        self.assertEqual(self.run_bill(date.today())["invoices_created"], 1)
        self.assertEqual(self.run_bill(date.today())["invoices_created"], 0)
        inv = self.invoice()
        self.assertEqual(inv["total"], 21078)
        self.confirm(inv["id"])
        self.assertEqual(self.payment(inv["id"], 10000, "ACCEPT-PART").status_code, 201)
        self.assertEqual(
            self.client.get("/api/invoices/" + inv["id"]).json()["balance"], 11078
        )
        self.assertEqual(
            self.payment(inv["id"], 11078, "ACCEPT-FINAL").status_code, 201
        )
        report = self.client.get("/api/dashboard").json()
        self.assertEqual(
            (
                report["active_subscriptions"],
                report["mrr"],
                report["collected"],
                report["outstanding"],
            ),
            (1, 20000, 21078, 0),
        )
        with SessionLocal() as db:
            self.assertEqual(db.get(Discount, discount["id"]).uses, 1)
        self.assertIn(
            "text/html",
            self.client.get("/api/invoices/" + inv["id"] + "/print").headers[
                "content-type"
            ],
        )

    def test_draft_edit_validation_and_customer_ownership(self):
        payload, _ = self.setup_quote()
        sub = self.create("subscriptions", payload)
        changed = {
            **payload,
            "payment_days": 30,
            "expires_on": (date.today() + timedelta(days=120)).isoformat(),
            "lines": [{**payload["lines"][0], "quantity": 4}, payload["lines"][1]],
        }
        response = self.client.put("/api/subscriptions/" + sub["id"], json=changed)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["payment_days"], 30)
        self.assertEqual(response.json()["lines"][1]["quantity"], 4)
        invalid = {**changed, "customer_id": self.admin_id}
        self.assertEqual(
            self.client.put(
                "/api/subscriptions/" + sub["id"], json=invalid
            ).status_code,
            400,
        )
        self.assertEqual(
            self.client.get("/api/subscriptions/" + sub["id"]).json()["customer_id"],
            self.customer_id,
        )
        with TestClient(self.client.app) as other:
            self.sign_in(other, "other@test.local")
            self.assertEqual(
                other.get("/api/subscriptions/" + sub["id"]).status_code, 404
            )
            self.assertEqual(
                other.post(
                    "/api/subscriptions/" + sub["id"] + "/transition",
                    json={"action": "CLOSE"},
                ).status_code,
                404,
            )
        with TestClient(self.client.app) as customer:
            self.sign_in(customer, "customer@test.local")
            self.assertEqual(
                customer.get("/api/subscriptions/" + sub["id"]).status_code, 200
            )
            self.assertEqual(
                customer.put(
                    "/api/subscriptions/" + sub["id"], json=changed
                ).status_code,
                403,
            )

    def test_staff_cannot_change_admin_configuration(self):
        payload, _ = self.setup_quote()
        self.create(
            "users/staff",
            {
                "name": "Operations",
                "email": "staff@test.local",
                "password": "Demo-only!2026",
            },
        )
        with TestClient(self.client.app) as staff:
            self.sign_in(staff, "staff@test.local")
            for route, data in [
                ("plans", {"name": "Monthly", "interval": "MONTHLY"}),
                ("taxes", {"name": "No GST", "rate_bps": 0}),
                (
                    "discounts",
                    {
                        "name": "NO",
                        "kind": "FIXED",
                        "value": 100,
                        "starts_on": date.today().isoformat(),
                        "ends_on": date.today().isoformat(),
                        "max_uses": 1,
                    },
                ),
            ]:
                self.assertEqual(
                    staff.post("/api/" + route, json=data).status_code, 403, route
                )
                id = self.client.get("/api/" + route).json()[0]["id"]
                self.assertEqual(
                    staff.put("/api/" + route + "/" + id, json=data).status_code,
                    403,
                    route,
                )
            self.assertEqual(
                staff.post("/api/subscriptions/preview", json=payload).status_code, 200
            )

    def test_customer_controls_and_renewal_skip_closed_gaps(self):
        id = self.sub(anchor=date.today() - timedelta(days=95))
        with SessionLocal.begin() as db:
            db.get(Subscription, id).state = "CLOSED"
        with TestClient(self.client.app) as customer:
            self.sign_in(customer, "customer@test.local")
            route = "/api/subscriptions/" + id + "/transition"
            response = customer.post(
                route,
                json={
                    "action": "RENEW",
                    "expires_on": (date.today() + timedelta(days=90)).isoformat(),
                },
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertGreaterEqual(
                response.json()["next_billing_date"], date.today().isoformat()
            )
            self.assertEqual(
                customer.post(route, json={"action": "PAUSE"}).json()["state"], "PAUSED"
            )
            self.assertEqual(
                customer.post(route, json={"action": "RESUME"}).json()["state"],
                "ACTIVE",
            )
            self.assertEqual(
                customer.post(route, json={"action": "CLOSE"}).json()["state"], "CLOSED"
            )
        self.assertEqual(self.run_bill(date.today())["invoices_created"], 0)

    def test_coupon_codes_unique_and_template_term_validation(self):
        payload, discount = self.setup_quote()
        duplicate = {k: v for k, v in discount.items() if k not in ("id", "uses")}
        duplicate["name"] = "seats10"
        self.assertEqual(
            self.client.post("/api/discounts", json=duplicate).status_code, 400
        )
        template = self.create(
            "quotation-templates",
            {
                "name": "Reusable",
                "plan_id": payload["plan_id"],
                "lines": payload["lines"],
                "validity_days": 7,
            },
        )
        response = self.client.post(
            "/api/subscriptions/from-template/" + template["id"],
            json={
                "customer_id": self.customer_id,
                "expires_on": (date.today() - timedelta(days=1)).isoformat(),
            },
        )
        self.assertEqual(response.status_code, 422, response.text)
        invalid = {**payload, "lines": [{**payload["lines"][0], "quantity": 1}]}
        self.assertEqual(
            self.client.post("/api/subscriptions/preview", json=invalid).status_code,
            400,
        )
        self.assertEqual(self.client.get("/api/subscriptions").json()["total"], 0)


class PerformanceTests(DatabaseCase):
    def test_pages_and_500_subscription_billing_batch(self):
        day = date.today()
        next_day = period_date(day, "MONTHLY", 1, 1)
        product = Product(
            id=uid(),
            name="Performance core",
            price=10000,
            cost=1000,
            kind="SERVICE",
            tax_id=self.tax_id,
        )
        with SessionLocal.begin() as db:
            db.add(product)
        rows = []
        for i in range(5000):
            rows.append(
                {
                    "id": uid(),
                    "number": f"PERF-{i:05}",
                    "customer_id": self.customer_id if i % 2 == 0 else self.other_id,
                    "plan_id": self.plan_id,
                    "state": "ACTIVE",
                    "starts_on": day,
                    "quote_expires_on": day + timedelta(days=7),
                    "anchor_date": day,
                    "next_billing_date": next_day
                    if i < 500
                    else period_date(day, "MONTHLY", 1, 2),
                    "interval": "MONTHLY",
                    "interval_count": 1,
                    "payment_days": 14,
                    "cycle_index": 1 if i < 500 else 2,
                    "lines": [
                        {
                            "product_id": product.id,
                            "description": "Performance core",
                            "unit_price": 10000,
                            "quantity": 1,
                            "tax_id": self.tax_id,
                        }
                    ],
                }
            )
        invoices = [
            {
                "id": uid(),
                "number": f"PERF-INV-{i:05}",
                "subscription_id": s["id"],
                "customer_id": s["customer_id"],
                "period_start": day,
                "due_date": day + timedelta(days=14),
                "state": "CONFIRMED",
                "lines": [
                    {
                        **line,
                        "subtotal": 10000,
                        "discount": 0,
                        "tax_rate_bps": 1800,
                        "tax": 1800,
                        "total": 11800,
                    }
                    for line in s["lines"]
                ],
                "subtotal": 10000,
                "discount": 0,
                "tax": 1800,
                "total": 11800,
                "paid": 0,
                "discount_reason": "No discount",
            }
            for i, s in enumerate(rows)
        ]
        with engine.begin() as conn:
            conn.execute(Subscription.__table__.insert(), rows)
            conn.execute(Invoice.__table__.insert(), invoices)
        checks = {
            "dashboard": "/api/dashboard",
            "dashboard_filtered": f"/api/dashboard?start={day}&end={next_day}",
            "subscriptions": "/api/subscriptions",
            "subscriptions_last_page": "/api/subscriptions?page=200",
            "subscriptions_search": "/api/subscriptions?q=PERF-049",
            "invoices": "/api/invoices",
            "invoices_last_page": "/api/invoices?page=200",
            "invoice_search": "/api/invoices?q=PERF-INV-049",
            "subscription_detail": "/api/subscriptions/" + rows[0]["id"],
            "invoice_detail": "/api/invoices/" + invoices[0]["id"],
            "invoice_print": "/api/invoices/" + invoices[0]["id"] + "/print",
            "catalog": "/api/catalog",
            "users": "/api/users",
        }
        measured = {}
        for name, route in checks.items():
            samples = []
            for _ in range(3):
                start = time.perf_counter()
                response = self.client.get(route)
                samples.append(round((time.perf_counter() - start) * 1000, 2))
                self.assertEqual(response.status_code, 200, (name, response.text[:200]))
            measured[name] = {"samples_ms": samples, "max_ms": max(samples)}
            self.assertLess(max(samples), 2000, name)
        for name, mode in [
            ("billing_preview", "preview"),
            ("billing_commit", "run"),
            ("billing_repeat", "run"),
        ]:
            start = time.perf_counter()
            response = self.client.post(
                "/api/billing/" + mode, json={"as_of": next_day.isoformat()}
            )
            elapsed = round((time.perf_counter() - start) * 1000, 2)
            self.assertEqual(response.status_code, 200, response.text)
            expected = 0 if name == "billing_repeat" else 500
            self.assertEqual(response.json()["invoices_created"], expected)
            measured[name] = {"samples_ms": [elapsed], "max_ms": elapsed}
            self.assertLess(elapsed, 2000, name)
        with TestClient(self.client.app) as customer:
            self.sign_in(customer, "customer@test.local")
            start = time.perf_counter()
            for route in ["/api/dashboard", "/api/subscriptions", "/api/invoices"]:
                self.assertEqual(customer.get(route).status_code, 200)
            elapsed = round((time.perf_counter() - start) * 1000, 2)
            measured["portal_three_requests"] = {
                "samples_ms": [elapsed],
                "max_ms": elapsed,
            }
            self.assertLess(elapsed, 2000)
            self.assertEqual(customer.get("/api/subscriptions").json()["total"], 2500)
        result = {
            "dataset": {
                "subscriptions": 5000,
                "initial_invoices": 5000,
                "billing_batch": 500,
            },
            "scope": "Local PostgreSQL, in-process authenticated HTTP requests; browser/network/hardware affect real page loads",
            "measurements": measured,
        }
        target = (
            Path(__file__).resolve().parents[2]
            / "test-results"
            / "completion-performance.json"
        )
        target.parent.mkdir(exist_ok=True)
        target.write_text(json.dumps(result, indent=2) + "\n")
        print(
            "\nCompletion performance:",
            json.dumps({k: v["max_ms"] for k, v in measured.items()}),
        )
