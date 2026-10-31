from datetime import date
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Money = Annotated[int, Field(ge=0, le=100_000_000_000)]
Name = Annotated[str, Field(min_length=1, max_length=120)]


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Login(Payload):
    email: str = Field(pattern=r"^[^\s@]+@[^\s@]+\.[^\s@]+$", max_length=254)
    password: str = Field(min_length=1, max_length=256)


def strong_password(value):
    if (
        len(value) <= 8
        or not any(c.isupper() for c in value)
        or not any(c.islower() for c in value)
        or not any(not c.isalnum() and not c.isspace() for c in value)
    ):
        raise ValueError(
            "Use more than eight characters, uppercase, lowercase, and a special character"
        )
    return value


class Signup(Login):
    name: Name
    _strong = field_validator("password")(strong_password)

    @model_validator(mode="after")
    def password_not_email(self):
        if self.email.lower() in self.password.lower():
            raise ValueError("Password must not contain the email address")
        return self


class StaffCreate(Signup):
    pass


class Forgot(Payload):
    email: str = Field(pattern=r"^[^\s@]+@[^\s@]+\.[^\s@]+$", max_length=254)


class Reset(Payload):
    token: str = Field(min_length=20, max_length=200)
    password: str = Field(max_length=256)
    _strong = field_validator("password")(strong_password)


class TaxInput(Payload):
    name: Name
    rate_bps: int = Field(ge=0, le=10000)


class VariantInput(Payload):
    name: Name
    modifier: Money = 0


class ProductInput(Payload):
    name: Name
    kind: Literal["SOFTWARE", "SERVICE", "ADDON", "GOODS"] = "SOFTWARE"
    price: Money
    cost: Money = 0
    notes: str = Field(default="", max_length=2000)
    tax_id: str | None = None
    active: bool = True
    variants: list[VariantInput] = Field(default_factory=list, max_length=30)


class PlanInput(Payload):
    name: Name
    price: Money = 0
    interval: Literal["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]
    interval_count: int = Field(default=1, ge=1, le=120)
    min_quantity: int = Field(default=1, ge=1, le=100000)
    available_from: date | None = None
    available_until: date | None = None
    auto_close: bool = True
    allow_close: bool = True
    allow_pause: bool = True
    allow_renew: bool = True

    @model_validator(mode="after")
    def dates(self):
        if (
            self.available_from
            and self.available_until
            and self.available_from > self.available_until
        ):
            raise ValueError("Availability end must follow the start")
        return self


class DiscountInput(Payload):
    name: Name
    kind: Literal["PERCENT", "FIXED"]
    value: int = Field(ge=1, le=100_000_000_000)
    min_amount: Money = 0
    min_quantity: int = Field(default=1, ge=1, le=100000)
    starts_on: date
    ends_on: date
    max_uses: int = Field(ge=1, le=1000000)
    product_id: str | None = None

    @model_validator(mode="after")
    def valid(self):
        if self.ends_on < self.starts_on:
            raise ValueError("Discount end precedes start")
        if self.kind == "PERCENT" and self.value > 10000:
            raise ValueError("Percentage exceeds 100%")
        return self


class LineInput(Payload):
    product_id: str
    variant_id: str | None = None
    quantity: int = Field(default=1, ge=1, le=100000)


class TemplateInput(Payload):
    name: Name
    plan_id: str
    validity_days: int = Field(default=7, ge=1, le=365)
    lines: list[LineInput] = Field(min_length=1, max_length=50)


class SubscriptionInput(Payload):
    customer_id: str
    plan_id: str
    discount_id: str | None = None
    starts_on: date
    expires_on: date | None = None
    payment_days: int = Field(default=14, ge=0, le=365)
    validity_days: int = Field(default=7, ge=1, le=365)
    lines: list[LineInput] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def dates(self):
        if self.expires_on and self.expires_on < self.starts_on:
            raise ValueError("Expiry precedes start")
        return self


class Transition(Payload):
    action: Literal["QUOTE", "CONFIRM", "ACTIVATE", "PAUSE", "RESUME", "CLOSE", "RENEW"]
    expires_on: date | None = None


class BillingInput(Payload):
    as_of: date


class InvoiceAction(Payload):
    action: Literal["CONFIRM", "CANCEL", "SEND"]
    note: str = Field(default="", max_length=2000)


class PaymentInput(Payload):
    amount: int = Field(strict=True, gt=0, le=100_000_000_000)
    method: Literal["BANK", "UPI", "CARD", "CASH", "OTHER"]
    paid_on: date
    note: str = Field(default="", max_length=2000)
    reference: str = Field(min_length=1, max_length=120)


class VerifyCode(Payload):
    token: str = Field(pattern=r"^[0-9]{6}$")


class PasswordConfirmation(Payload):
    password: str = Field(min_length=1, max_length=256)


class DisableFactor(PasswordConfirmation):
    token: str = Field(pattern=r"^[0-9]{6}$")


class PaymentMethodInput(Payload):
    kind: Literal["BANK", "CARD", "CASH", "UPI", "OTHER"]
    label: Name
    last_four: str = Field(default="", pattern=r"^\d{0,4}$")
