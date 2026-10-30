# Sharflow implementation roadmap

Branch: security/phase1-s1-s4-20261030. Date: 30 October 2026.

## Phase 1 and approved security follow-up — implemented locally

- [x] Preserve S1–S4 ownership, recipient, canonical target, and browser-bound single-use OAuth protections.
- [x] Pending signup, hashed expiring verification, password setup after proof, safe Google claiming.
- [x] Version-bound sessions and ownership/review gates across protected HTTP and background operations.
- [x] Mongo-backed signup/login/verification limits, fixed mail content, verification cooldown, one-time welcome.
- [x] Environment-specific exact origins, configured callbacks, host-only cookies, www-to-apex redirect configuration.
- [x] Prevent old integration token/property reuse following account claiming.
- [x] Read-only index checker; no automatic index or customer changes.
- [x] P1 blockers corrected: immutable Google subjects, authoritative-email proof, inbox/session-gated unsafe linking, production scheduler delivery configuration.
- [x] 79 security tests; GA4 10, Paddle 47, plans 14, research 45 passed; 51 JS syntax checks passed.
- [ ] Compliance suite fully green: 10 passed, 1 existing Merchant of Record wording failure.
- [ ] Approve documented legacy session/ownership/review/reconnection migration and customer communication.
- [ ] Verify isolated staging topology, indexes, concurrent majority writes, trusted proxy IP configuration.
- [ ] Verify browser signup/cookies, exact OAuth callbacks, sandbox email/checkout and existing subscription workflows.
- [ ] Production isolation of previously published Vercel preview established (do not use it for testing).
- [ ] Approve publishing without triggering another unapproved deployment; follow-up remains local.
- [ ] Separate merge and deployment approval.

See SECURITY_PHASE1.md for configuration, migration impact, exact limits, residual risks and staging procedure.

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
claims that match measurable integration coverage. Ownership verification and exact origins are implemented above; complete account recovery remains future work.

Every later phase requires its own proposal and approval. Publishing must not trigger an unapproved
preview deployment; verify branch deployment settings before pushing. Never run the database-writing
watchdog integration suite against customer data.
