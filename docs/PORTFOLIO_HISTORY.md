# Portfolio history and evidence age

Phase 1 / M1.2 slice 2, built over `64d446125271b363511910b568a74271f982a00c`.
Implementation and CI evidence are separate from live HubSpot acceptance.

## API and customer surface

`GET /api/v1/enterprise/portfolio-history?days=30`

Requires a verified HubSpot request, Enterprise entitlement, an identified user
and `analytics.view`. Only GET is supported; the response uses the existing
no-store JSON response helper. The service makes no HubSpot/provider request and
writes no customer records. Existing record-level access checks are unchanged.

The App Home panel loads only after the user selects Load history. Its 7/30/90-day
selector and seven-row paging keep the view bounded. Loading, unavailable,
permission/error and empty-history states are explicit. Disabled/unmounted panels
invalidate outstanding requests; older responses cannot replace newer results.
The view is composed next to the Executive Revenue View. It does not replace the
legacy assessment-day trend or silently change that API's meaning.

## Daily state semantics

- Request windows contain 1-90 complete UTC calendar dates, including today.
  Today is evaluated at the captured server time and is explicitly partial.
- A single SQL statement reads retained assessment history consistently.
- The latest retained observation before the window seeds each deal. Within the
  window, the latest assessment per deal per UTC day is used; equal observation
  instants use descending ID order to match the existing deterministic tie rule.
- State intervals include closed and out-of-scope daily states before filtering.
  A closure ends open membership; a recorded reopening restores it. A selected
  owner/stage change cannot keep a convenient older in-scope row alive.
- `snapshotAt` is the daily cutoff, NOT the assessment time. The report's
  `generatedAt` is NOT a fresh CRM observation. Oldest/latest source observation
  times remain separate and unchanged when evidence is carried forward.
- `assessedDeals` counts current-open members whose selected observation was made
  on that UTC date. `carriedForwardDeals` is the rest of the recorded-open cohort.
  Closed deals have their own count; no assessment events are double-counted.
- Fresh is age <=24 hours; aging is >24 to <=72 hours; stale is >72 hours. These
  labels describe observation age at that day's cutoff, not a calibrated confidence
  or a claim that the underlying CRM record was unchanged.
- A date with no retained in-scope observation is `no_observations`. Average score
  and amounts are null rather than fabricated zeros. A recorded all-closed cohort
  can correctly contain zero open deals without reporting a zero readiness score.

## Permissions and data validity

Current recorded assignments establish the authorized deal set, including closed
deals. Historical dimensions and selected filters additionally restrict each
reported state. AND applies across assignment dimensions; IN applies within a
multi-value assignment. Filters can narrow but never widen access. Existing
analytics filter validation rejects duplicate, overlong or whitespace-altered IDs.
Tenant identity is bound into the SQL; no request value becomes executable SQL.

Source timestamps require an explicit timezone, are validated before casting and
are normalized to UTC. An invalid timestamp on an authorized deal withholds the
series rather than dropping an inconvenient transition. Future observations do
not enter daily metrics. Current authorization still uses the latest recorded
assignment, including newer records, rather than a historical access snapshot.

The expansion is limited to 10,000 currently authorized retained deals and 90 days.
Larger portfolios return unavailable with no truncated totals. Closed retained
deals count toward this limit. Selecting a filter does not bypass this authorized
cohort limit. Database scan cost still depends on retained assessment volume; the
cap is not a substitute for Phase 3 load testing or materialized snapshots.

## Monetary and score interpretation

Company-currency amounts are combined only with complete coverage of amount-bearing
open deals; otherwise one fully known source-currency cohort can be summed. Mixed
or unknown source currencies without comparable company coverage return null.
Missing source amounts are reflected in coverage, not fabricated as deal values.
Non-finite aggregates are never returned as money. No exchange rates are invented.
Scores are available only when every open member has a valid recorded score.
Changes in currency basis, portfolio composition, coverage or policy cannot be
interpreted as a matched-cohort improvement or causal effect.

## Boundaries and remaining work

This is reconstructed history, not a newly persisted or immutable daily snapshot
ledger. Retention/deletion of underlying assessments can change reconstructed
history. Missing dates before the first retained observation are not backfilled.
Unrecorded deletion, archive, scope reassignment or closure cannot be inferred.
No new archive ingestion, scheduler, migration, durable handoff-start clock,
forecast model, AI, billing action or notification is added.

M1.2 remains in progress. Durable snapshot retention/provenance, full lifecycle
reconciliation, live acceptance and load validation remain separate work. M1.1
staging/admin gates (#38, #41, #42) are unchanged. Rollback removes this application
slice; no schema reversal is required.

## Validation

`test/portfolio-history.test.mjs` covers window bounds, currency suppression,
missing-data semantics, source/cutoff separation, SQL parameterization and route/UI
wiring. Local strict compilation uses isolated boundary declarations; it is not
full production dependency validation.

`test/portfolio-history-postgres.test.mjs` runs the actual service against temporary
assessment tables copied from the migrated PostgreSQL schema in canonical CI. It
covers seeding, missing history, duplicates/ties, closure/reopening, current and
historical access, tenant separation, mixed currencies, timezone/DST independence,
future/invalid timestamps, freshness boundaries, the 10,000-deal/90-day fixture,
and the oversized-cohort guard. Test fixtures never contact customer providers.

Official implementation references: PostgreSQL 18 Set Returning Functions,
Date/Time Functions, and Data Validity Checking Functions; HubSpot UI extension
Select and Table documentation. CI results are recorded on PR #46.
