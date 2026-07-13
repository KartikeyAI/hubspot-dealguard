# DealGuard v1.4 product definition

## Release objective

v1.4 turns DealGuard's enterprise governance signal into an operational system. It adds durable remediation, customer-routed delivery, replayable reliability controls, service health, and commercial subscription infrastructure while keeping deterministic policy as the source of truth.

## Remediation cases

A remediation case is a durable record with:

- HubSpot deal and issue identity;
- title, description, severity, and priority;
- owner identity and optional email;
- SLA due time;
- open, acknowledged, in-progress, overdue, resolved, waived, closed, and reopened states;
- actor-attributed history;
- optional associated HubSpot task;
- resolution note and resolution time.

Critical assessment issues automatically create one active case per deal and issue code. When the underlying issue is no longer detected, assessment-created cases resolve automatically. Manual and workflow-created cases remain under explicit user control.

## HubSpot task creation

DealGuard discovers the portal's HubSpot-defined task-to-deal association metadata and creates a TODO task with subject, body, due time, priority, and owner. Task creation failure does not destroy the internal remediation case; the failure is recorded for diagnosis.

## Remediation workflow action

The deal-based **Create DealGuard remediation** action accepts:

- issue code;
- title and description;
- severity;
- SLA hours;
- whether to create an associated HubSpot task.

It returns the remediation case ID, status, due time, and HubSpot task ID.

## Routed delivery

Enterprise administrators can configure:

- Microsoft Teams Workflows using the Teams webhook-trigger workflow;
- email recipients;
- signed generic HTTPS webhooks.

Destinations can filter by event type, minimum severity, and pipeline. Endpoint URLs and signing secrets are encrypted. Generic webhooks include a unique delivery ID and HMAC-SHA256 signature.

## Delivery reliability

Events enter a durable outbox before external delivery. The dispatcher provides:

- compare-and-set processing leases;
- abandoned-lease recovery;
- delivery-attempt history;
- exponential backoff with jitter;
- eight-attempt limit;
- dead-letter state;
- administrator replay.

Delivery failure does not roll back assessment, policy, handoff, or remediation state.

## Service health

Each portal tracks:

- last successful scan;
- last successful HubSpot webhook processing;
- last successful outbound delivery;
- latest failure and consecutive-failure count;
- pending, failed, and dead-letter deliveries;
- overdue remediations;
- subscription entitlement.

## Commercial entitlement

Customer-facing tiers are Free, Growth, and Enterprise. Paid subscriptions use Stripe-hosted subscription Checkout and Stripe Customer Portal. Signed Stripe webhooks update entitlement, current period, cancellation state, and payment-failure grace periods. Manual Enterprise contracts can be applied through Rokad's authenticated internal operations endpoint.

The current schema maps commercial Enterprise to the legacy internal `beta_growth` capability value. This is an implementation detail and is never shown to customers.

## Security boundaries

- Only DealGuard administrators can manage billing, destinations, dead-letter replay, and tenant deletion.
- Managers and policy administrators can operate remediation according to the application role matrix.
- Remediation task creation uses only the explicit HubSpot task-write scope.
- DealGuard does not alter core deal stage, owner, amount, close date, or forecast category.
- Subscription webhook processing is signed, time-bounded, and idempotent.
- Destination delivery credentials are encrypted with AES-256-GCM.

## Non-goals

- AI-generated recommendations, anomaly detection, or benchmarking; these belong to v1.5.
- Autonomous mutation of core commercial deal fields.
- Storing card or bank details.
- Replacing the customer's incident-management or project-management platform.
