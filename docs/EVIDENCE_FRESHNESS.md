# Evidence freshness and snapshot acceptance

Phase 1 / M1.2 slice 4; 2026-09-18. Built on PR #46 head
`0915dec9956ca3cbe9bdced1363b9c550cfcc280`. Implementation is not live acceptance.

## Customer behavior

Regenerating a Deal Brief does not renew the age of its assessment. The Deal
Brief, Manager Decision Queue and Executive Revenue View now use a common
observation-age policy. A source is fresh through exactly 24 hours, aging after
24 through 72 hours, and stale after 72 hours. Classification precedes display
rounding. Aging evidence caps high confidence at medium; stale or unavailable
evidence cannot claim high confidence. These are deterministic evidence labels,
not statistical confidence or forecast probabilities.

The manager queue exposes both `assessmentFreshness` and `snapshotFreshness`,
including original assessment time, raw age in hours, generation time, and a
bounded reason code when unavailable. App Home distinguishes assessment and brief
generation timestamps and discloses stale/unavailable fallback evidence. Existing
four evidence-mode filters are retained. Stale or invalid snapshots cannot supply
brief scores, risk summaries, dimensions or next actions to the manager queue or
executive view. Recorded readiness remains explicitly identified as a fallback;
open remediation work and its stored deadline are not erased because a brief ages.

## Clock and identity contract

Evidence clocks must be explicit-zone ISO instants with real calendar dates at
millisecond precision. Date-only/local-time strings, impossible dates, future
observations or generation times, and generation before assessment are not valid
freshness evidence. Offset representations of the same instant are equivalent.
A snapshot must match its assessment exactly, not within a one-second tolerance.
The stored freshness label may downgrade the computed state but cannot upgrade it.
Unknown or unavailable stored labels fail closed. Missing generation times are
never replaced with the current time.

Snapshot extraction requires the payload deal ID to match the addressed deal and
valid bounded portal/deal identities. Missing essential numbers do not become
zero; invalid/out-of-range scores fail extraction. A missing optional dimension
score is omitted, not converted to zero. Real measured zero scores are preserved.
The cached-assessment reuse path also rejects invalid/future assessment clocks.

## Non-sliding fallback deadlines

The Deal Brief's readiness fallback uses assessment time plus 24 hours. The
manager fallback retains its severity delays (24/72/168 hours), anchored to the
assessment rather than page-read time. Reopening a view cannot postpone the date;
read-time overdue status advances normally. An invalid/future assessment supplies
no artificial deadline. Existing remediation dates and explicitly generated
non-readiness actions are unchanged.

These are advisory deadlines for a recorded assessment, not a durable issue-start
clock, customer SLA commitment, or first-seen issue ledger. A genuinely newer
assessment can still establish a new fallback clock; durable lifecycle timing is
separate work.

## Persistence and downstream effects

Open snapshot writes require a matching, recorded-open `deal_assessments` row in
the same portal. The upsert orders candidates by assessment time, then generation
time. Older sources, older generations of the same source and exact replays do
not overwrite stored snapshots. SQL RETURNING is the authority for whether an
insert/update happened. Ignored writes do not invoke recommendation observation.
Stale snapshots may be retained for honest disclosure but cannot present new
recommendations or evaluate outcomes through this write path.

This is a monotonic snapshot write gate, not an atomic transaction covering the
entire assessment/recommendation lifecycle. An exact replay does not retry a
previously failed best-effort recommendation observation; a later accepted fresh
generation can retry. Comprehensive close/reopen races and asynchronous lifecycle
reconciliation remain separate work. This slice does not add archive ingestion,
new lifecycle events, or an immutable snapshot ledger.

## Verification and release boundaries

- `test/evidence-freshness.test.mjs` executes shared policy, both readers, snapshot
  extraction and write-result side-effect boundaries, and Deal Brief behavior.
- `test/decision-snapshot-postgres.test.mjs` executes production persistence SQL
  against temporary tables copied from the actual migrated schema. It covers
  current/open matching, exact retries, out-of-order generations/sources, closure,
  tenant separation, equivalent offsets and rejected payloads. Canonical CI must
  supply its isolated analytics database fixture; local runs without it skip.
- Existing queue, brief, executive and contract regressions remain in the gate.

No migration or OAuth scope is added. No provider data, billing or notification
configuration is changed. Worker publication, HubSpot upload, rendered UI,
representative load testing and real-account acceptance are not claimed. The
product remains `2.1.0`; M1.1 live gates and M1.2 remain open. Freshness here covers
the recorded assessment and assembled snapshot, not independently persisted
fetch clocks for every enrichment source or proof that HubSpot has not changed.

Implementation references: ECMAScript Date Time String Format (explicit offsets)
and PostgreSQL 18 INSERT / ON CONFLICT / RETURNING (only changed rows returned).
