# DealGuard commercial model

DealGuard uses hybrid pricing designed for predictable enterprise procurement and cost-aligned overage.

## Base subscription

The base subscription is charged per HubSpot portal and includes:

- Portal access
- Deterministic deal assessments
- Scheduled and event-driven scans
- Workflow actions
- Standard notifications
- Governance, remediation and reporting according to tier
- Included usage allowances

## Usage dimensions

Only cost-sensitive or unusually high-volume dimensions are metered:

- AI credits
- Active-deal volume above included capacity
- Event volume above included capacity
- Extended retained-data volume

Customers are never billed per remediation action, policy approval, normal notification or routine workflow execution.

## Capped mode

- Overage is disabled.
- DealGuard blocks the applicable cost-bearing action when the hard limit is reached.
- The customer can upgrade, purchase a larger allowance or wait for the period reset.

## Metered mode

- Overage is explicitly enabled by an administrator.
- DealGuard records usage locally with an idempotency key.
- Eligible events are reported to Dodo Payments.
- Failed provider reports are retried without double billing.

## Enterprise contracts

Enterprise may be purchased through Dodo Payments or a manual contract with invoice, purchase order and bank transfer. Manual contracts use the same entitlements, allowances, security and audit controls as self-service subscriptions.

## Services

Rokad implementation, migration, integration, training and managed RevOps services are invoiced separately from the DealGuard software subscription.
