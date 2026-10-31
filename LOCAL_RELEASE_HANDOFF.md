# Brightloop: release handoff and verified security review

**Date:** 31 October 2026 (India time)
**Baseline incorporated:** `d80aef6` on `main`, including the demo-script revert
**Publication scope:** the owner authorized the README, application updates, tests and this report for publication.
**Decision:** feature development is frozen. Complete verification and publish through the protected PR workflow; no force push or protection bypass.

## Current state

The app remains running at http://127.0.0.1:3000. The latest local work adds Admin plan/tax/discount configuration, product editing/archival, multiple-line quotations and templates, quotation preview and draft editing, expiry/payment terms, and customer subscription actions including renewal. Existing role checks, invoice snapshots, and billing de-duplication remain in place.

Verification below records the local acceptance checks. The release PR must pass the required GitHub CI gate before merge; a previous baseline CI result does not verify new changes. No hackathon submission is claimed.

## Verification completed

- **48 automated checks passed:** 41 PostgreSQL/backend checks and seven frontend/controller contracts.
- Following final customer-view cleanup, the seven frontend checks, all active JavaScript syntax checks, Python bug-pattern checks, and Git whitespace checks passed again.
- Browser rehearsal: Admin saved a plan, a tax rule, and a discount; built a two-product quote with a variant, coupon, expiry, and payment terms; saved a multi-line template; edited the draft; and advanced it through Quotation, Confirmed and Active.
- Customer browser rehearsal: opened their own contract, paused/resumed it, and renewed its expiry. Staff-only billing/coupon tools are hidden in that view. Backend ownership and role restrictions are covered by tests.
- The full automated business rehearsal covers configuration → quote preview → contract activation → billing and retry → invoice confirmation → partial/final payment → reconciled dashboard totals.
- No browser console errors were reported in the final captured log.
- The local API was restarted with the changed backend. The local freeze checks did not include a fresh Docker build; the release CI includes a fresh container build/startup check. Consult the release PR check results rather than attributing an older container run to this revision.

### Performance evidence

Dataset: **5,000 subscriptions, 5,000 initial invoices, and a 500-subscription billing batch** in a disposable PostgreSQL schema. Read endpoints were sampled three times. The application database was not used for the load fixtures.

| Operation | Maximum measured local time |
| --- | ---: |
| Dashboard | 201.53 ms |
| Filtered dashboard | 172.19 ms |
| Subscription list / search / last page | 32.12 ms |
| Invoice list / search / last page | 16.20 ms |
| Subscription / invoice detail | 7.68 ms |
| Invoice print | 3.76 ms |
| Catalog | 5.23 ms |
| 500-subscription billing preview | 19.69 ms |
| 500-subscription billing commit | 1410.68 ms |
| Repeated billing run | 14.02 ms; zero duplicate invoices |
| Customer portal's three API reads combined | 71.63 ms |

These measure authenticated HTTP requests through the local test client, not full browser rendering, a remote network, or production hardware. They support the under-two-second API target for this dataset; they are not a universal performance guarantee. Raw measurements: ignored `test-results/completion-performance.json`.

## Teammate security report: verified findings

The pasted report names branch `ci/enable-auto-merge`, but does not provide its audited commit hash or reproduction evidence. Its line numbers and several examples match older code, not the active frontend. Its “Applied” checklist is not proof that a fix exists locally or on main. The claimed critical/high counts should not be copied as a verified security score.

| ID | Assessment against the current local code |
| --- | --- |
| C1: automatic customer with a fixed password | **Not present now.** Template spawning requires an explicit customer and uses the standard validation path. No fallback customer account is created there. |
| C2: passwords embedded in active `frontend/app.js` | **Not present now.** Quick-login selects a local fixture email and still requires a password. There is no embedded password or automatic authenticated session in that function. Explicit demo credentials exist in the documented opt-in demo fixture command; do not treat those accounts as production users. |
| C3: demo passwords in React portal | **Present in the unused reference portal.** `iam-react-portal/src/App.jsx` contains demo-password buttons. This directory is not served or copied into the supported Python app image. Remove/adapt them before ever publishing that separate portal. |
| H1: missing CSP/HSTS/Referrer/Permissions headers | **Confirmed hardening gap.** The active middleware does not set these headers. Missing headers alone do not prove a critical exploit. HSTS belongs on a real HTTPS deployment; a strict CSP needs work because the current UI uses inline scripts/handlers. Blindly adding a strict policy can break the app. |
| H2: unescaped active UI record names | **The cited examples are not reproduced in the current controller.** The active app, catalog, and configuration render record text through `esc()`. This scoped review does not prove every possible XSS path is absent. |
| H3: missing `esc()` helper | **Incorrect for current code.** `frontend/app.js` defines it and the other controllers use it. |
| H4: missing customer ID / unauthenticated template route | **Incorrect for current code.** Customer ID is required, the route requires an operator, and customer/plan/product rules are validated. The original report even describes the route as operator-only while claiming it needs no authentication. |
| H5: active frontend stores session tokens in localStorage | **Not present now.** The served frontend uses same-origin requests and HttpOnly cookies. No such localStorage token code was found in the active scripts. |
| M1: logout never reaches the server | **Incorrect for current code.** `logoutUser()` calls `/auth/logout`; the backend deletes the authenticated session and pending challenge and clears cookies. |
| M2: submitted coupon code echoed as a security leak | **Cited message is not current.** Invalid-code errors are generic. Eligibility reasons are shown to authenticated operators who already have catalog access; the report does not establish an enumeration vulnerability. |
| M3: minimum nine-character password is a bug | **Not a statement violation.** The supplied problem statement says “more than eight characters”; the current policy requires nine or more. Do not reduce it to eight just because this report suggests it. |
| M4: React portal points at port 5000 | **True in the unused reference portal.** The active frontend uses relative `/api`, served on port 3000. This is a blocker only if someone tries to run/publish that legacy portal. |
| M5: unused React symbols | **Maintenance/lint concern, not a demonstrated security exploit.** No full reference-portal lint audit was performed during this freeze. |
| M6: logout changes the user to Admin | **Incorrect for current code.** It sets `currentUser` to `null`. |
| L1: SMTP STARTTLS lacks an explicit verified context | **Confirmed production-mail hardening item.** The SMTP path calls `starttls()` without `ssl.create_default_context()`. Configure certificate verification before enabling authenticated external SMTP. Local Mailpit verification does not test external TLS. |
| L2: Server-Timing header | **Present; informational.** It reports request duration and supports the app's performance display. The report does not demonstrate a timing exploit. Consider deployment-specific exposure later. |
| L3: React effect / `checkAuth` warning | **Not a confirmed runtime error.** The effect callback runs after render; the quoted code does not by itself establish an initialization failure. Any lint claim needs the exact rule and output. The reference portal was not built here. |
| L4: scrypt cost | **Future password-storage review.** Current hashing uses a per-password salt and scrypt. Increasing its fixed cost without a compatible migration/verification strategy would invalidate existing passwords. Benchmark and version the scheme rather than changing the constant during the freeze. |
| L5: security middleware excludes static responses | **Incorrect as stated.** The HTTP middleware wraps API and static responses; the cache policy varies by path. Referrer-Policy is absent, but that duplicates H1 rather than proving static responses bypass middleware. |

### Security work to schedule after the freeze

1. Add an explicit verified TLS context for external SMTP and test delivery failures/certificate errors.
2. Design CSP without breaking inline handlers; add Referrer-Policy and Permissions-Policy, and configure HSTS at the HTTPS edge.
3. Before any public deployment: enable secure cookies, disable the local message-content mailbox, keep demo users out of real customer data, manage/back up the MFA encryption key securely, and use appropriate database/network permissions. Local HTTP/Mailpit settings are not production defaults.
4. Review the reference React portal separately if it will ever ship. It is not the active app.
5. Schedule a real dependency/security review and password-hash cost/migration assessment. A green CI credential check is not a complete penetration test or dependency vulnerability audit.

No security-header, password-hash, or SMTP behavior changes were introduced from the pasted report during this freeze.

## Known bugs, limitations, and unverified areas

No reproducible blocking failure remains in the tested flows. This is not a claim that the application has zero bugs.

- **Historical developer notes are stale:** earlier research/status files describe older implementations. Use this handoff for the current local state.
- **Kanban shows its first page:** the UI labels this limitation; use the paginated list for the complete dataset.
- **Quotation edits reprice before confirmation:** draft/quotation editing uses current catalog prices and resets validity from the chosen validity-days value. Confirmed contracts remain protected from editing.
- **Reference portal incompatibility:** the unused React app still has its own legacy routes, port, and demo buttons; do not launch it as the supported frontend.
- **Production infrastructure is unverified:** latest local changes have not been deployed or subjected to production SMTP/TLS, distributed load, backup/restore, or production migration testing.
- **Schema evolution:** startup creates tables and an IAM data migration exists; a comprehensive versioned schema migration/rollback workflow is future work.
- **Discount-code uniqueness:** enforced through the serialized API write path; direct database imports need equivalent validation or a database uniqueness migration.
- **Unexpected browser/network failures:** API errors are surfaced, but a complete offline synchronization/retry queue has not been implemented.

## Remaining and future features

The previously identified Admin screens, multiple quotation lines, expiry/payment terms, and customer lifecycle controls are implemented locally. Do not list them as entirely missing now.

Potential future work, deliberately stopped at the freeze:

- Automated term extension/renewal policies beyond explicit renewal and recurring invoice scheduling.
- Multiple simultaneous attribute combinations per product line; the current line selects one variant.
- Regional/jurisdiction tax matrices beyond the current product-linked tax rule.
- Credit notes, refunds, cancelled-invoice reissue rules, and accounting-period controls.
- Actual payment gateways, bank feeds, or automatic bank reconciliation. Current payments are manual ledger records; no real charge is made.
- Exportable reports, richer churn history/cohort analytics, and larger/distributed performance testing.
- Durable email retry/outbox workflows and a full production operations/monitoring plan.

These are future capabilities or deployment work, not a claim that the supplied problem statement mandates every item.

## Demonstration handoff

Prepare and rehearse a 5–6 minute functional walkthrough with all three teammates:

1. **0:00–1:20 — Admin owner:** show role separation; open Settings and a saved plan/tax/discount; show a product and variant modifier.
2. **1:20–2:40 — Subscription owner:** build/apply a multi-line template, enter expiry/payment terms, preview totals, and follow Draft → Quotation → Confirmed → Active. Show that a confirmed price is frozen.
3. **2:40–4:20 — Billing owner:** preview/run due billing, repeat to show zero duplicates, confirm an invoice, record partial then final payment, and show remaining balance/audit trail. Use a fresh reference for each payment.
4. **4:20–5:30 — Shared close:** show the customer's own records and pause/renew controls, then finance totals and the actual measured benchmark. Explain that payments are recorded locally, not bank-verified.

Local browser rehearsal records: `Demo Rehearsal Monthly`, `Demo Rehearsal GST`, `REHEARSAL10`, `Demo Rehearsal Bundle`, and contract `SUB-4938C471` for the local demo customer. Its renewal was tested to 31 March 2027. The existing billing worker generated its draft invoice. These are local demonstration data, not production transactions.

Screenshots and raw benchmark results are ignored artifacts under `test-results/`. The 5,000-record load fixtures were isolated and removed with their disposable schema.

## Submission and Git checklist — team-owned

The owner subsequently authorized committing/publishing the README, application changes, tests and this report. Submission-portal access, evaluator access changes and video uploads remain outside this release.

Release and submission checklist:

- Review the exact staged files, including this report, and exclude `.env`, keys, local data, dependencies and screenshots.
- Have each teammate commit their own work with accurate attribution.
- Use a normal branch/PR workflow with required CI; never force push or bypass main protection.
- Run the updated CI and a fresh-machine demo before submission.
- Team leader verifies the selected statement, repository link, public/evaluator access, portal timeline, and an accessible functional demo video within the organizer's stated duration.

No submission or new video was produced during this development task. The report is included in the owner-authorized release; private research notes and verification screenshots are excluded.
