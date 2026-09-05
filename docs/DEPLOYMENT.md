# DealGuard 2.1.0 deployment and release operations

DealGuard runs on Cloudflare Workers with direct TLS-enforced Neon PostgreSQL connectivity, Tigris S3-compatible object storage, Cloudflare Queues, HubSpot developer platform `2026.03`, Dodo Payments, Resend, Slack, and customer-configured delivery or SIEM endpoints.

For the first production deployment, follow these documents in order:

1. [`PRODUCTION_DEPLOYMENT_RUNBOOK.md`](PRODUCTION_DEPLOYMENT_RUNBOOK.md)
2. [`MIGRATION_D1_TO_NEON.md`](MIGRATION_D1_TO_NEON.md)
3. [`PRODUCTION_ACCEPTANCE_RUNBOOK.md`](PRODUCTION_ACCEPTANCE_RUNBOOK.md)

This document describes the permanent release model after the initial cutover.

## Protected environments

Create:

- `dealguard-staging`;
- `dealguard-production`;
- `dealguard-acceptance`.

Production must require an approving reviewer. Do not expose protected secrets to untrusted pull-request workflows.

### Environment variables

Configure separately for staging and production:

```text
APP_BASE_URL
HUBSPOT_APP_ID
HUBSPOT_CLIENT_ID
TIGRIS_ENDPOINT
TIGRIS_REGION
TIGRIS_BUCKET
SLACK_CLIENT_ID
DODO_ENVIRONMENT
DODO_GROWTH_MONTHLY_PRODUCT_ID
DODO_GROWTH_YEARLY_PRODUCT_ID
DODO_ENTERPRISE_MONTHLY_PRODUCT_ID
DODO_ENTERPRISE_YEARLY_PRODUCT_ID
DODO_AI_CREDIT_EVENT_NAME
DODO_ACTIVE_DEAL_EVENT_NAME
DODO_EVENT_OVERAGE_EVENT_NAME
DODO_RETENTION_EVENT_NAME
```

Use:

```text
staging:    https://dealguard-api-staging.rokad.co
production: https://dealguard-api.rokad.co
```

`DODO_ENVIRONMENT` must be `test` in staging and `live` in production.

### Environment secrets

```text
NEON_DATABASE_URL
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
HUBSPOT_CLIENT_SECRET
HUBSPOT_CLI_CONFIG_B64
TOKEN_ENCRYPTION_KEY
ADMIN_API_KEY
TIGRIS_ACCESS_KEY_ID
TIGRIS_SECRET_ACCESS_KEY
RESEND_API_KEY
SLACK_CLIENT_SECRET
DODO_API_KEY
DODO_WEBHOOK_SECRET
```

`NEON_DATABASE_URL` is used by protected migration and validation jobs and by the Worker runtime through the Neon serverless driver. Store it only as an environment secret, require TLS, and use separate staging and production branches and least-privilege roles.

## Infrastructure isolation

Provision independent staging and production resources:

1. Neon database branch and least-privilege roles;
2. Tigris bucket and scoped credentials;
3. scan queue;
4. delivery queue;
5. maintenance queue;
6. dead-letter queue;
7. Worker custom domain;
8. scheduled trigger.

Never point staging and production at the same database branch, bucket, queue, HubSpot app, or Dodo environment.

## Repository gate

A release must pass:

```bash
npm install
npm run typecheck
npm run typecheck:ui
npm test
npm run db:migrate
npm run db:migrate:check
npm run db:validate
```

The canonical migration directory is:

```text
database/migrations/
```

Applied migration filenames and checksums are immutable.

## Release identity

The package version and Worker health version must match.

For DealGuard 2.1.0:

```text
package.json:            2.1.0
worker/src/version.ts:   2.1.0
GET /health:             2.1.0
```

`/health` must return:

```json
{
  "status": "ok",
  "service": "dealguard-api",
  "version": "2.1.0"
}
```

## Release readiness

Run **Release readiness** for staging first and production only as a configuration audit.

It validates:

- Worker and HubSpot typechecks;
- automated tests;
- PostgreSQL migrations and tenant constraints;
- protected configuration presence and format;
- stable release identity;
- HubSpot marketplace manifest and target rendering;
- direct Neon, Tigris, Queues, retry, and dead-letter contracts;
- production deployment and acceptance documentation;
- target-specific Wrangler dry run;
- non-sensitive checksums and evidence.

Equivalent commands:

```bash
npm run release:preflight
npm run release:bundle
```

The rendered `.release/wrangler.toml` is ephemeral and must not be committed.

## Backup requirement

Every protected deployment requires a verified encrypted PostgreSQL backup object in Tigris.

Example:

```text
backups/production/2026-07-18/dealguard-2.1.0.sql.enc
```

Upload and verify:

```bash
npm run storage:backup:upload -- ./artifacts/dealguard-2.1.0.sql.enc \
  backups/production/2026-07-18/dealguard-2.1.0.sql.enc

npm run storage:backup:head -- \
  backups/production/2026-07-18/dealguard-2.1.0.sql.enc
```

Before production, download and restore one protected backup into an isolated Neon branch and record the restore test.

## Controlled deploy

Run the **Controlled deploy** workflow.

Staging requires:

- exact release SHA;
- verified staging backup reference;
- acceptance portal and administrator;
- preferably the `full` profile and a real test deal.

Production additionally requires:

- successful full-profile staging run ID for the exact SHA;
- `acceptance_profile=full`;
- a real production acceptance test deal;
- exact confirmation phrase `DEPLOY DEALGUARD TO PRODUCTION`;
- production environment approval.

The workflow executes:

1. immutable input validation;
2. exact SHA checkout;
3. stable semantic-version validation;
4. repository gate;
5. protected release preflight;
6. staging evidence verification for production;
7. Tigris backup verification;
8. PostgreSQL migration and checksum verification;
9. tenant constraint validation;
10. target-specific Worker deployment;
11. health identity verification;
12. public smoke checks;
13. signed acceptance;
14. release and migration checksums;
15. deployment evidence generation.

## Public smoke verification

Run independently with:

```bash
PRODUCTION_SMOKE_BASE_URL=https://dealguard-api.rokad.co \
npm run production:smoke
```

The smoke suite verifies:

- exact HTTPS production origin;
- health and release identity;
- public status response;
- docs, privacy, terms, and support;
- unsigned API rejection;
- HubSpot OAuth redirect contract;
- absence of obvious secret leakage.

Evidence is written under `.release/production-smoke/`.

## Signed acceptance

Run the `full` profile for final production certification:

```bash
ACCEPTANCE_PROFILE=full \
ACCEPTANCE_BASE_URL=https://dealguard-api.rokad.co \
ACCEPTANCE_PORTAL_ID=<portal-id> \
ACCEPTANCE_USER_EMAIL=<admin-email> \
ACCEPTANCE_TEST_DEAL_ID=<deal-id> \
HUBSPOT_APP_ID=<app-id> \
HUBSPOT_CLIENT_SECRET=<secret> \
DODO_WEBHOOK_SECRET=<secret> \
npm run acceptance:live
```

See [`PRODUCTION_ACCEPTANCE_RUNBOOK.md`](PRODUCTION_ACCEPTANCE_RUNBOOK.md) for the complete automated and manual test matrix.

## HubSpot project upload

Render target-specific files only in a clean checkout or disposable worktree.

Staging:

```bash
HUBSPOT_TARGET_BASE_URL=https://dealguard-api-staging.rokad.co npm run hubspot:render-target
npm run hubspot:deps
npm run hubspot:upload
```

Production:

```bash
HUBSPOT_TARGET_BASE_URL=https://dealguard-api.rokad.co npm run hubspot:render-target
npm run hubspot:deps
npm run hubspot:upload
```

Validate App Home, the deal card, settings, webhooks, both workflow actions, OAuth redirects, permitted fetch URLs, and all declared scopes.

## Database operations

Operational rules:

- never embed direct Neon credentials in Worker source or public configuration;
- use separate TLS-enforced Neon branches and least-privilege runtime roles per protected environment;
- use advisory locking for migrations;
- preserve immutable migration checksums;
- enforce composite tenant constraints for tenant-owned relationships;
- monitor connection errors, transaction failures, latency, and pool pressure;
- never automatically reverse an applied production migration.

## Tigris operations

Tigris stores large evidence, exports, attachments, and encrypted backups.

Rules:

- tenant-scope customer artifact keys;
- validate upload size and SHA-256;
- keep unbounded file bodies outside PostgreSQL;
- use permission-checked, time-limited access;
- test legal hold and deletion together;
- isolate backup authorization from customer downloads.

## Queue operations

Queue classes:

- scan queue: portal scans and resumable scan work;
- delivery queue: alerts, outbox, SIEM, billing usage, digests, and exports;
- maintenance queue: escalation, synthetics, billing schedules, exceptions, retention, audit promotion, and cleanup.

Monitor queue depth, age, retries, consumer failures, and dead-letter volume. Every dead-letter item must be explained before production release approval.

## Rollback

Before writes reopen, rollback means retaining the previous production runtime and source of truth while discarding the candidate target after preserving evidence.

After writes reopen:

1. pause writes and queue producers;
2. preserve logs and queue state;
3. reconcile the post-cutover write interval;
4. restore into an isolated branch;
5. validate tenant and domain invariants;
6. update the protected Worker database secret only through an approved incident change;
7. deploy the compatible Worker;
8. run public smoke and read-only signed acceptance;
9. reopen writes only after approval.

Prefer forward repair or verified restore-and-switch. Do not use automatic reverse schema migrations.

## Deployment evidence

Retain:

- deployment record;
- release preflight;
- health response;
- public smoke JSON and Markdown;
- signed acceptance JSON and Markdown;
- release checksums;
- migration checksums;
- backup reference and restore evidence;
- migration reconciliation reports;
- HubSpot and provider-console evidence;
- final go/no-go approval.
