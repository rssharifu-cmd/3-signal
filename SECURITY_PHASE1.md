# Sharflow Phase 1 security follow-up

Date: 30 October 2026. Branch: security/phase1-s1-s4-20261030.
Follow-up base: 6b3cd13dd189913e27502e0ed343ce63f5beca65 (original S1–S4).
Local implementation only. No push, merge, deployment, production connection, real email,
credential change, customer migration, or index mutation performed.

## Ownership and authentication

Signup/request_verification returns a generic 202, never a session or password installation.
New users remain pending. Fixed verification messages contain a 32-byte random token in the
URL fragment; only its SHA-256 hash and 30-minute expiry are stored in the user document.
A new request replaces the previous token. Opening a link does not consume it; explicit password
submission does. Atomic conditional findOneAndUpdate consumes it once with majority write concern.
Passwords are chosen after proof: minimum 12 characters, maximum 72 UTF-8 bytes, bcrypt cost 10.
The frontend removes the token fragment from browser history immediately and keeps it in memory.
No general password-reset/recovery system for already verified accounts is introduced.

Google requires a verified email and valid audience-bound identity token. Claiming an unverified
record clears the previous password, verification challenge, and pending checkout token, rotates
authVersion, and records ownership proof. Previously verified password credentials are preserved
when linking Google. A conflicting established Google subject requires support review.
Sessions require purpose=session and the current account authVersion; user responses omit
passwords, challenge hashes, version values, and pending checkout credentials.

Protected account operations, checkout issuance, integrations, monitoring, scheduler runs, and
both HTTP and internal email helpers require a verified, active account. Profile review gates
checkout and operational work but permits authenticated account review. Public config, send-route
health, and preflight remain public. Paddle webhook processing retains signature-based authority.
Welcome messages have a durable one-request-per-account guard, in addition to the shared 60-second
browser-send cooldown. Failed welcome delivery does not automatically remove its guard.

## Migration impact — rollout approval required

No records are automatically backfilled and no old account is silently marked verified.
All pre-follow-up sessions lack the required version and need fresh sign-in. Legacy password
users must verify their inbox and choose a new password; Google users prove ownership again
through Google. Existing verified records with current versions retain normal password login.
Passwords now use exact characters; leading/trailing whitespace is no longer trimmed by login.
Plans, subscriptions, existing trial dates, saved profiles, and report history are preserved.

Claiming a legacy account with a profile requires explicit profile confirmation before work resumes.
Existing integration records remain stored, but tokens predating integrationResetAt cannot be used.
Users must reconnect and select properties again. Reconnection cannot adopt an old refresh token
when the provider omits a new one. Shared Bing API-key fallback is removed from property discovery.
Scheduler skips unverified/review-required users before trial updates or network work. This can
pause existing customers' monitoring and emails until they complete ownership/review/reconnection.
Approve customer communication and support handling before rollout. No bulk migration is included.

## Minimal abuse limits

MongoDB fixed-window counters use HMAC-obscured identities, atomic increments, majority writes,
and fail closed on storage errors. Signup and resend share 5/hour and 20/day per IP, 1/minute,
3/hour and 5/day per address, plus 100/hour deployment-wide mail budget. An additional conditional
_id cooldown guarantees at least 60 seconds between verification deliveries across window edges.
Login: 50/15 minutes per IP, 5/15 minutes per IP/address, 20/15 minutes per address. Google and
verification completion: 20/15 minutes per IP each. Denials return 429 with Retry-After.
Successful login does not reset counters; account limits can temporarily inconvenience victims.
Login never sends email automatically; the user explicitly requests a link after a failed sign-in.
Verified signup addresses receive no verification mail. Pending signups cannot customize content.

By default IP identity uses the socket address, never arbitrary X-Forwarded-For. Behind a proxy
this can share limits among customers. TRUST_VERCEL_IP=true opts into x-vercel-forwarded-for only
when VERCEL=1; approve it only after confirming that the platform overwrites this header and
requests cannot bypass the trusted proxy. Without that proof keep it disabled and assess capacity.
Distributed abuse/CAPTCHA, retention cleanup, complete recovery, and durable delivery retries
remain future work. Delivery failures retain cooldowns and can invalidate a previous challenge.

## Origins, callbacks, and cookies

APP_ENV=production uses only https://sharflow.online. APP_ENV=staging uses only
https://staging.sharflow.online. Staging remains proposed and uncreated. APP_ENV=development allows
http://localhost:3000 or http://127.0.0.1:3000, selected by APP_ORIGIN. APP_ORIGIN must exactly match
one of that environment's allowed origins. Missing APP_ENV defaults to production; invalid
configuration fails closed. Wildcard Vercel/Cloud Run, alternate Sharflow domains, www CORS,
credentials in URLs, and cross-environment origins are rejected.

Callbacks are always configured-origin + /api/oauth-callback, regardless of NODE_ENV or Host.
OAuth cookies are host-only, HttpOnly, SameSite=Lax, Secure on HTTPS, with identical clearing scope.
Production www must redirect to apex BEFORE initiating auth. vercel.json includes that redirect;
this configuration has not been deployed or browser-tested. No cross-apex/www OAuth continuity
is promised. Production and staging cannot share these cookies. Frontend popup messages require
the same exact origin and the actual popup window. State binds the account authVersion, signed
browser cookie, exact persisted attempt and expiry. Only Bing retains cookie-only callback support.

## MongoDB requirements and read-only checker

Locked Node driver: mongodb 6.21.0. findOneAndUpdate/findOneAndDelete explicitly request document
results with includeResultMetadata=false. OAuth uses new oauth_attempts instead of oauth_pending,
avoiding legacy email/provider uniqueness. Attempts expire by query even without TTL cleanup.
Cooldown upsert treats only a duplicate _id index collision as a denial; other unique-index errors
fail closed. auth_rate_limits relies on atomic document increments, not read-then-write counters.
No transactions or partial indexes are required. No createIndex/dropIndex operation was added.

Required metadata for deployment approval:
- users: standard unique _id plus full, non-sparse, non-partial, simple-collation unique email index.
- oauth_attempts: standard _id and expiresAt TTL with expireAfterSeconds=0; no extra uniqueness.
- auth_rate_limits: standard _id and expiresAt TTL with expireAfterSeconds=0; no extra uniqueness.
- email_send_guards: standard _id; no TTL (welcome guard must remain durable), no extra uniqueness.
- No user-document TTL: an expired verification must never delete an established customer.

scripts/check-security-indexes.js reads only listCollections/listIndexes metadata. It reports
missing/incompatible indexes and collection validators, collation, capped/time-series options.
It never loads .env or falls back to MONGODB_URI. To run later, supply APP_ENV=staging,
SECURITY_INDEX_CHECK_ACK=isolated-staging-only, MONGODB_URI_STAGING and STAGING_DATABASE_NAME
matching sharflow_staging or sharflow_staging_<lowercase suffix>. These names are safeguards,
not proof that a URI points to an isolated service: approve/verify infrastructure first.
Use a metadata-only staging database credential. No real database checker run occurred here.

Real server compatibility, topology, majority acknowledgement, duplicate-key metadata, server-side
concurrent consumption, index provisioning and unsharded _id assumptions remain staging gates.
If sharded, review shard-key/unique-index guarantees before approval. Existing duplicate email
records or incompatible indexes require a separately approved remediation; never delete records
or silently create/drop indexes. TTL cleanup is asynchronous; application expiry checks remain.
Old oauth_pending entries/cookies are not migrated; users restart any in-flight authorization.

## Test results

All safe suites run with the network-blocking preload, scrubbed service variables, fake identities,
in-memory DB and mocked provider/email responses. No database or provider was contacted.
- Security regression: 61 passed, 0 failed (S1–S4 and follow-up).
- GA4 status: 10 passed; Paddle: 47 passed; plans: 14 passed; research: 45 passed.
- Routes/compliance: 10 passed, 1 pre-existing failure: refund.html lacks the expected
  Paddle Merchant of Record wording. Legal copy and that assertion were not changed.
- Every repository JavaScript file checked independently with node --check (51 files).
- Mocked read-only index inspection passes. Real MongoDB/index checker, browser verification UI,
  provider redirects, real delivery, and sandbox checkout are NOT verified.
Overall npm test exits nonzero because of the existing compliance failure.

## Required isolated staging procedure — no infrastructure created

1. Approve a separate staging database, provider OAuth apps, signing/encryption secrets, sandbox
   billing, and a mail sandbox/sink. Never reuse the current Vercel preview: production isolation
   is unverified. Do not push this branch while automatic preview deployment remains unapproved.
2. Approve APP_ENV/APP_ORIGIN settings and callback registrations for production apex and proposed
   staging. Register the exact staging callback, not wildcard domains. Keep EMAIL_DELIVERY_MODE
   disabled until an approved isolated email sink is configured. The only enabled mode implemented
   is resend; do not enable it with live delivery credentials for verification tests.
3. Run the read-only checker against the approved isolated DB. Review results and separately approve
   required index creation/remediation. Confirm majority writes and atomic concurrent behavior on
   the actual MongoDB topology; test an extra conflicting unique index without touching production.
4. With synthetic staging accounts, check signup, resend throttling, token expiry, parallel completion,
   stale-session denial, Google claiming, password login, profile review and integration reconnection.
   Confirm no old password, checkout token, selected property, or source token resumes authority.
5. In real browsers check apex www redirect before initiation; host-only create/clear; staging cookies
   excluded from production; valid Bing state/cookie-only flows and Google state flows; cancellations,
   replay, expired state, invalid origins and multiple popup windows. Inspect network/log redaction.
6. Check owned report delivery into the approved sink, one-time welcome, cooldown concurrency,
   scheduler ownership skips, existing subscription access, and sandbox checkout lifecycle.
7. Obtain separate merge/deployment and customer migration approval. This local commit is not a
   production-readiness assertion. No push, deployment or approval is implied by passing mocks.
