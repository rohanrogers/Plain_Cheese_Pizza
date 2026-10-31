import hashlib
import hmac
import os
import secrets
import smtplib
import time
from contextlib import asynccontextmanager
from datetime import date, timedelta
from email.message import EmailMessage
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import create_engine, event, text, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from .models import (
    Base,
    User,
    AuthSession,
    Product,
    Variant,
    Plan,
    Tax,
    Discount,
    QuoteTemplate,
    Subscription,
    Invoice,
    Audit,
    Mail,
    now,
    uid,
)
from .contracts import (
    StaffCreate,
    ProductInput,
    VariantInput,
    PlanInput,
    TaxInput,
    DiscountInput,
    DiscountValidateInput,
    TemplateInput,
    TemplateSpawnInput,
    SubscriptionInput,
    Transition,
)
from .billing import amounts, period_date
from .iam import IAMDependencies, create_iam_router
from .finance import FinanceDependencies, create_finance_router

load_dotenv()
ROOT = Path(__file__).resolve().parents[2]
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./brightloop.db")
if DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False, "timeout": 30}
    if DATABASE_URL.startswith("sqlite")
    else {},
    pool_pre_ping=True,
)
if engine.dialect.name == "sqlite":

    @event.listens_for(engine, "connect")
    def sqlite_settings(conn, record):
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA journal_mode=WAL")


SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


@asynccontextmanager
async def lifespan(app):
    Base.metadata.create_all(engine)
    from .migrations import migrate_iam

    migrate_iam(engine)
    yield


app = FastAPI(
    title="Brightloop subscription operations", version="0.1.0", lifespan=lifespan
)


@app.middleware("http")
async def request_guards(request, call_next):
    start = time.perf_counter()
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        allowed = {
            os.getenv("FRONTEND_URL", "http://127.0.0.1:3000"),
            "http://localhost:5173",
            str(request.base_url).rstrip("/"),
        }
        if origin and origin not in allowed:
            return JSONResponse({"detail": "Untrusted request origin"}, status_code=403)
    response = await call_next(request)
    response.headers["Server-Timing"] = (
        f"app;dur={(time.perf_counter() - start) * 1000:.2f}"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = (
        "no-store" if request.url.path.startswith("/api") else "no-cache"
    )
    response.headers["X-Frame-Options"] = "DENY"
    return response


@app.exception_handler(IntegrityError)
async def integrity_error(request, exc):
    return JSONResponse(
        {
            "detail": "A unique record already exists or a referenced record is invalid. Refresh and retry."
        },
        status_code=409,
    )


def db_session(request: Request):
    with SessionLocal() as db:
        try:
            # Single-workspace writes serialize at the database, across processes.
            # This deliberately favors correctness over parallel write throughput.
            if request.method not in ("GET", "HEAD", "OPTIONS"):
                if engine.dialect.name == "postgresql":
                    db.execute(text("SELECT pg_advisory_xact_lock(81726439)"))
                elif engine.dialect.name == "sqlite":
                    db.execute(text("BEGIN IMMEDIATE"))
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def password_hash(password):
    salt = secrets.token_hex(16)
    key = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1).hex()
    return salt + ":" + key


def password_matches(password, encoded):
    salt, key = encoded.split(":", 1)
    candidate = hashlib.scrypt(
        password.encode(), salt=salt.encode(), n=16384, r=8, p=1
    ).hex()
    return hmac.compare_digest(key, candidate)


def current_user(request: Request, db=Depends(db_session, scope="function")):
    token = request.cookies.get("brightloop_session", "")
    session = db.get(AuthSession, digest(token)) if token else None
    if not session or session.expires_at <= now():
        raise HTTPException(401, "Please sign in")
    user = db.get(User, session.user_id)
    if not user or user.role not in ("ADMIN", "STAFF", "CUSTOMER"):
        raise HTTPException(401, "Please sign in")
    return user


def operator(user=Depends(current_user)):
    if user.role not in ("ADMIN", "STAFF"):
        raise HTTPException(403, "Staff access required")
    return user


def admin(user=Depends(current_user)):
    if user.role != "ADMIN":
        raise HTTPException(403, "Administrator access required")
    return user


def require(db, model, id):
    item = db.get(model, id)
    if not item:
        raise HTTPException(404, "Record not found")
    return item


def owned(item, user):
    if user.role == "CUSTOMER" and item.customer_id != user.id:
        raise HTTPException(404, "Record not found")
    return item


def serialize(obj):
    return {
        column.name: getattr(obj, column.name)
        for column in obj.__table__.columns
        if column.name not in ("password_hash",)
    }


def audit(db, user, entity, action, detail):
    db.add(Audit(actor_id=user.id, entity_id=entity, action=action, detail=detail))


def mail_message(db, to, subject, body):
    status = "LOCAL_MAILBOX"
    host = os.getenv("SMTP_HOST")
    if host:
        message = EmailMessage()
        message["From"] = os.getenv("MAIL_FROM", "billing@brightloop.local")
        message["To"] = to
        message["Subject"] = subject
        message.set_content(body)
        try:
            with smtplib.SMTP(
                host, int(os.getenv("SMTP_PORT", "1025")), timeout=5
            ) as smtp:
                if os.getenv("SMTP_TLS", "false").lower() == "true":
                    smtp.starttls()
                if os.getenv("SMTP_USER"):
                    smtp.login(
                        os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", "")
                    )
                smtp.send_message(message)
            status = "SMTP_ACCEPTED"
        except (OSError, smtplib.SMTPException):
            status = "DELIVERY_FAILED"
    elif os.getenv("LOCAL_MAILBOX", "true").lower() != "true":
        status = "DELIVERY_FAILED"
    # Reset tokens are retained only in the explicitly enabled development mailbox.
    stored_body = (
        body
        if os.getenv("LOCAL_MAILBOX", "true").lower() == "true"
        else "Message content omitted outside local development"
    )
    db.add(Mail(recipient=to, subject=subject, body=stored_body, status=status))
    return status


@app.get("/api/health")
def health():
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
    return {
        "status": "ready",
        "database": engine.dialect.name,
        "today": date.today(),
        "currency": "INR",
        "mail_mode": "SMTP" if os.getenv("SMTP_HOST") else "LOCAL_MAILBOX",
    }


app.include_router(
    create_iam_router(
        IAMDependencies(
            db_session=db_session,
            current_user=current_user,
            admin=admin,
            digest=digest,
            password_hash=password_hash,
            password_matches=password_matches,
            serialize=serialize,
            mail_message=mail_message,
            audit=audit,
        )
    )
)


@app.get("/api/users")
def users(user=Depends(operator), db=Depends(db_session, scope="function")):
    rows = db.query(User)
    if user.role != "ADMIN":
        rows = rows.filter(User.role == "CUSTOMER")
    return [serialize(x) for x in rows.order_by(User.name).all()]


@app.post("/api/users/staff", status_code=201)
def create_staff(
    payload: StaffCreate, user=Depends(admin), db=Depends(db_session, scope="function")
):
    item = User(
        email=payload.email.lower(),
        name=payload.name,
        password_hash=password_hash(payload.password),
        role="STAFF",
    )
    db.add(item)
    db.flush()
    audit(db, user, item.id, "STAFF_CREATED", item.email)
    return serialize(item)


@app.get("/api/catalog")
def catalog(user=Depends(operator), db=Depends(db_session, scope="function")):
    variants = {}
    for v in db.query(Variant).all():
        variants.setdefault(v.product_id, []).append(serialize(v))
    return {
        "products": [
            {**serialize(p), "variants": variants.get(p.id, [])}
            for p in db.query(Product).order_by(Product.name).all()
        ],
        "plans": [serialize(x) for x in db.query(Plan).all()],
        "taxes": [serialize(x) for x in db.query(Tax).all()],
        "discounts": [serialize(x) for x in db.query(Discount).all()],
        "templates": [serialize(x) for x in db.query(QuoteTemplate).all()],
    }


@app.get("/api/products")
def list_products(
    q: str = Query(default="", max_length=100),
    user=Depends(operator),
    db=Depends(db_session, scope="function"),
):
    query = db.query(Product)
    if q:
        query = query.filter(Product.name.ilike(f"%{q}%"))
    products = query.order_by(Product.name).all()
    res = []
    for p in products:
        p_dict = serialize(p)
        variants = db.query(Variant).filter(Variant.product_id == p.id).all()
        p_dict["variants"] = []
        for v in variants:
            attr_name = v.name.split(":")[0].strip() if ":" in v.name else "Attribute"
            attr_val = v.name.split(":")[1].strip() if ":" in v.name else v.name
            calc_cents = p.price + v.modifier
            p_dict["variants"].append(
                {
                    **serialize(v),
                    "attribute_name": attr_name,
                    "attribute_value": attr_val,
                    "price_modifier": v.modifier,
                    "price_modifier_display": f"+₹{v.modifier / 100:,.2f}"
                    if v.modifier >= 0
                    else f"-₹{abs(v.modifier) / 100:,.2f}",
                    "calculated_price": calc_cents,
                    "calculated_price_display": f"₹{calc_cents / 100:,.2f}",
                }
            )
        p_dict["sales_price"] = round(p.price / 100, 2)
        p_dict["price_display"] = f"₹{p.price / 100:,.2f}"
        p_dict["cost_price"] = round(p.cost / 100, 2)
        res.append(p_dict)
    return res


@app.post("/api/products", status_code=201)
def create_product(
    payload: ProductInput, user=Depends(admin), db=Depends(db_session, scope="function")
):
    if payload.tax_id:
        require(db, Tax, payload.tax_id)
    prod_data = payload.model_dump(
        exclude={"variants", "sales_price", "cost_price", "type"}
    )
    item = Product(**prod_data)
    db.add(item)
    db.flush()
    for variant in payload.variants:
        v_name = variant.name
        if (
            variant.attribute_name
            and variant.attribute_value
            and (not v_name or v_name == "Standard")
        ):
            v_name = f"{variant.attribute_name}: {variant.attribute_value}"
        db.add(Variant(product_id=item.id, name=v_name, modifier=variant.modifier))
    audit(db, user, item.id, "PRODUCT_CREATED", item.name)
    db.flush()
    variants = db.query(Variant).filter(Variant.product_id == item.id).all()
    return {
        **serialize(item),
        "variants": [
            {
                **serialize(v),
                "attribute_name": v.name.split(":")[0].strip()
                if ":" in v.name
                else "Attribute",
                "attribute_value": v.name.split(":")[1].strip()
                if ":" in v.name
                else v.name,
                "price_modifier": v.modifier,
                "calculated_price": item.price + v.modifier,
                "calculated_price_display": f"₹{(item.price + v.modifier) / 100:,.2f}",
            }
            for v in variants
        ],
        "sales_price": round(item.price / 100, 2),
        "price_display": f"₹{item.price / 100:,.2f}",
        "cost_price": round(item.cost / 100, 2),
    }


@app.post("/api/products/{id}/variants", status_code=201)
def add_product_variant(
    id: str,
    payload: VariantInput,
    user=Depends(admin),
    db=Depends(db_session, scope="function"),
):
    prod = require(db, Product, id)
    v_name = payload.name
    if (
        payload.attribute_name
        and payload.attribute_value
        and (not v_name or v_name == "Standard")
    ):
        v_name = f"{payload.attribute_name}: {payload.attribute_value}"
    modifier_cents = (
        payload.price_modifier
        if payload.price_modifier is not None
        else payload.modifier
    )
    variant = Variant(product_id=id, name=v_name, modifier=modifier_cents)
    db.add(variant)
    db.flush()
    audit(db, user, variant.id, "VARIANT_ADDED", f"{v_name} on {prod.name}")
    calc_cents = prod.price + variant.modifier
    attr_name = v_name.split(":")[0].strip() if ":" in v_name else "Attribute"
    attr_val = v_name.split(":")[1].strip() if ":" in v_name else v_name
    return {
        **serialize(variant),
        "attribute_name": attr_name,
        "attribute_value": attr_val,
        "price_modifier": variant.modifier,
        "calculated_price": calc_cents,
        "calculated_price_display": f"₹{calc_cents / 100:,.2f}",
    }


@app.put("/api/products/{id}")
def edit_product(
    id: str,
    payload: ProductInput,
    user=Depends(admin),
    db=Depends(db_session, scope="function"),
):
    item = require(db, Product, id)
    if payload.tax_id:
        require(db, Tax, payload.tax_id)
    for k, v in payload.model_dump(
        exclude={"variants", "sales_price", "cost_price", "type"}
    ).items():
        setattr(item, k, v)
    existing = {v.name: v for v in db.query(Variant).filter(Variant.product_id == id)}
    for v in payload.variants:
        v_name = v.name
        if (
            v.attribute_name
            and v.attribute_value
            and (not v_name or v_name == "Standard")
        ):
            v_name = f"{v.attribute_name}: {v.attribute_value}"
        if v_name in existing:
            existing[v_name].modifier = v.modifier
        else:
            db.add(Variant(product_id=id, name=v_name, modifier=v.modifier))
    audit(
        db,
        user,
        id,
        "PRODUCT_UPDATED",
        "New quotations use updated prices; existing snapshots are preserved",
    )
    return serialize(item)


@app.get("/api/plans")
def list_plans(user=Depends(operator), db=Depends(db_session, scope="function")):
    plans = db.query(Plan).all()
    res = []
    for p in plans:
        p_dict = serialize(p)
        p_dict["price_display"] = f"₹{p.price / 100:,.2f}"
        p_dict["billing_interval"] = p.interval
        res.append(p_dict)
    return res


@app.post("/api/plans", status_code=201)
def create_plan(
    payload: PlanInput, user=Depends(admin), db=Depends(db_session, scope="function")
):
    item = Plan(**payload.model_dump())
    db.add(item)
    db.flush()
    audit(db, user, item.id, "PLAN_CREATED", item.name)
    return serialize(item)


@app.put("/api/plans/{id}")
def edit_plan(
    id: str,
    payload: PlanInput,
    user=Depends(admin),
    db=Depends(db_session, scope="function"),
):
    item = require(db, Plan, id)
    for k, v in payload.model_dump().items():
        setattr(item, k, v)
    audit(
        db, user, id, "PLAN_UPDATED", "New subscriptions use the updated billing terms"
    )
    return serialize(item)


@app.get("/api/taxes")
def list_taxes(user=Depends(operator), db=Depends(db_session, scope="function")):
    return [serialize(x) for x in db.query(Tax).all()]


@app.post("/api/taxes", status_code=201)
def create_tax(
    payload: TaxInput, user=Depends(admin), db=Depends(db_session, scope="function")
):
    item = Tax(**payload.model_dump())
    db.add(item)
    db.flush()
    audit(db, user, item.id, "TAX_CREATED", item.name)
    return serialize(item)


@app.put("/api/taxes/{id}")
def edit_tax(
    id: str,
    payload: TaxInput,
    user=Depends(admin),
    db=Depends(db_session, scope="function"),
):
    item = require(db, Tax, id)
    for k, v in payload.model_dump().items():
        setattr(item, k, v)
    audit(db, user, id, "TAX_UPDATED", "Existing invoices remain immutable")
    return serialize(item)


@app.get("/api/discounts")
def list_discounts(user=Depends(operator), db=Depends(db_session, scope="function")):
    items = db.query(Discount).all()
    today = date.today()
    res = []
    for d in items:
        d_dict = serialize(d)
        d_dict["code"] = d.name
        d_dict["is_active"] = (d.starts_on <= today <= d.ends_on) and (
            d.uses < d.max_uses
        )
        d_dict["used_count"] = d.uses
        d_dict["min_order_amount"] = round(d.min_amount / 100, 2)
        d_dict["value_display"] = (
            f"{d.value / 100:g}%" if d.kind == "PERCENT" else f"₹{d.value / 100:,.2f}"
        )
        res.append(d_dict)
    return res


@app.post("/api/discounts", status_code=201)
def create_discount(
    payload: DiscountInput,
    user=Depends(admin),
    db=Depends(db_session, scope="function"),
):
    if payload.product_id:
        require(db, Product, payload.product_id)
    if (
        db.query(Discount)
        .filter(func.lower(Discount.name) == payload.name.lower())
        .first()
    ):
        raise HTTPException(400, "A discount with this code already exists")
    item = Discount(**payload.model_dump())
    db.add(item)
    db.flush()
    audit(db, user, item.id, "DISCOUNT_CREATED", item.name)
    return serialize(item)


@app.put("/api/discounts/{id}")
def edit_discount(
    id: str,
    payload: DiscountInput,
    user=Depends(admin),
    db=Depends(db_session, scope="function"),
):
    item = require(db, Discount, id)
    if payload.product_id:
        require(db, Product, payload.product_id)
    if (
        db.query(Discount)
        .filter(func.lower(Discount.name) == payload.name.lower(), Discount.id != id)
        .first()
    ):
        raise HTTPException(400, "A discount with this code already exists")
    if payload.max_uses < item.uses:
        raise HTTPException(400, "Usage cap cannot be below uses already consumed")
    for k, v in payload.model_dump().items():
        setattr(item, k, v)
    audit(db, user, id, "DISCOUNT_UPDATED", item.name)
    return serialize(item)


@app.post("/api/discounts/validate")
def validate_discount_endpoint(
    payload: DiscountValidateInput,
    user=Depends(operator),
    db=Depends(db_session, scope="function"),
):
    discount = (
        db.query(Discount)
        .filter(
            (func.lower(Discount.name) == payload.code.lower())
            | (Discount.id == payload.code)
        )
        .first()
    )
    if not discount:
        raise HTTPException(400, "Discount coupon is invalid or does not exist")
    subscription = (
        require(db, Subscription, payload.subscription_id)
        if payload.subscription_id
        else None
    )
    if discount.product_id and not (payload.lines or subscription):
        raise HTTPException(
            400, "Product-scoped discounts require actual product lines"
        )
    lines = (
        subscription.lines
        if subscription
        else snapshot_lines(db, payload.lines)
        if payload.lines
        else [
            {
                "description": "Preview subtotal",
                "unit_price": payload.subtotal,
                "quantity": 1,
                "tax_id": None,
            }
        ]
    )
    if not payload.lines and not subscription:
        # Split aggregate value across quantity without rounding money away.
        count = payload.item_quantity
        unit, remainder = divmod(payload.subtotal, count)
        lines = [
            {
                "description": "Preview subtotal",
                "unit_price": unit,
                "quantity": count,
                "tax_id": None,
            }
        ]
        if remainder:
            lines.append(
                {
                    "product_id": None,
                    "description": "Rounding remainder",
                    "unit_price": remainder,
                    "quantity": 1,
                    "tax_id": None,
                }
            )
    if payload.plan_id:
        plan = require(db, Plan, payload.plan_id)
        if not payload.lines:
            raise HTTPException(400, "Select product lines for a plan preview")
        if plan.price:
            lines = [
                {
                    "product_id": None,
                    "description": plan.name + " · base plan fee",
                    "unit_price": plan.price,
                    "quantity": 1,
                    "tax_id": None,
                }
            ] + lines
    taxes = {x.id: x for x in db.query(Tax).all()}
    day = payload.target_date or (
        subscription.next_billing_date if subscription else date.today()
    )
    result = amounts(lines, discount, day, taxes)
    if result["discount_reason"] != "Eligible":
        reason = result["discount_reason"]
        if reason == "Minimum purchase or quantity not met":
            reason = "Minimum spend or Minimum quantity not met"
        raise HTTPException(400, reason)
    reduction = result["discount"]
    subtotal = result["subtotal"]
    return {
        "is_valid": True,
        "valid": True,
        "discount_id": discount.id,
        "code": discount.name,
        "name": discount.name,
        "discount_type": discount.kind,
        "value": discount.value,
        "discount_amount": reduction,
        "discount_amount_display": f"₹{reduction / 100:,.2f}",
        "new_subtotal": subtotal - reduction,
        "final_amount": subtotal - reduction,
        "final_amount_display": f"₹{(subtotal - reduction) / 100:,.2f}",
        "calculation": result,
    }


def snapshot_lines(db, inputs):
    lines = []
    for line in inputs:
        product = require(db, Product, line.product_id)
        if not product.active:
            raise HTTPException(400, "Selected product is archived")
        variant = require(db, Variant, line.variant_id) if line.variant_id else None
        if variant and variant.product_id != product.id:
            raise HTTPException(400, "Variant does not belong to this product")
        lines.append(
            {
                "product_id": product.id,
                "variant_id": variant.id if variant else None,
                "description": product.name + (" · " + variant.name if variant else ""),
                "quantity": line.quantity,
                "unit_price": product.price + (variant.modifier if variant else 0),
                "tax_id": product.tax_id,
            }
        )
    return lines


@app.get("/api/quotation-templates")
def list_quotation_templates(
    user=Depends(operator), db=Depends(db_session, scope="function")
):
    templates = db.query(QuoteTemplate).all()
    res = []
    for t in templates:
        plan = db.get(Plan, t.plan_id)
        res.append(
            {
                **serialize(t),
                "plan_name": plan.name if plan else "Plan",
                "is_active": True,
            }
        )
    return res


@app.post("/api/templates", status_code=201)
@app.post("/api/quotation-templates", status_code=201)
def create_template(
    payload: TemplateInput,
    user=Depends(operator),
    db=Depends(db_session, scope="function"),
):
    require(db, Plan, payload.plan_id)
    lines_snap = snapshot_lines(db, payload.lines)
    item = QuoteTemplate(
        name=payload.name,
        plan_id=payload.plan_id,
        validity_days=payload.validity_days,
        lines=lines_snap,
    )
    db.add(item)
    db.flush()
    audit(db, user, item.id, "TEMPLATE_CREATED", item.name)
    return serialize(item)


@app.post("/api/subscriptions/from-template/{template_id}", status_code=201)
def create_subscription_from_template(
    template_id: str,
    payload: TemplateSpawnInput,
    user=Depends(operator),
    db=Depends(db_session, scope="function"),
):
    template = require(db, QuoteTemplate, template_id)
    inputs = [
        {key: line.get(key) for key in ("product_id", "variant_id", "quantity")}
        for line in template.lines
    ]
    request = SubscriptionInput(
        customer_id=payload.customer_id,
        plan_id=template.plan_id,
        discount_id=payload.discount_id,
        starts_on=payload.starts_on or date.today(),
        expires_on=payload.expires_on,
        payment_days=payload.payment_days,
        validity_days=template.validity_days,
        lines=inputs,
    )
    return create_subscription(request, user, db)


def sub_result(db, item, user_map=None, plan_map=None, taxes=None, discounts=None):
    customer = (
        (user_map or {}).get(item.customer_id)
        if user_map is not None
        else db.get(User, item.customer_id)
    )
    plan = (
        (plan_map or {}).get(item.plan_id)
        if plan_map is not None
        else db.get(Plan, item.plan_id)
    )
    tax_map = taxes if taxes is not None else {x.id: x for x in db.query(Tax).all()}
    discount = (
        (discounts or {}).get(item.discount_id)
        if discounts is not None
        else db.get(Discount, item.discount_id)
        if item.discount_id
        else None
    )
    calculated = amounts(item.lines, discount, item.next_billing_date, tax_map)
    return {
        **serialize(item),
        "customer_name": customer.name if customer else "Customer",
        "plan_name": plan.name if plan else "Plan",
        "estimate": calculated,
    }


@app.get("/api/subscriptions")
def subscriptions(
    q: str = Query(default="", max_length=100),
    state: str = "",
    page: int = Query(default=1, ge=1),
    user=Depends(current_user),
    db=Depends(db_session, scope="function"),
):
    query = db.query(Subscription)
    if user.role == "CUSTOMER":
        query = query.filter(Subscription.customer_id == user.id)
    if q:
        query = query.join(User, User.id == Subscription.customer_id).filter(
            (Subscription.number.ilike("%" + q + "%"))
            | (User.name.ilike("%" + q + "%"))
        )
    if state:
        query = query.filter(Subscription.state == state)
    count = query.count()
    items = (
        query.order_by(Subscription.created_at.desc(), Subscription.id)
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
    pm = {x.id: x for x in db.query(Plan).all()}
    tm = {x.id: x for x in db.query(Tax).all()}
    dm = {x.id: x for x in db.query(Discount).all()}
    return {
        "items": [sub_result(db, x, um, pm, tm, dm) for x in items],
        "total": count,
        "page": page,
    }


def subscription_values(db, payload):
    customer = require(db, User, payload.customer_id)
    if customer.role != "CUSTOMER":
        raise HTTPException(400, "Select a customer account")
    plan = require(db, Plan, payload.plan_id)
    if sum(x.quantity for x in payload.lines) < plan.min_quantity:
        raise HTTPException(
            400, f"Plan requires at least {plan.min_quantity} product units"
        )
    if (
        plan.available_from
        and payload.starts_on < plan.available_from
        or plan.available_until
        and payload.starts_on > plan.available_until
    ):
        raise HTTPException(400, "Plan is not available on the subscription start date")
    if payload.discount_id:
        require(db, Discount, payload.discount_id)
    lines = snapshot_lines(db, payload.lines)
    if plan.price:
        lines.insert(
            0,
            {
                "product_id": None,
                "variant_id": None,
                "description": plan.name + " · base plan fee",
                "quantity": 1,
                "unit_price": plan.price,
                "tax_id": None,
            },
        )
    if payload.discount_id:
        discount = require(db, Discount, payload.discount_id)
        calculated = amounts(
            lines, discount, payload.starts_on, {t.id: t for t in db.query(Tax).all()}
        )
        if calculated["discount_reason"] != "Eligible":
            raise HTTPException(400, calculated["discount_reason"])
    return dict(
        customer_id=customer.id,
        plan_id=plan.id,
        discount_id=payload.discount_id,
        starts_on=payload.starts_on,
        expires_on=payload.expires_on,
        quote_expires_on=date.today() + timedelta(days=payload.validity_days),
        payment_days=payload.payment_days,
        next_billing_date=payload.starts_on,
        anchor_date=payload.starts_on,
        cycle_index=0,
        interval=plan.interval,
        interval_count=plan.interval_count,
        lines=lines,
    )


@app.post("/api/subscriptions/preview")
def preview_subscription(
    payload: SubscriptionInput,
    user=Depends(operator),
    db=Depends(db_session, scope="function"),
):
    values = subscription_values(db, payload)
    discount = db.get(Discount, payload.discount_id) if payload.discount_id else None
    return amounts(
        values["lines"],
        discount,
        payload.starts_on,
        {t.id: t for t in db.query(Tax).all()},
    )


@app.post("/api/subscriptions", status_code=201)
def create_subscription(
    payload: SubscriptionInput,
    user=Depends(operator),
    db=Depends(db_session, scope="function"),
):
    values = subscription_values(db, payload)
    item = Subscription(id=uid(), number="SUB-" + uid()[:8].upper(), **values)
    db.add(item)
    db.flush()
    audit(
        db,
        user,
        item.id,
        "SUBSCRIPTION_CREATED",
        "Draft created; price and recurrence snapshot saved",
    )
    return sub_result(db, item)


@app.put("/api/subscriptions/{id}")
def edit_subscription(
    id: str,
    payload: SubscriptionInput,
    user=Depends(operator),
    db=Depends(db_session, scope="function"),
):
    item = require(db, Subscription, id)
    if (
        item.state not in ("DRAFT", "QUOTATION")
        or db.query(Invoice).filter(Invoice.subscription_id == id).first()
    ):
        raise HTTPException(
            400,
            "Only an unbilled draft or quotation can be edited; confirmed prices are frozen",
        )
    for key, value in subscription_values(db, payload).items():
        setattr(item, key, value)
    audit(
        db,
        user,
        id,
        "SUBSCRIPTION_UPDATED",
        "Quotation lines and terms updated before confirmation",
    )
    return sub_result(db, item)


@app.get("/api/subscriptions/{id}")
def subscription(
    id: str, user=Depends(current_user), db=Depends(db_session, scope="function")
):
    item = owned(require(db, Subscription, id), user)
    result = sub_result(db, item)
    result["events"] = [
        serialize(x)
        for x in db.query(Audit)
        .filter(Audit.entity_id == id)
        .order_by(Audit.created_at.desc())
        .limit(30)
        .all()
    ]
    result["invoices"] = [
        serialize(x)
        for x in db.query(Invoice)
        .filter(Invoice.subscription_id == id)
        .order_by(Invoice.period_start.desc())
        .limit(50)
        .all()
    ]
    plan = require(db, Plan, item.plan_id)
    result["policies"] = {
        k: getattr(plan, k)
        for k in ("auto_close", "allow_close", "allow_pause", "allow_renew")
    }
    return result


@app.post("/api/subscriptions/{id}/transition")
def transition(
    id: str,
    payload: Transition,
    user=Depends(current_user),
    db=Depends(db_session, scope="function"),
):
    sub = owned(require(db, Subscription, id), user)
    plan = require(db, Plan, sub.plan_id)
    previous = sub.state
    action = payload.action.upper().strip()
    today = date.today()
    if user.role == "CUSTOMER" and action not in (
        "CONFIRM",
        "PAUSE",
        "RESUME",
        "CLOSE",
        "RENEW",
    ):
        raise HTTPException(403, "Staff action required")
    if action == "QUOTE" and previous == "DRAFT":
        sub.state = "QUOTATION"
    elif action == "CONFIRM" and previous == "QUOTATION":
        if today > sub.quote_expires_on:
            raise HTTPException(422, f"Quotation expired on {sub.quote_expires_on}")
        # Price Freeze Guarantee: Lock and deep-freeze line snapshot permanently
        sub.lines = [dict(x) for x in sub.lines]
        sub.state = "CONFIRMED"
    elif action == "ACTIVATE" and previous == "CONFIRMED":
        if sub.expires_on and sub.expires_on < today:
            raise HTTPException(400, "Subscription term has expired")
        sub.state = "ACTIVE"
    elif action == "PAUSE" and previous == "ACTIVE" and plan.allow_pause:
        sub.state = "PAUSED"
    elif action == "RESUME" and previous == "PAUSED" and plan.allow_pause:
        while sub.next_billing_date < today:
            sub.cycle_index += 1
            sub.next_billing_date = period_date(
                sub.anchor_date, sub.interval, sub.interval_count, sub.cycle_index
            )
        if sub.expires_on and sub.next_billing_date > sub.expires_on:
            raise HTTPException(400, "Renew the expired term before resuming")
        sub.state = "ACTIVE"
    elif action == "CLOSE" and previous in ("ACTIVE", "PAUSED") and plan.allow_close:
        sub.state = "CLOSED"
    elif (
        action == "RENEW"
        and previous in ("ACTIVE", "PAUSED", "CLOSED")
        and plan.allow_renew
    ):
        if not payload.expires_on or payload.expires_on <= max(
            today, sub.expires_on or today
        ):
            raise HTTPException(
                400, "Choose a renewal end after today and the current term"
            )
        # Paused/closed periods are not a retroactive billing obligation.
        if previous in ("PAUSED", "CLOSED"):
            while sub.next_billing_date < today:
                sub.cycle_index += 1
                sub.next_billing_date = period_date(
                    sub.anchor_date, sub.interval, sub.interval_count, sub.cycle_index
                )
        sub.expires_on = payload.expires_on
        sub.state = "ACTIVE"
    else:
        raise HTTPException(
            400, "This transition is not permitted by the current state or plan policy"
        )
    audit(db, user, id, "SUBSCRIPTION_" + action, f"{previous} → {sub.state}")
    return sub_result(db, sub)


@app.get("/api/mail")
def mailbox(user=Depends(admin), db=Depends(db_session, scope="function")):
    if os.getenv("LOCAL_MAILBOX", "true").lower() != "true":
        raise HTTPException(404, "Local mailbox is disabled")
    return [
        serialize(x)
        for x in db.query(Mail).order_by(Mail.created_at.desc()).limit(50).all()
    ]


app.include_router(
    create_finance_router(
        FinanceDependencies(
            db_session=db_session,
            current_user=current_user,
            operator=operator,
            require=require,
            owned=owned,
            serialize=serialize,
            audit=audit,
            mail_message=mail_message,
        )
    )
)
# Serve the teammate's existing UI and APIs from one origin.
app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
