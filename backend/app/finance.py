"""Billing, invoices, payments, and reporting. IAM dependencies are injected by the app."""

import html
import calendar
import os
from fractions import Fraction
import time
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Callable
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from sqlalchemy import func
from .models import (
    Invoice,
    InvoiceMonthlySummary,
    Subscription,
    User,
    Payment,
    Plan,
    Audit,
    uid,
)
from .contracts import BillingInput, InvoiceAction, PaymentInput
from .billing import run_billing


@dataclass(frozen=True)
class FinanceDependencies:
    db_session: Callable
    current_user: Callable
    operator: Callable
    require: Callable
    owned: Callable
    serialize: Callable
    audit: Callable
    mail_message: Callable


def create_finance_router(deps: FinanceDependencies):
    router = APIRouter(tags=["Finance"])
    require, owned, serialize = deps.require, deps.owned, deps.serialize
    audit, mail_message = deps.audit, deps.mail_message

    @router.post("/api/billing/preview")
    def billing_preview(
        payload: BillingInput,
        user=Depends(deps.operator),
        db=Depends(deps.db_session, scope="function"),
    ):
        try:
            return run_billing(db, payload.as_of)
        except ValueError as exc:
            raise HTTPException(400, str(exc))

    @router.post("/api/billing/run")
    def billing_run(
        payload: BillingInput,
        user=Depends(deps.operator),
        db=Depends(deps.db_session, scope="function"),
    ):
        start = time.perf_counter()
        try:
            result = run_billing(db, payload.as_of, True)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        audit(
            db,
            user,
            uid(),
            "BILLING_RUN",
            f"As of {payload.as_of}: created {result['invoices_created']}, existing {result['duplicates_skipped']}",
        )
        result["processing_ms"] = round((time.perf_counter() - start) * 1000, 2)
        return result

    def invoice_result(db, item, customer=None, sub=None):
        customer = customer or db.get(User, item.customer_id)
        sub = sub or db.get(Subscription, item.subscription_id)
        balance = item.total - item.paid
        return {
            **serialize(item),
            "customer_name": customer.name if customer else "Customer",
            "customer_email": customer.email if customer else "",
            "subscription_number": sub.number if sub else "",
            "balance": balance,
            "overdue": item.state == "CONFIRMED"
            and balance > 0
            and item.due_date < date.today(),
        }

    @router.get("/api/invoices")
    def invoices(
        q: str = Query(default="", max_length=100),
        state: str = "",
        overdue: bool = False,
        page: int = Query(default=1, ge=1),
        user=Depends(deps.current_user),
        db=Depends(deps.db_session, scope="function"),
    ):
        query = db.query(Invoice)
        if user.role == "CUSTOMER":
            query = query.filter(Invoice.customer_id == user.id)
        if q:
            query = query.join(User, User.id == Invoice.customer_id).filter(
                Invoice.number.ilike("%" + q + "%") | User.name.ilike("%" + q + "%")
            )
        if state:
            query = query.filter(Invoice.state == state)
        if overdue:
            query = query.filter(
                Invoice.state == "CONFIRMED",
                Invoice.due_date < date.today(),
                Invoice.paid < Invoice.total,
            )
        count = query.count()
        items = (
            query.order_by(Invoice.created_at.desc(), Invoice.id)
            .offset((page - 1) * 25)
            .limit(25)
            .all()
        )
        um = {
            x.id: x
            for x in db.query(User)
            .filter(User.id.in_({i.customer_id for i in items}))
            .all()
        }
        sm = {
            x.id: x
            for x in db.query(Subscription)
            .filter(Subscription.id.in_({i.subscription_id for i in items}))
            .all()
        }
        return {
            "items": [
                invoice_result(db, x, um.get(x.customer_id), sm.get(x.subscription_id))
                for x in items
            ],
            "total": count,
            "page": page,
        }

    @router.get("/api/invoices/{id}")
    def invoice(
        id: str,
        user=Depends(deps.current_user),
        db=Depends(deps.db_session, scope="function"),
    ):
        item = owned(require(db, Invoice, id), user)
        result = invoice_result(db, item)
        result["payments"] = [
            serialize(x)
            for x in db.query(Payment)
            .filter(Payment.invoice_id == id)
            .order_by(Payment.created_at.desc())
            .all()
        ]
        result["events"] = [
            serialize(x)
            for x in db.query(Audit)
            .filter(Audit.entity_id == id)
            .order_by(Audit.created_at.desc())
            .all()
        ]
        return result

    @router.post("/api/invoices/{id}/action")
    def invoice_action(
        id: str,
        payload: InvoiceAction,
        user=Depends(deps.operator),
        db=Depends(deps.db_session, scope="function"),
    ):
        item = require(db, Invoice, id)
        if payload.action == "CONFIRM" and item.state == "DRAFT":
            item.state = "PAID" if item.total == 0 else "CONFIRMED"
        elif (
            payload.action == "CANCEL"
            and item.state in ("DRAFT", "CONFIRMED")
            and item.paid == 0
        ):
            if not payload.note.strip():
                raise HTTPException(400, "A cancellation reason is required")
            item.state = "CANCELLED"
        elif payload.action == "SEND" and item.state in ("CONFIRMED", "PAID"):
            customer = require(db, User, item.customer_id)
            body = (
                f"Hello {customer.name},\n\nInvoice {item.number}\nTotal: INR {item.total / 100:.2f}\nOutstanding: INR {(item.total - item.paid) / 100:.2f}\nDue: {item.due_date}\n\nSign in to your Brightloop portal to view and print the full invoice.\n"
                + os.getenv("FRONTEND_URL", "http://127.0.0.1:3000")
            )
            status = mail_message(db, customer.email, "Invoice " + item.number, body)
            audit(db, user, id, "INVOICE_SEND", status)
            return {"delivery_status": status}
        else:
            raise HTTPException(
                400, "Invoice action is not allowed in the current state"
            )
        audit(db, user, id, "INVOICE_" + payload.action, payload.note or item.state)
        return invoice_result(db, item)

    @router.post("/api/invoices/{id}/payments", status_code=201)
    def record_payment(
        id: str,
        payload: PaymentInput,
        user=Depends(deps.operator),
        db=Depends(deps.db_session, scope="function"),
    ):
        item = require(db, Invoice, id)
        existing = (
            db.query(Payment).filter(Payment.reference == payload.reference).first()
        )
        if existing:
            if (
                existing.invoice_id == id
                and existing.amount == payload.amount
                and existing.method == payload.method
                and existing.paid_on == payload.paid_on
                and existing.note == payload.note
            ):
                return {**serialize(existing), "duplicate": True}
            raise HTTPException(
                409, "This payment reference was already used for a different payment"
            )
        if item.state != "CONFIRMED":
            raise HTTPException(400, "Only confirmed unpaid invoices accept payments")
        if payload.amount > item.total - item.paid:
            raise HTTPException(400, "Payment exceeds the remaining balance")
        if payload.paid_on > date.today():
            raise HTTPException(400, "Payment date cannot be in the future")
        payment = Payment(invoice_id=id, **payload.model_dump())
        db.add(payment)
        item.paid += payload.amount
        if item.paid == item.total:
            item.state = "PAID"
        db.flush()
        audit(
            db,
            user,
            id,
            "PAYMENT_RECORDED",
            f"INR {payload.amount / 100:.2f} · {payload.method} · {payload.reference}",
        )
        return serialize(payment)

    @router.get("/api/invoices/{id}/print", response_class=HTMLResponse)
    def print_invoice(
        id: str,
        user=Depends(deps.current_user),
        db=Depends(deps.db_session, scope="function"),
    ):
        item = owned(require(db, Invoice, id), user)
        customer = require(db, User, item.customer_id)
        rows = "".join(
            f"<tr><td>{html.escape(l['description'])}</td><td>{l['quantity']}</td><td>{l['unit_price'] / 100:,.2f}</td><td>{l['discount'] / 100:,.2f}</td><td>{l['tax'] / 100:,.2f}</td><td>{l['total'] / 100:,.2f}</td></tr>"
            for l in item.lines
        )
        return f"""<!doctype html><html lang='en'><meta charset='utf-8'><title>{item.number}</title><style>body{{font:15px system-ui;color:#17352d;margin:60px}}h1{{font-size:36px}}table{{width:100%;border-collapse:collapse;margin:40px 0}}td,th{{padding:14px 8px;border-bottom:1px solid #ddd;text-align:left}}.sum{{text-align:right;font-size:19px}}button{{padding:12px 20px}}@media print{{button{{display:none}}}}</style><button onclick='window.print()'>Print / Save PDF</button><h1>brightloop.</h1><p>INVOICE · {item.number} · {item.state}</p><h2>{html.escape(customer.name)}</h2><p>{html.escape(customer.email)}</p><p>Billing period: {item.period_start} · Due: {item.due_date}</p><table><thead><tr><th>Description</th><th>Qty</th><th>Unit (INR)</th><th>Discount</th><th>Tax</th><th>Total</th></tr></thead><tbody>{rows}</tbody></table><div class='sum'><p>Subtotal INR {item.subtotal / 100:,.2f}</p><p>Discount INR {item.discount / 100:,.2f}</p><p>Tax INR {item.tax / 100:,.2f}</p><h2>Total INR {item.total / 100:,.2f}</h2><p>Recorded payments INR {item.paid / 100:,.2f}</p><p>Balance INR {(item.total - item.paid) / 100:,.2f}</p></div></html>"""

    @router.get("/api/dashboard")
    def dashboard(
        start: date | None = None,
        end: date | None = None,
        user=Depends(deps.current_user),
        db=Depends(deps.db_session, scope="function"),
    ):
        if start and end and start > end:
            raise HTTPException(400, "Date range is reversed")
        iq = db.query(Invoice)
        sq = db.query(Subscription)
        pq = db.query(Payment).join(Invoice, Invoice.id == Payment.invoice_id)
        if user.role == "CUSTOMER":
            iq = iq.filter(Invoice.customer_id == user.id)
            sq = sq.filter(Subscription.customer_id == user.id)
            pq = pq.filter(Invoice.customer_id == user.id)
        if start:
            iq = iq.filter(Invoice.period_start >= start)
            pq = pq.filter(Payment.paid_on >= start)
        if end:
            iq = iq.filter(Invoice.period_start <= end)
            pq = pq.filter(Payment.paid_on <= end)
        issued = iq.filter(Invoice.state.in_(["CONFIRMED", "PAID"]))
        billed, net, tax, paid = issued.with_entities(
            func.coalesce(func.sum(Invoice.total), 0),
            func.coalesce(func.sum(Invoice.subtotal - Invoice.discount), 0),
            func.coalesce(func.sum(Invoice.tax), 0),
            func.coalesce(func.sum(Invoice.paid), 0),
        ).one()
        collections = pq.with_entities(
            func.coalesce(func.sum(Payment.amount), 0)
        ).scalar()
        overdue = issued.filter(
            Invoice.state == "CONFIRMED",
            Invoice.due_date < date.today(),
            Invoice.total > Invoice.paid,
        )
        overdue_total = overdue.with_entities(
            func.coalesce(func.sum(Invoice.total - Invoice.paid), 0)
        ).scalar()
        counts = {
            state: count
            for state, count in sq.with_entities(
                Subscription.state, func.count(Subscription.id)
            )
            .group_by(Subscription.state)
            .all()
        }
        buckets = []
        for label, lo, hi in [
            ("Not due", None, 0),
            ("1–30 days", 1, 30),
            ("31–60 days", 31, 60),
            ("61–90 days", 61, 90),
            ("90+ days", 91, None),
        ]:
            query = issued.filter(
                Invoice.state == "CONFIRMED", Invoice.total > Invoice.paid
            )
            if lo is None:
                query = query.filter(Invoice.due_date >= date.today())
            else:
                query = query.filter(
                    Invoice.due_date <= date.today() - timedelta(days=lo)
                )
                if hi:
                    query = query.filter(
                        Invoice.due_date >= date.today() - timedelta(days=hi)
                    )
            amount = query.with_entities(
                func.coalesce(func.sum(Invoice.total - Invoice.paid), 0)
            ).scalar()
            buckets.append({"label": label, "amount": amount})
        attention_rows = overdue.order_by(Invoice.due_date).limit(6).all()
        customers = {
            x.id: x
            for x in db.query(User)
            .filter(User.id.in_([x.customer_id for x in attention_rows]))
            .all()
        }
        activity = []
        if user.role != "CUSTOMER":
            activity = [
                serialize(x)
                for x in db.query(Audit)
                .order_by(Audit.created_at.desc())
                .limit(6)
                .all()
            ]
        active = sq.filter(Subscription.state == "ACTIVE").all()
        plans = {x.id: x.name for x in db.query(Plan).all()}
        mrr = Fraction(0)
        tiers = {}
        for sub in active:
            period_net = sum(
                line["unit_price"] * line["quantity"] for line in sub.lines
            )
            factor = {
                "MONTHLY": Fraction(1),
                "YEARLY": Fraction(1, 12),
                "WEEKLY": Fraction(52, 12),
                "DAILY": Fraction(1461, 48),
            }[sub.interval] / sub.interval_count
            mrr += period_net * factor
            name = plans.get(sub.plan_id, "Unknown plan")
            tiers[name] = tiers.get(name, 0) + 1
        trend = {}
        # Whole-month ranges can use the transactional cache. Partial-month
        # ranges need source rows so a mid-month boundary remains exact.
        whole_months = (not start or start.day == 1) and (
            not end or end.day == calendar.monthrange(end.year, end.month)[1]
        )
        cached_trend = db.bind.dialect.name == "postgresql" and whole_months
        if cached_trend:
            summary = db.query(
                InvoiceMonthlySummary.month_start, func.sum(InvoiceMonthlySummary.net)
            )
            if user.role == "CUSTOMER":
                summary = summary.filter(InvoiceMonthlySummary.customer_id == user.id)
            if start:
                summary = summary.filter(InvoiceMonthlySummary.month_start >= start)
            if end:
                summary = summary.filter(InvoiceMonthlySummary.month_start <= end)
            for month, net_amount in summary.group_by(
                InvoiceMonthlySummary.month_start
            ).all():
                trend[month.strftime("%Y-%m")] = net_amount
        else:
            for day, net_amount in issued.with_entities(
                Invoice.period_start, Invoice.subtotal - Invoice.discount
            ).all():
                month = day.strftime("%Y-%m")
                trend[month] = trend.get(month, 0) + net_amount
        return {
            "mrr": round(mrr),
            "arr": round(mrr * 12),
            "mrr_definition": "Current active contracted run rate before discounts and tax; yearly /12, weekly 52/12, daily 365.25/12. Not recognized revenue.",
            "plan_counts": [
                {"name": name, "count": count} for name, count in sorted(tiers.items())
            ],
            "trend_source": "monthly_summary" if cached_trend else "invoice_rows",
            "revenue_trend": [
                {"month": month, "net": net} for month, net in sorted(trend.items())
            ],
            "closed_subscriptions": counts.get("CLOSED", 0),
            "active_subscriptions": counts.get("ACTIVE", 0),
            "counts": counts,
            "billed": billed,
            "net_billed": net,
            "tax_billed": tax,
            "collected": collections,
            "outstanding": billed - paid,
            "overdue": overdue_total,
            "draft_invoices": iq.filter(Invoice.state == "DRAFT").count(),
            "aging": buckets,
            "attention": [
                {
                    **serialize(x),
                    "customer_name": customers[x.customer_id].name,
                    "balance": x.total - x.paid,
                }
                for x in attention_rows
            ],
            "activity": activity,
            "range": {"start": start, "end": end},
            "note": "Invoice figures use billing-period dates; collections use payment dates. Active subscriptions are current. Recorded payments are not bank-verified.",
        }

    return router
