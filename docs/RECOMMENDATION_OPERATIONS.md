# DealGuard Recommendation Operations

Recommendation Operations turns measured DealGuard recommendations into a governed manager workflow without adding autonomous CRM changes.

The foundation provides:

- explicit bulk selection of tracked recommendations;
- a time-limited delivery preview;
- human confirmation by the initiating manager;
- notification delivery through explicitly opted-in DealGuard routes and encrypted channels;
- per-recommendation and per-channel delivery evidence;
- scoped CSV or JSON evidence through a one-time secure download.

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

## Permissions and entitlement

Recommendation follow-up operations require:

```text
remediation.bulk
```

Recommendation evidence exports require:

```text
analytics.export
```

The Enterprise entitlement gate still applies. Pipeline, team, owner, and region assignments are enforced during preview and checked again at confirmation. No new HubSpot OAuth scope is introduced.

## Explicit route opt-in

The only event emitted by this feature is:

```text
recommendation.followup.requested
```

A notification route must explicitly include this event type. A route with an empty event-type list is not eligible for recommendation follow-ups, even where older general-alert behavior treats an empty list broadly.

Explicit opt-in prevents a newly introduced manager action from being delivered through a legacy or catch-all channel unintentionally.

## Preview workflow

### Endpoint

```text
POST /api/v1/enterprise/recommendation-followups/preview
```

Example:

```json
{
  "recommendationIds": ["recommendation-id-1", "recommendation-id-2"],
  "kind": "manager_review",
  "severity": "warning",
  "managerNote": "Review these actions before the weekly forecast meeting."
}
```

Supported kinds:

```text
owner_reminder
manager_review
```

Supported severities:

```text
warning
critical
```

A manager note of at least ten characters is required. One preview can include at most 100 unique recommendations.

### Eligibility

A recommendation must:

- exist in the current portal;
- be `presented` or `accepted`;
- be inside the initiating manager's assigned scope;
- match an enabled route that explicitly opts into `recommendation.followup.requested`;
- satisfy route severity and pipeline, team, owner, and region conditions;
- have at least one enabled configured channel;
- be outside configured quiet hours.

Terminal recommendations remain visible as ineligible preview items. A batch can be confirmed only when every selected item is active and delivery-ready.

### Preview evidence

The preview returns:

- recommendation and deal identifiers;
- recommendation state, priority, due date, and overdue state;
- bounded pipeline, team, owner, and region context;
- matching routes and channels;
- route and channel configuration versions;
- eligibility and delivery-readiness state;
- an explanation for each ineligible item;
- batch readiness and expiry.

No notification is sent during preview.

## Human confirmation

### Endpoint

```text
POST /api/v1/enterprise/recommendation-followups/{batchId}/confirm
```

A preview expires after 15 minutes. Confirmation is available only to the initiating manager or an administrator.

DealGuard revalidates:

1. recommendation status, priority, due date, and scope;
2. the confirming user's current data access;
3. route event opt-in, severity and scope;
4. quiet-hours state;
5. route configuration version;
6. channel type and configuration version.

The preview fingerprint binds the manager note, follow-up kind, severity, recommendation state, scope, routes, and channels. A change requires a new preview instead of silently redirecting delivery.

Confirmation uses an atomic lifecycle:

```text
previewed → confirming → queued
```

Only one request can claim confirmation. The recommendation event stream records `followup_requested` only after the queued transition is committed.

## Delivery Queue

Confirmed batches publish a wake-up to DealGuard's existing Cloudflare Delivery Queue. The queue consumer processes the dedicated recommendation-follow-up dispatcher alongside the general outbox dispatcher.

This provides:

- durable work after the HTTP response;
- scheduled recovery because regular outbox wakes also inspect queued follow-ups;
- an atomic `queued → delivering` claim that prevents two consumers from delivering the same batch concurrently;
- a bounded one-batch-per-wake processing model.

A confirmation claim that remains incomplete for five minutes is marked failed. A delivery claim that remains incomplete for twenty minutes is marked failed rather than automatically repeated, reducing the risk of duplicate outreach when a channel result is uncertain.

## Routing stability at delivery

Delivery is limited to route and channel IDs shown in the preview. DealGuard rechecks that:

- the route is still enabled and explicitly opted in;
- the route still matches severity and data scope;
- quiet hours still permit delivery;
- the route version is unchanged;
- the channel remains enabled;
- the channel type and version are unchanged.

A changed or unavailable destination is not substituted. The item records failure and requires a new manager preview.

## Supported channels

The dedicated dispatcher supports:

- Slack webhook;
- Microsoft Teams workflow;
- configured email channel;
- signed generic webhook.

DealGuard reuses encrypted channel credentials and configured recipients. It does not discover or retain new recipient data.

## Delivery evidence

Each item records one result per selected channel:

```text
delivered
failed
```

Item status becomes:

```text
delivered
partially_failed
failed
```

Batch status becomes:

```text
completed
partially_failed
failed
```

A confirmed action is not represented as delivered merely because confirmation succeeded. Channel failures remain visible in the batch evidence.

## Batch APIs

List recent batches:

```text
GET /api/v1/enterprise/recommendation-followups?limit=10
```

Read one batch:

```text
GET /api/v1/enterprise/recommendation-followups/{batchId}
```

Administrators can inspect portal batches. Other managers see only batches they initiated and that remain within their current assigned scope.

## Audit model

DealGuard writes audit entries for:

```text
recommendation.followup_previewed
recommendation.followup_confirmed
recommendation.followup_delivery_completed
```

The recommendation lifecycle event stream separately records:

```text
followup_requested
```

This preserves the distinction between a manager requesting follow-up and a channel delivering it.

## Database model

Migration `0019_recommendation_operations.sql` adds:

```text
recommendation_followup_batches
recommendation_followup_items
```

A batch retains bounded operational evidence: kind, severity, manager note, lifecycle status, counts, routing summary, preview expiry, actors, and confirmation/completion timestamps.

An item retains recommendation and deal IDs, action metadata, bounded pipeline/team/owner/region scope, matched route/channel IDs, routing fingerprint, delivery state, channel results, and a bounded error.

The model does not store contact records, communication bodies, call recordings, meeting content, quote documents, line-item rows, proposal text, or payment information.

Migration `0019` also extends:

- `recommendation_events` with `followup_requested`;
- secure-download kinds with `recommendation_evidence`.

## Recommendation evidence exports

Create an export through the existing secure-download endpoint:

```text
POST /api/v1/enterprise/downloads
```

CSV example:

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

JSON example:

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

The returned URL expires after ten minutes, is single-use, is bound to the requesting identity and portal, and rechecks `analytics.export` plus assigned data scope when consumed.

Supported filters:

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

A custom date range can span at most 366 days. DealGuard evaluates at most 10,001 rows and returns at most 10,000 recommendation instances. CSV exposes truncation in a response header; JSON includes a `truncated` field.

CSV values beginning with `=`, `+`, `-`, or `@` are prefixed before escaping to reduce spreadsheet-formula injection risk.

Exports contain bounded lifecycle, baseline, scope and later observational outcome evidence. They do not contain contact details or communication content, and they always retain `causalAttribution: false` semantics.

## Failure behavior

- A preview with no explicit route cannot be confirmed.
- A route, channel, scope, recommendation, or quiet-hours change requires a new preview.
- A queue or delivery failure does not trigger a HubSpot CRM fallback.
- One failed channel can produce a partial result while successful channels remain recorded.
- An export failure does not modify recommendation lifecycle state.
- Existing deterministic actions and lifecycle controls continue to work when no follow-up route is configured.

## Deployment dependency

Production deployment requires:

1. the Deal Intelligence stack through PR #27;
2. PR #28 and migration `0018_recommendation_outcomes.sql`;
3. PR #29 for recommendation lifecycle surfaces;
4. migration `0019_recommendation_operations.sql`;
5. the Recommendation Operations Worker changes;
6. at least one notification route with explicit `recommendation.followup.requested` opt-in;
7. developer-account validation of preview, confirmation, queue recovery, quiet-hours changes, partial delivery, and secure exports.

This foundation deliberately adds no new bulk-operation UI. The next product-surface slice should add selected-recommendation preview and confirmation controls to App Home, plus a secure evidence-export control.
