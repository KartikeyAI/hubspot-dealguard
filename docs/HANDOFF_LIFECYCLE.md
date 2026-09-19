# Durable handoff cycles

Phase 1 / M1.2 and M1.6 development; 2026-09-19.

Migration 0023 introduces tenant/deal-scoped numbered handoff cycles. An accepted
assessment first observing closed-won starts a cycle at that observation time.
Later won assessments retain the start. Confirmation locks the assessment before
the handoff, checks the exact observed version and current non-critical won state,
and returns the committed timestamp. Repeated confirmation is a no-op, not a new
confirmation event. Route notifications and write-back run only for a new change.

Reopening or changing away from won ends the cycle. Completed evidence remains
completed; unfinished work becomes cancelled. A later win starts a new numbered
cycle. Current handoff confirmation is cleared when the deal leaves won.

Legacy handoffs are retained with `legacy_unknown` start provenance. The migration
also initializes legacy won records with no handoff, without inventing starts.
No claim is made about historical CRM close time. Durations measure time since
DealGuard first observed the eligible state, not contractual SLA compliance.
The analytics response exposes measured duration count and coverage; missing starts
remain null rather than becoming zero. The cycle ledger is operational evidence,
not a tamper-proof external audit record.

Assessment writes reject malformed/future instants and ignore equal/older versions.
A database trigger also prevents bypass through concurrent or older application
writers. Scanner and event assessment paths stop downstream work for rejected
writes. Assessment context upserts do not overwrite a newer context. This does not
yet make all external notifications, CRM writes, history and recommendation updates
one atomic transaction. HubSpot fetch-start/source-version ordering remains a
separate ingestion concern.

## Validation and rollout

Unit tests exercise repository acceptance, idempotent confirmation and rejected
identity/version inputs. PostgreSQL tests execute the real migration, triggers,
repository writes and confirmation function using isolated tenant fixtures rolled
back at completion. Runtime identity remains 2.1.0. Apply migrations before the new
Worker. Old migrations are unchanged. Application rollback can retain 0023; the
monotonic guard and lifecycle trigger remain active and must not be disabled to
make an older writer overwrite newer evidence. No live migration or deployment
has been performed as part of development.
