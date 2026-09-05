# DealGuard 2.1.0 production deployment runbook

This is the authoritative operator procedure for the first production deployment of DealGuard on Cloudflare Workers with direct TLS-enforced Neon PostgreSQL connectivity, Tigris, and Cloudflare Queues.

The production release is not a single `wrangler deploy` command. It is a controlled sequence with immutable source, backup verification, data reconciliation, HubSpot platform deployment, signed acceptance, evidence retention, and an explicit go/no-go decision.

## Production go/no-go rule

Proceed only when every required item in this runbook is recorded as **PASS**. Stop immediately when a blocking check fails. Do not improvise around failed tenant constraints, row reconciliation, backup verification, signed acceptance, queue delivery, OAuth, or billing state.

## Roles

Assign these roles before the change window:

| Role | Responsibility |
|---|---|
| Release operator | Runs GitHub workflows and provider commands |
| Database operator | Owns source freeze, snapshot, import, reconciliation, and restore |
| HubSpot operator | Uploads the app, installs or reauthorizes it, and validates UI surfaces |
| Billing operator | Validates Dodo live configuration and lifecycle behavior |
| Approver | Reviews evidence and approves production environment deployment |
| Incident lead | Owns rollback decision and communications |

One person may hold multiple roles, but the release operator and final approver should be different people.

## Phase 0 — Freeze the release source

1. Confirm PR #7 contains the intended release.
2. Record the exact 40-character head SHA.
3. Confirm the package version is `2.1.0`.
4. Confirm `/health` is served from `worker/src/version.ts` and reports `2.1.0`.
5. Confirm the latest CI run for the exact SHA is green.
6. Confirm no unresolved pull-request review thread exists.
7. Do not add feature changes after this point. Any code change creates a new release SHA and invalidates prior staging evidence.

Evidence:

- release SHA;
- CI run URL and run number;
- PR review status;
- package and Worker version checksums.

## Phase 1 — Configure protected GitHub environments

Create or verify:

- `dealguard-staging`;
- `dealguard-production`;
- `dealguard-acceptance`.

For `dealguard-production`:

1. Require at least one approving reviewer.
2. Prevent self-approval by the release operator where organizational controls allow it.
3. Restrict deployment branches to `main` or the approved release branch.
4. Ensure secrets are not exposed to pull requests from untrusted forks.
5. Set a deployment wait timer only when it fits the agreed change window.

### Required environment variables

Configure these separately for staging and production:

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

Production values:

```text
APP_BASE_URL=https://dealguard-api.rokad.co
DODO_ENVIRONMENT=live
TIGRIS_ENDPOINT=https://t3.storage.dev
TIGRIS_REGION=auto
```

### Required environment secrets

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

Rules:

- use independent staging and production credentials;
- use separate TLS-enforced direct Neon URLs and least-privilege roles for migration and runtime access;
- provide the runtime Neon URL only through the protected Worker secret binding;
- grant the Cloudflare token only the Worker, Queue, route, and related permissions required for this application;
- grant Tigris credentials only the DealGuard production bucket;
- never store populated secrets in repository files or deployment artifacts.

## Phase 2 — Provision production infrastructure

### 2.1 Neon PostgreSQL

1. Create the production Neon project or protected production branch.
2. Select the region closest to the primary Cloudflare and customer traffic profile.
3. Create a migration role with schema-change permission.
4. Create or verify the least-privilege runtime role used by the Worker.
5. Require TLS.
6. Record the project, branch, database, and region without recording credentials.
7. Ensure the target application tables are empty before the first data import.

Validate from an approved operator machine:

```bash
NEON_DATABASE_URL="$PRODUCTION_NEON_URL" npm run db:migrate
NEON_DATABASE_URL="$PRODUCTION_NEON_URL" npm run db:migrate:check
NEON_DATABASE_URL="$PRODUCTION_NEON_URL" npm run db:validate
```

Expected result: migrations `0001` through `0014` are applied, checksums match, and all schema and tenant checks pass.

### 2.2 Direct Worker-to-Neon connectivity

1. Create a least-privilege production runtime role distinct from the migration role.
2. Use the Neon pooled endpoint appropriate for serverless Worker traffic.
3. Require TLS for every connection.
4. Store the complete runtime URL only as the protected `NEON_DATABASE_URL` environment secret.
5. Confirm staging uses a different Neon branch, runtime role, and URL.

Do not repoint the production Worker database secret during an active release without an approved incident or change record.

### 2.3 Tigris

1. Create the production bucket.
2. Enable the applicable retention or object-protection policy.
3. Create bucket-scoped credentials.
4. Verify upload, head, download, and checksum validation with a non-customer test object.
5. Define separate prefixes for backups, customer artifacts, exports, and release evidence.

Recommended prefixes:

```text
backups/production/
artifacts/production/
exports/production/
release-evidence/production/
```

### 2.4 Cloudflare Queues

Create:

```text
dealguard-scans-production
dealguard-delivery-production
dealguard-maintenance-production
dealguard-dead-letter-production
```

1. Bind all three producer queues to the production Worker environment.
2. Configure each primary queue consumer.
3. Configure the dead-letter queue.
4. Confirm retry limits match `wrangler.toml`.
5. Confirm queue names do not reference staging.
6. Record initial queue depth as zero.

### 2.5 Worker domain and scheduler

1. Bind `dealguard-api.rokad.co` to the production Worker environment.
2. Verify TLS and DNS resolution.
3. Configure the 15-minute scheduled trigger.
4. Confirm `workers.dev` exposure matches the approved policy.
5. Confirm the staging domain remains isolated.

## Phase 3 — Configure external providers

### 3.1 HubSpot

1. Verify the production HubSpot app ID and client credentials.
2. Verify the canonical redirect URL:

```text
https://dealguard-api.rokad.co/oauth/callback
```

3. Verify the permitted fetch URL includes:

```text
https://dealguard-api.rokad.co/
```

4. Verify all required scopes.
5. Confirm App Home, card, settings, workflow actions, and webhooks are present in the project.
6. Identify a dedicated production acceptance portal and an existing test deal.

### 3.2 Dodo Payments

1. Create or verify Growth monthly and annual products.
2. Create or verify Enterprise monthly and annual products.
3. Configure the live webhook endpoint:

```text
https://dealguard-api.rokad.co/webhooks/dodo
```

4. Configure the Customer Portal.
5. Verify product IDs and event names in `dealguard-production` variables.
6. Confirm `DODO_ENVIRONMENT=live`.
7. Do not run a real payment during the deployment workflow. Use a dedicated billing test account for post-deployment lifecycle validation.

### 3.3 Email and delivery integrations

1. Verify the Resend production API key and sender domain.
2. Verify Slack OAuth credentials.
3. Prepare one test destination for each integration that will be declared supported at launch.
4. Prepare an endpoint that can intentionally fail so retry and dead-letter behavior can be tested after deployment.

## Phase 4 — Staging certification

Use the exact production release SHA.

### 4.1 Run Release readiness

In GitHub Actions:

1. Open **Release readiness**.
2. Select `staging`.
3. Select HubSpot upload validation only when staging CLI credentials are configured.
4. Run the workflow.
5. Confirm every repository, environment, PostgreSQL, Worker bundle, and manifest check passes.
6. Download and retain the readiness artifact.

### 4.2 Rehearse the data cutover

Follow `docs/MIGRATION_D1_TO_NEON.md` against a copied source database and a disposable Neon branch.

Required evidence:

- source snapshot checksum;
- import report;
- independent verification report;
- exact row-count reconciliation;
- content and primary-key hash matches;
- tenant and foreign-key validation;
- self-referential policy history validation;
- encrypted Tigris backup reference;
- independent SHA-256 digest for the encrypted object;
- isolated restore result.

### 4.3 Deploy staging

Run **Controlled deploy** with:

```text
target=staging
release_sha=<exact production SHA>
backup_reference=<verified staging encrypted backup key>
backup_sha256=<independently recorded 64-character digest>
acceptance_profile=full
portal_id=<staging acceptance portal>
user_email=<staging acceptance admin>
test_deal_id=<existing staging test deal>
```

The workflow must pass:

- repository gate;
- release preflight;
- backup verification;
- PostgreSQL migration and validation;
- Worker deployment;
- health and version verification;
- public smoke checks where enabled;
- signed full acceptance;
- deployment evidence generation.

Record the successful staging run ID. Production promotion must use this exact run.

### 4.4 Upload and test the staging HubSpot project

In a clean checkout or disposable worktree:

```bash
HUBSPOT_TARGET_BASE_URL=https://dealguard-api-staging.rokad.co npm run hubspot:render-target
npm run hubspot:deps
npm run hubspot:upload
```

Install or reauthorize the staging app and complete `docs/PRODUCTION_ACCEPTANCE_RUNBOOK.md` against staging.

## Phase 5 — Production backup and write freeze

This phase applies to the first migration from the previous production persistence model.

1. Announce the change window.
2. Stop scheduled scans.
3. Pause scan, delivery, and maintenance queue producers or consumers as defined in the migration plan.
4. Prevent settings, policy, billing, remediation, and handoff mutations.
5. Record source database time and queue depth.
6. Generate the final deterministic source snapshot.
7. Encrypt the snapshot or PostgreSQL backup.
8. Upload it to Tigris under `backups/production/`.
9. Verify object metadata and checksum:

```bash
npm run storage:backup:head -- backups/production/<date>/<object>.enc <expected-sha256>
```

10. Restore a protected copy into an isolated branch and validate it.
11. Import the final source snapshot into the production Neon target.
12. Run independent verification:

```bash
NEON_DATABASE_URL="$PRODUCTION_NEON_URL" npm run migration:d1:verify -- \
  --input .release/migration/source-snapshot.json \
  --report .release/migration/production-verification.json
```

13. Stop if any table count, hash, primary key, foreign key, audit chain, subscription, policy, remediation, or object-reference check fails.

## Phase 6 — Production deployment

### 6.1 Final pre-deployment review

Verify:

- exact release SHA equals the successful staging release SHA;
- package version is `2.1.0`;
- staging Controlled deploy passed with the full profile;
- backup and restore evidence is attached;
- migration verification has zero failures;
- production environment approval is available;
- rollback owner is present;
- change window remains open.

### 6.2 Run Controlled deploy

In GitHub Actions, run **Controlled deploy** with:

```text
target=production
release_sha=<exact release SHA>
backup_reference=backups/production/<date>/<verified-object>.enc
backup_sha256=<independently recorded 64-character digest>
staging_run_id=<successful full-profile staging run ID>
acceptance_profile=full
portal_id=<production acceptance portal>
user_id=<optional HubSpot user ID>
user_email=<production acceptance administrator>
expected_tier=<free|growth|enterprise>
test_deal_id=<existing production test deal>
checkout_tier=enterprise
checkout_interval=year
production_confirmation=DEPLOY DEALGUARD TO PRODUCTION
```

The production environment reviewer must compare these inputs to the approved change record before approval.

### 6.3 Required workflow order

The workflow must complete in this order:

1. validate immutable inputs and production confirmation;
2. check out the exact SHA;
3. run repository tests and typechecks;
4. run production preflight;
5. verify matching staging evidence;
6. verify the encrypted Tigris backup;
7. apply and verify PostgreSQL migrations;
8. validate tenant constraints;
9. deploy the production Worker environment;
10. verify `/health` reports `2.1.0`;
11. run `npm run production:smoke`;
12. run signed full acceptance;
13. record source and migration checksums;
14. generate and upload the deployment record.

## Phase 7 — Upload the production HubSpot project

After the Worker is healthy and before opening the service broadly:

```bash
HUBSPOT_TARGET_BASE_URL=https://dealguard-api.rokad.co npm run hubspot:render-target
npm run hubspot:deps
npm run hubspot:upload
```

1. Resolve every HubSpot schema validation error.
2. Install or reauthorize the production acceptance portal.
3. Confirm the exact production redirect and fetch origins.
4. Confirm all required scopes.
5. Confirm App Home V3 loads.
6. Confirm the deal card loads on an existing deal.
7. Confirm the settings extension loads.
8. Confirm both workflow actions are available.
9. Confirm webhook subscriptions show healthy delivery.
10. Run the full acceptance profile again after the final HubSpot upload when the upload occurred after Worker deployment.

## Phase 8 — Production test execution

Follow `docs/PRODUCTION_ACCEPTANCE_RUNBOOK.md` in order.

Minimum release tests:

1. public smoke checks `DG-PROD-001` through `DG-PROD-007`;
2. signed acceptance `DG-LIVE-001` through `DG-LIVE-014`, with documented skips only where the runbook permits them;
3. real test-deal assessment;
4. full portal scan and queue completion;
5. HubSpot card, App Home, settings, workflow, webhook, and reauthorization tests;
6. Dodo live webhook signature and entitlement isolation;
7. delivery success, retry, dead-letter, and replay;
8. Tigris upload and single-use export;
9. audit-chain verification and legal-hold behavior;
10. backup download and isolated restore verification.

## Phase 9 — Reopen writes and monitor

Reopen in this order:

1. maintenance consumers;
2. delivery consumers;
3. scan consumers;
4. inbound webhooks;
5. user mutations;
6. scheduled scans.

For at least the agreed rollback window, monitor:

- Worker error rate and latency;
- Worker-to-Neon connection and transaction failures;
- Neon CPU, storage, connections, and slow queries;
- queue depth, age, retries, and dead letters;
- Tigris errors;
- HubSpot webhook failures;
- Dodo webhook failures and subscription state;
- email and integration delivery;
- audit-chain verification;
- tenant counts and key business invariants.

## Phase 10 — Release decision

### Go

Declare the release successful only when:

- deployment record result is `passed`;
- production smoke has zero failures;
- full signed acceptance has zero failures;
- manual HubSpot and provider tests pass;
- migration reconciliation remains exact;
- no unexpected dead letters or tenant-isolation failures exist;
- the approver signs the release record.

### No-go

Do not reopen or continue production traffic when:

- health version is wrong;
- OAuth redirects to the wrong app or origin;
- signed APIs fail;
- row counts or hashes differ;
- subscription or entitlement state differs;
- queue processing is failing or dead letters are unexplained;
- audit continuity is broken;
- secure exports, legal holds, or backup restore fail;
- the rollback owner cannot safely reconcile post-cutover writes.

## Rollback

Before reopening writes:

1. keep the previous Worker active or restore its route;
2. keep the previous source database authoritative;
3. discard the candidate Neon branch only after preserving diagnostics;
4. resume the prior processing model;
5. record the failed gate.

After reopening writes:

1. close writes and pause queue producers;
2. preserve logs, queue state, and the post-cutover write interval;
3. determine how post-cutover writes will be reconciled;
4. restore into an isolated Neon branch first;
5. validate tenant, subscription, policy, remediation, audit, and object-reference state;
6. update the protected Worker database secret only through an approved incident change;
7. deploy the compatible Worker version;
8. run public smoke and read-only signed acceptance before reopening writes.

Never run an automatic reverse schema migration in production. Prefer forward repair or verified restore-and-switch.

## Required final evidence bundle

Retain for at least 90 days, or longer when contractual requirements apply:

- release SHA and PR;
- CI and Release readiness records;
- staging and production Controlled deploy records;
- preflight reports;
- public smoke JSON and Markdown;
- signed acceptance JSON and Markdown;
- migration and source checksums;
- final source snapshot checksum;
- import and verification reports;
- backup object reference and checksum;
- isolated restore evidence;
- HubSpot upload and installation evidence;
- Dodo, Slack, email, webhook, and SIEM test evidence;
- screenshots for account-bound provider actions;
- go/no-go approval and incident notes.
