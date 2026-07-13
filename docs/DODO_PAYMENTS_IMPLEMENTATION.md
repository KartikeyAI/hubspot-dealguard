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

Attach usage meters to products intended for metered overage. Configure each meter to aggregate the numeric `quantity` metadata property and use event names matching the Worker secrets or defaults:

- `dealguard_ai_credit`
- `dealguard_active_deal_overage`
- `dealguard_event_overage`
- `dealguard_retention_gb_month`

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

## Usage reporting

Usage is first reserved atomically in D1 using the portal, metric, billing-period start and idempotency key. The reservation and usage row are committed together, so concurrent scans cannot exceed a hard cap and duplicate calls cannot increment consumption twice.

For metered subscriptions with administrator-enabled overage, DealGuard submits an idempotent event to Dodo's `/events/ingest` endpoint. The event includes `quantity` in metadata for the configured meter aggregation. Failed provider reports remain locally counted and are retried by the scheduled Worker using the same Dodo event ID.

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
8. Metered event ingestion, quantity aggregation and idempotent retry.
9. Concurrent hard-cap enforcement.
10. Manual contract activation, expiry and allowance enforcement.
11. Upgrade, downgrade and scheduled plan-change tests.
