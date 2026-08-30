# DealGuard Recommendation Routing Policies and SLAs

Recommendation Routing Policies turn active DealGuard recommendations into a governed notification workflow. They reuse DealGuard's existing notification routes, encrypted channels, business calendars, data-scope filters, and delivery queue.

The feature is deterministic. It does not use AI to decide who should be notified or to draft message content.

## Product boundary

A routing policy may send a notification when an active recommendation crosses an explicitly configured due or overdue threshold.

A policy does not:

- accept, complete, dismiss, expire, or supersede a recommendation;
- modify deal fields, stages, owners, amounts, close dates, next steps, activities, quotes, line items, or forecast categories;
- create a HubSpot task;
- infer a recipient from CRM contact data;
- claim that a notification caused later deal movement;
- bypass route scope, quiet hours, channel configuration, or customer permissions.

## Durable customer authorization

Manual follow-ups retain the existing two-step model:

```text
preview → human confirmation → queued delivery
```

An enabled recommendation routing policy is different. Saving the policy in an enabled state is the customer's **durable customer authorization** for deterministic notifications that match the saved policy.

The authorization is bounded by:

- one trigger;
- one recommendation lifecycle scope;
- one minimum priority;
- one due or overdue threshold;
- one initial route;
- one cooldown;
- one maximum notification count;
- optional pipeline, team, owner, and region scope;
- an optional one-time manager escalation route and SLA;
- a deterministic manager note.

Disabling or deleting the policy stops future evaluations. It does not remove historical delivery evidence.

## Events and explicit route opt-in

A route must explicitly include the event it is intended to deliver:

```text
recommendation.policy.due_soon
recommendation.policy.overdue
recommendation.policy.escalated
```

An empty route event list is not treated as policy opt-in.

The initial route must include the policy's trigger event. An escalation route must include `recommendation.policy.escalated`.

## Supported channels

Policies reuse configured DealGuard notification channels:

- Slack incoming webhook;
- Microsoft Teams workflow;
- email;
- signed HTTPS webhook.

Endpoints and signing secrets remain encrypted through the existing notification-channel model. Email recipients remain in the configured email channel rather than being copied into each policy.

## Recommendation eligibility

A recommendation can match a policy only when:

1. It is still `presented` or `accepted`.
2. Its lifecycle state is included by the policy.
3. Its priority meets the configured minimum.
4. Its pipeline, team, owner, and region match the policy scope.
5. It has a valid due date.
6. It satisfies the configured due or overdue threshold.

For `presented` recommendations, DealGuard also requires the recommendation to remain the current bounded Deal Brief action. Accepted recommendations remain active until completed, dismissed, expired because the deal closed, or otherwise terminally resolved.

## Due-soon policies

A due-soon policy matches when:

```text
now <= due_at <= now + threshold_minutes
```

An overdue recommendation is not presented as due soon.

## Overdue policies

An overdue policy matches when:

```text
due_at <= now - threshold_minutes
```

The threshold is an explicit grace period after the due date.

## Cooldown and maximum notifications

DealGuard calculates the effective cooldown as the largest of:

1. 15 minutes;
2. the policy cooldown;
3. the selected route's suppression window.

The policy can send at most the configured number of initial or repeat notifications for one recommendation. The allowed range is 1–10.

Cooldown and notification count are tracked per portal, policy, and recommendation.

## Quiet hours

If the selected route references a business calendar, DealGuard checks the route's current local schedule and holidays before queueing or delivering a notification.

A route in quiet hours is not delivery-ready. The recommendation remains eligible for a later maintenance evaluation after business hours resume.

Quiet hours are rechecked at delivery time. A route that enters quiet hours after evaluation is not used.

## Manager escalation

A policy may specify one escalation route and one escalation SLA.

Escalation becomes eligible when:

- the recommendation still matches the policy;
- at least one initial notification was queued;
- the configured number of minutes has passed since the first queue event;
- no prior escalation has been sent for that policy and recommendation;
- the escalation route is enabled and explicitly opted into `recommendation.policy.escalated`;
- the escalation route is outside quiet hours and has an available channel.

Escalation is one-time. It does not alter recommendation ownership or CRM data.

## Evaluation schedule

Enabled policies are evaluated by the existing maintenance queue. An authorized operator can also request an immediate portal-scoped evaluation from App Home.

Per evaluation, DealGuard bounds work to:

- 500 enabled policies;
- 5,000 active due-dated recommendations per portal;
- 100 recommendations per queued delivery batch.

A manual preview shows at most 25 matching rows while reporting counts across up to 1,000 current recommendations.

## Delivery revalidation

A policy match is not enough by itself. DealGuard stores a fingerprint of:

- recommendation lifecycle state;
- priority and due date;
- policy event and guidance;
- data scope;
- route identity and update timestamp;
- route suppression window;
- channel identity, type, and update timestamp.

Before delivery, DealGuard reloads the route and channels, rechecks event opt-in, scope, severity, quiet hours, route version, channel version, and channel configuration.

A changed or unavailable route is excluded rather than silently substituted.

## Evidence and auditability

DealGuard records:

- policy creation, update, enablement, disablement, deletion, and immediate evaluation;
- policy evaluation timestamps and counts;
- per-policy/per-recommendation dispatch state;
- first and latest queue timestamps;
- next eligible time;
- notification and escalation counts;
- last batch and delivery status;
- deterministic follow-up events;
- batch and per-channel delivery results.

Configured-policy batches are marked:

```text
authorization_mode = configured_policy
```

Manual batches remain:

```text
authorization_mode = human_confirmation
```

## Permissions

```text
alert.view
```

Required to list and preview routing policies.

```text
alert.manage
```

Required to create, update, enable, disable, delete, or immediately evaluate policies.

```text
remediation.view
```

Required when previewing the recommendation matches behind a policy.

Assigned pipeline, team, owner, and region scope remains authoritative. When a scoped operator leaves a policy dimension blank, DealGuard binds that dimension to the operator's assigned scope rather than creating an unrestricted policy.

## Data minimisation

Policies and dispatch state retain only bounded operational evidence:

- policy configuration;
- route and channel identifiers;
- recommendation and deal identifiers;
- recommendation definition, priority, due date, and scope identifiers;
- delivery status and bounded error evidence;
- authorization and audit actors already used by Enterprise governance.

They do not persist contact records, communication content, quote documents, contract text, call recordings, meeting content, or buyer sentiment.

## App Home workflow

The App Home surface supports:

1. Listing current policies and health.
2. Creating a disabled draft.
3. Selecting an explicitly opted-in initial route.
4. Selecting an optional manager escalation route.
5. Setting lifecycle, priority, threshold, cooldown, and notification limits.
6. Previewing current matches without sending anything.
7. Enabling the policy as durable notification authorization.
8. Running an immediate evaluation.
9. Reviewing match, queue, failure, and escalation counts.

## Deployment dependency

Production rollout requires:

1. The Deal Intelligence and recommendation-outcome stack through migration `0018`.
2. Canonical Recommendation Operations and migration `0019`.
3. Migration `0020_recommendation_routing_policies.sql`.
4. Worker deployment with `routes-v15` active.
5. HubSpot project upload containing the updated App Home surfaces.
6. At least one configured notification channel.
7. Notification routes that explicitly opt into the selected policy events.
8. Validation of quiet hours, cooldown, repeat, and escalation behavior in a developer portal.

No new HubSpot OAuth scope is required.
