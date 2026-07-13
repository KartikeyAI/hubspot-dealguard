# Dodo Payments event mapping

DealGuard treats webhook delivery as an unordered, retryable event stream. The runtime derives subscription state from the latest verified payload and applies idempotency using `webhook-id`.

## Subscription lifecycle

| Dodo event family | DealGuard state |
|---|---|
| subscription.active / renewed | `active` |
| subscription.trialing | `trialing` |
| subscription.on_hold / paused | `on_hold` with grace when configured |
| subscription.past_due | `past_due` with grace |
| subscription.failed / payment failed | `failed` unless a recoverable grace payload applies |
| subscription.cancelled / canceled | `cancelled` |
| subscription.expired | `expired` |

## Required metadata

Checkout sessions and subscription records must preserve:

- `portal_id`
- `tier`
- `interval`
- `usage_mode`
- `overage_enabled`

The HubSpot portal ID is the tenant correlation key. Events without a valid portal ID are retained as ignored billing events and do not alter entitlements.

## Ordering

Webhook events may arrive out of order. Product acceptance must verify that an older payload cannot re-enable access after a newer cancellation or expiration. Production event handlers should compare provider timestamps and current subscription period data when the Dodo payload exposes them.

## Idempotency

- `webhook-id` is stored as `provider_event_id`.
- Processed and ignored events are no-ops on replay.
- Failed events remain retryable.
- Payload hashes are stored for diagnostics without treating the payload hash as the event identity.
