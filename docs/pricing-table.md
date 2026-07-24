# DealGuard pricing table

DealGuard uses a hybrid commercial model with a portal-level base subscription and usage-based overage only when explicitly enabled. The base subscription and included allowances are defined in [docs/COMMERCIAL_MODEL.md](COMMERCIAL_MODEL.md) and the Dodo meter semantics are described in [docs/DODO_PAYMENTS_IMPLEMENTATION.md](DODO_PAYMENTS_IMPLEMENTATION.md).

## Base subscription summary

The self-service commercial flow is priced per HubSpot portal. The starter launch recommendation below keeps the base subscription straightforward and leaves usage overage as a clear optional extension when the customer enables metered billing.

| Plan       | Billing cadence | Recommended starter base price | Notes                                                                                   |
| ---------- | --------------- | -----------------------------: | --------------------------------------------------------------------------------------- |
| Growth     | Monthly         |                      $99/month | Good fit for small and mid-market HubSpot installs.                                     |
| Growth     | Annual          |                    $1,188/year | Recommended launch discount: 0% to 5% off the monthly equivalent for annual commitment. |
| Enterprise | Monthly         |                     $499/month | Appropriate for higher automation, larger volume, and advanced governance needs.        |
| Enterprise | Annual          |                    $5,988/year | Recommended launch discount: 0% to 5% off the monthly equivalent for annual commitment. |

## Recommended starter pricing

The table below is a simple launch recommendation for the metered dimensions already modeled in the codebase. These are starter rates for commercial alignment, not fixed legal pricing.

| Metric                | Charge unit                                           | Included allowance in current defaults           | Hard limit in current defaults           | Recommended starter overage price | Notes                                                                                                                 |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------ | ---------------------------------------- | --------------------------------: | --------------------------------------------------------------------------------------------------------------------- |
| `active_deal_overage` | 1 additional active deal above the included allowance | Growth: 5,000; Enterprise: 25,000                | Growth: 10,000; Enterprise: unlimited    |             $0.02 per active deal | Use the monthly peak active-deal gauge reached during the billing period.                                             |
| `event_overage`       | 1 additional event above the included allowance       | Growth: 250,000; Enterprise: 2,500,000           | Growth: 1,000,000; Enterprise: unlimited |                $0.00002 per event | Good fit for high-volume event lift when customers exceed the included event budget.                                  |
| `ai_credit`           | 1 additional AI credit above the included allowance   | Growth: 500 included; Enterprise: 5,000 included | Growth: 2,000; Enterprise: unlimited     |               $0.02 per AI credit | Keep this price visibly lower than the cost-sensitive event overage rate because AI credits are a premium capability. |
| `retention_gb_month`  | 1 additional GB retained above the included allowance | Growth: 5 GB; Enterprise: 50 GB                  | Growth: 20 GB; Enterprise: unlimited     |                      $1.00 per GB | Useful as a predictable cost-aligned retained-data overage rule.                                                      |

## Pricing logic

- Every subscription is billed per HubSpot portal.
- Included allowances are bundled into the plan and must be purchased up front.
- Hard limits are the guardrail: once the included quantity is exhausted, the customer must either stay within the hard limit, enable overage, or wait for the next reset period.
- Metered overage is only applied when the customer has explicitly enabled overage.
- Overage should remain conservative and explainable to administrators in the HubSpot app.
- The codebase currently treats `active_deal_overage` as a gauge-style metric with `max` aggregation, while `event_overage` and `ai_credit` are accumulation-style metrics with `sum` aggregation.

## Suggested launch position

For the initial launch, use the following plan-wide steering values:

- `active_deal_overage`: $0.02 per active deal over the included allowance
- `event_overage`: $0.00002 per event over the included allowance
- `ai_credit`: $0.02 per AI credit over the included allowance
- `retention_gb_month`: $1.00 per GB over the included allowance

For annual commitments, keep the launch discount small and predictable: a 0% to 5% savings compared with the equivalent monthly spend. That is enough to support a yearly sales motion without creating a separate, hard-to-explain pricing ladder.

## Manual enterprise contracts

Manual Enterprise contracts should keep the same usage dimensions and overage semantics as self-service Dodo products, but the contract itself may include negotiated base pricing, annual commitment terms, custom implementation services, purchase-order handling, and bank-transfer invoicing. The entitlement and usage logic should remain provider-neutral so that Dodo and manual contracts are governed by the same allowance and overage policy.

## Implementation note

The Dodo meter for each metric should be configured with:

- the appropriate overage meter semantics
- a measurement unit that matches the billing concept
- aggregation aligned to the metric's effective billing behavior
