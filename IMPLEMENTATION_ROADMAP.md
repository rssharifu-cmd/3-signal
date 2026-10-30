# Sharflow implementation roadmap

Baseline: `c27e0eff4e11b16de42fcef7e3f9cb783a6543dd` (main rechecked 30 October 2026).
Working branch: `security/phase1-s1-s4-20261030`.

## Phase 1: critical security — implemented locally; review pending

- [x] S1: Existing Google-only, passwordless, and password accounts cannot acquire a password through signup.
- [x] S2: HTTP email requests require a login session; recipient/profile/report come from owned server records.
- [x] S2: Both frontend callers updated and exercised; actual scheduler processUser exercised with mocked delivery.
- [x] S2: Atomic per-account 60-second browser-send cooldown; idempotency key supplied to Resend.
- [x] S3: All target identifiers validated and resolved to one authorized account; admin targeting retained.
- [x] S4: Global fallback removed; signed browser-bound state and exact pending record required.
- [x] S4: One-use pending attempt consumed atomically before token exchange; cookie-only Bing flow retained.
- [x] Session verification rejects OAuth/checkout tokens, including legacy OAuth-shaped tokens; legacy login sessions retained.
- [x] 45 isolated security tests pass; all 45 JavaScript files pass syntax checking.
- [x] Existing safe GA4, Paddle, plan, and network-blocked research suites pass.
- [ ] Existing route/compliance suite is green: 10 pass, 1 pre-existing failure about Merchant of Record wording.
- [ ] Actual provider redirects, browser cookies, MongoDB concurrency, and email delivery verified in authorized staging.
- [ ] Remote branch published: blocked by missing GitHub write permission / Git push credentials.
- [ ] Merge approved and completed.
- [ ] Deployment approved and completed.

See SECURITY_PHASE1.md for behavior changes, tests, residual risks, and manual checks.

## Phase 2: trustworthy report evidence — not implemented

Reverify before proposing changes. Gate: complete and fresh comparison periods, property isolation,
consistent metric units/currency, unknown distinct from zero, raw critical findings preserved,
validated AI output, and reassurance limited to evaluated coverage.

## Phase 3: reliable daily delivery — not implemented

Gate: retryable generation/delivery, expiring leases, scheduler deduplication, accurate run/dependency
telemetry, and operator alerts for missed or failed daily reports. General run throttling belongs here.

## Phase 4: paid subscriptions — not implemented

Gate: Analytics ($9 proposed) and Complete ($19 proposed) price mappings, sandbox purchase and
subscription lifecycle tests, explicit plan enforcement, cancellation access matching policy.
Resolve the existing Merchant of Record test/copy mismatch with business confirmation.

## Phase 5: customer experience and trust — not implemented

Gate: faster onboarding, server-refreshing dashboard cache, actionable evidence-based reports,
incident lifecycle/history, accessible controls, received-email client verification, and marketing
claims that match measurable integration coverage. Add email ownership verification and recovery,
and tighten deployment-origin allowlisting as separate reviewed security work.

Every later phase requires its own proposal and approval. Publishing must not trigger an unapproved
preview deployment; verify branch deployment settings before pushing. Never run the database-writing
watchdog integration suite against customer data.
