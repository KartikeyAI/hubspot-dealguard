# Disposable local recorded-read scale rehearsal

This rehearsal calls the actual `recordedAssessment` service for **10,000 deals
across two concurrent portals**. It measures local Node.js and PostgreSQL only.
It does not exercise Cloudflare Workers, the deployed Neon HTTP adapter, a HubSpot
card or HTTP route, Tigris, queues, AI providers, billing providers, or live CRM
traffic. Its timings do not satisfy the production load or recovery gates.

## Fixture and checks

The script requires the exact `RUN DISPOSABLE LOCAL SCALE` opt-in, a literal
loopback address, database name `dealguard_test`, and an initially empty tenant
table. It creates two explicitly synthetic portals with 5,000 deals each. The
portals deliberately share their deal IDs while using different deal names and
owners. Each deal has a recorded assessment, current context and history,
lifecycle state, and stored Deal Brief with preserved source timestamps.

Each portal has an explicitly assigned viewer restricted to its synthetic
pipeline and owner. Eight PostgreSQL connections provide four concurrent readers
per portal. They enable `default_transaction_read_only`, and a local instrumented
adapter uses the production SQL placeholder and relation normalization helpers.
The adapter requires a bound portal predicate or an allowed portal-bound scalar
read; it rejects another fixture portal in parameters or returned `portal_id`.
Every service response must match its expected portal-specific deal name, deal
ID, source timestamp, stored brief generation time, and viewer capabilities.

The measurement includes application authorization and all SQL queries performed
by `recordedAssessment`. Connection setup, fixture creation, `ANALYZE`, 32 warm-up
reads, and final verification are outside the measured read window. There is a
15-second SQL statement timeout and a three-minute limit on measured reads. The
script performs one measured read of each of the 10,000 deals at fixed concurrency.

`fetch` throws if any read attempts an external request. Row counts and SHA-256
content fingerprints for every schema table must remain unchanged between
seeding and completion. Database sessions also reject writes from functions. The
fixture and all connections are removed afterward; the receipt contains only
synthetic measurements and table fingerprints.

These checks detect unexpected tenant parameters, returned tenant rows, or wrong
response identities in this workload. They do not prove which physical database
rows PostgreSQL scanned, general cross-tenant noninterference, or independent
security acceptance.

## Invocation

Build the application, then use the disposable runner so the database exists
inside the same process/network environment as the rehearsal:

```sh
npm run build
DEALGUARD_POSTGRES_BIN=/path/to/postgresql/bin \
DEALGUARD_LOCAL_SCALE='RUN DISPOSABLE LOCAL SCALE' \
DEALGUARD_SCALE_REPORT=/tmp/dealguard-local-scale.json \
node scripts/test-local.mjs -- npm run test:scale:local
```

The runner creates and migrates a new local cluster. It does not consume an
external `DATABASE_URL` or application `.env`. To run the rehearsal directly,
provide an already migrated, empty disposable loopback `dealguard_test` database
and use `npm run test:scale:local` with the same opt-in.

## Observed local result

On **2026-11-21**, using Node.js **24.22.3**, PostgreSQL **18.7**, and migrations
through **0043**, the run completed all 10,000 measured reads and 90,000 measured
SQL queries. The read window was **5,216.902 ms** at concurrency eight:

| Local service latency | Observed milliseconds |
| --- | ---: |
| p50 | 3.998 |
| p95 | 6.629 |
| p99 | 9.716 |
| Maximum | 25.784 |

Both portals completed 5,000 reads. There were zero attempted writes, unexpected
tenant parameters, returned other-portal rows, or external requests. All **112**
schema table fingerprints matched before and after the reads. The machine-readable
receipt is `artifacts/acceptance/local-scale-rc1-schema43.json` when retained with
the validation bundle; this generated path is intentionally ignored by Git.

These measurements are a bounded regression rehearsal, not a capacity promise.
The separate production acceptance run must measure the exact deployed candidate
on Workers and Neon with representative data, actual authentication and provider
limits, concurrent portals, queue recovery, and the agreed p95 threshold. Object
recovery, production RPO/RTO, and customer pilots remain separate evidence.
