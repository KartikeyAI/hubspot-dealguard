# Current-episode win/loss evidence

Phase 1 / M1.2 slice 3; 2026-09-18. Repository implementation is distinct from
live HubSpot acceptance and production release.

## Product contract

The existing Enterprise analytics response exposes `outcomeCorrelation` using
`latest_preclose_assessment_for_current_closed_episode`. This is an observational
comparison of retained pre-close assessments, not a forecast or proof of impact.
App Home shows the observed sample win rate, group sizes, inclusion/exclusion
coverage, and the score difference only when both outcome groups have complete
pre-close scores. It distinguishes unavailable reports from empty cohorts.

Compatibility field names are retained. Unknown averages, win rate for an empty
cohort, and score differences without two complete groups now return null, not
fabricated zero. Consumers must handle null. `confidence` is retained as a
sample-strength label with an explicit non-predictive `confidenceBasis`.

## Lifecycle selection

A single read-only SQL statement performs the following steps:

1. Read this portal's retained assessment history and validate explicit-zone
   observation times and binary closed/won state flags.
2. Establish current recorded authorization with the latest assignment, including
   closed deals. Unknown timestamps take precedence and block affected authorized
   evidence rather than silently discarding an inconvenient transition. Newer
   recorded assignments can revoke access even when their source time is future.
3. For lifecycle analysis, use observations at or before the server-captured
   reporting time. Normalize timestamps by instant; collapse same-instant ties
   using descending ID, rather than treating UUID order as an event sequence.
4. Keep only deals whose latest eligible state is closed. A recorded reopening
   removes the prior outcome from this current-episode report.
5. Find the latest open observation and the first closed observation after it.
   The first close anchors the reporting window. Repeated closed assessments
   cannot bring an old closure into a newer window.
6. Require a strictly earlier open assessment, current recorded access, and
   permitted dimensions on both the open and first closed observations. Null
   observed dimensions do not satisfy a restricted scope.
7. A won/lost label change within a closed episode, without a recorded reopening,
   is excluded as conflicting outcome evidence. Reopening and reclosing creates
   a new eligible episode, using only its new pre-close assessment.

The window is inclusive at both boundaries and uses the same captured server time
as the parent analytics response. `outcome_at` means FIRST OBSERVED closure, not
HubSpot's actual close date or a claim about unobserved CRM transitions.

## Denominators and missing data

`coverage.closedDealsInWindow` counts currently closed, currently authorized deals
whose first observed closure in the current episode has permitted dimensions and
falls within the window. Each candidate is included or assigned exactly one
exclusion: no pre-close evidence, pre-close outside scope, or conflicting labels.
Excluded counts never return the inaccessible observation or its dimensions.

`winRate` is won / included deals, not the win rate of the entire CRM portfolio.
Missing numeric fields do not change that label denominator. Instead each outcome
group exposes per-metric observation counts, and an average is withheld unless
its whole included group has valid values. A measured zero remains zero.

Sample strength requires complete scores in both groups: strong requires at least
100 included deals and 30 in each class; directional requires at least 30 total
and 10 in each class; otherwise it is limited. These are descriptive product
thresholds, not statistical significance tests or predictive calibration.

Invalid timestamps or lifecycle flags in the authorized retained history withhold
statistics. More than 10,000 authorized retained deals or 250,000 authorized
observations also withhold statistics; the service does not publish partial
sample totals. These guards bound subsequent processing, not the cost of reading
all retained source history. No production latency guarantee follows from them.

## Authorization and side effects

The parent route's signed HubSpot identity, Enterprise entitlement and analytics
collection permission checks remain in place. Scope predicates are compiled from
fixed repository aliases; portal, time and selected/assigned values are bound SQL
parameters. Both closure and pre-close evidence obey the effective filters, and
current assignments obey the caller's authorization scope. Saved views grant no
additional access. The service writes no rows and makes no provider requests.

## Boundaries

This is reconstructed retained assessment evidence, not an immutable event ledger.
Retention can remove a boundary or pre-close observation and change the report.
Unrecorded reopening, deletion, archive, or reassignment is not inferred. No new
webhook subscription, archive reconciliation, snapshot ledger, handoff clock,
forecast model, AI feature, OAuth scope, migration, billing action or notification
is introduced. Current state and other analytics contracts are not redefined.

No deployment is performed by this slice. M1.1 live/admin gates and remaining
M1.2 work remain open. Rollback is an application rollback, with no schema reversal.

## Validation and reproducibility

- `test/outcome-evidence.test.mjs` executes the query builder and summary model,
  checks null/zero distinctions, group support, scope parameterization and UI wiring.
- `test/outcome-evidence-postgres.test.mjs` executes the production query/service
  against temporary tables copied from the migrated PostgreSQL schema. Canonical
  CI requires its isolated analytics database fixture. Local runs without that
  fixture skip this database suite explicitly.
- Existing scoped analytics tests exercise the integrated parent service.
- CI retains a seven-day `git archive HEAD` source artifact for reproducible review.
  It is created before dependencies or `.env`; it includes only committed source,
  not credentials, generated configuration, untracked files or installed packages.

Primary implementation references: PostgreSQL 18 SELECT / DISTINCT ON and Data
Validity Checking Functions. Actual CI results are recorded on PR #46. Repository
unit/SQL checks do not replace rendered HubSpot UI acceptance or load testing.
