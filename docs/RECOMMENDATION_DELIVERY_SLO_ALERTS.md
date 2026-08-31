# Recommendation Delivery SLOs and Operational Alerts

DealGuard Recommendation Delivery SLOs convert bounded delivery analytics into governed operational objectives.

They measure whether DealGuard's recommendation-notification system is meeting configured transport and scheduler expectations. They do not measure deal outcome, recommendation correctness, buyer behaviour, revenue impact, or causal effect.

## Product surfaces

### App Home

The **Delivery SLOs & operational alerts** panel provides:

- on-demand loading;
- objective creation and editing;
- current SLO state;
- open and acknowledged incidents;
- incident acknowledgement;
- recent governed notifications;
- explicit evaluation;
- notification-route event opt-in;
- clear evidence and interpretation boundaries.

The panel does not automatically load when App Home opens.

### Enterprise API

```text
GET    /api/v1/enterprise/recommendation-delivery-slos
POST   /api/v1/enterprise/recommendation-delivery-slos
PUT    /api/v1/enterprise/recommendation-delivery-slos/{policyId}
DELETE /api/v1/enterprise/recommendation-delivery-slos/{policyId}
POST   /api/v1/enterprise/recommendation-delivery-slos/evaluate
POST   /api/v1/enterprise/recommendation-delivery-slos/incidents/{incidentId}/acknowledge
POST   /api/v1/enterprise/recommendation-delivery-slos/routes/{routeId}/enable-events
```

## Permissions

Reading SLO configuration and incidents requires:

```text
reliability.view
```

Creating, updating, deleting, evaluating, and acknowledging requires:

```text
reliability.manage
```

Changing a notification route's event subscriptions additionally requires:

```text
alert.manage
```

Recommendation delivery SLOs are portal-level reliability controls. The caller must have an unrestricted pipeline, team, owner, and region assignment. This prevents a partially scoped operator from defining a portal-wide objective or seeing cross-scope operational evidence.

## Supported metrics

### Delivery success percentage

```text
delivered evidence / all terminal delivery evidence
```

A partially failed item is not counted as fully delivered.

Supported targets:

- portal;
- notification route;
- notification channel;
- recommendation routing policy.

The configured objective is a minimum percentage.

### Failed delivery count

Counts failed or partially failed terminal evidence inside the window.

Supported targets:

- portal;
- notification route;
- notification channel;
- recommendation routing policy.

The configured objective is a maximum count.

### Route unavailable count

Counts deduplicated `route_unavailable` observations produced by the Delivery Analytics observer.

Supported targets:

- portal;
- notification route.

The configured objective is a maximum count.

### Escalation SLA breach count

Counts still-relevant recommendation-policy dispatches whose configured escalation was not queued by:

```text
first primary queue time
+ escalationAfterMinutes
+ 20-minute scheduler allowance
```

A dispatch resolved before the escalation due time is excluded.

Supported targets:

- portal;
- recommendation routing policy.

The configured objective is a maximum count.

### 95th-percentile completion time

Measures completed batch latency in minutes using one observation per batch:

```text
batch completion time - confirmation or creation time
```

Supported targets:

- portal;
- recommendation routing policy.

The configured objective is a maximum number of minutes.

## Objective configuration

Each SLO specifies:

- name;
- metric;
- portal, route, channel, or routing-policy target;
- threshold;
- evidence window from 60 to 43,200 minutes;
- minimum comparable sample count;
- consecutive breach evaluations required before incident creation;
- consecutive healthy evaluations required before recovery;
- warning or critical severity;
- portal-wide notification route;
- alert cooldown;
- maximum alerts per incident;
- whether recovery should be notified;
- enabled or disabled state.

A portal can configure at most 25 recommendation delivery SLO policies.

Policies are disabled by default. Saving a policy does not evaluate it or send an alert.

## Evidence sufficiency

An SLO evaluation is enforceable only when:

1. the bounded evidence queries are not truncated;
2. the metric produces a comparable value; and
3. the sample count meets `minimumSamples`.

Insufficient or truncated evidence produces:

```text
insufficient_data
```

It cannot:

- open an incident;
- send a breach alert;
- resolve an existing incident;
- claim that the objective is healthy or unhealthy.

An existing incident remains open until sufficient recovery evidence is observed.

## State machine

### `meeting`

Sufficient evidence meets the configured objective and no incident requires recovery confirmation.

### `breaching`

Sufficient evidence breaches the objective, but the configured number of consecutive breach evaluations has not yet been reached.

### `breached`

The configured persistence requirement is satisfied. DealGuard opens or updates one incident for the SLO policy.

### `recovering`

An open or acknowledged incident has at least one sufficient healthy evaluation, but has not yet met the configured recovery-evaluation requirement.

### `insufficient_data`

Evidence is incomplete, unavailable, below the minimum sample count, or truncated.

## Incident lifecycle

One SLO policy can have at most one open or acknowledged incident.

An incident records:

- frozen policy and target context;
- first, worst, and latest observed values;
- sample count;
- opening and last-observation timestamps;
- acknowledgement evidence;
- recovery timestamp and reason;
- alert count;
- latest governed notification state.

Users with `reliability.manage` can acknowledge an open incident. Acknowledgement does not suppress evaluation or automatic recovery.

An incident resolves only after the configured number of consecutive sufficient healthy evaluations. Resolution reason is:

```text
objective_recovered
```

## Alert cooldown and limits

The first confirmed incident queues a breach notification.

While the objective remains breached, reminder alerts are allowed only when:

- the alert cooldown has elapsed; and
- the incident has not reached `maxAlertsPerIncident`.

The maximum is ten alerts per incident.

Recovery notifications are optional and use a separate dedupe key.

## Explicit route opt-in

The selected notification route must be:

- enabled;
- portal-wide, with no pipeline, team, owner, or region filters;
- connected to at least one enabled channel;
- explicitly subscribed to every required SLO event.

Event types are:

```text
recommendation.delivery.slo.breached
recommendation.delivery.slo.reminder
recommendation.delivery.slo.recovered
```

The App Home panel can append these event subscriptions to a portal-wide route when the user has both `reliability.manage` and `alert.manage`.

An empty route event list is not treated as consent.

## Delivery safeguards

SLO alerts reuse DealGuard's encrypted notification-channel and route infrastructure.

Supported channels are:

```text
slack_webhook
teams_workflow
email
webhook
```

At queue time, DealGuard stores a routing fingerprint derived from:

- event type;
- incident state;
- route version;
- channel versions and types;
- policy severity;
- bounded alert summary.

Immediately before delivery, DealGuard revalidates the fingerprint. A changed route or channel is not silently adopted.

## Quiet hours

Quiet hours do not erase an authorized alert. They defer transport through the configured business calendar.

A deferred notification remains durable and is retried after a bounded interval until the calendar permits delivery or the retry limit is exhausted.

## Retry model

A failed notification is retried with bounded exponential delay.

```text
maximum attempts: 5
maximum retry delay: 60 minutes
```

A partial delivery is terminal to avoid duplicating a successful channel delivery during a retry.

Delivery results retain bounded channel identifiers, names, types, statuses, and errors. Endpoint values and signing secrets are never exposed to the analytics or App Home response.

## Deterministic content

A notification contains only:

- SLO policy and incident identity;
- target and metric;
- threshold and latest observed value;
- sample count;
- operational summary;
- non-causal and no-CRM-mutation markers.

No AI-generated alert copy is used.

## Data minimisation

The SLO subsystem does not store or process:

- contacts;
- buyer email addresses sourced from HubSpot;
- email, meeting, call, or note content;
- recordings or transcripts;
- quotes, proposals, contracts, or line-item rows;
- buyer sentiment or intent;
- forecast probability;
- expected revenue or expected financial loss.

## No CRM mutation

SLO evaluation, incident handling, alert queueing, and delivery do not:

- accept, complete, dismiss, expire, or supersede a recommendation;
- change a deal stage, owner, amount, close date, next step, or forecast category;
- change stakeholder relationships;
- create a HubSpot task;
- call a HubSpot CRM endpoint;
- request another OAuth scope.

## Migration

Migration `0022_recommendation_delivery_slo_alerts.sql` adds:

```text
recommendation_delivery_slo_policies
recommendation_delivery_slo_states
recommendation_delivery_slo_incidents
recommendation_delivery_slo_notifications
```

It also adds a tenant-bound unique key to `notification_routes` so SLO policy and notification foreign keys cannot cross portals.

The schema includes:

- one active-incident partial unique index per policy;
- notification deduplication;
- tenant-bound foreign keys;
- bounded status, count, threshold, cooldown, and lifecycle constraints;
- indexes for evaluation, incident review, and delivery processing.

## Runtime integration

The existing 15-minute maintenance cycle performs:

1. recommendation routing-policy evaluation;
2. delivery-control observation;
3. recommendation delivery SLO evaluation.

The existing Delivery Queue dispatches:

- normal outbox events;
- recommendation follow-up batches;
- recommendation delivery SLO notifications.

No additional queue or scheduled trigger is introduced.

## Deployment gate

Production release requires:

1. the complete prerequisite stack through Recommendation Delivery Analytics;
2. migration `0022_recommendation_delivery_slo_alerts.sql`;
3. canonical and focused PostgreSQL validation;
4. Worker and HubSpot UI typechecking;
5. focused and full repository tests;
6. Worker deployment;
7. HubSpot project upload;
8. developer-account validation of portal-wide routes, quiet hours, retries, breach persistence, reminders, acknowledgement, and automatic recovery.

No production migration or deployment is part of this repository slice.
