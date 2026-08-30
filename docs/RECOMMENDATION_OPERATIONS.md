# DealGuard Recommendation Operations

Recommendation Operations turns measured DealGuard recommendations into a governed manager workflow without adding autonomous CRM changes.

The foundation provides:

- explicit bulk selection of tracked recommendations;
- a time-limited delivery preview;
- human confirmation by the initiating manager;
- notification delivery through explicitly opted-in DealGuard routes and encrypted channels;
- per-recommendation and per-channel delivery evidence;
- scoped CSV or JSON recommendation-evidence exports through one-time secure downloads.

## Product boundary

The feature does not:

- update deal properties;
- change stage, owner, amount, close date, forecast category, or next step;
- create HubSpot tasks;
- send a notification merely because a recommendation exists;
- use AI to draft notification content;
- infer contact or owner email addresses from HubSpot;
- claim that follow-up or recommendation completion caused a deal outcome.

All notification content is deterministic and based on the selected recommendation, its bounded scope context, and the manager's explicit note.

## Permissions

Recommendation follow-up operations require:

```text
remediation.bulk
```

Recommendation evidence exports require:

```text
analytics.export
```

The existing Enterprise entitlement gate still applies.

Pipeline, team, owner, and region assignments are enforced when a batch is previewed. They are checked again at confirmation. A manager cannot confirm a batch after losing access to one of its recommendations.

No new HubSpot OAuth scope is introduced.

## Follow-up event

The only notification event emitted by this feature is:

```text
recommendation.followup.requested
```

A notification route must explicitly include this exact event type.

A route with an empty event-type list is **not** eligible for recommendation follow-ups. This differs intentionally from older general-alert behavior where an empty list may represent a broad route.

Explicit route opt-in prevents a newly introduced manager action from being delivered to a broad or legacy channel unintentionally.

## Preview workflow

### Endpoint

```text
POST /api/v1/enterprise/recommendation-followups/preview
```

Example request:

```json
{
  "recommendationIds": ["recommendation-id-1", "recommendation-id-2"],
  "kind": "manager_review",
  "severity": "warning",
  "managerNote": "Review these actions before the weekly forecast meeting."
}
```

Supported follow-up kinds are:

```text
owner_reminder
manager_review
```

Supported severities are:

```text
warning
critical
```

A manager note of at least ten characters is required. A preview can contain at most 100 unique recommendations.

### Eligibility

A selected recommendation must:

- exist in the current portal;
- be in `presented` or `accepted` status;
- be inside the initiating manager's assigned data scope;
- match at least one enabled notification route that explicitly opts into `recommendation.followup.requested`;
- satisfy the route's minimum severity and pipeline, team, owner, and region conditions;
- have at least one enabled configured channel;
- be outside the route's current quiet hours.

A terminal recommendation remains visible in the preview as ineligible. It cannot be confirmed.

### Preview result

The preview returns:

- recommendation and deal identifiers;
- recommendation status, priority, due date, and overdue state;
- bounded pipeline, team, owner, and region context;
- matching route IDs and names;
- matching channel IDs, names, and types;
- eligibility and delivery-readiness status;
- any ineligibility explanation;
- a batch-level readiness summary.

No notification is sent during preview.

## Human confirmation

### Endpoint

```text
POST /api/v1/enterprise/recommendation-followups/{batchId}/confirm
```

The preview expires after 15 minutes.

Confirmation is allowed only when:

1. the batch is still in `previewed` state;
2. the preview has not expired;
3. every selected recommendation remains active and delivery-ready;
4. the confirming user is the initiating manager or an administrator;
5. the confirming user still has data-scope access;
6. the recommendation status, priority, due date, scope, manager note, severity, routes, and channels still produce the same routing fingerprint.

If recommendation state, route configuration, channel availability, quiet hours, or scope changes after preview, confirmation returns a conflict and the manager must create a new preview.

This makes confirmation meaningful: the manager approves the same bounded delivery plan that DealGuard previewed.

## Delivery

After confirmation, DealGuard records `followup_requested` in the recommendation lifecycle event stream and starts the dedicated delivery operation through the request execution context.

Supported channel types are:

- Slack webhook;
- Microsoft Teams workflow;
- email;
- signed generic webhook.

The feature reuses encrypted notification-channel credentials and configured email recipients. It does not discover or store new recipient data.

Each recommendation item records one delivery result per selected channel:

```text
delivered
failed
```

The item status becomes:

```text
delivered
partially_failed
failed
```

The batch becomes:

```text
completed
partially_failed
failed
```

A confirmed follow-up is not represented as delivered until at least one configured channel succeeds. Channel errors remain visible in bounded delivery evidence.

## Batch APIs

List the initiating manager's recent batches:

```text
GET /api/v1/enterprise/recommendation-followups?limit=10
```

Administrators can list portal batches. Other users see only batches they initiated and that remain inside their current data scope.

Read one batch:

```text
GET /api/v1/enterprise/recommendation-followups/{batchId}
```

The response includes preview, confirmation, delivery, item, and channel-level evidence.

## Auditing

DealGuard writes audit entries for:

```text
recommendation.followup_previewed
recommendation.followup_confirmed
recommendation.followup_delivery_completed
```

The audit record includes batch identity, kind, severity, counts, human-confirmation status, and the no-CRM-mutation boundary.

The recommendation event stream separately records:

```text
followup_requested
```

This preserves the distinction between a manager asking for follow-up and a notification channel successfully delivering it.

## Database model

Migration `0019_recommendation_operations.sql` adds:

```text
recommendation_followup_batches
recommendation_followup_items
```

### Batch evidence

A batch stores:

- follow-up kind and severity;
- manager note;
- lifecycle status;
- requested, eligible, routable, confirmed, delivered, and failed counts;
- bounded routing summary;
- preview expiry;
- initiating and confirming actors;
- confirmation and completion timestamps.

### Item evidence

An item stores:

- recommendation and deal identifiers;
- recommendation code, label, instruction, status, priority, and deadline;
- bounded pipeline, team, owner, and region scope;
- matched route and channel IDs;
- routing fingerprint;
- delivery status;
- bounded channel delivery results and last error.

The operation model does not store contact records, communication bodies, call recordings, meeting content, quote documents, line-item rows, proposal text, or payment information.

## Recommendation evidence exports

Recommendation evidence is available through the existing one-time secure-download API.

### Create a secure export

```text
POST /api/v1/enterprise/downloads
```

Example CSV request:

```json
{
  "kind": "recommendation_evidence",
  "format": "csv",
  "params": {
    "days": 90,
    "status": "completed",
    "pipelineId": "default"
  }
}
```

Example JSON request:

```json
{
  "kind": "recommendation_evidence",
  "format": "json",
  "params": {
    "from": "2026-07-01",
    "to": "2026-09-30",
    "overdueOnly": false
  }
}
```

The returned URL:

- expires after ten minutes;
- can be used only once;
- is bound to the requesting user identity and portal;
- rechecks `analytics.export` and assigned scope when consumed.

### Export filters

Supported filters include:

```text
days
from
to
status
priority
overdueOnly
recommendationCode
pipelineId
teamId
ownerId
regionCode
```

A custom date range can span at most 366 days.

### Export bounds

An export evaluates at most 10,001 rows and returns at most 10,000 recommendation instances. The CSV response includes an explicit truncation header, and JSON includes a `truncated` field.

CSV cells beginning with:

```text
=
+
-
@
```

are prefixed before escaping to reduce spreadsheet-formula injection risk.

### Export semantics

Exports include:

- recommendation lifecycle state and timestamps;
- bounded baseline readiness, stage, owner, team, region, close date, and Deal Brief evidence;
- later observed recommendation-outcome evidence;
- `causal_attribution = false`.

They do not contain contact details or communication content.

## Failure and degradation behavior

- A preview with missing explicit routing cannot be confirmed.
- A routing change forces a new preview rather than silently changing recipients.
- A delivery failure does not trigger a HubSpot CRM fallback.
- One failed channel can produce an item-level partial result while successful channels remain recorded.
- Export failure does not modify recommendation lifecycle state.
- Existing deterministic actions and lifecycle controls continue to work when no follow-up route is configured.

## Deployment dependency

Production deployment requires, in order:

1. the Deal Intelligence and trustworthy-analytics stack through PR #27;
2. PR #28 and migration `0018_recommendation_outcomes.sql`;
3. PR #29 for recommendation lifecycle product surfaces;
4. migration `0019_recommendation_operations.sql`;
5. the Recommendation Operations Worker changes;
6. configuration of at least one notification route with explicit `recommendation.followup.requested` opt-in;
7. developer-account validation of preview, confirmation, quiet-hours changes, partial delivery, and secure export behavior.

This foundation slice deliberately adds no new bulk-operation UI. The next product-surface slice should add selected-recommendation preview and confirmation controls to App Home, plus a secure evidence-export control.
