# Enterprise A–H traceability

This matrix maps the enterprise release requirements to the implementation modules.

| Area | Primary implementation |
|---|---|
| A — Policy management | `enterprise-policy.ts`, `enterprise-routes.ts`, governance tables in migration 0007 |
| B — Analytics | `enterprise-analytics-v2.ts`, `EnterpriseHomeV2.tsx`, analytics and saved-view tables |
| C — Roles and approvals | `enterprise-access.ts`, `authorization.ts`, scoped role tables and approval controls |
| D — Remediation | `remediation-enterprise.ts`, `remediation-task.ts`, evidence/comment/bulk-operation tables |
| E — Alerts | `alerting-enterprise.ts`, `outbox.ts`, destination, acknowledgement, quiet-hour and escalation tables |
| F — Audit and compliance | `audit-chain.ts`, `compliance.ts`, `secure-downloads.ts`, audit-chain/legal-hold/export/SIEM tables |
| G — Reliability | `reliability.ts`, scheduled Worker integration, checkpoint/synthetic/incident tables |
| H — Commercial | `billing.ts`, Dodo checkout/webhook/usage logic, subscription/allowance/usage tables |

A feature is complete only when the automated and live acceptance checks in `ENTERPRISE_COMPLETE_ACCEPTANCE.md` pass.
