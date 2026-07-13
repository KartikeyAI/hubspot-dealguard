# Dodo Payments implementation

DealGuard uses Dodo Payments as its primary self-service commercial platform and Merchant of Record. The internal entitlement service remains authoritative; verified Dodo subscription events update that neutral entitlement state.

## Commercial model

- Base subscription per HubSpot portal
- Included active-deal, event, retention and AI-credit allowances
- Customer-selectable capped or metered mode
- Optional overage only when explicitly enabled
- Manual Enterprise contract path for purchase orders and bank transfers

## Required Dodo configuration

Create four subscription products:

- Growth monthly
- Growth annual
- Enterprise monthly
- Enterprise annual

Attach usage meters to products intended for metered overage. Each meter reads the numeric `quantity` metadata property. Configure the aggregation deliberately:

| Event name | Aggregation | Meaning |
|---|---|---|
| `dealguard_ai_credit` | `sum` | Cumulative consumed AI credits |
| `dealguard_event_overage` | `sum` | Cumulative billable events |
| `dealguard_active_deal_overage` | `max` | Maximum active-deal gauge reached in the billing period |
| `dealguard_retention_gb_month` | `max` | Maximum retained-data gauge reached in the billing period |

DealGuard sends absolute values to `max` meters and increments to `sum` meters. The local D1 ledger uses the same semantics, so hard-cap enforcement, customer-visible usage and Dodo invoicing cannot diverge merely because a scan runs repeatedly.

Create the webhook endpoint:

```text
https://dealguard-api.rokad.co/webhooks/dodo
```

Subscribe to the Dodo subscription lifecycle events used by DealGuard: active, updated, renewed, plan changed, payment method updated, on hold, cancelled, failed, and expired. Payment, refund and dispute events may be retained for commercial diagnostics, but they are explicitly ignored by the entitlement state machine.

## Worker secrets

```text
DODO_API_KEY
DODO_WEBHOOK_SECRET
DODO_ENVIRONMENT
DODO_GROWTH_MONTHLY_PRODUCT_ID
DODO_GROWTH_YEARLY_PRODUCT_ID
DODO_ENTERPRISE_MONTHLY_PRODUCT_ID
DODO_ENTERPRISE_YEARLY_PRODUCT_ID
DODO_AI_CREDIT_EVENT_NAME
DODO_ACTIVE_DEAL_EVENT_NAME
DODO_EVENT_OVERAGE_EVENT_NAME
DODO_RETENTION_EVENT_NAME
```

`DODO_ENVIRONMENT` must be `test` before production acceptance and `live` only after test-mode acceptance succeeds.

## Webhook security and ordering

DealGuard validates the Standard Webhooks headers `webhook-id`, `webhook-timestamp` and `webhook-signature`, rejects delivery timestamps outside five minutes, compares HMAC-SHA256 signatures in constant time, and uses `webhook-id` for idempotency.

The handler persists and applies the small subscription-state transaction before returning success. A processing error returns non-2xx so Dodo retries it. The body event timestamp is stored on the subscription; older events cannot overwrite newer state, and an equal-time active event cannot regress a terminal cancellation or expiration. Sparse update and plan-change events preserve existing tier, product, interval, customer and period values when Dodo omits them.

Only `subscription.*` events can mutate entitlement. Payments, refunds, disputes, credits, grants and recovery events cannot activate, downgrade or cancel a DealGuard plan.

## Plan changes

DealGuard uses Dodo's provider-backed plan-change endpoints:

- Preview: `POST /subscriptions/{id}/change-plan/preview`
- Apply or schedule: `POST /subscriptions/{id}/change-plan`
- Cancel scheduled change: `DELETE /subscriptions/{id}/change-plan/scheduled`

Requests include product, quantity, proration mode, effective time and payment-failure behavior. DealGuard reads provider state before applying a change and re-reads it after an ambiguous provider failure, preventing duplicate plan mutations. Entitlements change only when the verified subscription webhook confirms provider state. Local scheduled changes are reserved for manual Enterprise contracts; Dodo plans are never changed by DealGuard's cron worker.

## Usage reporting

Usage is first reserved atomically in D1 using the portal, metric, billing-period start and idempotency key. The reservation and usage row are committed together, so concurrent scans cannot exceed a hard cap and duplicate calls cannot increment consumption twice.

A capped scan reserves its active-deal and event capacity before assessments, alerts or HubSpot writes begin. A Dodo reporting outage does not take DealGuard offline: the local reservation remains authoritative and the scheduled Worker retries the same idempotent provider event.

For metered subscriptions with administrator-enabled overage, DealGuard submits an idempotent event to Dodo's `/events/ingest` endpoint. Failed provider reports remain locally counted and are retried using the same Dodo event ID.

## Manual Enterprise contracts

Manual subscriptions support:

- Contract reference
- Purchase-order reference
- Currency
- Contract period
- Capped or metered usage mode
- Overage enablement
- Explicit allowances

Manual entitlements use the same application authorization, cap enforcement, usage ledger and audit controls as Dodo subscriptions.

## Acceptance

Before release, complete:

1. Test-mode checkout for Growth monthly and annual.
2. Test-mode checkout for Enterprise monthly and annual.
3. Customer Portal session.
4. Signed activation, update, renewal and plan-change webhooks.
5. On-hold grace, recovery, failed mandate, cancellation and expiration.
6. Out-of-order event delivery and stale-state rejection.
7. Payment, refund and dispute events verified as entitlement no-ops.
8. Metered `sum` and `max` event ingestion, quantity aggregation and idempotent retry.
9. Repeated-scan gauge validation and concurrent hard-cap enforcement.
10. Provider plan preview, immediate change, scheduled change, ambiguous-response recovery and cancellation.
11. Manual contract activation, expiry and allowance enforcement.
