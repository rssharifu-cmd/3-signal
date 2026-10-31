# Manual isolated MongoDB restore test

This procedure is intentionally separate from the scheduled backup. It is **not automated** and
must never point at production. Restore content remains sensitive even in a test environment.
Do not start the Sharflow app, scheduler, webhooks or email workers against restored production data.

1. Obtain explicit approval for an isolated MongoDB instance with no route/credentials to production.
   Restrict network access and create a **new empty database** named `sharflow_restore_test_<unique suffix>`.
   Give a temporary restore user permissions only on that database, including index creation.
   Do not grant that credential access to production namespaces. Match source major version/FCV
   and use compatible Database Tools. Keep TTL expiration in mind when comparing old records.
2. On a trusted Linux workstation, install Database Tools, AWS CLI and Node 22+. Use private,
   encrypted storage for the encrypted download and an adequately sized RAM-backed directory for
   decrypted data. If RAM is insufficient, use an approved encrypted scratch volume with appropriate
   cleanup instead. Do not run this in an ordinary CI job or upload any restore artifacts.
3. Securely inject bucket-scoped R2 read credentials, `R2_ACCOUNT_ID`, `BACKUP_ENCRYPTION_KEY`,
   `BACKUP_OBJECT_KEY`, `RESTORE_TEST_URI`, `RESTORE_TEST_DB` and `BACKUP_SOURCE_DB` into the local
   process environment. Values belong in the approved secret manager, never in this document/history.
   The test URI must explicitly name the new isolated DB; source DB is the archived application's DB.
   Review target hostname and credential scope independently; matching a DB name alone proves no isolation.
4. Run the following manually (Bash). Read every command first. Do not enable `set -x`.

```bash
set +x
set -euo pipefail
umask 077
WORK_DIR=$(mktemp -d /tmp/sharflow-restore-ciphertext.XXXXXX)
RAM_DIR=$(mktemp -d /dev/shm/sharflow-restore-private.XXXXXX)
# These directories were created by mktemp, outside the repository.
cleanup() {
  rm -rf -- "$WORK_DIR" "$RAM_DIR"
  unset BACKUP_ENCRYPTION_KEY RESTORE_TEST_URI AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export AWS_EC2_METADATA_DISABLED=true
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

# Download ciphertext only. AWS credentials are supplied securely via environment.
aws --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" --region auto \
  s3 cp "s3://sharflow-backups/${BACKUP_OBJECT_KEY}" "$WORK_DIR/backup.shfb" \
  --only-show-errors --no-progress
node scripts/backups/crypto.js verify "$WORK_DIR/backup.shfb"
node scripts/backups/crypto.js decrypt "$WORK_DIR/backup.shfb" "$RAM_DIR/restore.archive.gz"

# Write a private destination config without exposing its URI as a process argument.
export RAM_DIR
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const target = process.env.RESTORE_TEST_DB || '';
const uri = process.env.RESTORE_TEST_URI || '';
const source = process.env.BACKUP_SOURCE_DB || '';
if (!/^sharflow_restore_test_[a-z0-9_]+$/.test(target) ||
    !/^[A-Za-z0-9_-]+$/.test(source)) throw Error('Explicit isolated target/source names required');
const match = /^mongodb(?:\+srv)?:\/\/[^/?#]+\/([^/?#]+)(?:\?[^#]*)?$/.exec(uri);
if (!match || match[1] !== target) throw Error('Destination URI must name the isolated test DB');
fs.writeFileSync(path.join(process.env.RAM_DIR,'restore.yml'),
  'uri: '+JSON.stringify(uri)+'\n', {mode:0o600,flag:'wx'});
NODE

# No --drop, no production credentials, no automatic production restore.
# Remap only the application's namespaces into the NEW isolated database.
if ! mongorestore --config "$RAM_DIR/restore.yml" --archive="$RAM_DIR/restore.archive.gz" \
  --gzip --stopOnError --nsInclude="${BACKUP_SOURCE_DB}.*" \
  --nsFrom="${BACKUP_SOURCE_DB}.*" --nsTo="${RESTORE_TEST_DB}.*" \
  > "$RAM_DIR/mongorestore-private.log" 2>&1; then
  echo 'Isolated restore failed; service details suppressed to protect data.' >&2
  exit 1
fi
```

5. Before exiting the shell, inspect only the isolated database using your approved database client.
   Confirm the expected collections are present (including empty ones), collection options and indexes
   match expected definitions, and record counts/sample relationships are plausible for the backup time.
   Check unique/TTL/partial indexes and view definitions, and verify that application collection data
   was actually restored: a zero-namespace restore is not a successful drill. Live source counts may
   differ because writes continued; do not compare by querying production as part of this procedure.
   Keep a synthetic reference inventory or an independently approved backup-time inventory for comparisons.
6. Record only backup object key, UTC backup/test time, tools/server versions, verification result,
   namespace/index/count checks and reviewer sign-off. Do not attach customer documents or dump files.
   Exit the shell to trigger scratch cleanup. Confirm the private files are gone, revoke the temporary
   credential and decommission the isolated test database through a separate approved action.
   This procedure does not drop or delete any MongoDB database automatically.

Any authentication, decryption, namespace, index-build or count-validation failure means the drill
failed. Stop and investigate in isolation. Never resolve test failures by pointing at production,
removing authentication checks, or disabling index restoration. Keep the recovery key available in
an independent secure vault; backups without the corresponding key cannot be restored.
