# Durable HubSpot webhook inbox

Development slice 13. Migration 0028 is additive. The project subscribes to
`object.deletion` and `object.restore` for deals alongside creation/property events.

The signed HTTP endpoint validates and persists a bounded batch before returning
202. It never relies on waitUntil for receipt durability. The inbox stores only a
hash, tenant/deal identity, approved event category, event time and processing
metadata: no property values or raw communication content. Event keys include
subscription/topic/deal/time, not just an event ID. Unknown accounts, other object
types and invalid identities are ignored; oversized or non-array batches fail.

Maintenance queue wakeups are best-effort because scheduled polling also drains
the durable inbox. Atomic SKIP LOCKED claims use five-minute leases, at most eight
automatic attempts, bounded backoff, and terminal dead letters. A crashed final
lease becomes visible dead-letter work. Only the current lease holder can finalize
a job. Processing has a bounded event count/time window; each provider request has
a deadline. This is at-least-once processing: downstream operations still require
their own idempotency boundaries, not an exactly-once distributed guarantee.

Deletion and restore processing verifies current availability instead of trusting
delivery order or fabricating a loss. Ordinary events retain the configured existing
assessment behavior. Permanently unresolvable records stay visible as failed
verification; they are not silently counted as archived. Project upload is required
before the newly declared event subscriptions can actually be delivered.

App Home exposes portal-wide administrator status and bounded explicit retries.
GET /api/v1/enterprise/webhook-inbox
POST /api/v1/enterprise/webhook-inbox/retry

The retry endpoint checks identity, Enterprise entitlement and portal-wide scan
permission and records an audit event. Unexpired claims cannot be reset by retries.
Processed receipts can expire after 30 days; pending/dead-letter work is retained.
The old inbound_events table is not retroactively made retryable because it lacks
payload identity sufficient to reconstruct all historical work.

Live signed delivery, interrupted-worker recovery and customer account testing
remain release gates. CI uses actual PostgreSQL claims and explicit transport
fixtures; no production notification or CRM change was performed during development.
