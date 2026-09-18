# DealGuard 3.0 delivery progress

Updated: 2026-09-18. Programme: the agreed three-phase production roadmap.
This file records development progress, not a production-release declaration.

## M1.1 slice 1: release baseline and staging controls

Starting source: `eb8f49612fa3d6b85a3b5732af9db9517be1be00` on `main`.
The intelligence programme from PR #35 is already merged. The package and Worker
release identity remain `2.1.0`; this slice does not relabel production as 3.0.
The current architecture is Cloudflare Workers, direct Neon PostgreSQL, Tigris,
Cloudflare Queues and Dodo Payments. Hyperdrive is not the runtime database path.

### Implemented in this slice

- `npm run release:baseline` inventories the exact committed source, Git tree,
  package/Worker identity, UI package versions, migration SHA-256 hashes, HubSpot
  component UIDs/types, required/optional OAuth scopes and configuration hashes.
- The command rejects mismatched release SHAs, dirty tracked source, untracked
  release source, symlinked inventory files, invalid/duplicate migrations,
  duplicate component identities and inconsistent package/Worker versions.
- Baselines read committed Git objects rather than relying on `GITHUB_SHA`, which
  can identify the workflow trigger instead of a separately checked-out release.
- CI and Controlled deploy record the baseline before dependency installation,
  migration or deployment. The deployment checksum list includes the baseline.
- Staging supports stable versions and `alpha.N`, `beta.N`, `rc.N` prereleases.
  Production remains stable-only. Unknown targets fail closed. Build metadata
  and other prerelease channel names are intentionally not supported.
- Protected preflight no longer pins the product to exactly `2.1.0`.
- Dispatch values are passed to deployment shell validation through quoted
  environment variables, not substituted directly into executable shell source.
- Hidden baseline/deployment evidence is uploaded through explicit path lists;
  neither `.env` nor rendered `.release/wrangler.toml` is uploaded.
- Dependency-free tests exercise Git repositories, CLI, preflight and shell execution.

### Use

Run from a clean, committed repository root before installing dependencies:

```bash
npm run release:baseline -- --target staging
RELEASE_TARGET=production RELEASE_SHA=<exact-40-character-sha> npm run release:baseline
node --test test/release-baseline.test.mjs
```

The default output is `.release/release-baseline.json` (mode 0600). Generated
release artifacts and `.env` are not source inventory. Untracked source beneath
Worker, HubSpot, migration, script or workflow directories must be committed or
removed first. Do not pass secret values on the command line.

This is a **repository baseline**, not an attestation of live deployment. It does
not read protected secrets, call HubSpot, query Neon, apply migrations, upload a
project, run checkout, or send notifications. Applied database version and
HubSpot project build ID remain null; live verification fields stay
`not_verified`. Source hashes do not replace checksum validation against the
actual database, signed acceptance, backup restoration or operator approval.

### Remaining M1.1 gates

- Configure/verify isolated staging resources and protected environment values
  (existing issue #41); this commit does not create or inspect secret values.
- Enable/verify required CI, reviewed changes and main-branch protection
  (existing issue #42); workflow checks do not enable repository protection.
- Run protected readiness and Controlled staging deployment on the exact SHA.
- Upload the staging HubSpot project and record its real build identifier.
- Execute intelligence and standard acceptance in a developer account; validate
  the main customer surfaces and permission-denial paths (existing issue #38).
- Preserve actual database, backup/restore, project and acceptance evidence.
- Finish feature/edition/permission validation and reconcile remaining stale
  overview documents without rewriting historical release records.

M1.1 is **in progress** until those live gates pass. M1.2-M1.6 have not been
completed by this release-tooling slice.

## Existing feature acceptance inventory

`Implemented` below refers to the merged PR #35 scope, not live customer proof.
The authoritative behavior remains in the linked specifications. All live
acceptance is pending for the 3.0 candidate.

| Capability | Repository basis | 3.0 live validation |
|---|---|---|
| Currency-safe current-state analytics | `ENTERPRISE_ANALYTICS.md` | Pending M1.2 |
| Momentum and close-date credibility | `DEAL_MOMENTUM_AND_CLOSE_DATE.md` | Pending M1.3 |
| Buyer-committee coverage | `BUYER_COMMITTEE_INTELLIGENCE.md` | Pending M1.3 |
| Six-dimension Deal Brief | `DEAL_BRIEF.md` | Pending M1.3 |
| Metadata-only engagement | `ENGAGEMENT_INTELLIGENCE.md` | Pending M1.3 |
| Optional commercial integrity | `COMMERCIAL_INTEGRITY.md` | Pending M1.3 |
| Manager Decision Queue | `MANAGER_DECISION_QUEUE.md` | Pending M1.5 |
| Executive Revenue View | `EXECUTIVE_REVENUE_VIEW.md` | Pending M1.5 |
| Recommendation lifecycle/outcomes | `RECOMMENDATION_OUTCOMES.md` | Pending M1.6/M2.1 |
| Follow-up, routing and delivery controls | `RECOMMENDATION_OPERATIONS.md` and related routing/SLO specifications | Pending M1.6 |

Background portfolio enrichment, qualified forecasting, native governed AI and
Breeze adapters are future milestones, not features shipped by this slice.

## Programme checkpoints

| Phase | Milestones | Exit condition |
|---|---|---|
| 1: deterministic product | M1.1 staging baseline; M1.2 trustworthy metrics/history; M1.3 complete Deal Brief; M1.4 bounded background intelligence; M1.5 persona workflows; M1.6 closed-loop remediation/handoff | Live-validated deterministic alpha |
| 2: intelligence and AI beta | M2.1 outcome datasets; M2.2 qualified forecasts; M2.3 grounded AI; M2.4 AI governance/budgets; M2.5 Breeze adapters; M2.6 self-service/billing | Feature-complete native beta; prediction eligibility and tool approvals explicit |
| 3: production release | M3.1 acceptance/upgrades; M3.2 security/privacy; M3.3 load/recovery; M3.4 controlled pilot; M3.5 support/Marketplace readiness; M3.6 cutover/sign-off | Evidenced, monitored, supported `3.0.0` deployment |

Versions follow alpha, beta, RC, then stable only when their respective gates
pass. Useful deterministic behavior remains mandatory when AI is unavailable.
Marketplace approval, Breeze approval, code merge and production readiness are
separate states.

## M1.1 slice 2: required intelligence certification and evidence binding

Built on PR #46 head `e80284a275ba8b39824d45f82f1323ebbbadd5a0`.
The second slice remains in the same Phase 1 review branch.

- Full Controlled deploy runs now execute standard and required intelligence
  acceptance. All twelve intelligence tests must be present, required and passed.
- Missing configuration fails before the intelligence suite sends requests;
  diagnostics remain available but never produce promotable release evidence.
- Deployment evidence v4 retains result sets and binds the baseline, smoke,
  standard suite and intelligence suite to the selected release/context.
- Production promotion revalidates evidence against trusted GitHub run metadata,
  requires the selected run/attempt, and rejects legacy, mixed or stale reports.
- Updated current controlled-deployment documentation to direct Neon/Tigris and
  documented the complete gate in `INTELLIGENCE_RELEASE_GATE.md`.
- Focused validation: 55 tests pass locally, including real CLI execution with
  isolated test transport, evidence-file selection, promotion and shell guards.
  Canonical GitHub CI remains the full repository validation gate.

No database migration, Worker deployment, HubSpot upload, OAuth grant change,
customer notification or plan change was executed by this implementation slice.
The live/admin gates above remain pending; M1.1 and Phase 1 are not complete.

## M1.2 slice 1: scoped analytics, saved views and exports

Built on PR #46 head `0846bc78e7b582e464f501ac99f57826261c2a73`.
This is the first runtime product slice, not another release-tooling change.

- Collection analytics now work for identified scoped users without weakening
  record-level permission checks. SQL enforces all assigned dimensions, including
  multi-value scopes when no explicit filter is selected.
- Current-state selection remains latest-per-deal before filtering. Historical
  observations and policy-period timestamps require current recorded access as
  well as permitted observation dimensions. Handoffs use current deal dimensions
  and include closed deals; missing assessment evidence does not grant access.
- Saved-view updates/deletes require both tenant and creator ownership. Shared
  definitions remain readable, not editable by other users. Empty-email matches
  and cross-tenant global-ID upserts are removed.
- CSV exports use the same scope and separate export permission, neutralize
  formula-like string cells, and retain empty values as empty cells.
- Added unit tests plus executed-SQL regression coverage using temporary tables
  derived from the migrated PostgreSQL schema. Canonical CI requires the isolated
  analytics database fixture. See `ANALYTICS_SCOPE.md` for exact semantics.

M1.2 remains in progress: lifecycle/archive/reopen coverage, daily carry-forward
history, evidence freshness and live acceptance still require further work.
Authorization reflects latest recorded DealGuard dimensions, not an additional
live HubSpot authorization lookup. No new scope, migration, provider request,
notification, billing action or deployment is introduced by this slice.

## M1.2 slice 2: portfolio carry-forward history and evidence age

Built on PR #46 head `64d446125271b363511910b568a74271f982a00c`.

- Added a signed, Enterprise/analytics.view-protected portfolio-history GET API
  and an on-demand App Home panel with 7/30/90-day windows and paginated rows.
- Reconstruct daily recorded states from retained pre-window seeds and daily
  final assessments. Recorded closures/reopenings and scope changes end previous
  intervals before historical filters are applied. Existing trend API is unchanged.
- Separate report generation, daily cutoff, and oldest/latest observation clocks.
  Carried-forward evidence retains its age; missing history and scores stay null.
- Apply current and historical scope, currency-safe aggregates, timestamp validity
  checks and a 10,000-authorized-deal/90-day expansion bound without partial totals.
- Added eight focused tests plus a real PostgreSQL service suite including the
  10,000-deal/90-day fixture. Local boundary compilation/tests do not claim full
  dependency or provider validation; current-head CI evidence is on the PR.

See `PORTFOLIO_HISTORY.md` for exact semantics. This is reconstructed retained
history, NOT a durable snapshot ledger. Lifecycle ingestion/reconciliation,
materialized snapshot retention/provenance, handoff timing, production load and
real-account UI acceptance remain pending. M1.1 live/admin gates are unchanged.
No new migration, OAuth grant, provider request, notification or deployment is
performed by this slice. Version remains 2.1.0; M1.2 is not declared complete.

## M1.2 slice 3: current-episode outcome evidence

Built on `0e7eb6c5a0319bc425dc79dfd58b5fe40efe4b2e`; 2026-09-18.

- Win/loss evidence now follows the currently closed episode. Recorded reopening
  removes an earlier outcome; reclosing uses its new pre-close assessment.
- The first observed closure anchors the reporting window. A closed-record refresh
  cannot shift an old outcome into a newer window. Conflicting closed labels,
  missing pre-close observations and inaccessible historical dimensions are excluded.
- Per-group metric coverage is explicit. Empty samples, absent outcome classes and
  incomplete numeric evidence produce null statistics, not zero-value claims.
- App Home explains inclusion, exclusions, sample win rate and unavailable evidence;
  sample strength is explicitly not forecast confidence.
- Added read-only PostgreSQL regression tests for lifecycle, time ordering, scope,
  tenant isolation, invalid evidence and processing limits. See `OUTCOME_EVIDENCE.md`.
- CI now preserves the exact committed source as a seven-day review artifact before
  dependency installation or environment-file creation, alongside the release baseline.

No schema migration, live-provider action, deployment, OAuth change, billing action
or customer notification is performed. Runtime/package version remains `2.1.0`.
M1.1 live gates remain open. M1.2 is not complete: durable snapshot provenance,
archive/deletion ingestion, handoff timing, other freshness work, and live acceptance
remain distinct tasks. Validation results belong to the exact PR head and are
recorded in its discussion; the existence of this code is not production acceptance.


## M1.2 slice 4: observation freshness and accepted snapshot writes

Built on PR #46 head `0915dec9956ca3cbe9bdced1363b9c550cfcc280`.

- Shared source-age policy for the Deal Brief, manager queue and executive reader;
  generation cannot renew observation age. Exact 24/72-hour boundaries are applied
  before display rounding. Invalid/future clocks and mismatched assessments fail closed.
- Manager responses/UI distinguish observation and generation times. Aging evidence
  caps confidence; stale/invalid snapshots cannot supply current brief actions or scores.
- Readiness fallback deadlines are anchored to the recorded assessment rather than
  page refresh; existing remediation deadlines remain unchanged.
- Snapshot extraction rejects missing essential numbers, false zero coercions,
  misaddressed payloads and invented generation clocks. Optional missing scores stay absent.
- Snapshot upserts require a matching recorded-open assessment and advance only on
  newer source/generation pairs. Ignored writes and stale evidence do not drive new
  recommendation observations. This is not full lifecycle transaction serialization.
- Added executed reader/policy tests and migrated-PostgreSQL snapshot-write scenarios.
  Exact validation results are recorded on the final PR head, separately from deployment.

See `EVIDENCE_FRESHNESS.md` for limits, source-clock semantics and retry behavior.
No migration, OAuth grant, provider call, publication, billing action or customer
notification is performed by this slice. M1.1 live gates and M1.2 remain open:
durable snapshot provenance, archive/deletion reconciliation, durable handoff
clocks, per-source enrichment provenance and real-account acceptance are pending.

## Consecutive development — slice 7: durable handoff cycles

Built on `1b7502f50c9453d1dd62804aea0b7ec8f3aaf1af`. Adds migration 0023 without
rewriting earlier migrations. Observed closed-won starts, confirmation timestamps,
reopening/cancellation and reclosed cycles are retained with explicit provenance.
Legacy starts remain unknown. Confirmation and lifecycle changes share assessment-
first row locking; retries preserve the committed timestamp and suppress duplicate
route notifications. New duration counts and coverage distinguish legacy gaps.

Core assessment writes now reject old/equal timestamps, including via a database
guard. Rejected scanner/event work stops before notification, sync or remediation.
The remaining integration lifecycle is not represented as one atomic transaction.
Unit and migrated PostgreSQL scenarios accompany the implementation; exact CI
results are recorded on PR #46. See `HANDOFF_LIFECYCLE.md` for rollout and limits.
M1.1 live gates and the complete M1.2/M1.6 milestones remain open.

## Consecutive development — slice 8: durable portfolio snapshots

Adds migration 0024: tenant/day manifests, frozen per-deal observations and leased,
bounded maintenance capture. Empty, invalid and oversized cohorts do not publish
partial history. GET readers recheck current plus captured scope and expose missing
captures; App Home switches between reconstructed history and recorded snapshots.
Configured retention, legal holds and portal deletion cover the new ledger.
Real PostgreSQL tests cover atomicity, duplicate capture, sealed updates, source
retention independence and integrity withholding. See `DURABLE_PORTFOLIO_SNAPSHOTS.md`.

## Consecutive development — slice 9: usable scoped manager workflows

Manager/executive collections now use the shared collection access boundary.
Manager search, ranked pagination, capacity detection, strict filters and stale-
response protection are implemented. Executive historical evidence respects
captured scope; invalid dates and duplicated controls are rejected. Local helper,
service and contract tests accompany the changes. See `MANAGER_COLLECTION_WORKFLOWS.md`.

These slices remain development candidates until exact-tree canonical CI and live
acceptance succeed. No feature version, public release, production deployment or
third-party approval is implied. M1.3/M1.4 completion, remaining security review,
M2 AI/model qualification and the Phase 3 customer/recovery gates are still open.

## Consecutive development — slice 10: opt-in background intelligence

Built over the validated slices 7–9 tree. Adds migration 0025 and signed,
portal-wide administrator controls. Disabled by default. Persisted jobs,
per-portal leases, atomic per-day request reservations, strict read-only provider
admission, pacing, deadlines, retry/backoff and cancellation are implemented.
The worker reuses deterministic evidence builders and optional commercial reads;
never-opened recorded deals can acquire useful persisted briefs without CRM
write-back, notifications or billable-event orchestration. App Home exposes real
status, configuration, budget consumption and retries. Full provider/queue load
and live-account validation remain gates, not claims based on fixtures.

M1.4 remains in progress: initial bounded throughput is not a portfolio freshness
SLA, and close-date-aware priority, larger-scale scheduling and real-account
acceptance require further work. Source retention, archive ingestion, full atomic
lifecycle reconciliation and all phase-exit gates remain separately tracked.
See `BACKGROUND_INTELLIGENCE.md` for exact behavior and limitations.

## Consecutive development — slice 11: decision lifecycle transaction fences

Migration 0026 serializes application snapshot upserts with their parent
assessment, invalidates superseded briefs and atomically records closure-driven
recommendation terminal events. Late closed payloads cannot remove reopened
briefs; late active recommendation insertion requires the current open source
and matching snapshot. Rejected insertion cannot emit a presentation event.
Two real PostgreSQL sessions test both snapshot/closure race directions and
rollback consistency. See `DECISION_LIFECYCLE_FENCES.md`. This does not claim that
all downstream CRM/remediation/notification operations are one transaction.

## Consecutive development — slice 12: verified archive/restore lifecycle

Migration 0027 adds tenant-bound availability state and timeline evidence. Verified
archives suppress current briefs/actions without inventing a lost sale, erasing
assessment history or renewing source clocks. Restore, late-work fences, handoff
termination, scoped current reporting and archive-aware provider admissions are
implemented. Real PostgreSQL and client-boundary tests accompany this work.
See `RECORD_ARCHIVE_LIFECYCLE.md` for incomplete-provider and concurrency boundaries.

## Consecutive development — slice 13: durable webhook receipt and retries

Migration 0028 adds an at-least-once durable inbox: signature before persistence,
persistence before acknowledgment, atomic claims, expiring leases, bounded retries,
visible dead letters and signed administrator controls. Added project deletion and
restore subscriptions without increasing OAuth grants. Polling recovers a failed
queue wakeup. Earlier unavailable payloads are not retroactively reconstructed.
See `DURABLE_WEBHOOK_INBOX.md`. Exact-tree CI evidence is recorded on PR #46 after
execution, not inferred here. No live deployment or phase exit is claimed.
