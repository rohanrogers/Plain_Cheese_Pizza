"""Regressions exposed by integrating the teammate's catalog with IAM/finance."""

from datetime import date, timedelta
from fastapi.testclient import TestClient
from backend.tests.test_finance import DatabaseCase
from backend.app.main import SessionLocal
from backend.app.models import Plan, Product


class IntegrationRegressions(DatabaseCase):
    def product(self, **changes):
        payload = {"name": "Integrated service", "price": 10000}
        payload.update(changes)
        result = self.client.post("/api/products", json=payload)
        self.assertEqual(result.status_code, 201, result.text)
        return result.json()

    def template(self, product):
        result = self.client.post(
            "/api/quotation-templates",
            json={
                "name": "Reusable quote",
                "plan_id": self.plan_id,
                "validity_days": 7,
                "lines": [{"product_id": product["id"], "quantity": 1}],
            },
        )
        self.assertEqual(result.status_code, 201, result.text)
        return result.json()["id"]

    def coupon(self, **changes):
        payload = {
            "name": "ONE_PERCENT",
            "kind": "PERCENT",
            "value": 100,
            "starts_on": date.today().isoformat(),
            "ends_on": (date.today() + timedelta(days=30)).isoformat(),
            "max_uses": 10,
        }
        payload.update(changes)
        result = self.client.post("/api/discounts", json=payload)
        self.assertEqual(result.status_code, 201, result.text)
        return result.json()

    def test_private_catalog_and_admin_only_price_changes(self):
        product = self.product()
        with TestClient(self.client.app) as anonymous:
            for route in (
                "products",
                "plans",
                "taxes",
                "discounts",
                "quotation-templates",
            ):
                self.assertEqual(anonymous.get("/api/" + route).status_code, 401, route)
        created = self.client.post(
            "/api/users/staff",
            json={
                "name": "Catalog staff",
                "email": "staff@test.local",
                "password": "Demo-only!2026",
            },
        )
        self.assertEqual(created.status_code, 201, created.text)
        with TestClient(self.client.app) as staff:
            self.sign_in(staff, "staff@test.local")
            response = staff.post(
                f"/api/products/{product['id']}/variants",
                json={"name": "Unauthorized", "modifier": 56000},
            )
            self.assertEqual(response.status_code, 403, response.text)

    def test_decimal_price_aliases_cannot_bypass_money_validation(self):
        for field in ("sales_price", "cost_price"):
            for value in (-1.23, "1.005", "NaN", "Infinity", "1000000000.01"):
                result = self.client.post(
                    "/api/products", json={"name": "Invalid", field: value}
                )
                self.assertEqual(result.status_code, 422, (field, value, result.text))
        product = self.product(
            price=0, sales_price="100.01", cost_price="56.09", type="service"
        )
        self.assertEqual(
            (product["price"], product["cost"], product["kind"]),
            (10001, 5609, "SERVICE"),
        )

    def test_coupon_uses_basis_points_and_exact_code(self):
        self.coupon()
        result = self.client.post(
            "/api/discounts/validate", json={"code": "one_percent", "subtotal": 10000}
        )
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["discount_amount"], 100)
        self.assertEqual(result.json()["new_subtotal"], 9900)
        wildcard = self.client.post(
            "/api/discounts/validate", json={"code": "%", "subtotal": 10000}
        )
        self.assertEqual(wildcard.status_code, 400)

    def test_product_scoped_coupon_uses_actual_lines(self):
        eligible, other = self.product(), self.product(name="Other")
        self.coupon(product_id=eligible["id"])
        for data in (
            {"subtotal": 10000},
            {"lines": [{"product_id": other["id"], "quantity": 1}]},
        ):
            response = self.client.post(
                "/api/discounts/validate", json={"code": "ONE_PERCENT", **data}
            )
            self.assertEqual(response.status_code, 400, response.text)
        response = self.client.post(
            "/api/discounts/validate",
            json={
                "code": "ONE_PERCENT",
                "lines": [
                    {"product_id": eligible["id"], "quantity": 2},
                    {"product_id": other["id"], "quantity": 3},
                ],
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["discount_amount"], 200)
        self.assertEqual(response.json()["new_subtotal"], 49800)

    def test_template_reuses_customer_plan_and_product_guards(self):
        product = self.product()
        template = self.template(product)
        route = f"/api/subscriptions/from-template/{template}"
        self.assertEqual(self.client.post(route, json={}).status_code, 422)
        self.assertEqual(
            self.client.post(route, json={"customer_id": self.admin_id}).status_code,
            400,
        )
        with SessionLocal.begin() as db:
            db.get(Plan, self.plan_id).min_quantity = 2
        self.assertEqual(
            self.client.post(route, json={"customer_id": self.customer_id}).status_code,
            400,
        )
        with SessionLocal.begin() as db:
            plan = db.get(Plan, self.plan_id)
            plan.min_quantity = 1
            plan.available_from = date.today() + timedelta(days=1)
        self.assertEqual(
            self.client.post(route, json={"customer_id": self.customer_id}).status_code,
            400,
        )
        with SessionLocal.begin() as db:
            db.get(Plan, self.plan_id).available_from = None
            db.get(Product, product["id"]).active = False
        self.assertEqual(
            self.client.post(route, json={"customer_id": self.customer_id}).status_code,
            400,
        )
        self.assertEqual(self.client.get("/api/subscriptions").json()["total"], 0)

    def test_close_respects_plan_policy_for_customer_and_admin(self):
        subscription = self.sub(anchor=date.today())
        with SessionLocal.begin() as db:
            db.get(Plan, self.plan_id).allow_close = False
        route = f"/api/subscriptions/{subscription}/transition"
        self.assertEqual(
            self.client.post(route, json={"action": "CLOSE"}).status_code, 400
        )
        with TestClient(self.client.app) as customer:
            self.sign_in(customer, "customer@test.local")
            self.assertEqual(
                customer.post(route, json={"action": "CLOSE"}).status_code, 400
            )

    def test_template_through_billing_and_partial_reconciliation(self):
        product = self.product(tax_id=self.tax_id)
        template = self.template(product)
        coupon = self.coupon()
        result = self.client.post(
            f"/api/subscriptions/from-template/{template}",
            json={"customer_id": self.customer_id, "discount_id": coupon["id"]},
        )
        self.assertEqual(result.status_code, 201, result.text)
        subscription = result.json()["id"]
        for action in ("QUOTE", "CONFIRM", "ACTIVATE"):
            response = self.client.post(
                f"/api/subscriptions/{subscription}/transition", json={"action": action}
            )
            self.assertEqual(response.status_code, 200, response.text)
        with SessionLocal.begin() as db:
            db.get(Product, product["id"]).price = 99900
        preview = self.client.post(
            "/api/discounts/validate",
            json={"code": coupon["name"], "subscription_id": subscription},
        )
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(
            preview.json()["discount_amount"],
            100,
            "Saved-contract preview must use frozen prices",
        )
        self.assertEqual(self.run_bill(date.today())["invoices_created"], 1)
        self.assertEqual(self.run_bill(date.today())["invoices_created"], 0)
        invoice = self.invoice()
        self.assertEqual(
            (invoice["discount"], invoice["tax"], invoice["total"]), (100, 1782, 11682)
        )
        self.confirm(invoice["id"])
        paid = self.payment(invoice["id"], 5000)
        self.assertEqual(paid.status_code, 201, paid.text)
        invoice = self.client.get(f"/api/invoices/{invoice['id']}").json()
        self.assertEqual(invoice["state"], "CONFIRMED")
        self.assertEqual(invoice["balance"], 6682)
        paid = self.payment(invoice["id"], 6682, ref="FINAL")
        self.assertEqual(paid.status_code, 201, paid.text)
        self.assertEqual(
            self.client.get(f"/api/invoices/{invoice['id']}").json()["state"], "PAID"
        )
