# DealGuard Recommendation Delivery & SLA Analytics

Recommendation Delivery & SLA Analytics measures whether DealGuard's governed recommendation notifications are being routed and transported reliably. It combines manual follow-up batches, configured-policy batches, policy dispatch state, route/channel delivery evidence, and a bounded control-event ledger.

It does not measure whether a deal progressed, whether a recommendation was commercially correct, or whether DealGuard caused an outcome.

## Endpoint

```text
GET /api/v1/enterprise/recommendation-delivery-analytics
```

The endpoint requires:

- Enterprise entitlement;
- `analytics.view`;
- compliance with assigned pipeline, team, owner, and region scope.

Supported query parameters:

```text
days=7..365
pipelineId=<id>
teamId=<id>
ownerId=<id>
regionCode=<code>
policyId=<id>
routeId=<id>
authorizationMode=human_confirmation|configured_policy
```

The default window is 30 days. Responses are cached for 60 seconds per user and filter set.

## Customer-facing metrics

### Delivery success

Delivery success is calculated from completed recommendation follow-up item evidence:

```text
delivered items / delivered + partially failed + failed items
```

Partially failed items are not counted as fully successful.

This is notification transport evidence. It is not recommendation effectiveness, sales-rep compliance, buyer engagement, deal progression, or revenue impact.

### Completion latency

Completion latency measures the interval between batch confirmation or creation and batch completion. The API reports median and 95th-percentile minutes for completed batches.

### Policy queue stages

Configured-policy items are classified as:

- `initial`: first non-escalation item for a policy dispatch;
- `repeat`: later non-escalation items for the same dispatch;
- `escalation`: manager-review items whose batch timing aligns with the dispatch escalation timestamp.

Human-confirmed manager follow-up remains separate from configured-policy delivery.

## Escalation SLA compliance

Escalation SLA compliance uses the policy's configured `escalationAfterMinutes` threshold.

For each dispatch:

```text
SLA due = first primary queue time + escalationAfterMinutes
```

A dispatch resolved before its SLA due time is excluded because escalation was no longer required.

Because DealGuard's maintenance cycle runs every 15 minutes, the analytics model applies a transparent 20-minute scheduler allowance. An escalation is compliant when it is queued no later than:

```text
SLA due + 20 minutes
```

A due escalation that remains unresolved and unqueued after that point is counted as breached.

This is an operational scheduler-aware SLA measure. It is not a customer-facing contractual commitment unless separately agreed.

## Control-event ledger

Migration `0021_recommendation_delivery_sla_analytics.sql` adds:

```text
recommendation_delivery_events
```

The ledger records bounded, deduplicated operational observations:

```text
policy_matched
quiet_hours_deferred
cooldown_suppressed
notification_limit_suppressed
route_unavailable
dispatch_resolved
```

### Deduplication semantics

- Policy match is recorded once per policy and recommendation.
- Quiet-hour deferral is recorded once per policy, recommendation, route, stage, and UTC day.
- Route unavailability is recorded once per policy, recommendation, route, stage, and UTC day.
- Cooldown suppression is recorded once per dispatch and `nextEligibleAt` window.
- Notification-cap suppression is recorded once per dispatch and configured maximum.
- Dispatch resolution is recorded once per dispatch resolution timestamp.

The counts therefore represent affected operational conditions rather than raw 15-minute evaluator invocations.

Events are retained for 400 days and are deleted with the HubSpot portal installation.

## Route health

Route health combines:

- attributed channel delivery attempts;
- delivered and failed channel results;
- quiet-hour deferrals;
- route-unavailable observations;
- most recent delivery evidence.

When one channel belongs to more than one matching route, the delivery can be attributed to each route. Channel totals remain deduplicated by batch, recommendation item, and channel.

Health states are:

```text
healthy
watch
degraded
unavailable
```

A route can be `watch` because quiet hours or an availability condition is present even when completed deliveries succeed.

## Channel health

Channel health is calculated from per-channel evidence stored in `recommendation_followup_items.delivery_summary_json`.

Supported channel categories remain:

```text
slack_webhook
teams_workflow
email
webhook
```

The analytics layer does not decrypt endpoint or signing-secret values.

## Policy delivery performance

For each policy, DealGuard reports:

- first observed matches;
- primary, repeat, and escalation queue counts;
- completed item delivery success;
- quiet-hour deferrals;
- cooldown and notification-cap suppression;
- route-unavailable observations;
- escalation SLA compliance and breaches;
- median match-to-first-queue time;
- operational health.

This should be described as policy delivery performance or operating effectiveness. It must not be described as commercial effectiveness or causal revenue impact.

## Evidence coverage

The response discloses:

- loaded follow-up item rows;
- loaded control events;
- loaded policy dispatches;
- completed-attempt coverage;
- channel-result coverage;
- bounded-query truncation.

The API limits are:

```text
20,000 follow-up item rows
20,000 control events
10,000 policy dispatches
```

When a limit is reached, the response is marked truncated.

## App Home behavior

The App Home panel is loaded on demand rather than during initial navigation. Users can select 7-, 30-, 90-, or 180-day windows and inspect:

- delivery success;
- escalation SLA compliance;
- quiet-hour deferrals;
- cooldown and notification-cap controls;
- route availability;
- completion latency;
- policy performance;
- route health;
- channel health;
- recent failures;
- daily evidence coverage.

Changing the reporting window explicitly requests new evidence. The panel does not call HubSpot CRM.

## Data minimisation

The analytics layer stores or reads only bounded operating evidence:

- recommendation, dispatch, policy, batch, route, and channel identifiers;
- lifecycle and delivery statuses;
- route/channel result codes;
- due, queue, escalation, completion, and observation timestamps;
- pipeline, team, owner, and region identifiers;
- bounded deterministic failure messages.

It does not store or process:

- contact records;
- recipient addresses from HubSpot;
- email bodies;
- meeting or call content;
- recordings or transcripts;
- quote or proposal documents;
- contract text;
- line-item rows;
- buyer sentiment;
- buyer intent;
- probability or expected-loss estimates.

## No CRM mutation

The observer, analytics endpoint, and App Home panel do not:

- accept, complete, dismiss, expire, or supersede recommendations;
- change deal stage, owner, amount, close date, next step, forecast category, or stakeholder relationships;
- create HubSpot tasks;
- invoke a HubSpot CRM endpoint;
- add a HubSpot OAuth scope.

## Runtime integration

The delivery-control observer runs after:

- the scheduled recommendation-policy evaluator;
- an explicitly requested policy evaluation.

It records deduplicated evidence after the existing evaluator has made its queueing decision. Delivery success continues to come from the immutable batch/item delivery evidence rather than being duplicated in a second transport log.

## Deployment prerequisites

Production release requires:

1. the complete Deal Intelligence stack through PR #29;
2. migrations `0015` through `0018`;
3. Recommendation Operations and Routing Policies migrations `0019` and `0020`;
4. migration `0021_recommendation_delivery_sla_analytics.sql`;
5. canonical and focused PostgreSQL validation;
6. Worker deployment;
7. HubSpot project upload;
8. developer-account delivery evidence across Slack, Teams, email, and signed webhook routes;
9. quiet-hour, cooldown, notification-cap, and escalation-SLA validation.

No production migration or deployment is performed by this repository slice.
