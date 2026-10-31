# Integrated IAM and finance

The teammate's IAM commit `3026801` is now part of this branch's history. Its registration, two-step login, role portals, staff provisioning, password reset and authenticator workflows were adapted into `backend/app/iam.py` and `frontend/identity.js`, sharing the existing FastAPI/PostgreSQL finance app. The original Express prototype entry point is disabled; `iam-react-portal/` remains a reference prototype. Run the combined app from the root README.

## Working identity flows

- Customer registration validates email syntax, unique normalized email and a password longer than eight characters with uppercase, lowercase and a special character. Staff provisioning and password reset use the same strength policy. Signup creates no fake subscriptions or paid invoices.
- Password verification creates a five-minute challenge, not an authenticated session. Accounts without an authenticator receive an email code; enrolled accounts use TOTP. Only successful code verification creates a fresh opaque HttpOnly, SameSite=Strict session cookie.
- Codes are one-use. Challenge attempts and address/account rate limits persist in PostgreSQL, and concurrent code consumption is serialized with the same transaction lock used by finance.
- Authenticator setup requires an authenticated session and password re-entry. A setup secret is returned only during a short initial enrollment and must be verified. An enrolled secret is never returned by login or setup. Stored seeds are encrypted with the private MFA_ENCRYPTION_KEY; TOTP time steps cannot be replayed. Disabling an authenticator requires a password and fresh code.
- A completed sign-in invalidates previous authenticated sessions for that account. Logout revokes the session. Password reset uses expiring hashed one-use tokens, revokes both authenticated sessions and pending sign-in challenges, and preserves an already enrolled authenticator.
- Reset email links open the working reset form. Tokens use a URL fragment so they are not sent in the page request URL, and the client removes them from the address bar after loading.
- Admins provision internal staff and view the user directory. Staff can access operational finance functions, while core prices/taxes/discounts and staff provisioning remain admin-only. Customers can view and print only their own invoices and see only their own subscriptions.
- Customers can manage payment preference labels and optional last four digits. This stores metadata for manual billing; it does not store card numbers/CVV/bank credentials or charge payment providers. All actual payment recording uses the existing validated finance ledger; the old Node payment endpoint is not served.

## Local setup and upgrade

Use `python -m backend.configure_local` after installing requirements. It creates .env from the example only when absent and generates a private authenticator encryption key only when missing. Existing secrets are preserved and never printed. Keep that key stable and backed up if authenticators are enrolled; do not replace it casually.

PostgreSQL and Mailpit run through Docker Compose. Mailpit captures development email at http://127.0.0.1:8025. First sign-in uses the email code there. Failed SMTP delivery blocks email-code login instead of pretending success. SMTP and TOTP require no hosted API service. Set LOCAL_MAILBOX=false outside local development, configure your SMTP transport, and enable SECURE_COOKIES behind HTTPS. Missing encryption configuration prevents authenticator enrollment rather than storing plaintext seeds.

Startup adds IAM tables without rewriting existing finance records. The idempotent `iam_v1_require_verified_sessions` data migration revokes legacy password-only sessions once. Later restarts preserve verified sessions. `backend/schema.sql` is the current bootstrap DDL; future changes to existing table columns still need explicit migrations.

## Validation

Run `npm test` for the PostgreSQL finance and IAM suites, or `npm run test:iam` for IAM only. Tests create/drop a random isolated schema, never the application's schema. The test runner uses assertions and nonzero failure exits.

**22 tests passed**: original finance coverage plus malformed input, staff password policy, role restrictions against real finance APIs, email-code and TOTP verification, OTP expiry/attempt limits/replay, single-device sessions, reset revocation of pending challenges, SMTP failure, encrypted enrollment, private payment preferences, concurrent verification, and idempotent upgrade preserving finance documents. A local dashboard request with 5,000 subscriptions and 5,000 invoices measured 125.5 ms; this is a local observation, not a production guarantee.

Browser checks covered administrator password → email code → live finance dashboard, staff/user management screen, logout, customer password → email code → only-owned portal, and desktop/mobile account layouts. Authenticator enrollment and reset mutations were exercised through integration tests. The larger catalog/quotation/lifecycle editor remains a separate unfinished team module; completing IAM does not mean the whole hackathon product is complete.
