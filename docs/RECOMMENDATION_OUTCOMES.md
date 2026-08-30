# DealGuard Recommendation Outcome Measurement

DealGuard Recommendation Outcome Measurement records whether a deterministic recommendation was presented, accepted, completed, dismissed, expired, or superseded, then compares later Deal Brief evidence after completion.

The result is an **observed association, not causal attribution**. DealGuard does not claim that completing a recommendation caused a deal to improve, worsen, advance, close, or be won.

## Purpose

The feature answers:

1. Which recommendations are customers actually seeing?
2. Which recommendations are accepted, completed, dismissed, expired, or superseded?
3. How long does acceptance or completion usually take?
4. Which recommendation types are acted upon most often?
5. After completion, did later deterministic CRM evidence improve, weaken, remain mixed, or remain insufficient?
6. Where is DealGuard repeatedly recommending work that users decline or leave overdue?

## Data model

Migration `0018_recommendation_outcomes.sql` adds three tenant-scoped tables.

### `recommendation_instances`

One row represents one recommendation instance for one deal and baseline assessment.

It stores:

- recommendation code, label, instruction, priority, owner role, due date, rationale, and bounded evidence codes;
- lifecycle status and lifecycle timestamps;
- the actor who accepted, completed, or dismissed it;
- dismissal reason;
- baseline assessment, readiness, stage, owner, close date, Deal Brief attention, Deal Brief status, and bounded dimension scores;
- pipeline, team, owner, and region scope fields for permission enforcement.

It does not store contact details, communication content, email bodies, meeting content, call recordings, quote documents, line-item rows, or proposal text.

### `recommendation_events`

This is the append-only lifecycle event stream. Events are:

- `presented`;
- `accepted`;
- `completed`;
- `dismissed`;
- `expired`;
- `superseded`;
- `outcome_observed`.

Each user transition is also written to the existing DealGuard audit log.

### `recommendation_outcomes`

This stores the latest bounded observation for a completed recommendation:

- evaluation status;
- observed progress classification;
- later assessment and Deal Brief timestamps;
- readiness and attention deltas;
- whether the stage identifier changed;
- recorded close-date movement;
- bounded dimension-score deltas;
- baseline evidence codes no longer present in the bounded current evidence;
- whether the same recommendation remains current;
- positive and negative evidence-signal counts;
- a non-causal explanation.

`causal_attribution` is constrained to `0` in PostgreSQL.

## Lifecycle semantics

### Presented

A new recommendation instance is created when a final enriched Deal Brief exposes a top next action that is not already active for the same deal.

Repeated record-card loads update `last_presented_at`; they do not create duplicate instances for the same active recommendation.

### Accepted

A user with the existing `remediation.manage` permission can accept a presented recommendation.

Accepted recommendations do not expire merely because they are overdue. They remain accepted and are returned with `overdue: true` until completed or dismissed.

### Completed

A presented or accepted recommendation can be completed. Direct completion also records acceptance when acceptance was not previously recorded.

Completion creates a pending outcome record. Completion itself is not treated as impact.

### Dismissed

A presented or accepted recommendation can be dismissed. A dismissal reason is required and retained for product-quality analysis.

### Expired

Only an unaccepted `presented` recommendation expires automatically when its due date passes.

When a deal closes, an accepted but unfinished recommendation is expired with the terminal reason `deal_closed`.

### Superseded

A presented recommendation is superseded when a different top recommendation replaces it or the Deal Brief no longer exposes a current recommendation.

Accepted recommendations are not silently superseded by a later top recommendation.

## Observation timing

Recommendation outcomes are evaluated only for completed recommendations.

A later Deal Brief must be generated at least one minute after completion. Completed recommendations remain observable for 90 days.

The latest later observation may update an earlier outcome when fresher evidence becomes available.

## Observed progress model

The deterministic evaluator compares available baseline and later evidence:

- readiness-score delta;
- Deal Brief attention delta, where lower attention is better;
- momentum-score delta;
- close-date-credibility delta;
- relationship-coverage delta;
- engagement-evidence delta;
- commercial-integrity delta;
- Deal Brief status movement;
- whether the same recommendation remains current;
- whether baseline evidence codes remain present in the bounded later evidence;
- stage-identifier change and recorded close-date movement as disclosed context.

Results are:

- `improved`;
- `mixed`;
- `unchanged`;
- `worsened`;
- `insufficient_evidence`.

At least two comparable signals are required for a directional classification.

A changed stage identifier is recorded but is not assumed to be an advance because stage ordering may be customer-specific.

Close-date movement is recorded as context. A later close date is not automatically interpreted as worse, and an earlier close date is not automatically interpreted as better.

## API endpoints

### Deal recommendation history

```text
GET /api/v1/deals/{dealId}/recommendations?limit=20
```

Requires:

- Enterprise entitlement;
- `remediation.view`;
- compliance with assigned pipeline, team, owner, and region scope.

### Accept

```text
POST /api/v1/recommendations/{recommendationId}/accept
```

### Complete

```text
POST /api/v1/recommendations/{recommendationId}/complete
```

### Dismiss

```text
POST /api/v1/recommendations/{recommendationId}/dismiss
Content-Type: application/json

{
  "reason": "The customer confirmed this is not required for the current buying process."
}
```

Lifecycle mutations require Enterprise entitlement, `remediation.manage`, and the caller's assigned data scope.

### Enterprise outcome analytics

```text
GET /api/v1/enterprise/recommendation-outcomes?days=90
```

Optional scoped filters:

```text
pipelineId=<id>
teamId=<id>
ownerId=<id>
regionCode=<code>
```

The endpoint requires `analytics.view` and returns:

- presented, accepted, completed, dismissed, expired, superseded, and overdue-accepted counts;
- acceptance and completion rates as a share of presented recommendations;
- median hours to acceptance and completion;
- observed-progress distribution;
- observed improved share;
- per-recommendation lifecycle counts;
- recent recommendation instances and outcome evidence.

## Permissions and least privilege

No new enterprise permission is introduced.

- `remediation.view` controls deal-level recommendation history.
- `remediation.manage` controls acceptance, completion, and dismissal.
- `analytics.view` controls portfolio outcome analytics.

No new HubSpot OAuth scope is introduced.

The lifecycle and analytics APIs make no HubSpot CRM request. Recommendation capture and later observation reuse the final record-level Deal Brief that DealGuard already generates.

## Runtime boundary

- Full scans, scheduled scans, webhooks, and workflow actions do not gain new HubSpot reads.
- Recommendation capture occurs only when the bounded final Deal Brief snapshot is persisted.
- Observation failure is isolated and cannot break the deal-record response.
- Closed deals terminate open recommendation work without retaining a current Deal Brief snapshot.
- Automatic expiry is evaluated during record observation, deal-history reads, and portfolio analytics reads.
- At most 500 due presented recommendations are expired in one evaluation pass.
- Outcome observation is limited to completed recommendations from the previous 90 days.

## Interpretation boundaries

The API explicitly returns:

```text
observationalOnly: true
causalAttribution: false
completionDoesNotProveImpact: true
missingEvidenceDoesNotMeanFailure: true
```

A completed recommendation followed by improved evidence does not prove that the recommendation caused the improvement.

A worsened or unchanged observation does not prove that the recommendation was ineffective.

Dismissal may reflect legitimate customer context, not product failure.

Missing evidence reduces what DealGuard can conclude; it is not treated as a negative outcome.

## Deployment dependency

Production deployment requires, in order:

1. PR #17 and migration `0015`;
2. PRs #18–#23;
3. PR #24 and migration `0016`;
4. PR #25;
5. PR #26 and migration `0017`;
6. PR #27;
7. migration `0018_recommendation_outcomes.sql`;
8. Recommendation Outcome Measurement Worker changes;
9. Worker deployment and HubSpot project upload;
10. fresh Deal Brief records to begin recommendation capture.

The next product-surface slice should add recommendation lifecycle controls to the deal record and observed-outcome analytics to App Home. This foundation slice deliberately adds no new UI.
