# Opt-in background deal intelligence

Phase 1 / M1.4 implementation candidate, 2026-09-19. Migration 0025.

## Customer workflow

An identified Enterprise administrator or portal-wide user with `scan.run` can
load status, set a refresh target (1–72 hours), set a separate daily request
budget (100–10,000 reservations per UTC day), enable/pause enrichment, and retry
failed jobs. No settings row means disabled. App Home controls call signed APIs:

- GET/PUT `/api/v1/enterprise/background-intelligence`
- POST `/api/v1/enterprise/background-intelligence/retry`

Settings changes and retry requests are audited. Scoped managers retain their
normal queue access but cannot authorize portal-wide background reads.

## Execution and safety

The maintenance schedule now dispatches separately addressed portal messages with
reserved publication and execution leases. Each visit registers up to 100 missing
jobs and processes up to three eligible deals. Oldest waiting work receives a fair
slot alongside overdue, near-close and critical priority. Budget-aware delayed
continuations drain remaining work without waiting for every maintenance tick.
See `BACKGROUND_SCHEDULING.md` for migration 0029, exact bounds and retry semantics.
No portfolio freshness or production throughput SLA is inferred from fixture tests.

All HubSpot calls use a guarded real HubSpotClient. Each admission atomically
reserves budget against the current tenant, enabled settings version and lease.
Reservations are conservative: a failed or already-admitted cancelled request is
not refunded. CRM writes are prohibited by the request policy; only approved CRM
read/search/batch-read paths and OAuth refresh are allowed. Requests are paced,
have abort deadlines, and cannot follow redirects. A job is limited to 40 provider
admissions and a 60-second network/evidence-building window. A swallowed optional-
loader error cannot swallow the shared guard's budget or throttling failure.
401/429 responses stop further admissions. OAuth refresh 429/5xx does not itself
mark an installation disconnected. This budget is separate from HubSpot's actual
account/API-specific limits, which remain authoritative.

The worker reuses deterministic record evidence builders, metadata-only engagement
and progressively authorized commercial reads without calling the interactive
assessment orchestration. It does not send notifications, invoke native CRM
write-back, create remediation/tasks, or charge event overage through this path.
Accepted open briefs can record recommendation observations through the existing
bounded mechanism. Core assessments use the initial read-start clock, so slower
older work cannot overwrite a later accepted observation. Stored evidence remains
subject to the existing freshness policy and conditional snapshot write gate.

Pause/configuration changes revoke admission leases and cancel queued/processing
work. Already-admitted HTTP reads may finish; settings and entitlement are checked
again before persistence. The entire database-and-provider operation is not one
transaction. Lost downstream observation attempts, full close/reopen reconciliation
and provider-side archive ingestion remain independent lifecycle work.

## Data, validation and release

Jobs retain IDs, state, attempt/error codes and timestamps, not tokens or raw
email/quote contents. Usage stores daily counters. Configured retention and legal
holds cover usage evidence; deletion of portal assessment data cascades job
records, and portal removal removes settings and counters. Compliance export
includes the applicable operational records.

Unit tests exercise settings, read-only admission, budget/lease denial, throttling,
deadlines and the actual HubSpotClient request hook. PostgreSQL tests use isolated
fixtures, two real concurrent database sessions for budget admission, revoked
leases, administrator permissions and full worker composition with explicitly
simulated HubSpot HTTP responses. They do not claim live HubSpot account or
rendered App Home acceptance. Apply migrations through 0029 before deploying code; rollback can retain
additive tables with background enrichment disabled. Product version remains 2.1.0.

References: HubSpot API usage guidelines and limits (developer platform, March 30,
2026); PostgreSQL INSERT / ON CONFLICT / RETURNING. Current HubSpot limits must be
rechecked before rollout; the separate local budget is not a replacement for them.
