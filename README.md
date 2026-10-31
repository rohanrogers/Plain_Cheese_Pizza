# Brightloop subscriptions, IAM and finance

A local subscription application using **FastAPI, PostgreSQL and the existing JavaScript/CSS dashboard**. The teammate's IAM work is integrated with billing, invoices, manual payments and reporting through one database and one authenticated session. Original teammate commit history is preserved.

## Run locally

```sh
docker compose up -d
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m backend.configure_local
# Optional explicit demonstration fixtures; never overwrites existing users.
.venv/bin/python -m backend.demo
npm run dev
```

Open http://127.0.0.1:3000. PostgreSQL uses loopback port 5433. Development email is captured in Mailpit at http://127.0.0.1:8025.

Fixture accounts: `admin@brightloop.local`, `staff@brightloop.local`, `customer1@brightloop.local`. Fixture password: `Demo-only!2026`. Enter the email sign-in code from Mailpit to finish logging in. These are local fixtures, not production credentials. Authenticator enrollment is available under Settings → Account & access. Keep the private encryption key in .env stable once authenticators are enrolled.

Chart.js and its license are vendored under frontend/vendor; there is no frontend build step or runtime CDN requirement for the combined app. To regenerate the pinned vendor asset: `npm ci && npm run vendor`. Node is needed for these maintenance scripts; the web backend is Python.

## Features

- Validated signup, two-step sign-in, optional authenticator enrollment, single-device sessions and working email password reset.
- Admin staff provisioning, server-enforced Admin/Staff/Customer permissions, and customer-only subscriptions/invoices/payment preferences.
- Billing preview/execution, missed-period catch-up, line taxes/discounts, invoice snapshots, period de-duplication, confirmation/cancellation/print/email.
- Partial/full manual payments with balance validation, unique references and an audit ledger.
- Live MRR/ARR estimates, invoice/collection/receivable totals, aging, pagination and PostgreSQL monthly invoice summaries.
- **Module 2: Dynamic Product & Variant Catalog**: Base + variant modifier calculation (`price_modifier` in BigInteger cents, e.g. +$560.00 = `56000` cents), nested variant arrays, and dynamic attribute management.
- **Module 3: Quotation Templates & 5-Stage Subscription Lifecycle**: Strict FSM (`DRAFT` ➔ `QUOTATION` ➔ `CONFIRMED` ➔ `ACTIVE` ➔ `CLOSED`), one-click spawning from preset templates with validity periods, automatic HTTP 422 quotation expiry enforcement, and line-item Price Freezing upon confirmation.
- **Module 5: Standalone Discount & Promotion Rule Engine**: Live validation endpoint (`POST /api/discounts/validate`) verifying date windows, maximum usage limits, minimum order spend, and minimum quantity thresholds with real-time integer cents deduction.
- **Odoo 17/18 Light Theme UI**: Authentic purple navigation bar (`#714B67`), 9-dot App Drawer, Subscriptions Kanban board, Document Sheet (`.o_form_sheet`) with 5-stage status ribbon, live variant simulator, and tactile 120ms micro-interactions.

## Test

```sh
npm run check
npm test
# IAM only:
npm run test:iam
# Modules 2, 3, 5 (Catalog, Quotation Templates, FSM Price Freeze, Discount Validator):
python -m unittest backend.tests.test_modules_2_3_5 -v
```

The comprehensive backend test suite covers authentication/security regressions, permissions, billing correctness, dynamic product variants, quotation templates, price freezing guarantees, discount validation rules, concurrent retries, rollback and reporting. See IAM_INTEGRATION.md for definitions, migration behavior and validation details.

## Unattended billing

The fixture command prints an existing staff ID for audit attribution:

```sh
.venv/bin/python -m backend.scheduler --actor-id STAFF_USER_ID --serve
# One-shot run, suitable for a daily local cron task:
.venv/bin/python -m backend.scheduler --actor-id STAFF_USER_ID
```

The worker checks due periods every 60 seconds and shares the API's PostgreSQL transaction lock. Starting the web server alone does not start the worker. No cloud deployment or OS startup task is configured.

Financial amounts are integer paise; tax/percentage rates use basis points. MRR is current active contracted run rate before discounts and taxes, not recognized revenue. Invoice-month trends use confirmed/paid documents. Payment preferences are labels/last-four metadata; payments are manually recorded, not charged or bank-verified.

Fresh tables are created on startup. IAM's data migration revokes legacy password-only sessions once and preserves finance records. Existing-table schema changes require explicit migrations. .env, encryption keys, databases, dependencies, caches, logs and verification screenshots are ignored. .env.example is a shareable template.

The original Node/React IAM prototype is retained for reference; backend/server.js deliberately refuses to launch it. Use the supported entry point above.
