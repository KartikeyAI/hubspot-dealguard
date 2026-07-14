# Deployment and enterprise release operations

DealGuard `2.1.0-rc.1` runs on Cloudflare Workers with Neon PostgreSQL through Cloudflare Hyperdrive, Tigris S3-compatible object storage, Cloudflare Queues, HubSpot developer platform `2026.03`, Dodo Payments, Slack, Resend, and customer-configured delivery or SIEM endpoints.

Repository validation proves source consistency. It does not replace authenticated provider provisioning, a protected staging deployment, signed HubSpot acceptance, backup verification, restore testing, or production approval.

## 1. Protected environments

Create these GitHub Environments:

- `dealguard-staging`
- `dealguard-production`
- `dealguard-acceptance`

Production must require an approving reviewer. Do not expose protected secrets to untrusted pull-request workflows.

### Environment variables

Configure these variables separately for staging and production:

```text
APP_BASE_URL
HUBSPOT_APP_ID
HUBSPOT_CLIENT_ID
HYPERDRIVE_CONFIG_ID
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

Use `https://dealguard-api-staging.rokad.co` for staging and `https://dealguard-api.rokad.co` for production. `DODO_ENVIRONMENT` must be `test` in staging and `live` only after production approval.

### Environment secrets

Configure:

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

`NEON_DATABASE_URL` is used only by reviewed migration and validation jobs. Runtime database traffic uses the environment-specific Hyperdrive binding. Restrict every credential to the minimum account, database, bucket, queue, Worker, or HubSpot application scope required.

The `dealguard-acceptance` environment requires at minimum:

```text
HUBSPOT_CLIENT_SECRET
DODO_WEBHOOK_SECRET
```

## 2. Infrastructure prerequisites

Provision separate staging and production resources:

1. Neon PostgreSQL databases or branches with encrypted connections and independent credentials.
2. Cloudflare Hyperdrive configurations pointing to the corresponding Neon database.
3. Tigris buckets with versioning or provider retention controls appropriate to the release policy.
4. Three Cloudflare Queues per environment for scans, delivery, and maintenance.
5. One dead-letter queue per environment.
6. Cloudflare Worker custom domains and the 15-minute scheduler.

The queue names and Worker bindings are declared in `wrangler.toml`. Provider resource identifiers remain environment-specific and are rendered only into ephemeral release configuration.

## 3. Repository and schema gate

A release candidate must pass:

```bash
npm install
npm run typecheck
npm run typecheck:ui
npm test
npm run db:migrate
npm run db:migrate:check
npm run db:validate
```

CI and Release readiness use a disposable PostgreSQL 17 service for schema application and tenant-isolation validation. This proves that migrations are contiguous and internally consistent without mutating staging or production.

The canonical migration directory is:

```text
database/migrations/
```

Migrations are immutable after application. `db:migrate:check` rejects a changed filename or checksum and rejects a database missing a committed migration.

## 4. Release readiness

Run **Release readiness** for the target environment before deployment. It:

1. executes Worker and HubSpot extension typechecks;
2. runs the full automated test suite;
3. applies and validates PostgreSQL migrations in a disposable database;
4. validates protected configuration by presence and format without publishing secret values;
5. checks package and health-version consistency;
6. validates the canonical HubSpot marketplace manifest and target renderer;
7. verifies Hyperdrive, Tigris, Cloudflare Queues, retry, and dead-letter contracts;
8. verifies migrations through `0014_neon_tigris_queues.sql`;
9. renders an ephemeral target-specific Wrangler file;
10. builds the selected Worker environment with `wrangler deploy --dry-run`;
11. publishes only checksums and non-sensitive evidence.

Equivalent local commands are:

```bash
npm run release:preflight
npm run release:bundle
```

Do not retain `.release/wrangler.toml` after the release operation.

## 5. Backup before any database change

Every protected deployment requires an encrypted pre-change PostgreSQL dump uploaded to Tigris. The input `backup_reference` is the object key, for example:

```text
backups/production/2026-07-14/dealguard-2.1.0-rc.1.sql.enc
```

Upload and verify a backup with:

```bash
npm run storage:backup:upload -- ./artifacts/dealguard.sql.enc \
  backups/production/2026-07-14/dealguard-2.1.0-rc.1.sql.enc

npm run storage:backup:head -- \
  backups/production/2026-07-14/dealguard-2.1.0-rc.1.sql.enc
```

The upload records a SHA-256 digest in object metadata. The protected deployment fails before migration if the object or checksum metadata is missing.

A backup reference is not sufficient by itself. Before production, download one protected backup, verify its digest, restore it into an isolated Neon branch, and record the restore test in release evidence.

## 6. Legacy data cutover

The first production release on Neon must follow `docs/MIGRATION_D1_TO_NEON.md`.

The cutover requires:

- a bounded write freeze;
- a final encrypted source export;
- schema application through migration `0014`;
- deterministic import into the `dealguard` schema;
- row-count reconciliation and key integrity checks;
- tenant-boundary, foreign-key, audit-chain, subscription, policy, and remediation validation;
- staging acceptance before production;
- a recorded rollback decision point before traffic is switched.

Do not deploy the new production Worker against an unverified empty or partially imported database.

## 7. Controlled deployment

Run **Controlled deploy** with:

- exact 40-character release commit SHA;
- target environment;
- verified Tigris backup object key;
- successful staging deployment run ID for production;
- acceptance profile and test portal details.

The workflow:

1. checks out the immutable commit without persisted credentials;
2. runs the repository gate and release preflight;
3. verifies matching staging evidence for production promotion;
4. verifies the Tigris backup object;
5. applies PostgreSQL migrations through the direct Neon migration credential;
6. verifies migration checksums and tenant constraints;
7. deploys the selected Wrangler environment;
8. checks `/health` and exact release version;
9. runs signed post-deployment acceptance;
10. records source, manifest, and migration checksums;
11. publishes a deployment evidence record retained for 90 days.

Application deployment command:

```bash
npx wrangler deploy --config .release/wrangler.toml --env staging
# or
npx wrangler deploy --config .release/wrangler.toml --env production
```

## 8. Runtime database access

The Worker receives a `HYPERDRIVE` binding. `worker/src/postgres.ts` connects through `HYPERDRIVE.connectionString` and establishes the `dealguard, public` search path.

Operational rules:

- never embed a direct Neon credential in Worker source or public configuration;
- use one Hyperdrive configuration per protected environment;
- use advisory locking for schema migrations;
- preserve immutable migration checksums;
- enforce tenant ownership through composite constraints where child relationships are tenant-owned;
- monitor connection errors, transaction failures, statement latency, and pool pressure.

## 9. Object storage

Tigris stores large immutable or downloadable artifacts such as evidence attachments, generated exports, and encrypted backup files.

Operational rules:

- object keys must be tenant-scoped for customer artifacts;
- upload completion must validate expected size and SHA-256;
- database rows store metadata and object references, not unbounded file bodies;
- signed access must be time-limited and permission-checked;
- deletion and legal-hold behavior must be tested together;
- backup objects must not share customer-download authorization paths.

## 10. Queue operations

Cloudflare Queues separate request handling from scans, external delivery, exports, and maintenance.

Current queue classes:

- scan queue: portal scans and resumable scan work;
- delivery queue: alerts, outbox, SIEM, billing usage, digests, and data exports;
- maintenance queue: remediation escalation, alert escalation, synthetics, billing schedules, policy exceptions, retention, audit promotion, secure-download cleanup, and maintenance.

Consumers use bounded retries. Exhausted messages are acknowledged only after the configured retry limit and are also routed by Cloudflare to the environment dead-letter queue. Monitor queue depth, age, retries, consumer failures, and dead-letter volume before production promotion.

## 11. HubSpot project upload

The committed HubSpot project remains canonical for production. Before staging upload, render a temporary target copy in a clean checkout or disposable worktree:

```bash
HUBSPOT_TARGET_BASE_URL=https://dealguard-api-staging.rokad.co \
  npm run hubspot:render-target
npm run hubspot:deps
npm run hubspot:upload
```

For production, use `https://dealguard-api.rokad.co`. Do not commit target-rendered files over the canonical production manifest.

Authenticated upload must validate:

- App Home V3;
- deal readiness card;
- settings extension;
- webhook subscriptions;
- **Assess deal with DealGuard** workflow action;
- **Create DealGuard remediation** workflow action;
- OAuth redirects and permitted fetch URL.

Repository JSON parsing is not HubSpot platform-schema approval.

## 12. HubSpot scopes and reauthorization

Current required scopes are:

```text
crm.objects.deals.read
crm.objects.deals.write
crm.objects.contacts.read
crm.objects.companies.read
crm.objects.tasks.write
crm.schemas.deals.read
crm.schemas.deals.write
```

Existing installations must reauthorize after scope changes. DealGuard writes only its namespaced derived properties and explicitly requested remediation tasks; it does not autonomously rewrite core commercial fields.

## 13. Dodo Payments

Create Growth and Enterprise monthly and annual products. Configure the Customer Portal and the appropriate environment webhook endpoint.

Validate in Dodo test mode:

- hosted checkout and Customer Portal;
- activation, renewal, `past_due`, recovery, cancellation, and expiry;
- immediate and next-billing-date changes;
- cancellation of scheduled changes;
- stale-event and terminal-state protections;
- webhook idempotency;
- cumulative and gauge usage meters;
- hard caps, optional overage, and manual Enterprise contracts.

Only verified `subscription.*` events can change commercial entitlement.

## 14. Signed acceptance

After deployment and HubSpot installation, run the protected acceptance profile.

Use `read-only` first, then `full`. The full profile may create an uncompleted checkout session, run a scan, assess a designated test deal, preview a plan change, validate signature isolation, and verify single-use exports. It must not pay, cancel, delete tenant data, publish policy, change roles, or mutate a subscription plan.

Complete manual account-bound validation for governance, analytics, remediation, routed delivery, queue retries, dead-letter handling, audit continuity, object uploads, legal holds, backup restore, and disaster recovery.

## 15. Rollback and incident boundary

Before traffic cutover, rollback means keeping the previous Worker active and discarding the candidate Neon branch after preserving evidence.

After traffic cutover:

1. stop new release activity and pause queue producers if data integrity is uncertain;
2. identify the last known-good Worker deployment and database restore point;
3. preserve logs, queue state, migration records, and backup references;
4. restore into an isolated Neon branch first;
5. validate tenant counts, audit continuity, subscriptions, policies, remediation, and object references;
6. switch Hyperdrive only through an approved incident change;
7. deploy the compatible Worker version;
8. run read-only acceptance before reopening writes.

Never reverse an applied production schema migration automatically. Prefer forward repair or verified restore-and-switch.

## 16. Local development

Create `.dev.vars` from `.env.example`, provide a local PostgreSQL database, and run:

```bash
npm run db:migrate
npm run db:validate
npm run dev:worker
```

HubSpot UI extensions cannot fetch arbitrary localhost origins. Use HubSpot local development tooling with its proxy or an approved temporary HTTPS Worker URL included in the rendered test manifest.
