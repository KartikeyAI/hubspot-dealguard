# Independent source clocks and automatic remediation resolution

Reconstructed from the retained slices 18–19 specifications after the unpushed
workspace did not persist. This is a newly validated implementation, not a claim
that the previous local-only implementation was recovered byte for byte.

Each assembled brief now carries versioned observation receipts for readiness,
property history, buyer relationships, engagement metadata and commercial data.
Observation age is recalculated on read. A new generation time cannot refresh
source evidence. Missing, invalid and future clocks are unavailable; source
snapshots older than 72 hours are stale. Aging evidence cannot elevate confidence.

The builder excludes unusable optional sources. Stored current-state manager and
executive readers require matching source receipts for all included dimensions.
Legacy snapshots without these receipts fall back to readiness-only evidence
until a valid refresh occurs. A captured receipt records when DealGuard fetched
metadata; it is not proof that HubSpot has not changed since that fetch, nor does
an engagement receipt imply complete availability of every activity subtype.

Automatic case resolution reads the locked current assessment rather than caller-
supplied issue codes. It requires an active, available open record and an assessment
no older than 72 hours. Configured evidence approval and acknowledgement gates must
pass. Manual/workflow cases are excluded. The case, event, audit and notification
outbox record commit together. Reopening requires a newer assessment before another
automatic resolution. A queued event is not proof of delivery.

Migration 0031 is additive. It has only been applied to an isolated test database.
The database functions use invoker rights and the existing archive/assessment/case
lock order. They do not grant new user permissions or contact customer providers.

Local restored baseline: 576 passing tests. This reconstruction: 592 passing tests,
zero failures or skips, including real PostgreSQL concurrency and rollback tests.
Live HubSpot acceptance and representative load/recovery testing remain outstanding.
