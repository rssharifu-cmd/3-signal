# Phase 2/3 production release procedure

Prepared 2026-11-03. Status: READY FOR SCOPED OPERATOR APPROVAL, NOT RELEASED.
No production actions are authorized by this document. Never print credentials,
customer email bodies, OAuth tokens or database connection strings into logs.

## Evidence and exact scope

Local application stack, in dependency order:

| Commit | Change |
| --- | --- |
| `07e58d8083722d90ce5788e885e0c4949f1739b9` | Report trust/rendering |
| `204a3428852a0910257d62153abddc89ff6ca8e1` | Pre-launch payment wording; checkout inactive |
| `0f14c3bd32f8b77fed02111e8ab6a6b0925a1b9e` | Durable daily delivery |
| `360398c35fc24ed66b0cb37fbfa4c578960edf05` | Application and scheduler Node 24 |

All four form one ancestry chain above base
`9fd658c147b666b091a33bfcc9ee15ac35917d25`. Do not cherry-pick the whole
stack after merging one of its ancestors. If main moves or merges are squashed,
compare patch equivalence before rebasing remaining changes; verify changed
behavior only, rather than repeating every unchanged suite.

Previously completed: full isolated regression suite, clean dependency install
and real MongoDB 8.0.16 verification on Node 24.22.2. MongoDB: 13 database checks
plus 7 mock-provider checks, 20 pass / 0 fail. No real provider or Atlas failover
behavior has been established. Keep existing successful backup system intact.

GitHub read-only snapshot on preparation date:
- PR #4 is open, unmerged: head `07e58d8`, base `9fd658c`.
- Main daily-digest workflow selects Node 20 and runs daily at 13:00 UTC.
- This snapshot does not prove that the workflow is enabled, idle, or the only
  worker. Recheck operational state at cutover.

## Stage A — freeze and read-only production evidence (approval required)

Requested authorization is limited to: push the reviewed local release branch
(a Vercel Preview may result); disable ONLY `.github/workflows/daily-digest.yml`;
inspect its active/queued/recent runs; and inspect production collection/index
metadata plus narrowly scoped delivery/report/provider evidence. No merge,
database writes, customer sends, workflow dispatch or scheduler enablement.
Confirm Preview has separate database/email settings before pushing: arbitrary
Preview API calls must not access production secrets or send real email.

1. Record current main SHA, last successful Vercel production deployment, rollback
   deployment ID, workflow enabled state and execution-ack variable presence.
   Record presence/configuration checks, never secret values. Capture existing
   backup's most recent successful run and restore evidence; do not rebuild it.
2. Disable the daily-digest workflow to prevent further scheduled runs. Keep
   backup/restore workflows untouched. Do not blindly cancel an in-flight send.
3. List queued/in-progress daily runs and their commit SHAs. Allow running legacy
   workers to finish; investigate stalled runs before intervention. Confirm no
   external cron, Vercel cron, local/manual process or operator dispatch also
   invokes the old scheduler. Pause operator-triggered sends during cutover.
4. Require zero running/queued old workers and account for any possibly accepted
   send from an interrupted run. Waiting 15 minutes alone is not drain evidence:
   old workers do not implement the new lease/concurrency protocol.
5. Confirm which Atlas cluster/database the production deployment and scheduler
   actually select, using protected configuration. Never infer the DB name from a
   URI default. Use a database-scoped read-only identity where available, with
   listCollections/listIndexes permissions. No dotenv fallback or application
   database-module import is needed for inspection.
6. Read collection metadata and indexes for `daily_deliveries`; reuse existing
   security-index requirements for `users`, `oauth_attempts`, `auth_rate_limits`
   and `email_send_guards`. Existing index checker is staging-only: do not bypass
   its guard to connect production. Use the approved read-only operator session.
7. Record the actual UTC cutover timestamp and compute the new first target via
   `scheduledDate`: before 13:00 UTC it is UTC date minus two days; from 13:00 it
   is UTC date minus one day. At 13:00 UTC it is 16:00 in Riyadh. Recalculate if
   cutover crosses that boundary.
8. Review legacy logs and associated reports around cutover, plus every unresolved
   old worker/date. Include execution timestamps, explicit report targetDate,
   owner identity/email history and provider receipts. A date window is only an
   initial filter; widen it for unresolved evidence. Preserve source records.

Stage A output: main/deployment references; worker-drain evidence; index/options
findings; intended first target; counts of reconciled/held legacy items; and exact
proposed database writes (if any). Keep per-customer evidence in restricted storage,
with hashed delivery IDs in general operator logs. Unknown evidence is a HOLD.

## Collection acceptance and minimal provisioning (separate approval)

`daily_deliveries` must be an ordinary durable collection with standard unique
`_id` identity. No TTL, extra unique indexes, capped/time-series configuration,
expiry/deletion of daily IDs or unreviewed validators/collation. Existing runtime
preflight does not itself reject every validator/collation configuration: the
operator must review these separately. Verify production role can read metadata
and perform required writes; do not grant broad admin access as a workaround.

If missing, propose ONLY creation of the normal `daily_deliveries` collection,
which creates built-in `_id`. No optional indexes are necessary for first release.
Under the later approved database-write window, the minimal mongosh operation is:

```javascript
// Run only after confirming the selected production database and explicit approval.
// If the collection already exists, inspect it; never drop/recreate it.
db.createCollection('daily_deliveries');
```

If incompatible indexes/options exist, stop and propose their exact repair with
impact/rollback. Never drop an index or collection during inspection. Security
index findings get a separate scoped migration; do not mix them into delivery setup.

## Legacy and ambiguous delivery reconciliation

For each owner/date, retain a restricted ledger: hashed new daily ID, legacy log
reference, actual report date, run SHA/timestamps, provider receipt reference,
evidence classification, disposition, reviewer and approval reference.

| Evidence | Disposition |
| --- | --- |
| Provider acceptance proved for that owner and actual report date | Preserve receipt; prevent another send for that date |
| `completed` alone, even with `emailSent` | Insufficient to prove inbox delivery; correlate provider/report evidence |
| `failed`, `in_progress`, missing receipt, timeout or interrupted worker | Outcome unknown; hold, no automatic resend |
| Definitive rejection/no send, verified against report and worker evidence | Record evidence; any recovery send requires a separately approved case |
| Owner/email change or inconsistent report date | Identity/date review; no new claim as a workaround |

Old scheduler used execution-day lock dates; new scheduler uses completed UTC
report dates. Never blindly shift legacy dates or bulk-copy old logs into the new
collection. A matching legacy email/date causes the new worker to create
`needs_review`; a nonmatching legacy date is NOT proof that no email was sent.
Cross-date provider/report evidence must be checked before enabling the new worker.

If overlap/unknown evidence could allow duplicate delivery, keep the scheduler
disabled. Propose a reviewed per-record suppression/migration with exact immutable
identity and evidence, or wait for an explicitly approved safe target. This
procedure does not authorize a generic status reset or fabricated accepted row.

For existing new-system records: preserve payload, idempotency key, firstSendAt,
providerMessageId and status history. Replays are only the normal code path with
the same key/body inside 23 hours of first intent and within five attempts.
Unknown generation, expired replay window, key conflict or exhausted unknown
outcome stays `needs_review`. Do not reset attempts, delete claims, rotate keys,
or manually rerun the old scheduler. Provider acceptance is not inbox delivery.

## Stage B — reviewed provisioning and release (separate approval)

Only after Stage A findings are concrete and accepted:

1. Approve exact database provisioning/suppression actions, if necessary; capture
   pre-change metadata and use the existing backup evidence. Verify the resulting
   collection/index metadata without generating reports or sending email.
2. Keep daily workflow disabled and `DAILY_DELIVERY_EXECUTION_ACK` unset. Confirm
   no stale acknowledgement can enable delivery when the workflow is re-enabled.
3. Release report trust and payment wording before the daily-delivery implementation;
   preserve dependency order. The Node 24 follow-up belongs with the Phase 3
   release. Each main update may auto-deploy: approval must cover those updates.
4. Verify final main contains the equivalent of all four patches and the released
   Vercel deployment matches that main revision. Verify actual Node major 24 in
   build/runtime evidence. A source declaration alone is not runtime proof.
5. Inspect the deployed public pricing/legal surfaces once: checkout unavailable,
   Paddle inactive, proposed pricing disclosed. Check auth/dashboard/report access
   using the operator's own account without triggering report generation or email.
   No redundant preview comments or screenshot cycles are required.

## Stage C — scheduler enablement and first monitored run (separate approval)

Approval must explicitly permit real production report generation, its database
writes and customer email for the eligible-user batch. The current scheduler has
no one-user canary flag: never promise a one-recipient run or fake a canary by
changing customer eligibility. If a canary is required, prepare it separately.

1. Reconfirm no legacy workers, unresolved target overlap, unsupported collection
   options, missing security configuration, or review items affecting that batch.
2. Record computed target date, eligible-user count and expected recipient scope.
3. Set `DAILY_DELIVERY_EXECUTION_ACK=approved-daily-delivery-v1`, enable daily
   workflow, and observe one run on final main. Dispatching it is a real send
   action and must be included in approval. The hourly cron provides recovery;
   do not launch extra runs to hurry retries.
4. Compare run summary with durable statuses and provider acceptance receipts.
   Do not equate a green workflow or provider acceptance with inbox delivery.
   Investigate retry/failed/needs_review/error and pending inactive/missing owners.
5. Observe the next scheduled run for duplicate prevention and pending recovery.
   Escalate meaningful failures; do not rerun all regression suites after release.

## Stop and rollback

On unexpected sends, ownership issues, incompatible indexes or uncertain outcomes:
disable daily workflow, remove acknowledgement, stop new dispatches, and account
for running work. Do not blindly terminate in-flight sends. Preserve all claims,
legacy records, keys, payloads and provider evidence.

If app rollback is necessary, use the recorded known-good Vercel deployment under
approval. Keep scheduler disabled: rolling back application code must NOT restart
the old worker. Never roll back by deleting `daily_deliveries` or resetting states.
Reconcile any acceptance during the incident before any later re-enable decision.

## Approval record

| Stage | Current state |
| --- | --- |
| Local code, regression and isolated MongoDB verification | Complete |
| Procedure and reconciliation rules | Prepared |
| A: Preview isolation, push, scheduler freeze, production read-only evidence | Awaiting explicit approval |
| B: Exact database writes and merge/deploy | Not requested until Stage A evidence |
| C: Real generation/email and scheduler enablement | Not requested until Stage B verification |

Lemon Squeezy products, checkout/webhooks and customer launch follow this release.
No payment operations are included in any of the above scopes.
