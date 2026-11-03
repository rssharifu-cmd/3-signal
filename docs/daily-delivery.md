# Daily delivery v1 — implementation and release gate

This branch is a local implementation, **not authorization to enable production**.
The workflow requires an explicit `DAILY_DELIVERY_EXECUTION_ACK` repository variable
with value `approved-daily-delivery-v1`. No variable is configured by this change.
The guard runs before loading the eager database module. Imports are inert; only
the approved standalone entry point opens a connection, which it closes on exit.

## Storage and atomicity

Provision an ordinary, durable `daily_deliveries` collection in an isolated test
database first. The release operator must separately approve any production
provisioning. Preflight only reads collection metadata and indexes; it never
creates them. The unique daily identity is the built-in unique `_id` index over
`SHA256([canonicalUserId, UTC targetDate])`, prefixed with `daily-v1-`. No additional
unique index is required. No TTL, capped collection, time-series retention or
deletion of deduplication records is allowed. Optional non-unique operational
indexes: `{status:1,nextAttemptAt:1,leaseUntil:1}` and `{updatedAt:-1}`.

An insert establishes identity. An atomic findOneAndUpdate claims an eligible
record and increments attempts. State writes require majority acknowledgement.
A random owner token and a 15-minute lease fence
every checkpoint. Duplicate-key races on `_id` are harmless; other lock/storage
failures stop the worker before generation or sending. Legacy `delivery_logs`
with the old email/date lock key require reconciliation; they are never replayed
automatically. Treat email-address changes as an identity review, not a fresh send.

## State and recovery

`pending → generating → prepared → sending → accepted`

Recoverable failures become `retry`, with exponential backoff starting at two
minutes, capped at 60 minutes, and at most five claims. Claims, including crash
recoveries, count toward this bound. Known generation failures can retry. Successful
generation is checkpointed in the daily record and reused for every send attempt.
An expired generation lease has an unknown outcome: it becomes `needs_review`
instead of generating twice. This deliberately favors duplicate prevention over
automatic recovery when a generator crashed before its checkpoint.

Persisted report, exact provider payload (including sender), stable idempotency
key, first-send intent timestamp and eventual provider message ID survive restarts.
Provider acceptance is recorded as `accepted`, not mailbox delivery. Permanent
rejections become `failed`; payload/key conflicts become `needs_review`. Unknown
outcomes retry using the identical payload/key within 23 hours of first send
intent. After that window, or after five ambiguous attempts, operator review is
required. A later eligibility change/rejection cannot erase earlier uncertainty.

Resend retains keys for 24 hours, so replay has a one-hour margin:
[provider documentation](https://resend.com/changelog/idempotency-keys).
Never rotate a key or change a frozen payload to work around a conflict. No
automatic resend after the retention window. A fencing/eligibility check occurs
immediately before provider I/O, which has a 30-second timeout. Provider-side
idempotency is still an external dependency; this is not an unlimited exactly-once
guarantee under arbitrary process suspension or provider failure.

The workflow wakes hourly and opens yesterday's completed UTC report target at
13:00. Before 13:00 it continues the target opened on the previous day. Passing
today's date would be rejected by the actual report generator. It also resumes
older persisted nonterminal records; it does not invent historical backfills.
Concurrency is serialized, cancellation is disabled and job runtime is bounded.
Hourly wakeups mean retries execute at the next available workflow run after
backoff, not exactly at the backoff deadline. A mixed success/failure batch fails
the workflow. Missing/inactive owners with pending work surface as operator issues.

## Diagnostics and safe reconciliation

Admin diagnostics now read `daily_deliveries`, showing provider acceptances,
retry/failure counts, expired leases and unresolved records older than 24 hours.
They project state fields and never return stored email bodies or full reports.
Worker output contains hashed delivery IDs and machine-readable reasons, not raw
provider errors, credentials or email content. It does not perform repairs.

For `generation_outcome_unknown`, stop/reconcile any old worker and inspect the
persisted report and provider evidence under a separately approved scoped plan.
For an ambiguous send, reconcile the frozen key, intent time and provider message
ID with the provider. Never delete a record, rotate its key or reset `sending`
blindly. There is intentionally no automatic operator reset command in this patch.
Do not enable production until an operator reconciliation procedure is accepted.

## Verification and limits

`npm test` runs with service credentials scrubbed and all network access blocked.
The delivery regression suite uses synthetic users, in-memory atomic database
operations and a simulated idempotent provider. No live database, scheduler or
email execution is part of these tests. Separate isolated MongoDB 8.0.16
verification on Node 24 passed 13 database checks and 7 mock-provider checks,
including 40 concurrent workers and lease/crash recovery. Real provider replay
behavior and deployed Vercel/GitHub environment isolation remain release checks.

The application targets Node 24: `package.json` specifies `24.x` (also used by
Vercel for new deployments), the daily scheduler selects Node 24, and `.nvmrc`
selects the same major locally. Use the latest available patched Node 24 release.
Vercel manages minor/patch versions, so exact build/function patch parity is not
assumed. Verify the actual deployed runtime after an approved release. The
independent backup/restore tools retain their supported Node 22 configuration;
their production workflows are not changed by this application runtime patch.

Daily claims cover the daily scheduler. Explicit on-demand audits and user-requested
manual email sends retain their existing behavior and are not a cross-entry-point
exactly-once guarantee. Provider-accepted email does not prove inbox delivery;
bounce/delivery webhook tracking is future work. Five attempts, conservative
generation recovery and manual reconciliation can result in a missed daily email.
Diagnostics and pending-work scans currently suit a small deployment; large-volume
rollout needs pagination/aggregation and retention planning that preserves dedup IDs.

Release order: review Phase 2 payment copy and passing tests; verify isolated
environment; review this separate Phase 3 diff; validate Mongo/provider integration
with synthetic recipients and blocked real delivery; approve collection/index
provisioning and explicit workflow enablement separately. Drain/stop all legacy
scheduler workers and reconcile their same-date logs before enabling v1; old
workers do not participate in the new claims or concurrency group. Merge, remote push,
production configuration and deployment are outside this development task.
