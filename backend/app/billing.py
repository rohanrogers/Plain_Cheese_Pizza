"""A period is billed once. Preview and execution use the same calculation path."""

import calendar
from datetime import date, timedelta
from .models import Subscription, Invoice, Plan, Tax, Discount, User, uid


def period_date(anchor, interval, count, index):
    if interval == "DAILY":
        return anchor + timedelta(days=count * index)
    if interval == "WEEKLY":
        return anchor + timedelta(weeks=count * index)
    months = count * index * (12 if interval == "YEARLY" else 1)
    month_index = anchor.year * 12 + anchor.month - 1 + months
    year, month = divmod(month_index, 12)
    return date(
        year, month + 1, min(anchor.day, calendar.monthrange(year, month + 1)[1])
    )


def rounded(numerator, denominator=10000):
    return (numerator + denominator // 2) // denominator


def amounts(lines, discount, day, tax_map, used=None):
    if not lines:
        raise ValueError("Subscription has no billable lines")
    for line in lines:
        if (
            type(line.get("unit_price")) is not int
            or line["unit_price"] < 0
            or type(line.get("quantity")) is not int
            or line["quantity"] < 1
        ):
            raise ValueError(
                "Invalid stored price or quantity; correct the subscription before billing"
            )
        if line.get("tax_id") and line["tax_id"] not in tax_map:
            raise ValueError(
                "A configured tax rule is missing; billing was not executed"
            )
    used = discount.uses if discount and used is None else (used or 0)
    eligible = [
        i
        for i, l in enumerate(lines)
        if discount
        and (not discount.product_id or l.get("product_id") == discount.product_id)
    ]
    base = sum(lines[i]["unit_price"] * lines[i]["quantity"] for i in eligible)
    # Base plan fees contribute value, but are not customer seats/items.
    quantity = sum(
        lines[i]["quantity"]
        for i in eligible
        if "product_id" not in lines[i] or lines[i]["product_id"] is not None
    )
    reason = "No discount selected"
    reduction = 0
    if discount:
        reason = "Eligible"
        if day < discount.starts_on:
            reason = "Discount has not started"
        elif day > discount.ends_on:
            reason = "Discount expired"
        elif used >= discount.max_uses:
            reason = "Usage limit reached"
        elif base < discount.min_amount or quantity < discount.min_quantity:
            reason = "Minimum purchase or quantity not met"
        elif not eligible:
            reason = "No matching products"
        else:
            reduction = min(
                base,
                rounded(base * discount.value)
                if discount.kind == "PERCENT"
                else discount.value,
            )
    # Allocate proportionally; put the rounding remainder on the last eligible line.
    allocated = 0
    result = []
    for i, line in enumerate(lines):
        sub = line["unit_price"] * line["quantity"]
        disc = 0
        if reduction and i in eligible:
            disc = (
                reduction - allocated if i == eligible[-1] else reduction * sub // base
            )
            allocated += disc
        tax_rule = tax_map.get(line.get("tax_id"))
        rate = tax_rule.rate_bps if tax_rule else 0
        tax = rounded((sub - disc) * rate)
        result.append(
            {
                **line,
                "subtotal": sub,
                "discount": disc,
                "tax_rate_bps": rate,
                "tax": tax,
                "total": sub - disc + tax,
            }
        )
    return {
        "lines": result,
        "subtotal": sum(l["subtotal"] for l in result),
        "discount": reduction,
        "tax": sum(l["tax"] for l in result),
        "total": sum(l["total"] for l in result),
        "discount_reason": reason,
    }


def run_billing(db, as_of, execute=False):
    subs = (
        db.query(Subscription)
        .filter(Subscription.state == "ACTIVE", Subscription.next_billing_date <= as_of)
        .order_by(Subscription.next_billing_date, Subscription.id)
        .all()
    )
    plans = {
        x.id: x
        for x in db.query(Plan).filter(Plan.id.in_({s.plan_id for s in subs})).all()
    }
    taxes = {x.id: x for x in db.query(Tax).all()}
    discounts = {x.id: x for x in db.query(Discount).all()}
    customers = {
        x.id: x.name
        for x in db.query(User).filter(User.id.in_({s.customer_id for s in subs})).all()
    }
    existing = {
        (s, d)
        for s, d in db.query(Invoice.subscription_id, Invoice.period_start)
        .filter(
            Invoice.subscription_id.in_({s.id for s in subs}),
            Invoice.period_start <= as_of,
        )
        .all()
    }
    usage = {x.id: x.uses for x in discounts.values()}
    rows = []
    total = 0
    created = 0
    skipped = 0
    for sub in subs:
        index = sub.cycle_index
        day = sub.next_billing_date
        periods = 0
        while day <= as_of and (not sub.expires_on or day <= sub.expires_on):
            if len(rows) >= 10000:
                raise ValueError(
                    "More than 10,000 periods are due. Run a smaller date window."
                )
            duplicate = (sub.id, day) in existing
            discount = discounts.get(sub.discount_id)
            calculated = amounts(
                sub.lines, discount, day, taxes, usage.get(sub.discount_id, 0)
            )
            row = {
                "subscription_id": sub.id,
                "subscription": sub.number,
                "customer": customers.get(sub.customer_id, "Customer"),
                "period": day.isoformat(),
                "outcome": "ALREADY_INVOICED" if duplicate else "CREATE",
                "total": calculated["total"],
                "reason": "Stored invoice already covers this period"
                if duplicate
                else calculated["discount_reason"],
            }
            rows.append(row)
            if duplicate:
                skipped += 1
            else:
                created += 1
                total += calculated["total"]
                if discount and calculated["discount"]:
                    usage[discount.id] += 1
                    if execute:
                        discount.uses = usage[discount.id]
                if execute:
                    invoice = Invoice(
                        id=uid(),
                        number="INV-" + uid().replace("-", "")[:20].upper(),
                        subscription_id=sub.id,
                        customer_id=sub.customer_id,
                        period_start=day,
                        due_date=day + timedelta(days=sub.payment_days),
                        **calculated,
                    )
                    db.add(invoice)
                existing.add((sub.id, day))
            index += 1
            periods += 1
            day = period_date(sub.anchor_date, sub.interval, sub.interval_count, index)
        if execute:
            sub.cycle_index = index
            sub.next_billing_date = day
            if (
                sub.expires_on
                and day > sub.expires_on
                and plans[sub.plan_id].auto_close
            ):
                sub.state = "CLOSED"
        if not periods:
            rows.append(
                {
                    "subscription_id": sub.id,
                    "subscription": sub.number,
                    "customer": customers.get(sub.customer_id, "Customer"),
                    "period": day.isoformat(),
                    "outcome": "TERM_ENDED",
                    "total": 0,
                    "reason": "Renew the term before further billing",
                }
            )
    if execute:
        db.flush()
    return {
        "as_of": as_of,
        "periods_evaluated": created + skipped,
        "invoices_created": created,
        "duplicates_skipped": skipped,
        "total": total,
        "rows": rows[:300],
        "rows_total": len(rows),
        "executed": execute,
    }
