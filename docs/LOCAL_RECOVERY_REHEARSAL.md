# Disposable encrypted PostgreSQL recovery rehearsal

This command validates one **small localhost fixture**. It cannot target a Neon,
production or other provider database and does not contact Tigris. It is not a
production RPO/RTO, representative load, independent security review or
provider-backup acceptance test.

## Admission and execution

The script requires the exact opt-in `RUN DISPOSABLE LOCAL REHEARSAL`, a literal
loopback host (`127.0.0.1` or `::1`), database name `dealguard_test`, and zero existing
tenants. It creates its own synthetic tenant, consents, assigned administrator,
datasets, evaluation/usage fixture, and populated rows in all seven forecast
relations, then records row counts and SHA-256 content fingerprints for every
schema table. The forecast artifact is explicitly synthetic and suspended, with
no reviewer or approval digest. Its placeholder prediction is never a customer
estimate or qualification result.

It makes a plain-SQL dump of the `dealguard` schema, encrypts it with the existing
backup-compatible AES-256-CBC/PBKDF2 envelope and a fresh ephemeral passphrase,
checks the encrypted and decrypted digests, and restores into a newly created
local database. All table counts/fingerprints must match. The restored database
then exercises consent revocation under a synthetic legal hold: queued evaluation
work is cancelled, controls remain disabled, and held forecast rows are retained.
Calling the actual `forecastStatus` service must withhold those retained models
and outcome reports. After releasing the hold and disconnecting the synthetic
installation, the restored lifecycle triggers must revoke every optional consent,
disable Breeze, and cascade non-held datasets, evaluations, models, monitoring,
predictions, caches, jobs and outcome reports. The temporary database, seeded
tenant and temporary dump/key material are removed after execution. The receipt
contains no credentials or customer data and does not create an approval.

The digest check assumes an independently trusted digest receipt; this is not a
claim that CBC provides authenticated encryption against an attacker who can
replace both backup and digest.

## Local invocation

Build the application and use a fresh disposable PostgreSQL 18 cluster. The
server bundle and client tools may be in different locations; the recovery path
needs both `pg_dump` and `psql`, which some embedded server bundles omit:

```sh
npm run build
DEALGUARD_POSTGRES_BIN=/path/to/postgresql/server/bin \
PG_BIN=/path/to/postgresql/client/bin \
DEALGUARD_LOCAL_RECOVERY='RUN DISPOSABLE LOCAL REHEARSAL' \
DEALGUARD_RECOVERY_REPORT=/tmp/dealguard-recovery-receipt.json \
node scripts/test-local.mjs -- npm run test:recovery:local
```

Alternatively, use an already migrated, empty disposable database:

```sh
DATABASE_URL=postgresql://fixture_user@127.0.0.1:55432/dealguard_test \
PG_BIN=/path/to/postgresql/bin \
DEALGUARD_LOCAL_RECOVERY='RUN DISPOSABLE LOCAL REHEARSAL' \
DEALGUARD_RECOVERY_REPORT=/tmp/dealguard-recovery-receipt.json \
npm run test:recovery:local
```

`PG_BIN` selects local `pg_dump` and `psql` and defaults to
`DEALGUARD_POSTGRES_BIN` if present. A portable PostgreSQL library directory
can be supplied through `LD_LIBRARY_PATH`; the script clears that override when
calling system OpenSSL to avoid loading incompatible OpenSSL libraries. No
provider secrets or actual customer identifiers should be supplied to this test.

## Executed scope and remaining work

The **November 21, 2026** execution with PostgreSQL **18.7**, Node.js **24.22.3**,
and migrations through **0043** verified **112 tables**, including empty tables,
and populated synthetic rows in all seven new forecast relations. All table counts
and content fingerprints matched after actual encrypted dump/decrypt/restore.
The restored database passed held-consent revocation, cancelled queued evaluation
work, withheld retained forecast output through `forecastStatus`, and deleted the
non-held forecast evidence by cascade after hold release and deactivation.

The full local fixture rehearsal took **475 ms**. This small local elapsed time
must not be advertised as a production recovery target. The receipt explicitly
sets provider/object-store recovery, production RPO/RTO, and forecast qualification
verification to false. No forecast approval was created. When retained with the
validation bundle, the receipt is
`artifacts/acceptance/local-recovery-rc1-schema43.json`; that generated path is
intentionally ignored by Git.

Before production, independently test the real Neon and Tigris backup/restore
sequence with realistic volumes, permissions, encrypted object references,
retention/holds, a trusted digest receipt, rollback and reconciliation. Bind that
separate evidence to the exact release candidate and named operator sign-off.
