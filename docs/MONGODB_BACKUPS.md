# Encrypted MongoDB backups to Cloudflare R2

## Scope and activation

`.github/workflows/mongodb-backup.yml` runs daily at **02:00 UTC** and allows manual execution.
Only `main` can execute the production job; manually dispatching another branch skips it.
GitHub schedules run from the default branch and can be delayed. Keep the default branch `main`.
This change has not been pushed, deployed or run against MongoDB/R2. It does not change the watchdog.

Use the existing GitHub Actions **repository secrets** directly; no GitHub environment is required.
The job runs only from reviewed main-branch code, has a read-only GitHub token, has no pull-request
or push trigger, and exposes secrets only to the backup execution step. Protect main and restrict
repository/workflow write access. These guards are not a replacement for trusting workflow authors.
The backup performs only mongodump reads; it does not change MongoDB data or permissions. Do not
replace the shared MONGODB_URI secret merely to give this job different permissions: the watchdog
may also depend on it. A dedicated least-privilege backup credential can be a separate future change.
No GitHub environment, MongoDB account or bucket is created by this code.

Confirm these existing repository secrets are present under Settings → Secrets and variables →
Actions → Repository secrets. Secret values are never inspected by this implementation:

| Secret | Requirement |
| --- | --- |
| `MONGODB_URI` | Production source URI explicitly naming the application database; TLS enabled. No cluster-wide, `admin`, `local` or `config` dump. Confirm the DB matches the running application. |
| `BACKUP_ENCRYPTION_KEY` | Existing canonical Base64 encoding of exactly 32 random bytes. Preserve it in an independent secure recovery vault; never commit it. |
| `R2_ACCOUNT_ID` | Cloudflare account identifier. |
| `R2_ACCESS_KEY_ID` | R2 S3-compatible access key, restricted to this bucket. |
| `R2_SECRET_ACCESS_KEY` | Corresponding secret key. |
| `R2_BUCKET_NAME` | Must identify the private `sharflow-backups` bucket; other buckets are rejected. |

Create/confirm that bucket manually: keep public `r2.dev` access and public custom domains disabled.
The token needs Object Read & Write for upload, head, and download verification, including multipart
uploads; do not grant account-wide administrative access. Neither code nor workflow deletes R2
objects or MongoDB records. Configure retention separately as described below.

Allow the GitHub-hosted runner to connect to the source via an approved Atlas/network policy.
Do not broadly expose MongoDB merely to make this job pass. GitHub-hosted IPs are dynamic: use an
approved network arrangement or a separately reviewed fixed-egress runner if your allowlist requires
one. The workflow is designed for ephemeral GitHub-hosted Ubuntu, not a shared persistent runner.

The workflow installs MongoDB Database Tools from MongoDB's signed Ubuntu 24.04/8.0 apt repository
and AWS CLI, and uses Node 22 built-in cryptography. Only tools are installed, not MongoDB Server.
Review tool/source MongoDB major-version compatibility before the first run; retain tool-version
information in the run log. Dependencies are fetched when the workflow actually runs, not by local tests.
The job has a 60-minute limit and serializes backup jobs without cancelling a running backup.

## Data flow, verification and cleanup

1. Validate all settings and the encryption key before connecting.
2. Store only the mongodump connection configuration in a private, RAM-backed `/dev/shm` directory
   with mode 0700 and config mode 0600. The URI is never a process argument or logged.
3. `mongodump --config <private-file> --archive --gzip` selects the entire explicit application
   database, without collection filters or index exclusion. The archive contains BSON and collection
   metadata/index definitions; it does not include other databases, deployment-wide configuration,
   external secrets, R2 data, or every cluster user/role.
4. Pipe archive stdout directly through AES-256-GCM into a mode-0600 encrypted file. No plaintext
   archive is created. Fail if mongodump exits nonzero or produces no archive bytes. Tool stderr is
   suppressed because it may contain a connection URI or sensitive namespace details.
5. Validate the local authentication tag, compute ciphertext SHA-256 and upload only `.shfb` to
   `mongodb/YYYY/MM/DD/<UTC-timestamp>-<random-UUID>.shfb` via R2's HTTPS S3 endpoint.
6. Require successful upload, matching HEAD size/hash metadata, and a successful full encrypted
   download. Recompute SHA-256 and validate its GCM tag. ETag is not treated as a SHA-256 digest,
   especially for multipart objects. A successful log includes only the object key, ciphertext size
   and ciphertext hash. Any subprocess, crypto or verification failure makes the job fail.
7. Remove private config, encrypted working files and encrypted verification download in `finally`;
   zero the decoded key buffer. A separate `always()` workflow step removes both per-run roots,
   including after failures/cancellation where GitHub still permits cleanup to execute.

There are no GitHub backup artifacts, no plaintext output logs, and no `mongorestore` invocation in
the workflow. MongoDB URI/encryption key are not passed to AWS subprocesses; database-tool child
environment does not include R2 credentials. Shell tracing is never enabled.

RAM-backed config avoids writing connection secrets to persistent disks. Node/runtime copies of
secret strings cannot be guaranteed physically erased; force-killed or lost runners cannot execute
cleanup. Security therefore also depends on private temporary permissions and runner ephemerality.
Deleting ciphertext is not a claim of physical SSD erasure. Do not enable swap on a restore machine
holding decrypted content in RAM without an approved encrypted-swap policy.

The file is a logical database dump, **not a guaranteed cross-collection point-in-time snapshot**
while writes/DDL continue. This single-database workflow does not use `--oplog` (which requires a
full replica-set dump), pause production writes, or change production topology. For strict transaction
consistency/sharded-cluster recovery, separately approve Atlas snapshots or another topology-aware
backup method. Review these limits before treating backups as disaster recovery. AES-GCM v1 also
has a per-file payload limit of approximately 64 GiB; larger compressed archives must fail rather
than reuse the nonce or weaken encryption. Monitor job failures and capacity as the database grows.

## Authenticated file format v1

All offsets are byte offsets; no textual encoding is applied to file contents.

| Offset | Length | Meaning |
| --- | --- | --- |
| 0 | 8 | ASCII `SHRFBK01` (format and algorithm version) |
| 8 | 12 | Cryptographically random nonce, newly generated for each encryption |
| 20 | N | AES-256-GCM ciphertext of the gzip mongodump archive |
| 20 + N | 16 | GCM authentication tag |

The complete 20-byte header is GCM additional authenticated data (AAD). Header/nonce, ciphertext,
tag, truncation and appended-byte tampering are rejected. No compression is performed after encryption.
No source URI or plaintext database name appears in the header or object key. The key is not stored
with the backup; there is no password-based derivation or padding. Keep old keys until every backup
using them has expired and recovery no longer needs them. Rotation requires retaining the matching
key out of band; v1 does not embed a key identifier. Nonces are random 96-bit values; retain this key
only for this low-volume backup use, not unrelated encryption workloads.

## Manual decryption and restore

There is no automatic restore path. Use the separate [isolated restore-test procedure](BACKUP_RESTORE_TEST.md)
first. Production recovery requires its own explicit approval and destination review.

On a trusted, access-restricted recovery workstation, download a chosen encrypted object using
bucket-scoped R2 credentials via AWS CLI and the R2 endpoint. Obtain `BACKUP_ENCRYPTION_KEY` securely
from the recovery vault, not a command argument, tracked `.env`, log or shell history. Set `umask 077`
and disable shell tracing before handling credentials.

```bash
node scripts/backups/crypto.js verify /private/backup.shfb
node scripts/backups/crypto.js decrypt /private/backup.shfb /approved-private-volume/restore.archive.gz
# ONLY after independently verifying the destination URI in the private config:
mongorestore --config /private/restore.yml --archive=/approved-private-volume/restore.archive.gz --gzip --stopOnError > /private/restore-private.log 2>&1
```

The decryption utility reads `BACKUP_ENCRYPTION_KEY` from the environment, authenticates without
releasing plaintext first, then writes a private file in a second authenticated pass. It rejects existing
output paths and removes a partial file on failure. Both file passes require an immutable trusted input.
`restore.yml` uses `uri: "..."`, mode 0600, ideally RAM-backed, with the **approved destination** URI.
Tool output is private too: errors can contain document values. Remove the private restore log along
with plaintext files. Never copy the source backup URI into restore configuration. `mongorestore` restores indexes by default;
do not use `--noIndexRestore`, `--noOptionsRestore`, or `--drop` in a restore test. Review any TTL indexes
before restoring old production data: expiration can begin immediately in the isolated database.
After recovery verification, remove decrypted files, config and environment credentials according to
the workstation's encrypted-storage cleanup policy. Never upload decrypted archives as artifacts.

## Independent R2 retention: seven days

Manually open Cloudflare Dashboard → R2 Object Storage → `sharflow-backups` → Settings →
Object lifecycle rules. Add and enable a rule targeting prefix **`mongodb/`**, with the action to
**delete objects seven days after creation**. Do not merely configure incomplete-multipart expiry;
that does not delete completed backups. Optionally use a separate rule to abort incomplete multipart
uploads after one day. Review any existing bucket lock/retention rules that could prevent expiration.
Lifecycle deletion is asynchronous; do not assume exact deletion at the 168-hour boundary.
No lifecycle changes are made by this workflow. This rule deletes R2 backup objects only, never
MongoDB source collections or indexes. Verify the selected prefix and seven-day retention before
saving because this is an intentionally destructive storage policy, separate from the backup job.

## Validation and operations

Run locally without secrets or service access:

```bash
node --test scripts/backups/test-backup.js
node --check scripts/backups/crypto.js
node --check scripts/backups/run.js
node --check scripts/backups/test-backup.js
```

Tests prohibit network/subprocess access and use random synthetic bytes, fake DB output, fake R2
responses and temporary files. They cover independent format decoding, round trips, nonce uniqueness,
wrong keys, corruption, truncation, partial-file cleanup, subprocess failure/empty dumps, settings,
encrypted-only uploads, failed uploads, read-back verification failures, abort cleanup and workflow guards.
They do not prove a real production dump, R2 upload, Ubuntu tool installation or a MongoDB restore.
After approval, manually run the main-branch workflow once, verify its success marker and encrypted
object, then perform the isolated restore test. Enable GitHub Actions failure notifications and check
that a new verified backup appears each day; successful execution is not a substitute for restore drills.

References: [MongoDB dump and archive behavior](https://www.mongodb.com/docs/database-tools/mongodump/),
[MongoDB Ubuntu repository](https://www.mongodb.com/docs/v8.0/tutorial/install-mongodb-on-ubuntu/),
[MongoDB restore](https://www.mongodb.com/docs/database-tools/mongorestore/),
[R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/),
[R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).
