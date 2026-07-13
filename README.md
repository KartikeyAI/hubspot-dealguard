# DealGuard by Rokad

DealGuard is a production-oriented HubSpot application that detects incomplete, stale, and risky deals, makes readiness signals available natively inside HubSpot, monitors high-signal deal changes in real time, and governs the closed-won sales-to-delivery handoff.

## What ships in v1.2

- Marketplace-distributed OAuth app targeting HubSpot developer platform `2026.03`.
- HubSpot deal-record readiness card.
- Connected-app settings and pipeline-health view.
- Deterministic, explainable scoring engine.
- Manual, installation, scheduled, and webhook-triggered assessments.
- Seven fixed `dealguard_*` deal properties for native HubSpot lists, views, filters, reports, and workflows.
- Growth-only property provisioning, controlled backfill, and ongoing write-back.
- Reusable workflow outputs for score, status, grade, issue count, handoff state, summary, and assessment time.
- Closed-won handoff confirmation with critical-gap blocking.
- Slack OAuth using the minimal `incoming-webhook` permission.
- Transition-aware Slack alerts for critical deals and handoff events.
- Idempotent webhook and notification processing with bounded retention.
- Free/Growth entitlement enforcement and beta-Growth access.
- Optional scheduled email digests.
- Cloudflare Worker + D1 multitenant backend.
- AES-256-GCM encrypted HubSpot and Slack credential storage.
- Request-signature validation, audit history, complete deletion flow, migrations, tests, and deployment runbook.

## Repository layout

```text
src/app/                 HubSpot app, card, settings, workflow action, and webhooks
worker/src/              Cloudflare Worker backend
worker/migrations/       D1 schema migrations
test/                    Node test suite
docs/                    Product, security, deployment, beta, and Marketplace documentation
```

## Validate

```bash
npm install
npm run check
rm -rf .wrangler/state
npm run db:migrate:local
```

## Deploy and test

Follow [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Existing installations must reauthorize after v1.2 deployment because native HubSpot persistence adds deal and deal-schema write scopes. Native sync remains disabled until a Growth administrator provisions the DealGuard properties and explicitly enables it.

## Current release

`1.2.0-beta.1` — external-beta release adding HubSpot-native DealGuard properties, controlled backfill, ongoing CRM write-back, and reusable workflow outputs. Predictive AI, autonomous stage changes, and writes to customer-owned non-DealGuard fields remain outside this release.
