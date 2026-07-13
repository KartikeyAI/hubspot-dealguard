# DealGuard Enterprise 2.0 release scope

DealGuard 2.0 is the enterprise-complete HubSpot revenue governance release. It replaces the Stripe-specific commercial layer with Dodo Payments and closes the remaining product gaps across governance, analytics, permissions, remediation, delivery, compliance, reliability and commercial operations.

## Included

- Enterprise policy templates, segmentation, exceptions, import/export and simulation
- Executive and operational analytics with drill-down and saved views
- Fine-grained role and scope enforcement
- Evidence-backed remediation, comments, bulk operations and SLA queues
- Multi-destination alert routing, quiet hours, acknowledgement and escalation
- Hash-chained audit, compliance exports, legal holds and SIEM delivery
- Synthetic monitoring, resumability, runbooks and operational health
- Dodo Payments subscriptions, customer portal, usage metering and manual contracts

## Authority boundary

DealGuard may write only DealGuard-owned CRM fields and explicitly requested HubSpot tasks. It does not autonomously change deal stage, owner, amount, close date or forecast category.

## Commercial boundary

Dodo Payments is the primary self-service Merchant of Record. The entitlement and metering model is provider-neutral and supports manual Enterprise contracts. Customers can use capped plans or explicitly enable usage overage.

## Release status

The source implementation is a release candidate until all automated gates and live acceptance gates in `ENTERPRISE_COMPLETE_ACCEPTANCE.md` pass.
