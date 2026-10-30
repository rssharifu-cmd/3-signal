# Phase 1 security implementation and verification

Date: 30 October 2026. Base: c27e0eff4e11b16de42fcef7e3f9cb783a6543dd.
Scope: approved S1–S4. No production data, secrets, deployment settings, or main-branch changes made.

## Implemented behavior

### S1 — account ownership

`api/auth.js` rejects signup for every existing account (409), without adding a password or issuing
a session. Google-only login directs to Google; legacy passwordless login directs to support.
New signup, password login, and verified Google sign-in remain supported.

Login JWTs now declare purpose=session. `api/_lib/authMiddleware.js`, `api/auth.js`, and
`api/user.js` reject other token purposes and legacy OAuth-shaped tokens. Existing login tokens
without a purpose remain accepted until their normal expiry. No signing secret rotation is required.

### S2 — authenticated, owned email

HTTP `/api/send` accepts only `{action:"welcome"}` or
`{action:"watchdog_report"|"digest",reportId:"<saved report identifier>"}`.
It requires a valid account session and loads the recipient, name, profile, and report from MongoDB.
Report lookup includes userEmail; a conflicting stored userId is rejected. Client recipient/content
overrides are rejected. Missing account/report, failed database lookup, and restricted plan deny sending.

`api/_lib/emailSendGuard.js` uses an atomic conditional upsert on MongoDB's unique `_id` for a
60-second account cooldown shared across browser send actions. Duplicate-key collision denies the
send. Failures keep the cooldown because provider acceptance can be ambiguous. Each claimed attempt
gets a Resend idempotency key. This is not a full retry queue or exactly-once delivery guarantee.

Both `js/app.js` callers authenticate. Welcome mail is requested only after a successful profile save.
Report email sends only reportId. Refresh old browser tabs before testing the changed request contract.

The scheduler's direct `sendWatchdogEmail` call stays internal and supplies resolved entitlements.
The helper checks report owner versus recipient and enforces monitoring entitlements. It does not
require a browser JWT. HTTP requests cannot access its internal options.

### S3 — canonical watchdog target

`api/watchdog.js` checks every identity supplied by URL, parsed query, and body. Invalid or contradictory
identifiers are rejected. Ordinary users can target only their own account. Allowlisted admins can
target a resolved existing account by email or ID. Report queries, target entitlements, and pipeline
calls use that resolved account; body precedence no longer overrides authorization.

### S4 — browser-bound OAuth

`api/oauth.js` no longer searches global pending users. It generates cryptographically random state
nonces, uses purpose=oauth_state, and inserts a pending attempt keyed by nonce before returning a URL.
The callback requires its `sharflow_oauth_attempt` cookie. Returned state must match the cookie;
only Bing may omit returned state. Signature, purpose, provider, identity, timestamps, nonce,
origin, and callback URI are validated. An exact, unexpired pending record is atomically deleted
before provider token exchange. Persistence/claim failure denies the operation.

The new cookie name avoids legacy host-only cookie ambiguity. Production apex/www share a scoped
Secure/HttpOnly/SameSite=Lax cookie because the existing callback uses the apex domain. Local
development remains host-only. Legacy in-progress OAuth attempts must restart; saved integrations
are not migrated. Cancellation/provider failure requires a new authorization attempt.

## Verification

Run `npm ci --ignore-scripts --no-audit --no-fund`, then `npm test`.

The new test preloader clears inherited service credentials and blocks fetch, HTTP(S), TLS, and
socket connections. New route tests compile actual source with isolated dependency graphs,
in-memory database fixtures, and mocked provider responses. No .env is loaded by these suites.

Final results on Node v24.14.1 / npm 11.11.0:

| Check | Result |
| --- | --- |
| `npm run test:security` | 45 passed, 0 failed |
| GA4 connection-status suite | Passed; 11 labeled scenarios, legacy summary says 10 |
| Paddle suite | 47 passed, 0 failed |
| Plans suite | 14 passed, 0 failed |
| Research suite with network blocked | 45 passed, 0 failed; parsing/error paths only, not live provider success |
| Routes/compliance suite | 10 passed, 1 failed |
| `node --check` for all tracked/new JavaScript | 45 files passed |

The compliance failure is `Must mention Paddle Merchant of Record`: refund.html lacks the exact
string `Paddle.com Market Ltd` expected by the existing test. Re-executing the unmodified baseline
suite with its files read directly from Git reproduced the same 10/1 result. No test assertion or
legal copy was weakened or changed. Consequently `npm test` exits 1; this branch is not fully green.

Security tests cover new/password/Google authentication, token-purpose separation, recipient/content
overrides, owned/foreign reports, missing/expired credentials/accounts/plans, send races/failures,
actual frontend callers, actual scheduler processUser, canonical self/admin targets, conflicting
identifiers, Google/Bing success paths, cookie-only Bing, missing/mismatched/legacy cookies,
state validation, pending-store failure, expiry, cancellation, provider rejection, and parallel replay.

Not run: database-writing `scripts/test-watchdog.js`, real OAuth, live research/provider checks,
real email sends, staging/browser end-to-end tests, real MongoDB race tests, Node 18/20 compatibility
runs. Mock success is not evidence of production provider configuration or delivery.

## Remaining risks outside this phase

- Email/password accounts still lack email ownership verification and a secure self-service recovery
  flow. Restricting mail to the account address does not prove that a new signup owns that address.
- Signup/login and expensive monitoring calls still need general abuse/rate controls.
- Sessions remain in localStorage with no immediate server-side revocation mechanism.
- OAuth trust still includes broad preview-provider domains; replace with explicitly owned origins.
- Collection uniqueness, historical property isolation, comparison completeness, and AI evidence
  issues remain in the roadmap. This security patch does not establish report accuracy.
- Scheduler retry/deduplication defects remain; browser cooldown is not scheduler delivery protection.
- Pending attempts expire logically but unused records have no automatic cleanup here. Existing
  production indexes are unknown; an old unique email/provider index could reject repeat inserts
  safely. Inspect staging indexes before rollout; no production migration was attempted.
- Dependencies were installed from the lockfile; this work is not a dependency vulnerability audit.

## Manual gates before deployment

1. Review the diff and obtain merge/deployment approval separately. Ensure publishing this branch
   cannot trigger a preview deployment connected to customer services; auto-deployment settings
   were not changed or verified.
2. Use a staging database and provider test accounts. Confirm required collection permissions and
   MongoDB conditional-upsert/duplicate-key and findOneAndDelete behavior with concurrent requests.
3. Verify signup, password login, Google sign-in, and older legitimate login sessions in a browser.
   Google-only duplicate signup must fail without altering the account.
4. Verify Google and Bing OAuth on apex/www and mobile browsers, including cancellation, missing
   cookie, replay, and reconnect. Check actual redirect registrations and Set-Cookie headers.
5. Save a profile, request welcome mail, generate/save a report, and email it to a controlled mailbox.
   Confirm the 60-second limit and that another account's report cannot be sent. Verify actual
   Resend idempotency behavior. Refresh existing tabs to load the new request contract.
6. Run the scheduler against staging fixtures only and verify a controlled recipient receives the
   owned report. Do not trigger the production daily workflow as a test.
7. Resolve the existing legal-copy test discrepancy before declaring the overall suite green.

Remote publication is currently blocked: the GitHub connector returns 403 for branch creation and
Git push dry-run cannot obtain credentials. The local branch/commit and export artifacts are the
deliverable; no remote branch, merge, or deployment is claimed.
