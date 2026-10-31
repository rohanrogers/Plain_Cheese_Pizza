"""Integrated IAM, adapted from teammate commit 3026801 for the shared database.

A password creates a short-lived challenge, never an authenticated session.
Existing TOTP seeds are never returned during login. All mutations share the
application transaction lock, including attempt limits and challenge consumption.
"""

import base64
import hmac
import io
import os
import secrets
import time
from dataclasses import dataclass
from datetime import timedelta
from typing import Callable

import pyotp
import qrcode
import qrcode.image.svg
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from .models import (
    User,
    AuthSession,
    PasswordReset,
    LoginChallenge,
    SecondFactor,
    AuthThrottle,
    CustomerPaymentMethod,
    now,
)
from .contracts import (
    Login,
    Signup,
    Forgot,
    Reset,
    VerifyCode,
    PasswordConfirmation,
    DisableFactor,
    PaymentMethodInput,
)


@dataclass(frozen=True)
class IAMDependencies:
    db_session: Callable
    current_user: Callable
    admin: Callable
    digest: Callable
    password_hash: Callable
    password_matches: Callable
    serialize: Callable
    mail_message: Callable
    audit: Callable


def create_iam_router(deps):
    router = APIRouter(tags=["Identity and access"])
    digest = deps.digest
    serialize = deps.serialize
    dummy_hash = deps.password_hash(secrets.token_urlsafe(32))

    def cookie(response, name, value, max_age):
        response.set_cookie(
            name,
            value,
            httponly=True,
            samesite="strict",
            secure=os.getenv("SECURE_COOKIES", "false").lower() == "true",
            max_age=max_age,
            path="/",
        )

    def error(status, message):
        # Return errors rather than raise after changing counters, so the
        # request dependency commits rate limits and consumed challenges.
        return JSONResponse({"detail": message}, status_code=status)

    def limited(db, request, bucket, identity="", limit=10, seconds=900):
        host = request.client.host if request.client else "local"
        key = digest(bucket + ":" + host + ":" + identity.lower())
        item = db.get(AuthThrottle, key)
        if not item:
            item = AuthThrottle(
                key=key, count=0, expires_at=now() + timedelta(seconds=seconds)
            )
            db.add(item)
        elif item.expires_at <= now():
            item.count = 0
            item.expires_at = now() + timedelta(seconds=seconds)
        item.count += 1
        db.flush()
        return item.count > limit

    def cipher():
        key = os.getenv("MFA_ENCRYPTION_KEY")
        if not key:
            raise HTTPException(503, "Authenticator encryption key is not configured")
        try:
            return Fernet(key.encode())
        except (ValueError, TypeError):
            raise HTTPException(503, "Authenticator encryption key is invalid")

    def decrypt(value):
        try:
            return cipher().decrypt(value.encode()).decode()
        except InvalidToken:
            raise HTTPException(
                503,
                "Authenticator key cannot decrypt this account; contact the administrator",
            )

    def totp_counter(secret, token, last_counter):
        otp = pyotp.TOTP(secret)
        counter = int(time.time()) // otp.interval
        # Previous/current step only: no future-code acceptance, no replay.
        for step in [counter, counter - 1]:
            if step > last_counter and hmac.compare_digest(
                otp.at(step * otp.interval), token
            ):
                return step
        return None

    def public_user(db, user):
        factor = db.get(SecondFactor, user.id)
        return {
            **serialize(user),
            "two_factor_enabled": bool(factor and factor.enabled),
        }

    @router.post("/api/auth/signup", status_code=201)
    def signup(
        payload: Signup, request: Request, db=Depends(deps.db_session, scope="function")
    ):
        if limited(db, request, "signup-address", limit=20, seconds=3600):
            return error(429, "Too many registrations. Try again later.")
        email = payload.email.lower()
        if db.query(User).filter(User.email == email).first():
            raise HTTPException(409, "An account with this email already exists")
        user = User(
            email=email,
            name=payload.name,
            password_hash=deps.password_hash(payload.password),
            role="CUSTOMER",
        )
        db.add(user)
        db.flush()
        deps.audit(
            db,
            user,
            user.id,
            "CUSTOMER_REGISTERED",
            "Customer account created; no financial documents were fabricated",
        )
        return public_user(db, user)

    @router.post("/api/auth/login")
    def login(
        payload: Login,
        request: Request,
        response: Response,
        db=Depends(deps.db_session, scope="function"),
    ):
        # Bound both per-address and per-email work across service processes.
        if limited(db, request, "login-address", limit=60) or limited(
            db, request, "login-account", payload.email, limit=10
        ):
            return error(429, "Too many login attempts. Try again after 15 minutes.")
        user = db.query(User).filter(User.email == payload.email.lower()).first()
        matches = deps.password_matches(
            payload.password, user.password_hash if user else dummy_hash
        )
        if not user or not matches:
            return error(401, "Email or password is incorrect")
        factor = db.get(SecondFactor, user.id)
        method = "TOTP" if factor and factor.enabled else "EMAIL"
        token = secrets.token_urlsafe(32)
        # A new password check supersedes pending challenges for this account.
        db.query(LoginChallenge).filter(LoginChallenge.user_id == user.id).delete()
        challenge = LoginChallenge(
            token_hash=digest(token),
            user_id=user.id,
            password_fingerprint=digest(user.password_hash),
            method=method,
            expires_at=now() + timedelta(minutes=5),
            attempts=0,
        )
        delivery = None
        if method == "EMAIL":
            code = f"{secrets.randbelow(1000000):06d}"
            challenge.code_hash = digest(token + ":" + code)
            delivery = deps.mail_message(
                db,
                user.email,
                "Your Brightloop sign-in code",
                f"Hello {user.name},\n\nYour sign-in code is: {code}\nIt expires in five minutes and can be used once.\nIf you did not request this, ignore this message.",
            )
            if delivery == "DELIVERY_FAILED":
                return error(
                    503,
                    "The sign-in code could not be delivered. Contact your administrator or try again later.",
                )
        db.add(challenge)
        cookie(response, "brightloop_challenge", token, 300)
        return {
            "require2FA": True,
            "method": method,
            "delivery_status": delivery,
            "message": "Enter your authenticator code."
            if method == "TOTP"
            else "Enter the code sent to your email. Local development mail is captured in Mailpit.",
        }

    @router.post("/api/auth/verify-2fa")
    def verify(
        payload: VerifyCode,
        request: Request,
        response: Response,
        db=Depends(deps.db_session, scope="function"),
    ):
        if limited(db, request, "verify-address", limit=60):
            return error(429, "Too many verification attempts. Try again later.")
        token = request.cookies.get("brightloop_challenge", "")
        challenge = db.get(LoginChallenge, digest(token)) if token else None
        if not challenge or challenge.expires_at <= now():
            return error(401, "Sign-in challenge expired. Sign in again.")
        user = db.get(User, challenge.user_id)
        if not user or challenge.password_fingerprint != digest(user.password_hash):
            db.delete(challenge)
            return error(401, "Credentials changed. Sign in again.")
        if challenge.attempts >= 5:
            return error(429, "Too many code attempts. Start a new sign-in.")
        challenge.attempts += 1
        valid = False
        if challenge.method == "EMAIL":
            valid = hmac.compare_digest(
                challenge.code_hash, digest(token + ":" + payload.token)
            )
        else:
            factor = db.get(SecondFactor, user.id)
            if factor and factor.enabled:
                counter = totp_counter(
                    decrypt(factor.secret_encrypted), payload.token, factor.last_counter
                )
                if counter is not None:
                    factor.last_counter = counter
                    valid = True
        if not valid:
            return error(400, "Invalid, expired, or already used code")
        # New opaque token prevents session fixation. One active device/account.
        db.query(AuthSession).filter(AuthSession.user_id == user.id).delete()
        db.query(LoginChallenge).filter(LoginChallenge.user_id == user.id).delete(
            synchronize_session=False
        )
        session_token = secrets.token_urlsafe(32)
        db.add(
            AuthSession(
                token_hash=digest(session_token),
                user_id=user.id,
                expires_at=now() + timedelta(hours=8),
            )
        )
        cookie(response, "brightloop_session", session_token, 28800)
        response.delete_cookie("brightloop_challenge", path="/")
        deps.audit(db, user, user.id, "LOGIN_VERIFIED", challenge.method)
        return public_user(db, user)

    @router.get("/api/auth/me")
    def me(
        user=Depends(deps.current_user), db=Depends(deps.db_session, scope="function")
    ):
        return public_user(db, user)

    @router.post("/api/auth/logout")
    def logout(
        request: Request,
        response: Response,
        db=Depends(deps.db_session, scope="function"),
    ):
        for model, name in [
            (AuthSession, "brightloop_session"),
            (LoginChallenge, "brightloop_challenge"),
        ]:
            token = request.cookies.get(name, "")
            item = db.get(model, digest(token)) if token else None
            if item:
                db.delete(item)
            response.delete_cookie(name, path="/")
        return {"ok": True}

    @router.post("/api/auth/forgot-password")
    @router.post("/api/auth/forgot")
    def forgot(
        payload: Forgot, request: Request, db=Depends(deps.db_session, scope="function")
    ):
        if limited(db, request, "forgot-address", limit=10, seconds=3600):
            return error(429, "Too many reset requests. Try again later.")
        user = db.query(User).filter(User.email == payload.email.lower()).first()
        if user:
            db.query(PasswordReset).filter(PasswordReset.user_id == user.id).update(
                {"used": True}
            )
            token = secrets.token_urlsafe(32)
            db.add(
                PasswordReset(
                    token_hash=digest(token),
                    user_id=user.id,
                    expires_at=now() + timedelta(minutes=20),
                )
            )
            link = (
                os.getenv("FRONTEND_URL", "http://127.0.0.1:3000").rstrip("/")
                + "/#reset="
                + token
            )
            deps.mail_message(
                db,
                user.email,
                "Reset your Brightloop password",
                f"Hello {user.name},\n\nUse this single-use link within 20 minutes:\n{link}\n\nIf you did not request this, ignore this message.",
            )
        return {
            "message": "If this address is registered, a reset message has been queued. Check your email or the configured local mail service. If no message arrives, contact the administrator."
        }

    @router.post("/api/auth/reset-password")
    @router.post("/api/auth/reset")
    def reset(
        payload: Reset, request: Request, db=Depends(deps.db_session, scope="function")
    ):
        if limited(db, request, "reset-address", limit=15):
            return error(429, "Too many reset attempts. Try again later.")
        item = db.get(PasswordReset, digest(payload.token))
        if not item or item.used or item.expires_at <= now():
            return error(400, "Reset link is invalid or expired")
        user = db.get(User, item.user_id)
        if user.email.lower() in payload.password.lower():
            return error(422, "Password must not contain the email address")
        user.password_hash = deps.password_hash(payload.password)
        db.query(PasswordReset).filter(PasswordReset.user_id == user.id).update(
            {"used": True}
        )
        db.query(AuthSession).filter(AuthSession.user_id == user.id).delete()
        db.query(LoginChallenge).filter(LoginChallenge.user_id == user.id).delete()
        factor = db.get(SecondFactor, user.id)
        if factor:
            factor.pending_encrypted = None
            factor.pending_expires_at = None
        deps.audit(
            db,
            user,
            user.id,
            "PASSWORD_RESET",
            "Revoked authenticated and pending sign-in sessions",
        )
        return {
            "message": "Password changed. Sign in again; your existing authenticator remains enabled if configured."
        }

    @router.post("/api/auth/2fa/setup")
    def setup(
        payload: PasswordConfirmation,
        request: Request,
        user=Depends(deps.current_user),
        db=Depends(deps.db_session, scope="function"),
    ):
        if limited(db, request, "factor-setup", user.id, limit=5):
            return error(429, "Too many setup attempts. Try again later.")
        if not deps.password_matches(payload.password, user.password_hash):
            return error(401, "Password is incorrect")
        factor = db.get(SecondFactor, user.id)
        if factor and factor.enabled:
            return error(
                409,
                "An authenticator is already enrolled. Its secret cannot be displayed again.",
            )
        if not factor:
            factor = SecondFactor(user_id=user.id, enabled=False, last_counter=-1)
            db.add(factor)
        secret = pyotp.random_base32()
        factor.pending_encrypted = cipher().encrypt(secret.encode()).decode()
        factor.pending_expires_at = now() + timedelta(minutes=5)
        uri = pyotp.TOTP(secret).provisioning_uri(
            name=user.email, issuer_name="Brightloop"
        )
        img = qrcode.make(uri, image_factory=qrcode.image.svg.SvgPathImage)
        stream = io.BytesIO()
        img.save(stream)
        return {
            "secret": secret,
            "otpauth_uri": uri,
            "qr_code": "data:image/svg+xml;base64,"
            + base64.b64encode(stream.getvalue()).decode(),
            "message": "Scan and verify within five minutes. This secret is shown only during enrollment.",
        }

    @router.post("/api/auth/2fa/enable")
    def enable(
        payload: VerifyCode,
        request: Request,
        user=Depends(deps.current_user),
        db=Depends(deps.db_session, scope="function"),
    ):
        if limited(db, request, "factor-enroll", user.id, limit=5):
            return error(
                429, "Too many authenticator enrollment attempts. Try again later."
            )
        factor = db.get(SecondFactor, user.id)
        if (
            not factor
            or factor.enabled
            or not factor.pending_encrypted
            or factor.pending_expires_at <= now()
        ):
            return error(400, "Enrollment expired or unavailable; start setup again")
        counter = totp_counter(decrypt(factor.pending_encrypted), payload.token, -1)
        if counter is None:
            return error(400, "Invalid authenticator code")
        factor.secret_encrypted = factor.pending_encrypted
        factor.enabled = True
        factor.last_counter = counter
        factor.pending_encrypted = None
        factor.pending_expires_at = None
        db.query(LoginChallenge).filter(LoginChallenge.user_id == user.id).delete()
        deps.audit(db, user, user.id, "AUTHENTICATOR_ENABLED", "Enrollment verified")
        return {"message": "Authenticator enabled. Future sign-ins require its code."}

    @router.post("/api/auth/2fa/disable")
    def disable(
        payload: DisableFactor,
        request: Request,
        user=Depends(deps.current_user),
        db=Depends(deps.db_session, scope="function"),
    ):
        if limited(db, request, "factor-disable", user.id, limit=5):
            return error(429, "Too many attempts. Try again later.")
        factor = db.get(SecondFactor, user.id)
        if not deps.password_matches(payload.password, user.password_hash):
            return error(401, "Password is incorrect")
        if not factor or not factor.enabled:
            return error(400, "No authenticator is enabled")
        counter = totp_counter(
            decrypt(factor.secret_encrypted), payload.token, factor.last_counter
        )
        if counter is None:
            return error(400, "Invalid or already used authenticator code")
        db.delete(factor)
        db.query(LoginChallenge).filter(LoginChallenge.user_id == user.id).delete()
        deps.audit(
            db,
            user,
            user.id,
            "AUTHENTICATOR_DISABLED",
            "Password and authenticator verified; future logins use email codes",
        )
        return {
            "message": "Authenticator disabled. Sign-in codes will be sent by email."
        }

    @router.get("/api/payment-methods")
    def methods(
        user=Depends(deps.current_user), db=Depends(deps.db_session, scope="function")
    ):
        return [
            serialize(x)
            for x in db.query(CustomerPaymentMethod)
            .filter(CustomerPaymentMethod.customer_id == user.id)
            .order_by(CustomerPaymentMethod.created_at)
            .all()
        ]

    @router.post("/api/payment-methods", status_code=201)
    def add_method(
        payload: PaymentMethodInput,
        user=Depends(deps.current_user),
        db=Depends(deps.db_session, scope="function"),
    ):
        if (
            db.query(CustomerPaymentMethod)
            .filter(CustomerPaymentMethod.customer_id == user.id)
            .count()
            >= 10
        ):
            raise HTTPException(400, "Keep at most ten payment preferences")
        item = CustomerPaymentMethod(customer_id=user.id, **payload.model_dump())
        db.add(item)
        db.flush()
        deps.audit(
            db,
            user,
            item.id,
            "PAYMENT_PREFERENCE_ADDED",
            "Metadata only; no card or bank credentials accepted",
        )
        return serialize(item)

    @router.delete("/api/payment-methods/{id}")
    def delete_method(
        id: str,
        user=Depends(deps.current_user),
        db=Depends(deps.db_session, scope="function"),
    ):
        item = db.get(CustomerPaymentMethod, id)
        if not item or item.customer_id != user.id:
            raise HTTPException(404, "Payment preference not found")
        db.delete(item)
        deps.audit(
            db,
            user,
            id,
            "PAYMENT_PREFERENCE_REMOVED",
            "Customer removed payment preference",
        )
        return {"ok": True}

    return router
