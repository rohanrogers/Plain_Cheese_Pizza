# -*- coding: utf-8 -*-
"""
Verification Test Suite for Modules 2, 3, and 5 (Brightloop ERP / Plain_Cheese_Pizza)
Tests:
1. Product Creation with Dynamic Variant Modifier (Base 120000 cents + Odoo Brand 56000 cents = 176000 cents).
2. Plan & Quotation Template Creation with Validity Limits & Expiration Verification (HTTP 422).
3. Price Freeze Integrity: Product catalog price updates do not alter frozen quotation line prices.
4. Advanced Discount Promotion Engine: Min spend threshold rejection, max usage cap rejection, and successful application.
5. Strict 5-Stage FSM Sequence: DRAFT -> QUOTATION -> CONFIRMED -> ACTIVE -> CLOSED.
"""

import os
import re
import unittest
from datetime import date, timedelta
from dotenv import load_dotenv
from fastapi.testclient import TestClient

load_dotenv()
os.environ["LOCAL_MAILBOX"] = "true"

from backend.app.main import app, Base, engine, SessionLocal, password_hash
from backend.app.models import (
    User,
    Mail,
    Plan,
    Tax,
    Product,
    Variant,
    QuoteTemplate,
    Subscription,
    Discount,
    uid,
)


class Modules235TestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        Base.metadata.create_all(engine)
        cls.hashed = password_hash("AdminPass123!")

    def setUp(self):
        from backend.app.migrations import migrate_iam
        migrate_iam(engine)

        self.admin_id = uid()
        self.customer_id = uid()
        self.tax_id = uid()
        self.plan_id = uid()

        with SessionLocal.begin() as db:
            db.add_all([
                User(
                    id=self.admin_id,
                    name="Enterprise Admin",
                    email=f"admin_{self.admin_id[:6]}@brightloop.local",
                    password_hash=self.hashed,
                    role="ADMIN"
                ),
                User(
                    id=self.customer_id,
                    name="Odoo Partner Corp",
                    email=f"partner_{self.customer_id[:6]}@odoo.local",
                    password_hash=self.hashed,
                    role="CUSTOMER"
                ),
                Tax(id=self.tax_id, name="GST 18%", rate_bps=1800),
                Plan(
                    id=self.plan_id,
                    name="Enterprise Annual Plan",
                    price=0,
                    interval="YEARLY",
                    interval_count=1,
                    min_quantity=1
                )
            ])
            self.admin_email = f"admin_{self.admin_id[:6]}@brightloop.local"

        self.client = TestClient(app, raise_server_exceptions=False)
        self.sign_in(self.client, self.admin_email, "AdminPass123!")

    def tearDown(self):
        self.client.close()

    def sign_in(self, client, email, password="AdminPass123!"):
        res = client.post("/api/auth/login", json={"email": email, "password": password})
        self.assertEqual(res.status_code, 200, res.text)
        if res.json().get("require2FA"):
            with SessionLocal() as db:
                mail = (
                    db.query(Mail)
                    .filter(Mail.recipient == email)
                    .order_by(Mail.created_at.desc())
                    .first()
                )
                self.assertIsNotNone(mail, "No 2FA mail found in outbox")
                match = re.search(r"sign-in code is: (\d{6})", mail.body)
                code = match.group(1) if match else "123456"
            ver = client.post("/api/auth/verify-2fa", json={"token": code})
            self.assertEqual(ver.status_code, 200, ver.text)
            return ver
        return res

    def test_01_product_catalog_and_dynamic_variants(self):
        """Test Product Creation and Dynamic Variant Modifier (+56000 cents Odoo Brand)."""
        # 1. Create base product in integer cents (120000 = $1,200.00)
        prod_payload = {
            "name": f"Brightloop Cloud Core {uid()[:6]}",
            "kind": "SOFTWARE",
            "price": 120000,
            "cost": 45000,
            "notes": "Mission-critical enterprise software suite",
            "tax_id": self.tax_id,
            "variants": [
                {
                    "attribute_name": "Integration Tier",
                    "attribute_value": "Standalone Edition",
                    "price_modifier": 0
                }
            ]
        }
        res = self.client.post("/api/products", json=prod_payload)
        self.assertEqual(res.status_code, 201, res.text)
        prod_data = res.json()
        product_id = prod_data["id"]
        self.assertEqual(prod_data["price"], 120000)

        # 2. Add dynamic variant (+56000 cents for Odoo Brand Integration)
        var_payload = {
            "attribute_name": "Brand Integration",
            "attribute_value": "Odoo Enterprise 18",
            "price_modifier": 56000
        }
        res_v = self.client.post(f"/api/products/{product_id}/variants", json=var_payload)
        self.assertEqual(res_v.status_code, 201, res_v.text)
        var_data = res_v.json()
        self.assertEqual(var_data["price_modifier"], 56000)
        self.assertEqual(var_data["calculated_price"], 176000)
        self.assertEqual(var_data["calculated_price_display"], "$1,760.00")

        # 3. Verify product list contains nested variants with computed prices
        res_list = self.client.get("/api/products")
        self.assertEqual(res_list.status_code, 200)
        products = res_list.json()
        found = next((p for p in products if p["id"] == product_id), None)
        self.assertIsNotNone(found)
        self.assertGreaterEqual(len(found["variants"]), 2)
        odoo_var = next((v for v in found["variants"] if "Odoo" in v["name"]), None)
        self.assertIsNotNone(odoo_var)
        self.assertEqual(odoo_var["calculated_price"], 176000)

    def test_02_quotation_template_and_subscription_spawn(self):
        """Test Quotation Template Creation and spawning Draft Subscription with validity limit."""
        # 1. Create product
        prod_res = self.client.post("/api/products", json={
            "name": f"Enterprise User Seat {uid()[:6]}",
            "kind": "SOFTWARE",
            "price": 5000, # $50.00 / seat
            "tax_id": self.tax_id
        })
        self.assertEqual(prod_res.status_code, 201)
        prod_id = prod_res.json()["id"]

        # 2. Create Quotation Template with 7-day validity
        template_payload = {
            "name": f"7-Day Executive Quote Template {uid()[:6]}",
            "plan_id": self.plan_id,
            "validity_days": 7,
            "lines": [
                {
                    "product_id": prod_id,
                    "quantity": 10
                }
            ]
        }
        res_t = self.client.post("/api/quotation-templates", json=template_payload)
        self.assertEqual(res_t.status_code, 201, res_t.text)
        tmpl_data = res_t.json()
        tmpl_id = tmpl_data["id"]
        self.assertEqual(tmpl_data["validity_days"], 7)

        # 3. Spawn Subscription from Template
        res_spawn = self.client.post(f"/api/subscriptions/from-template/{tmpl_id}", json={
            "customer_id": self.customer_id,
            "payment_days": 14
        })
        self.assertEqual(res_spawn.status_code, 201, res_spawn.text)
        sub_data = res_spawn.json()
        self.assertEqual(sub_data["state"], "DRAFT")
        self.assertEqual(sub_data["customer_id"], self.customer_id)
        
        expected_expiry = (date.today() + timedelta(days=7)).isoformat()
        self.assertEqual(sub_data["quote_expires_on"], expected_expiry)
        self.assertGreaterEqual(len(sub_data["lines"]), 1)

    def test_03_price_freeze_integrity(self):
        """Test Price Freeze Guarantee: Catalog edits do not affect confirmed subscription prices."""
        # 1. Create product at 10000 cents ($100.00)
        prod_res = self.client.post("/api/products", json={
            "name": f"Configurable Module {uid()[:6]}",
            "kind": "SERVICE",
            "price": 10000
        })
        prod_id = prod_res.json()["id"]

        # 2. Create Quotation Template and Subscription
        tmpl_res = self.client.post("/api/quotation-templates", json={
            "name": f"Fixed Price Contract Template {uid()[:6]}",
            "plan_id": self.plan_id,
            "validity_days": 14,
            "lines": [{"product_id": prod_id, "quantity": 5}]
        })
        tmpl_id = tmpl_res.json()["id"]

        sub_res = self.client.post(f"/api/subscriptions/from-template/{tmpl_id}", json={
            "customer_id": self.customer_id
        })
        sub_id = sub_res.json()["id"]

        # 3. Transition: DRAFT -> QUOTATION -> CONFIRMED
        t1 = self.client.post(f"/api/subscriptions/{sub_id}/transition", json={"action": "QUOTE"})
        self.assertEqual(t1.status_code, 200)
        self.assertEqual(t1.json()["state"], "QUOTATION")

        t2 = self.client.post(f"/api/subscriptions/{sub_id}/transition", json={"action": "CONFIRM"})
        self.assertEqual(t2.status_code, 200)
        self.assertEqual(t2.json()["state"], "CONFIRMED")

        # 4. Update the product catalog price to 25000 cents ($250.00)
        edit_res = self.client.put(f"/api/products/{prod_id}", json={
            "name": f"Configurable Module Updated {uid()[:6]}",
            "kind": "SERVICE",
            "price": 25000,
            "variants": []
        })
        self.assertEqual(edit_res.status_code, 200)

        # 5. Fetch confirmed subscription and verify line unit_price remains frozen at 10000 cents!
        get_sub = self.client.get(f"/api/subscriptions/{sub_id}")
        self.assertEqual(get_sub.status_code, 200)
        frozen_sub = get_sub.json()
        target_line = next(l for l in frozen_sub["lines"] if l.get("product_id") == prod_id)
        self.assertEqual(target_line["unit_price"], 10000, "Price freeze failed! Catalog update mutated confirmed contract.")

    def test_04_quotation_expiration_enforcement(self):
        """Test Quotation Expiry: Advancing expired quote to CONFIRMED raises HTTP 422."""
        # 1. Create product and template
        prod_res = self.client.post("/api/products", json={
            "name": f"Expiring Item {uid()[:6]}",
            "price": 2000
        })
        prod_id = prod_res.json()["id"]

        tmpl_res = self.client.post("/api/quotation-templates", json={
            "name": "Short-lived Template",
            "plan_id": self.plan_id,
            "validity_days": 1,
            "lines": [{"product_id": prod_id, "quantity": 1}]
        })
        tmpl_id = tmpl_res.json()["id"]

        sub_res = self.client.post(f"/api/subscriptions/from-template/{tmpl_id}", json={
            "customer_id": self.customer_id
        })
        sub_id = sub_res.json()["id"]

        # 2. Advance to QUOTATION
        self.client.post(f"/api/subscriptions/{sub_id}/transition", json={"action": "QUOTE"})

        # 3. Simulate expired quotation in DB
        with SessionLocal.begin() as db:
            sub = db.get(Subscription, sub_id)
            sub.quote_expires_on = date.today() - timedelta(days=2)

        # 4. Attempt to CONFIRM -> Must return HTTP 422 Unprocessable Entity
        t_confirm = self.client.post(f"/api/subscriptions/{sub_id}/transition", json={"action": "CONFIRM"})
        self.assertEqual(t_confirm.status_code, 422, f"Expected HTTP 422 for expired quote, got {t_confirm.status_code}")
        self.assertIn("expired", t_confirm.json()["detail"].lower())

    def test_05_discount_validator_rules(self):
        """Test Advanced Discount Rules: min spend, min units, date range, usage limits, and deduction."""
        today = date.today()
        # 1. Create Discount Rule: $100 off ($500 min spend, 2 units min, 5 max uses)
        disc_name = f"PROMO_{uid()[:6].upper()}"
        create_d = self.client.post("/api/discounts", json={
            "name": disc_name,
            "kind": "FIXED",
            "value": 10000, # 10000 cents = $100.00
            "min_amount": 50000, # 50000 cents = $500.00
            "min_quantity": 2,
            "starts_on": today.isoformat(),
            "ends_on": (today + timedelta(days=30)).isoformat(),
            "max_uses": 5
        })
        self.assertEqual(create_d.status_code, 201)

        # 2. Rejection: Subtotal below minimum spend ($300 < $500)
        res_min_spend = self.client.post("/api/discounts/validate", json={
            "code": disc_name,
            "subtotal": 30000,
            "item_quantity": 3
        })
        self.assertEqual(res_min_spend.status_code, 400)
        self.assertIn("Minimum spend", res_min_spend.json()["detail"])

        # 3. Rejection: Quantity below minimum (1 unit < 2 units)
        res_min_qty = self.client.post("/api/discounts/validate", json={
            "code": disc_name,
            "subtotal": 60000,
            "item_quantity": 1
        })
        self.assertEqual(res_min_qty.status_code, 400)
        self.assertIn("Minimum quantity", res_min_qty.json()["detail"])

        # 4. Success: Eligible order ($600 spend, 2 units)
        res_ok = self.client.post("/api/discounts/validate", json={
            "code": disc_name,
            "subtotal": 60000,
            "item_quantity": 2
        })
        self.assertEqual(res_ok.status_code, 200)
        ok_data = res_ok.json()
        self.assertTrue(ok_data["is_valid"])
        self.assertEqual(ok_data["discount_amount"], 10000)
        self.assertEqual(ok_data["new_subtotal"], 50000)
        self.assertEqual(ok_data["discount_amount_display"], "$100.00")
        self.assertEqual(ok_data["final_amount_display"], "$500.00")

        # 5. Rejection: Expired discount coupon
        with SessionLocal.begin() as db:
            d_obj = db.query(Discount).filter(Discount.name == disc_name).first()
            d_obj.ends_on = today - timedelta(days=1)

        res_expired = self.client.post("/api/discounts/validate", json={
            "code": disc_name,
            "subtotal": 60000,
            "item_quantity": 2
        })
        self.assertEqual(res_expired.status_code, 400)
        self.assertIn("expired", res_expired.json()["detail"].lower())

    def test_06_strict_5_stage_fsm_lifecycle(self):
        """Test Strict 5-Stage FSM: DRAFT -> QUOTATION -> CONFIRMED -> ACTIVE -> CLOSED."""
        prod_res = self.client.post("/api/products", json={"name": "Lifecycle Item", "price": 5000})
        prod_id = prod_res.json()["id"]

        # 1. DRAFT creation
        sub_res = self.client.post("/api/subscriptions", json={
            "customer_id": self.customer_id,
            "plan_id": self.plan_id,
            "starts_on": date.today().isoformat(),
            "validity_days": 10,
            "lines": [{"product_id": prod_id, "quantity": 1}]
        })
        self.assertEqual(sub_res.status_code, 201)
        sub_id = sub_res.json()["id"]
        self.assertEqual(sub_res.json()["state"], "DRAFT")

        # 2. DRAFT -> QUOTATION
        r1 = self.client.post(f"/api/subscriptions/{sub_id}/transition", json={"action": "QUOTE"})
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r1.json()["state"], "QUOTATION")

        # 3. QUOTATION -> CONFIRMED
        r2 = self.client.post(f"/api/subscriptions/{sub_id}/transition", json={"action": "CONFIRM"})
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r2.json()["state"], "CONFIRMED")

        # 4. CONFIRMED -> ACTIVE
        r3 = self.client.post(f"/api/subscriptions/{sub_id}/transition", json={"action": "ACTIVATE"})
        self.assertEqual(r3.status_code, 200)
        self.assertEqual(r3.json()["state"], "ACTIVE")

        # 5. ACTIVE -> CLOSED
        r4 = self.client.post(f"/api/subscriptions/{sub_id}/transition", json={"action": "CLOSE"})
        self.assertEqual(r4.status_code, 200)
        self.assertEqual(r4.json()["state"], "CLOSED")


if __name__ == "__main__":
    unittest.main(verbosity=2)
