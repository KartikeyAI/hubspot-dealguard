# DealGuard by Rokad

DealGuard is an enterprise HubSpot revenue-governance application that detects incomplete, stale, and risky deals; governs policy lifecycle; makes readiness signals native inside HubSpot; manages remediation SLAs; delivers operational events reliably; and provides auditable commercial, compliance, and reliability controls.

## What ships in v2.1.0

### Revenue governance

- Marketplace-distributed OAuth app targeting HubSpot developer platform `2026.03`.
- HubSpot deal-record readiness card, connected-app settings, and complete Enterprise App Home.
- Deterministic, explainable scoring across scheduled, manual, workflow, record-card, and webhook assessments.
- Seven fixed `dealguard_*` deal properties and reusable workflow outputs.
- Policy templates, segmentation, versioning, simulation, diff, import/export, two-person approval, publication, rollback, exceptions, evidence, and expiry.

### Executive analytics

- Historical readiness and amount-at-risk trends.
- Pipeline, stage, owner, team, and region breakdowns.
- Stage-aging heatmaps, failure patterns, handoff SLA, and policy-impact timelines.
- Audience-specific and customer-defined saved views plus secure CSV export.

### Access and approvals

- Fine-grained Enterprise roles and explicit permissions.
- Pipeline, team, owner, and region data scopes.
- Two-person high-impact change approvals, self-approval prevention, expiry, and last-administrator protection.

### Remediation operations

- Durable remediation cases with severity, priority, owner, manager, SLA, acknowledgement, escalation, waiver, closure, and reopening.
- Evidence requirements, independent evidence review, comments, and immutable timeline events.
- Bulk operations and HubSpot task creation attached to existing remediation cases.
- Workflow action for customer-owned remediation automation.

### Alerts and integration delivery

- Multiple Slack webhooks, Microsoft Teams Workflows, email channels, and HMAC-signed customer webhooks.
- Routing by event type, severity, pipeline, team, owner, and region.
- Direct owner/manager delivery, quiet hours, holidays, suppression, acknowledgement, and escalation policies.
- Durable outbox, Cloudflare Queue processing, retry, dead-letter state, replay, and delivery history.

### Compliance and audit

- Cryptographically chained immutable audit events.
- Actor, source, request, before/after, and hashed network-context attribution.
- Chain verification; CSV, JSON, and JSONL exports; SIEM streaming; legal holds; and customer-requested complete data exports.
- Configurable retention controls that stop destructive retention while a legal hold is active.
- Single-use export links that expire after ten minutes.
- Tigris-backed evidence, exports, attachments, and encrypted backup artifacts.

### Reliability

- Service SLOs, latency/success telemetry, synthetic checks, incident management, and a public status endpoint.
- Resumable scans using processed-deal checkpoints stable across HubSpot result reordering.
- Recoverable job leases, exponential backoff with jitter, service health, backup manifests, and restore-test evidence.
- Neon PostgreSQL through Cloudflare Hyperdrive, with immutable migrations and tenant constraint validation.

### Commercial infrastructure

- Dodo Payments Merchant-of-Record integration for Growth and Enterprise subscriptions.
- Test/live environments, monthly and annual products, hosted checkout, Customer Portal, signed/idempotent webhooks, ordered subscription state, trial/grace/cancellation state, and scheduled plan changes.
- Manual Enterprise contracts with contract and purchase-order references.
- Hybrid capped/metered usage, included allowances, atomic hard limits, optional overage, idempotent usage reporting, and retry.
- Provider-neutral entitlement schema; legacy provider records remain only for rollback or audit and are not authoritative.

### Security boundaries

- AES-256-GCM encryption for HubSpot, Slack, Teams, webhook, and SIEM credentials.
- Least-privilege application scopes and product-level authorization.
- DealGuard never autonomously changes deal stage, owner, amount, close date, or forecast category.
- Deterministic policy remains the readiness system of record.
- Direct Neon credentials are reserved for protected migration jobs; runtime access uses Hyperdrive.

## Repository layout

```text
src/app/                 HubSpot app, App Home, card, settings, workflow actions, and webhooks
worker/src/              Cloudflare Worker backend
database/migrations/     Canonical PostgreSQL schema migrations
scripts/                 Release, migration, backup, smoke, and acceptance tooling
test/                    Automated contract, migration, smoke, and regression tests
docs/                    Product, deployment, security, compliance, billing, and Marketplace documents
```

## Validate

```bash
npm install
npm run check
npm run db:migrate
npm run db:migrate:check
npm run db:validate
```

## Deploy and test

Start with:

1. [`docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md`](docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md)
2. [`docs/MIGRATION_D1_TO_NEON.md`](docs/MIGRATION_D1_TO_NEON.md)
3. [`docs/PRODUCTION_ACCEPTANCE_RUNBOOK.md`](docs/PRODUCTION_ACCEPTANCE_RUNBOOK.md)
4. [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)
5. [`docs/DODO_PAYMENTS_IMPLEMENTATION.md`](docs/DODO_PAYMENTS_IMPLEMENTATION.md)

Production enablement requires protected staging evidence, an encrypted and restore-tested backup, exact migration reconciliation, a production Worker deployment, HubSpot project upload and reauthorization, Dodo live configuration, production smoke evidence, and full signed acceptance.

## Current release

`2.1.0` — production release of DealGuard on Neon PostgreSQL, Cloudflare Hyperdrive, Tigris object storage, Cloudflare Queues, HubSpot developer platform `2026.03`, and Dodo Payments.
