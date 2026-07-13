# DealGuard by Rokad

DealGuard is an enterprise-oriented HubSpot revenue-governance application that detects incomplete, stale, and risky deals, makes readiness signals available natively inside HubSpot, monitors high-signal changes in real time, and governs the closed-won sales-to-delivery handoff.

## What ships in v1.3

- Marketplace-distributed OAuth app targeting HubSpot developer platform `2026.03`.
- HubSpot deal-record readiness card, connected-app settings, and dedicated App Home.
- Deterministic, explainable scoring engine.
- Manual, installation, scheduled, and webhook-triggered assessments.
- Seven fixed `dealguard_*` deal properties for native HubSpot lists, views, filters, reports, and workflows.
- Reusable workflow outputs for score, status, grade, issue count, handoff state, summary, and assessment time.
- Enterprise policy lifecycle: draft, edit, submit, approve, reject, publish, supersede, simulate, and rollback.
- Two-person approval controls and prevention of policy self-approval.
- Governance roles for administrators, policy administrators, approvers, managers, and viewers.
- Direct live-rule editing lock after governance is enabled.
- Pipeline amount-at-risk, readiness, handoff, owner, pipeline, and trend analytics.
- Searchable audit API and CSV export.
- Slack OAuth and governed alerts for critical deals and handoff events.
- Closed-won handoff confirmation with critical-gap blocking.
- Cloudflare Worker + D1 multitenant backend with encrypted HubSpot and Slack credentials.
- Request-signature validation, complete deletion flow, migrations, tests, and deployment runbook.

## Repository layout

```text
src/app/                 HubSpot app, App Home, card, settings, workflow action, and webhooks
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

Follow [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Existing installations must reauthorize for DealGuard-owned deal and schema write scopes introduced in v1.2. Enterprise governance remains disabled until an eligible portal administrator captures and publishes the baseline policy.

## Current release

`1.3.0-beta.1` — enterprise-governance release adding App Home, policy lifecycle controls, role-based administration, two-person approval, simulations, rollback, commercial-risk analytics, and audit export. Predictive AI, autonomous stage changes, and writes to customer-owned non-DealGuard fields remain outside this release.
