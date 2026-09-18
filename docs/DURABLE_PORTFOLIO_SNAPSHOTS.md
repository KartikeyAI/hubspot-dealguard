# Durable portfolio snapshots

Phase 1 / M1.2 consecutive slice 8; 2026-09-19.

Migration 0024 adds sealed daily capture manifests, item evidence and a bounded
maintenance schedule. The first successful capture in each UTC day records the
current retained assessment of each deal, its original observation time, captured
scope dimensions and comparable monetary fields. It is not an end-of-day snapshot.
The capture timestamp is server-owned, not a client-selected historical cutoff.
There is no fabricated backfill for days before installation or missed captures.

One SQL statement creates the manifest and items. Empty, invalid or oversized
source cohorts do not create partial snapshots. More than 10,000 retained deals
withholds capture. A SHA-256 fingerprint records the selected source rows.
Concurrent same-day attempts use a unique tenant/day constraint. Normal UPDATE
paths cannot overwrite captures. Explicit retention and erasure may delete them;
this is not tamper-proof storage against a privileged database administrator.

The existing maintenance queue attempts up to ten due active portals per run,
rechecks Enterprise entitlement, leases an attempt for fifteen minutes and backs
failed/no-evidence attempts off for one hour. Capture reads DealGuard's database,
not HubSpot, and introduces no new OAuth scope or AI cost. Database scan cost
still depends on history volume and needs representative load validation.

`GET /api/v1/enterprise/portfolio-snapshots?days=30` is signed, Enterprise-gated
and analytics.view-protected. Current and captured scopes both restrict items.
Scoped users without retained current assignment evidence receive no grant from
old snapshots. Unrestricted users can read retained captures after assessment
history retention. Tenant manifests and item counts are checked before returning
aggregates; incomplete captures return unavailable, not partial totals.

App Home offers Recorded snapshots beside Reconstructed history. It shows capture
time, source age, explicit missing captures and comparable amounts. Loading remains
on demand. Retention uses configured operational retention and conservatively
preserves all captures where an active legal hold exists. Portal data removal
also removes the ledger and capture schedule. Standard compliance export now
includes the captured evidence and handoff-cycle ledger.

There is no change to reconstruction or to the legacy assessment-day trend.
New migrations must be applied before deploying this Worker. Rollback can retain
the additive tables and remove the new queue task/reader code. PostgreSQL tests
cover real migrations, capture atomicity, same-day idempotence, mutation rejection,
retention independence, access controls and incomplete-ledger withholding. No live
customer data, deployment or actual scheduled capture has been used in development.
