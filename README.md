# DealGuard by Rokad

DealGuard is a production-oriented HubSpot application that detects incomplete, stale, and risky deals, monitors high-signal deal changes in real time, and governs the closed-won sales-to-delivery handoff.

## What ships in v1.1

- Marketplace-distributed OAuth app targeting HubSpot developer platform `2026.03`.
- HubSpot deal-record readiness card.
- Connected-app settings and pipeline-health view.
- Deterministic, explainable scoring engine.
- Manual, installation, scheduled, and webhook-triggered assessments.
- Closed-won handoff confirmation with critical-gap blocking.
- Slack OAuth using the minimal `incoming-webhook` permission.
- Transition-aware Slack alerts for critical deals and handoff events.
- Deal-based HubSpot workflow action with optional Slack delivery.
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

Follow [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). A live installation requires Rokad's HubSpot credentials, Cloudflare D1 database, Worker secrets and route, plus a Slack app for the optional Slack channel integration.

## Current release

`1.1.0-beta.1` — external-beta release adding Slack operations, real-time HubSpot event processing, and a workflow action. Deterministic scoring remains the system of record; predictive AI and autonomous record mutation remain outside this release.
