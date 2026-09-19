# Recommendation-to-remediation work

Phase 1 M1.6 / slices 16–17, September 19, 2026. Implementation and isolated
integration validation are not live HubSpot or production acceptance.

## Customer workflow

An authorized Enterprise user can explicitly create or link a remediation from
an actionable recommendation in the deal-record lifecycle card. The request
must contain a reviewed revision, a numeric HubSpot owner ID, a timezone-qualified
ISO deadline, and `confirm: true`. Owner IDs are recorded as user-provided
assignments; this endpoint does not perform an additional live owner-directory
lookup. They must not be confused with HubSpot user IDs.

The new `POST /api/v1/recommendations/:id/remediation` endpoint creates local work.
For a readiness recommendation it reuses an existing active case for the same
issue where available. Reuse preserves the existing owner, due date, priority,
and evidence/acknowledgement requirements: it does not silently apply the
creation form's requested values to an existing case. The UI discloses this.
The original recommendation, link, and case retain separate identities.

Creating work accepts a still-presented actionable recommendation. Completing a
recommendation does **not** resolve its case, prove subsequent improvement, or
establish causal impact. The API/card display the linked case's current status.
The App Home manager workspace provides on-demand case lists, direct case-ID
navigation, assignment, acknowledgement, work start, comments, text evidence,
evidence review, resolution/waiver notes, close, and reopen actions.

No task or immediate notification is created by these new linkage/lifecycle
operations. Existing explicitly configured escalation policies may subsequently
act on the case. Existing separate task-creation and notification routes retain
their own effects and are not part of the linkage transaction.

## Access and mutation contract

Current CRM deal assignment, not the case assignee, determines the user's
pipeline/owner/team/region boundary. All four dimensions intersect, and each
multi-value dimension is an allowed set. Missing or stale assignment evidence
does not grant scope. Archived/unavailable records are not ordinary active-work
resources. Their retained evidence remains governed by compliance export and
retention rules.

Recommendation baseline scope also remains required. Collection predicates are
bound SQL, and case filters can narrow but cannot widen access. Case lists reject
more than 200 matching rows rather than returning a silently incomplete list.
The UI pages the bounded list in tens. Detail histories cap each collection at
200 and disclose truncation; the panel renders the first ten comments/evidence
items. Summary counts cover all authorized cases and a missing resolution-time
sample is null, not zero. Resolution duration is the recorded case lifetime,
not a per-reopening cycle SLA or a causal effectiveness metric.

Migration 0030 adds composite tenant/deal-safe links and monotonic work revisions.
Revision checks, rather than millisecond timestamps alone, detect a changed
reviewed definition. Concurrent identical linkage attempts yield one case/link.
An exact replay of original creation parameters is a no-op; changed parameters
for an existing link conflict. It is not an assignment-edit API.

The lock order is record advisory lock, current assessment, then work item.
The current assessment source is compared under lock. Accepted manual
recommendation transitions, lifecycle events, outcome-pending initialization,
and audit rows commit together. Presented-to-completed transitions record an
acceptance event in the same transaction. Expiration updates only still-presented
rows and creates their terminal events atomically; it cannot revert accepted
work or manufacture duplicate terminal events.

Case transitions and their events/audit rows are atomic. Evidence and
acknowledgement resolution gates are checked under the case lock. Resolve/waive
require notes; closing requires resolved/waived state and the applicable gates.
Reopening clears acknowledgement/resolution and resets required evidence to
missing. Earlier comments/evidence remain retained and may be explicitly reviewed
again. No new automatic due date is invented.

Controls, comments, evidence submission/review use a source/revision-checked
transaction. Concurrent changes require a refresh. They do not claim exactly-once
comment submission under client retries. Existing audit-chain promotion remains
a separate process; atomic audit-row creation is not synchronous hash-chain
promotion. Existing automatic remediation/escalation and external task delivery
are separate services and are not claimed to share these transactions.

Permission checks occur in the service before invoking invoker-rights SQL
functions, and record authorization is repeated before returning record details.
This is DealGuard's configured authorization model, not a complete mirror of
native HubSpot per-user sharing. The SQL functions are not an independent
public-user API or a substitute for least-privilege runtime database credentials.

## Verification

`recommendation-remediation.test.mjs` exercises input normalization, revision,
result handling, separated linked-case state, scoped wiring and UI confirmation.
`recommendation-remediation-postgres.test.mjs` invokes real service/query paths
with disposable tenant fixtures on the migrated schema: retries, two-session
concurrent linking, rollback, controls/evidence/acknowledgement resolution,
reassignment, scope, expiry, and composite isolation.

All four builds must pass, followed by the full CI regression suite. Real account
UI acceptance, policy configuration validation, external task delivery failure
reconciliation, bulk UX completeness, load testing, staging/production deployment
and operational sign-off remain separate gates. Rollback may leave this additive
schema in place; do not rewrite already-applied migrations or delete work evidence
merely to roll back application code.
