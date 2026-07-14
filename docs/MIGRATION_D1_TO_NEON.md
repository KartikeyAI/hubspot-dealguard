# Controlled D1-to-Neon data cutover

This runbook governs the one-time migration of an existing DealGuard database from Cloudflare D1 to Neon PostgreSQL. It is separate from routine PostgreSQL schema migrations.

Do not execute a production cutover from an unreviewed branch. Do not delete or mutate the source database during the migration window.

## 1. Required evidence

Create a change record containing:

- exact release commit SHA;
- source database name and Cloudflare account;
- target Neon project, branch, database, and region;
- Hyperdrive configuration ID;
- Tigris backup bucket and object key;
- planned write-freeze start and maximum duration;
- named operator and approver;
- source snapshot SHA-256;
- import and verification report paths;
- staging acceptance run;
- rollback owner and decision deadline.

Secrets and connection strings must not be copied into the change record.

## 2. Preconditions

The following must be true before the write freeze:

1. PR CI is green at the exact release SHA.
2. Release readiness passes for staging.
3. The target Neon branch is new or contains only DealGuard schema-migration records.
4. PostgreSQL migrations apply through `0014_neon_tigris_queues.sql`.
5. `npm run db:migrate:check` and `npm run db:validate` pass.
6. Staging Hyperdrive connects to the intended Neon branch.
7. Staging scan, delivery, and maintenance queues exist with dead-letter queues.
8. The staging Tigris bucket is accessible and backup checksum verification succeeds.
9. The current Worker deployment and source database are independently recoverable.
10. A signed read-only HubSpot acceptance run has passed against staging.

## 3. Dry run

Perform at least one full rehearsal against a copied or non-production source database.

```bash
npm run migration:d1:snapshot -- \
  --database dealguard-staging \
  --output .release/migration/source-snapshot.json

DATABASE_URL="$NEON_REHEARSAL_DATABASE_URL" npm run db:migrate

DATABASE_URL="$NEON_REHEARSAL_DATABASE_URL" npm run migration:d1:import -- \
  --input .release/migration/source-snapshot.json \
  --report .release/migration/import-report.json

DATABASE_URL="$NEON_REHEARSAL_DATABASE_URL" npm run migration:d1:verify -- \
  --input .release/migration/source-snapshot.json \
  --report .release/migration/verification-report.json
```

Review failed constraints, transformed values, unsupported source tables, row-count differences, and hash differences. Correct the migration tooling or schema; never edit customer rows ad hoc to make a report pass.

## 4. Write freeze

At the approved start time:

1. stop scheduled scans and maintenance producers;
2. pause or drain scan, delivery, and maintenance consumers;
3. prevent configuration, billing, remediation, policy, and handoff mutations;
4. retain inbound HubSpot and Dodo events for controlled replay where supported;
5. record the final source database timestamp and queue depth;
6. verify that no write-producing job remains active.

The source database stays available for read-only inspection. If a complete write freeze cannot be established, stop the cutover.

## 5. Final source snapshot

Create the final deterministic JSON snapshot:

```bash
mkdir -p .release/migration
chmod 700 .release/migration

npm run migration:d1:snapshot -- \
  --database dealguard-production \
  --output .release/migration/source-snapshot.json
```

The snapshot command:

- enumerates application tables from `sqlite_master`;
- excludes provider and migration bookkeeping tables;
- records source columns and primary-key order;
- reads rows in bounded batches;
- stores a deterministic per-table content hash;
- writes a manifest checksum;
- never prints row contents.

Treat the snapshot as sensitive customer data. Restrict it to the operator account and encrypt it immediately:

```bash
openssl enc -aes-256-cbc -pbkdf2 -salt \
  -in .release/migration/source-snapshot.json \
  -out .release/migration/source-snapshot.json.enc

npm run storage:backup:upload -- \
  .release/migration/source-snapshot.json.enc \
  backups/production/2026-07-14/d1-final-source-snapshot.json.enc

npm run storage:backup:head -- \
  backups/production/2026-07-14/d1-final-source-snapshot.json.enc
```

Record the Tigris object key, size, ETag, and SHA-256 metadata. Do not proceed if verification fails.

## 6. Prepare target Neon branch

Use a dedicated target branch so the candidate can be discarded without affecting an existing database.

```bash
NEON_DATABASE_URL="$NEON_TARGET_DATABASE_URL" npm run db:migrate
NEON_DATABASE_URL="$NEON_TARGET_DATABASE_URL" npm run db:migrate:check
NEON_DATABASE_URL="$NEON_TARGET_DATABASE_URL" npm run db:validate
```

The import tool refuses a target containing application rows. This prevents accidental merge-import into a live tenant database.

## 7. Import

```bash
NEON_DATABASE_URL="$NEON_TARGET_DATABASE_URL" npm run migration:d1:import -- \
  --input .release/migration/source-snapshot.json \
  --report .release/migration/import-report.json
```

The importer:

- validates the snapshot manifest checksum;
- introspects target columns, data types, primary keys, and foreign keys;
- inserts only source columns that exist in the target schema;
- orders tables by target foreign-key dependencies;
- uses parameterized PostgreSQL statements;
- runs the complete import in one transaction;
- rolls back on the first insert, constraint, count, or content-hash failure;
- excludes schema-migration bookkeeping from customer-data import;
- does not log row contents or credentials.

Any source table that does not exist in the target is a blocking error unless it is explicitly listed as provider bookkeeping by the migration tool.

## 8. Verification

Run verification independently after import:

```bash
NEON_DATABASE_URL="$NEON_TARGET_DATABASE_URL" npm run migration:d1:verify -- \
  --input .release/migration/source-snapshot.json \
  --report .release/migration/verification-report.json
```

Required checks:

### Row-count reconciliation

- every imported table has the exact source row count;
- tenant counts match exactly;
- no source application table is omitted;
- target-only infrastructure tables are identified separately and not treated as migrated data.

### Key and content integrity

- per-table normalized content hashes match;
- primary-key sets match;
- foreign-key validation remains enabled and passes;
- composite tenant ownership constraints pass;
- there are no orphaned policy, remediation, notification, approval, outbox, or audit records.

### Domain invariants

Manually inspect and record:

- one free, one Growth, and one Enterprise tenant where available;
- active and terminal Dodo subscriptions;
- scheduled plan changes;
- active and historical policy versions;
- policy approvals and simulations;
- remediation cases, comments, evidence, and SLA dates;
- notification routes, outbox events, and delivery history;
- audit-chain continuity and legal holds;
- latest successful scans and checkpoints;
- secure export metadata and object references.

Do not treat a row-count-only match as sufficient.

## 9. Staging cutover

1. Point staging Hyperdrive to the imported Neon branch.
2. Deploy the exact release SHA to the staging environment.
3. Render and upload the HubSpot staging project.
4. Run `/health` and `/status` checks.
5. Run signed read-only acceptance.
6. Run the full acceptance profile with the designated test portal and deal.
7. Execute one scan, one workflow action, one remediation flow, one delivery retry, one export, and one object upload.
8. Confirm queue acknowledgements, retries, and dead-letter behavior.
9. Confirm no runtime request uses the retired database binding.
10. Attach migration, verification, acceptance, and backup evidence.

Production promotion is prohibited if staging used a different commit, schema checksum, snapshot format, or migration tool version.

## 10. Production traffic switch

After approval:

1. verify the write freeze is still active;
2. verify the final source snapshot and Tigris backup again;
3. verify the production Hyperdrive configuration points to the imported production Neon branch;
4. run the protected Controlled deploy workflow with the exact release SHA and staging run ID;
5. confirm the PostgreSQL migration check and tenant validation pass;
6. confirm Worker health reports the exact release version;
7. run signed read-only acceptance before reopening writes;
8. resume queue consumers in a controlled order: maintenance, delivery, then scans;
9. reopen application writes and webhook processing;
10. monitor errors, queue depth, database latency, and domain invariants continuously through the rollback window.

Do not delete the source database after cutover.

## 11. Rollback

Rollback is mandatory when any of these occur:

- row-count or content-hash mismatch;
- missing or duplicated tenant data;
- failed foreign-key or tenant-isolation validation;
- audit-chain discontinuity;
- incorrect subscription or entitlement state;
- sustained database or queue failure;
- signed acceptance failure;
- inability to replay retained events safely.

Before writes reopen, rollback means:

1. keep the previous Worker and source database active;
2. discard the candidate Neon branch after preserving diagnostics;
3. resume the previous scheduler and queue model;
4. document the failed check and corrective action.

After writes reopen, rollback requires an incident change:

1. close writes and pause queue producers;
2. preserve the Neon transaction window, logs, and queue state;
3. determine whether post-cutover writes can be replayed safely to the source system;
4. restore or switch only after reconciliation of those writes;
5. deploy the compatible previous Worker;
6. run read-only acceptance before reopening writes.

A code rollback without data reconciliation is not a valid rollback.

## 12. Post-cutover retention

Retain for the approved recovery period:

- source database;
- encrypted final source snapshot in Tigris;
- snapshot manifest checksum;
- import report;
- independent verification report;
- migration checksums;
- staging and production deployment records;
- HubSpot acceptance evidence;
- restore-test evidence;
- incident or exception records.

Delete local plaintext snapshots immediately after evidence is uploaded and independently verified.
