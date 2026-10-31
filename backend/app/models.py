"""SQLAlchemy schema. All monetary values are integer paise; rates are basis points."""

from datetime import datetime, timezone
from uuid import uuid4
from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import declarative_base

Base = declarative_base()


def uid():
    return str(uuid4())


def now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(Base):
    __tablename__ = "users"
    id = Column(String(36), primary_key=True, default=uid)
    email = Column(String(254), unique=True, nullable=False)
    name = Column(String(120), nullable=False)
    password_hash = Column(Text, nullable=False)
    role = Column(String(20), nullable=False, default="CUSTOMER")
    created_at = Column(DateTime, default=now, nullable=False)


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    token_hash = Column(String(64), primary_key=True)
    user_id = Column(String(36), ForeignKey("users.id"), nullable=False)
    expires_at = Column(DateTime, nullable=False)


class PasswordReset(Base):
    __tablename__ = "password_resets"
    token_hash = Column(String(64), primary_key=True)
    user_id = Column(String(36), ForeignKey("users.id"), nullable=False)
    expires_at = Column(DateTime, nullable=False)
    used = Column(Boolean, default=False, nullable=False)


class Tax(Base):
    __tablename__ = "taxes"
    id = Column(String(36), primary_key=True, default=uid)
    name = Column(String(120), nullable=False)
    rate_bps = Column(Integer, nullable=False)


class Product(Base):
    __tablename__ = "products"
    id = Column(String(36), primary_key=True, default=uid)
    name = Column(String(120), nullable=False)
    kind = Column(String(30), nullable=False)
    price = Column(BigInteger, nullable=False)
    cost = Column(BigInteger, nullable=False, default=0)
    notes = Column(Text, nullable=False, default="")
    tax_id = Column(String(36), ForeignKey("taxes.id"))
    active = Column(Boolean, nullable=False, default=True)


class Variant(Base):
    __tablename__ = "variants"
    id = Column(String(36), primary_key=True, default=uid)
    product_id = Column(String(36), ForeignKey("products.id"), nullable=False)
    name = Column(String(120), nullable=False)
    modifier = Column(BigInteger, nullable=False, default=0)


class Plan(Base):
    __tablename__ = "plans"
    id = Column(String(36), primary_key=True, default=uid)
    name = Column(String(120), nullable=False)
    price = Column(BigInteger, nullable=False, default=0)
    interval = Column(String(20), nullable=False)
    interval_count = Column(Integer, nullable=False, default=1)
    min_quantity = Column(Integer, nullable=False, default=1)
    available_from = Column(Date)
    available_until = Column(Date)
    auto_close = Column(Boolean, nullable=False, default=True)
    allow_close = Column(Boolean, nullable=False, default=True)
    allow_pause = Column(Boolean, nullable=False, default=True)
    allow_renew = Column(Boolean, nullable=False, default=True)


class Discount(Base):
    __tablename__ = "discounts"
    id = Column(String(36), primary_key=True, default=uid)
    name = Column(String(120), nullable=False)
    kind = Column(String(20), nullable=False)
    value = Column(BigInteger, nullable=False)
    min_amount = Column(BigInteger, nullable=False, default=0)
    min_quantity = Column(Integer, nullable=False, default=1)
    starts_on = Column(Date, nullable=False)
    ends_on = Column(Date, nullable=False)
    max_uses = Column(Integer, nullable=False)
    uses = Column(Integer, nullable=False, default=0)
    product_id = Column(String(36), ForeignKey("products.id"))


class QuoteTemplate(Base):
    __tablename__ = "quote_templates"
    id = Column(String(36), primary_key=True, default=uid)
    name = Column(String(120), nullable=False)
    plan_id = Column(String(36), ForeignKey("plans.id"), nullable=False)
    validity_days = Column(Integer, nullable=False, default=7)
    lines = Column(JSON, nullable=False)


class Subscription(Base):
    __tablename__ = "subscriptions"
    id = Column(String(36), primary_key=True, default=uid)
    number = Column(String(30), unique=True, nullable=False)
    customer_id = Column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    plan_id = Column(String(36), ForeignKey("plans.id"), nullable=False)
    discount_id = Column(String(36), ForeignKey("discounts.id"))
    state = Column(String(20), nullable=False, default="DRAFT")
    starts_on = Column(Date, nullable=False)
    expires_on = Column(Date)
    quote_expires_on = Column(Date, nullable=False)
    payment_days = Column(Integer, nullable=False, default=14)
    next_billing_date = Column(Date, nullable=False)
    anchor_date = Column(Date, nullable=False)
    cycle_index = Column(Integer, nullable=False, default=0)
    interval = Column(String(20), nullable=False)
    interval_count = Column(Integer, nullable=False)
    lines = Column(JSON, nullable=False)
    created_at = Column(DateTime, default=now, nullable=False)
    __table_args__ = (Index("ix_subs_due", "state", "next_billing_date"),)


class Invoice(Base):
    __tablename__ = "invoices"
    id = Column(String(36), primary_key=True, default=uid)
    number = Column(String(30), unique=True, nullable=False)
    subscription_id = Column(String(36), ForeignKey("subscriptions.id"), nullable=False)
    customer_id = Column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    period_start = Column(Date, nullable=False)
    due_date = Column(Date, nullable=False)
    state = Column(String(20), nullable=False, default="DRAFT")
    lines = Column(JSON, nullable=False)
    subtotal = Column(BigInteger, nullable=False)
    discount = Column(BigInteger, nullable=False)
    tax = Column(BigInteger, nullable=False)
    total = Column(BigInteger, nullable=False)
    paid = Column(BigInteger, nullable=False, default=0)
    discount_reason = Column(Text, nullable=False)
    created_at = Column(DateTime, default=now, nullable=False)
    __table_args__ = (
        UniqueConstraint("subscription_id", "period_start", name="uq_billing_period"),
        CheckConstraint(
            "subtotal >= 0 AND discount >= 0 AND discount <= subtotal AND tax >= 0",
            name="ck_invoice_amounts",
        ),
        CheckConstraint(
            "total = subtotal - discount + tax AND paid >= 0 AND paid <= total",
            name="ck_invoice_balance",
        ),
        CheckConstraint(
            "state IN ('DRAFT','CONFIRMED','PAID','CANCELLED')", name="ck_invoice_state"
        ),
        Index("ix_invoice_aging", "state", "due_date"),
        Index("ix_invoice_period", "period_start", "state"),
    )


class Payment(Base):
    __tablename__ = "payments"
    id = Column(String(36), primary_key=True, default=uid)
    invoice_id = Column(
        String(36), ForeignKey("invoices.id"), nullable=False, index=True
    )
    amount = Column(BigInteger, nullable=False)
    method = Column(String(30), nullable=False)
    paid_on = Column(Date, nullable=False)
    note = Column(Text, nullable=False)
    reference = Column(String(120), unique=True, nullable=False)
    created_at = Column(DateTime, default=now, nullable=False)

    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_payment_positive"),
        Index("ix_payment_date", "paid_on"),
    )


class Audit(Base):
    __tablename__ = "audit_events"
    id = Column(String(36), primary_key=True, default=uid)
    actor_id = Column(String(36), ForeignKey("users.id"), nullable=False)
    entity_id = Column(String(36), nullable=False, index=True)
    action = Column(String(120), nullable=False)
    detail = Column(Text, nullable=False)
    created_at = Column(DateTime, default=now, nullable=False)


class Mail(Base):
    __tablename__ = "mail_outbox"
    id = Column(String(36), primary_key=True, default=uid)
    recipient = Column(String(254), nullable=False)
    subject = Column(String(200), nullable=False)
    body = Column(Text, nullable=False)
    status = Column(String(30), nullable=False)
    created_at = Column(DateTime, default=now, nullable=False)


class InvoiceMonthlySummary(Base):
    __tablename__ = "invoice_monthly_summaries"
    customer_id = Column(String(36), ForeignKey("users.id"), primary_key=True)
    month_start = Column(Date, primary_key=True)
    net = Column(BigInteger, nullable=False)
    invoice_count = Column(BigInteger, nullable=False)


from .summary_cache import register_summary_cache

register_summary_cache(Base.metadata)


class LoginChallenge(Base):
    __tablename__ = "login_challenges"
    token_hash = Column(String(64), primary_key=True)
    user_id = Column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    password_fingerprint = Column(String(64), nullable=False)
    method = Column(String(10), nullable=False)
    code_hash = Column(String(64))
    expires_at = Column(DateTime, nullable=False)
    attempts = Column(Integer, nullable=False, default=0)


class SecondFactor(Base):
    __tablename__ = "second_factors"
    user_id = Column(String(36), ForeignKey("users.id"), primary_key=True)
    secret_encrypted = Column(Text)
    enabled = Column(Boolean, nullable=False, default=False)
    last_counter = Column(BigInteger, nullable=False, default=-1)
    pending_encrypted = Column(Text)
    pending_expires_at = Column(DateTime)


class AuthThrottle(Base):
    __tablename__ = "auth_throttles"
    key = Column(String(64), primary_key=True)
    count = Column(Integer, nullable=False)
    expires_at = Column(DateTime, nullable=False)


class CustomerPaymentMethod(Base):
    __tablename__ = "customer_payment_methods"
    id = Column(String(36), primary_key=True, default=uid)
    customer_id = Column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    kind = Column(String(20), nullable=False)
    label = Column(String(120), nullable=False)
    last_four = Column(String(4), nullable=False, default="")
    created_at = Column(DateTime, default=now, nullable=False)


class SchemaMigration(Base):
    __tablename__ = "schema_migrations"
    revision = Column(String(100), primary_key=True)
    applied_at = Column(DateTime, default=now, nullable=False)
