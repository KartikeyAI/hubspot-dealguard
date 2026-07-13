# Dodo Payments implementation

DealGuard uses Dodo Payments as its primary self-service commercial platform and Merchant of Record. The internal entitlement service remains authoritative; Dodo events update that neutral entitlement state.

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

Attach usage meters to products intended for metered overage. Configure event names matching the Worker secrets or the defaults:

- `dealguard_ai_credit`
- `dealguard_active_deal_overage`
- `dealguard_event_overage`
- `dealguard_retention_gb_month`

Create the webhook endpoint:

```text
https://dealguard-api.rokad.co/webhooks/dodo
```

Subscribe to subscription lifecycle, payment failure/recovery, refund, dispute and entitlement events required by the production account.

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

## Webhook security

DealGuard validates the Standard Webhooks headers `webhook-id`, `webhook-timestamp` and `webhook-signature`, rejects timestamps outside five minutes, compares HMAC-SHA256 signatures in constant time, stores event IDs for idempotency, and processes verified events asynchronously.

## Usage reporting

Usage events are first stored in D1 with an idempotency key. Metered events are then reported to Dodo's event-ingestion endpoint. Failed reports remain recoverable and are retried by the scheduled Worker.

## Manual Enterprise contracts

Manual subscriptions support:

- Contract reference
- Purchase-order reference
- Currency
- Contract period
- Capped or metered usage mode
- Overage enablement
- Explicit allowances

Manual entitlements use the same application authorization and usage enforcement as Dodo subscriptions.

## Acceptance

Before release, complete:

1. Test-mode checkout for Growth monthly and annual.
2. Test-mode checkout for Enterprise monthly and annual.
3. Customer Portal session.
4. Signed subscription activation webhook.
5. Payment-failure grace and recovery.
6. Cancellation and immediate entitlement removal.
7. Metered event ingestion and idempotent retry.
8. Manual contract activation and expiry.
9. Upgrade, downgrade and scheduled plan-change tests.
10. Refund and dispute handling according to Rokad's commercial policy.
