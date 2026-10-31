"""Explicit local fixtures, never an automatic application bootstrap."""

from datetime import date, timedelta
from .app.main import engine, Base, SessionLocal, password_hash
from .app.models import User, Tax, Product, Plan, Subscription, Invoice, Payment, uid
from .app.billing import run_billing


def main():
    Base.metadata.create_all(engine)
    with SessionLocal.begin() as db:
        if db.query(User).count():
            print("Database already has users; fixtures were not added or changed.")
            return
        hashed = password_hash("Demo-only!2026")
        admin = User(
            id=uid(),
            name="Demo Admin",
            email="admin@brightloop.local",
            password_hash=hashed,
            role="ADMIN",
        )
        staff = User(
            id=uid(),
            name="Demo Billing",
            email="staff@brightloop.local",
            password_hash=hashed,
            role="STAFF",
        )
        customers = [
            User(
                id=uid(),
                name=name,
                email=f"customer{i}@brightloop.local",
                password_hash=hashed,
                role="CUSTOMER",
            )
            for i, name in enumerate(
                ["Kochi Design Studio", "Harbour Software", "Malabar Analytics"], 1
            )
        ]
        db.add_all([admin, staff, *customers])
        db.flush()
        tax = Tax(id=uid(), name="Demo GST 18%", rate_bps=1800)
        plan = Plan(
            id=uid(),
            name="Monthly Standard",
            price=0,
            interval="MONTHLY",
            interval_count=1,
        )
        db.add_all([tax, plan])
        db.flush()
        product = Product(
            id=uid(),
            name="Workspace Subscription",
            kind="SERVICE",
            price=100000,
            cost=30000,
            tax_id=tax.id,
        )
        db.add(product)
        db.flush()
        today = date.today()
        anchor = (today.replace(day=1) - timedelta(days=1)).replace(day=1)
        for i in range(12):
            sub = Subscription(
                id=uid(),
                number=f"SUB-DEMO-{i + 1:03}",
                customer_id=customers[i % 3].id,
                plan_id=plan.id,
                state="ACTIVE",
                starts_on=anchor,
                anchor_date=anchor,
                next_billing_date=anchor,
                quote_expires_on=today + timedelta(days=7),
                interval="MONTHLY",
                interval_count=1,
                payment_days=14,
                lines=[
                    {
                        "product_id": product.id,
                        "description": product.name,
                        "unit_price": product.price,
                        "quantity": 1 + i % 3,
                        "tax_id": tax.id,
                    }
                ],
            )
            db.add(sub)
        db.flush()
        run_billing(db, anchor, True)
        invoices = db.query(Invoice).order_by(Invoice.number).all()
        for i, inv in enumerate(invoices):
            inv.state = "CONFIRMED"
            if i < 3:
                inv.paid = inv.total if i < 2 else inv.total // 2
                inv.state = "PAID" if inv.paid == inv.total else "CONFIRMED"
                db.add(
                    Payment(
                        invoice_id=inv.id,
                        amount=inv.paid,
                        method="BANK",
                        paid_on=today,
                        reference=f"DEMO-BANK-{i + 1}",
                        note="Explicit demonstration fixture",
                    )
                )
        print(f"Created local fixtures. Scheduler actor: {staff.id}")
        print(
            "Accounts: admin@brightloop.local, staff@brightloop.local, customer1@brightloop.local; password: Demo-only!2026"
        )


if __name__ == "__main__":
    main()
