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
- **Admin configuration:** create/edit billing plans, tax rates, and fixed/percentage discount rules under Settings; edit or archive products under Products & Pricing. Staff cannot change core configuration.
- **Quotation editor:** up to 50 product lines, variants, editable templates, expiry dates, payment terms, coupon/tax preview, and guarded editing before confirmation.
- **Customer self-service:** open an owned subscription and confirm, pause/resume, close, or renew when its state and plan policy permit. Renewal skips paused/closed gaps instead of billing those periods retroactively.
- Billing preview/execution, missed-period catch-up, line taxes/discounts, invoice snapshots, period de-duplication, confirmation/cancellation/print/email.
- Partial/full manual payments with balance validation, unique references and an audit ledger.
- Live MRR/ARR estimates, invoice/collection/receivable totals, aging, pagination and PostgreSQL monthly invoice summaries.
- **Module 2: Dynamic Product & Variant Catalog**: Base + variant modifier calculation (`price_modifier` in integer paise, e.g. +₹560.00 = `56000` paise), nested variant arrays, and dynamic attribute management.
- **Module 3: Quotation Templates & 5-Stage Subscription Lifecycle**: Strict FSM (`DRAFT` ➔ `QUOTATION` ➔ `CONFIRMED` ➔ `ACTIVE` ➔ `CLOSED`), one-click spawning from preset templates with validity periods, automatic HTTP 422 quotation expiry enforcement, and line-item Price Freezing upon confirmation.
- **Module 5: Standalone Discount & Promotion Rule Engine**: Live validation endpoint (`POST /api/discounts/validate`) verifying date windows, maximum usage limits, minimum order spend, and minimum quantity thresholds with integer-paise deductions through the same calculation function as billing.
- **Odoo 17/18 Light Theme UI**: Authentic purple navigation bar (`#714B67`), 9-dot App Drawer, Subscriptions Kanban board, Document Sheet (`.o_form_sheet`) with 5-stage status ribbon, live variant simulator, and tactile 120ms micro-interactions.

## Test

```sh
npm run check
npm test
# IAM only:
npm run test:iam
# Modules 2, 3, 5 (Catalog, Quotation Templates, FSM Price Freeze, Discount Validator):
.venv/bin/python -m unittest backend.tests.test_modules_2_3_5 -v
```

All PostgreSQL tests use a disposable schema and preserve the application data. `npm test` runs 48 checks, including frontend/controller contracts and the catalog integration regressions. The backend test suite covers authentication/security regressions, permissions, billing correctness, dynamic product variants, quotation templates, price freezing guarantees, discount validation rules, concurrent retries, rollback and reporting. See IAM_INTEGRATION.md for definitions, migration behavior and validation details.

## Container option

After configuring the private `.env`, run `docker compose --profile app up -d --build --wait` to run the same Python app with PostgreSQL and Mailpit. Stop a native `npm run dev` process first to free port 3000. Plain `docker compose up -d` starts only the database and local mail services for native development. The container runs as a non-root user; private environment files and local dependencies are excluded from the build context.

CI blocks its gate when the tracked-file credential check, PostgreSQL tests, served frontend checks, code-quality/style checks, or actual container startup/health checks fail. It does not claim to provide a complete dependency vulnerability audit. Require **CI Gate — All Checks Passed** in branch protection; if old optional check names were required, update them to match the workflow.

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

The quotation screen supports up to 50 editable product lines or an editable saved template, expiry dates, payment terms, preview totals, and guarded draft/quotation editing. Settings includes Admin plan, tax, and discount creation/editing. Products support editing and archival. Customers can open their own subscriptions and use permitted confirmation, pause/resume, closure, and renewal controls. All actions use shared authenticated APIs. Saved-contract coupon previews use frozen contract prices, and invoice billing revalidates eligibility for each period.

The original Node/React IAM prototype is retained for reference; backend/server.js deliberately refuses to launch it. Use the supported entry point above.

## Verification and known limits

The acceptance rehearsal covers plan/tax/discount setup → multi-line quotation → activation → billing and duplicate retry → invoice confirmation → partial/final payment → reconciled reporting. The performance test uses an isolated dataset of 5,000 subscriptions, 5,000 invoices and a 500-subscription billing batch. On the recorded local run, the batch committed in about 0.11 seconds and the measured read APIs stayed below 0.15 seconds. These are local API measurements, not a guarantee for every browser, network, or deployment.

See [the release handoff and verified security review](LOCAL_RELEASE_HANDOFF.md) for the complete evidence, limitations, future features and demo checklist. Security hardening still includes an explicit verified SMTP TLS context and a deployment-appropriate CSP, Referrer-Policy, Permissions-Policy and HTTPS/HSTS configuration. The review distinguishes active app findings from the unused React reference portal. Do not treat the local demo configuration or a passing CI run as a production security certification.

The removed `DEMO_SCRIPT.md` is not restored by this release; its revert remains in the repository history.
