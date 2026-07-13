# DealGuard by Rokad

DealGuard is a production-oriented HubSpot application that detects incomplete, stale, and risky deals and governs the closed-won sales-to-delivery handoff.

## What ships in v1

- Marketplace-distributed OAuth app targeting HubSpot developer platform `2026.03`.
- HubSpot deal-record readiness card.
- Connected-app pipeline-health dashboard, metadata-driven rule editor, and digest controls.
- Deterministic, explainable scoring engine.
- Background manual, installation, and scheduled portal scans with visible status.
- Closed-won handoff confirmation with critical-gap blocking.
- Free/Growth entitlement enforcement.
- Optional scheduled email digests.
- Cloudflare Worker + D1 multitenant backend.
- AES-256-GCM encrypted OAuth token storage.
- Request-signature validation, audit history, deletion flow, migrations, tests, and deployment runbook.

## Repository layout

```text
src/app/                 HubSpot app, card, and settings extension
worker/src/              Cloudflare Worker backend
worker/migrations/       D1 schema migrations
test/                    Node test suite
docs/                    Product, security, deployment, beta, and Marketplace documentation
```

## Validate

```bash
npm install
npm install --ignore-scripts --prefix src/app/cards
npm install --ignore-scripts --prefix src/app/settings
npm run check
```

## Deploy and test

Follow [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). The release becomes installable after Rokad supplies its HubSpot app credentials, Cloudflare D1 ID, Worker secrets, and production route.

## Current release

`1.0.0-beta.1` — sellable external-beta feature set with production controls and a documented live-install checklist. Billing checkout, predictive AI, record mutation, and external integrations are intentionally outside v1.
