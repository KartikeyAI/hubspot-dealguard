# DealGuard by Rokad

DealGuard is an enterprise HubSpot revenue-governance application that detects incomplete, stale, and risky deals, governs scoring policy, makes readiness signals native inside HubSpot, manages remediation SLAs, and delivers operational events reliably across customer systems.

## What ships in v1.4

- Marketplace-distributed OAuth app targeting HubSpot developer platform `2026.03`.
- HubSpot deal-record readiness card, connected-app settings, and Enterprise App Home.
- Deterministic, explainable scoring engine with scheduled, manual, workflow, and webhook assessments.
- Seven fixed `dealguard_*` deal properties and reusable workflow outputs.
- Enterprise policy lifecycle with simulation, two-person approval, publication, history, and rollback.
- Role-controlled administration, searchable audit events, and CSV export.
- Durable remediation cases with severity, priority, ownership, SLA, status history, escalation, and auto-resolution.
- Optional HubSpot remediation tasks associated with affected deals.
- DealGuard workflow action for creating remediation cases from customer-owned workflows.
- Slack alerts plus Microsoft Teams Workflow, email, and signed webhook destinations.
- Routing by event type, minimum severity, and pipeline.
- Durable delivery outbox with processing leases, exponential backoff, dead-letter state, replay, and delivery history.
- Per-portal service health for scans, webhooks, delivery, dead letters, and overdue remediations.
- Stripe-hosted subscription Checkout, Stripe Customer Portal, signed/idempotent billing webhooks, grace periods, and manual Enterprise contracts.
- Cloudflare Worker + D1 multitenant backend with AES-256-GCM encrypted HubSpot, Slack, Teams, and webhook credentials.

## Repository layout

```text
src/app/                 HubSpot app, App Home, card, settings, workflow actions, and webhooks
worker/src/              Cloudflare Worker backend
worker/migrations/       D1 schema migrations
test/                    Node test suite
docs/                    Product, security, deployment, and Marketplace documentation
```

## Validate

```bash
npm install
npm run check
rm -rf .wrangler/state
npm run db:migrate:local
```

## Deploy and test

Follow [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Existing installations must reauthorize for the HubSpot task-write scope added in v1.4. Configure Stripe price IDs and webhook signing, then apply the v1.4 migration before enabling paid Enterprise operations.

## Current release

`1.4.0-beta.1` — enterprise-operations release adding remediation SLAs, HubSpot tasks, routed delivery destinations, durable retries/dead letters, health visibility, and commercial subscription infrastructure. Deterministic policy remains the system of record; predictive AI and autonomous changes to core deal fields remain outside this release.
