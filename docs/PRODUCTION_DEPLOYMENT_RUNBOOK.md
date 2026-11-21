# DealGuard 3.0 production deployment runbook

This is the operator procedure for a stable v3 release on Cloudflare Workers, the Neon HTTP query adapter, Tigris, and Cloudflare Queues. It covers both an existing Neon installation and the separately identified first D1 cutover. A runbook, source version bump, local test run or public CI success is not production approval.

The controlled workflow is `.github/workflows/controlled-deploy.yml`. Its immutable source, staging, backup and independently signed evidence checks run before production migrations or Worker deployment. `STABLE_3_0_SIGNOFF.md` defines the mandatory evidence and two-reviewer signature contract; use its exact report checks and measured thresholds. The workflow does not upload the HubSpot project or provision Worker secrets.

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

Operational roles may overlap. The two production evidence signers must have distinct stable GitHub principals, distinct Ed25519 key material, and the `release_owner` and `security_reviewer` roles. Keep signing keys in their owners' approved signing systems. A GitHub environment approval does not replace either signature.

## Phase 0 — Freeze the release source

1. Confirm the reviewed, merged v3 scope includes all intended source and migration changes; record its PRs.
2. Record the exact 40-character commit SHA and source tree, with no uncommitted or local-only feature work.
3. Confirm the package version is the exact stable v3 candidate version.
4. Confirm `/health` is served from `worker/src/version.ts` and reports the exact stable v3 candidate version.
5. Confirm the latest CI run for the exact SHA is green.
6. Confirm no unresolved pull-request review thread exists.
7. Do not add feature changes after this point. Any code change creates a new release SHA and invalidates prior staging evidence.

Before freezing, reproduce the repository gate in a clean environment with Node 22.12 or later, PostgreSQL 18 binaries and the checked-in lockfiles:

```bash
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix src/app/cards
npm ci --ignore-scripts --prefix src/app/settings
npm ci --ignore-scripts --prefix src/app/pages
npm run test:local
```

Set `DEALGUARD_POSTGRES_BIN` to the directory containing `initdb` and `postgres` when they are not on `PATH`. Run as a non-root operating-system user, as PostgreSQL requires. The harness always creates its own disposable database, migrates it, sets both PostgreSQL test variables, validates it, runs `npm run check`, and removes it. It does not use production credentials or `.env` database URLs. A bare `npm test` without those database variables can skip PostgreSQL tests and is not the full production regression evidence.

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
6. Configure and independently verify `PRODUCTION_SIGNOFF_TRUST_JSON` using the format in `STABLE_3_0_SIGNOFF.md`; only public keys belong in this protected variable.

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
PRODUCTION_SIGNOFF_TRUST_JSON
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

Optional intelligence is disabled when its global flag is unset. Configure `DEALGUARD_AI_ENABLED`, its approved model/pricing metadata and protected `DEALGUARD_AI_API_KEY` only after native-AI acceptance; explicit portal consent, `ai.use`, evidence freshness and budgets still apply. `DEALGUARD_FORECAST_ENABLED` additionally requires portal outcome consent, a qualified model, independent evidence-bound review, a portal switch, current monitoring and per-deal eligibility. Breeze requires its global flag, exact registered action IDs and portal consent. See `GOVERNED_AI_ASSISTANCE.md`, `OUTCOME_DATASETS_AND_EVALUATION.md` and `optional/breeze/README.md`. Enabling a flag does not establish approval or complete acceptance.

## Phase 2 — Provision production infrastructure

### 2.1 Neon PostgreSQL

1. Create the production Neon project or protected production branch.
2. Select the region closest to the primary Cloudflare and customer traffic profile.
3. Create a migration role with schema-change permission.
4. Create or verify the least-privilege runtime role used by the Worker.
5. Require TLS.
6. Record the project, branch, database, and region without recording credentials.
7. Only for the first D1 import, ensure the target application tables are empty. Never empty or reimport an existing Neon production database as part of a v3 upgrade.

Rehearse migrations on a disposable restored branch before production approval. The actual production application of migrations belongs in Controlled deploy, after verification of the signed evidence. On the disposable branch:

```bash
NEON_DATABASE_URL="$REHEARSAL_NEON_URL" npm run db:migrate
NEON_DATABASE_URL="$REHEARSAL_NEON_URL" npm run db:migrate:check
NEON_DATABASE_URL="$REHEARSAL_NEON_URL" npm run db:validate
```

Expected result: every migration at the frozen release SHA is applied, checksums match, and all schema and tenant checks pass. This v3 implementation includes migrations through `0043`; the immutable candidate's migration manifest is authoritative. Do not edit previously applied migration files.

### 2.2 Direct Worker-to-Neon connectivity

1. Create a least-privilege production runtime role distinct from the migration role.
2. The runtime uses `@neondatabase/serverless` HTTP queries with a PostgreSQL connection URL. It does not open a new TCP client per request or use a Hyperdrive binding. Database migrations and isolated tests use the PostgreSQL driver separately.
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

This D1 procedure applies only when the release actually changes persistence from D1. For an existing Neon installation, instead restore an encrypted backup into an isolated branch, apply only pending migrations, validate tenant/audit/object integrity and rehearse the compatible Worker rollback. Preserve the existing production data and migration ledger.

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
- required intelligence certification;
- deployment evidence generation.

Record the successful staging run ID. Production promotion must use this exact run.
Retain its attempt-specific artifact `dealguard-deployment-staging-<run-id>-<attempt>`. A successful `read-only` run is diagnostic and cannot be promoted as full production certification.

### 4.4 Upload and test the staging HubSpot project

In a clean checkout or disposable worktree:

```bash
HUBSPOT_TARGET_BASE_URL=https://dealguard-api-staging.rokad.co npm run hubspot:render-target
npm run hubspot:deps
npm run hubspot:upload
```

Install or reauthorize the staging app and complete `docs/PRODUCTION_ACCEPTANCE_RUNBOOK.md` against staging.

### 4.5 Independent production evidence

Complete all eleven categories in `STABLE_3_0_SIGNOFF.md`: source, canonical CI, governance, account acceptance, security, commercial, intelligence, load, recovery, consenting pilots and operations. Local simulated integrations and local recovery tests cannot replace live provider or customer evidence. Reviewers verify original evidence, report digests, the exact SHA/tree/version and the full staging run before signing.

Publish the reviewed dossier, report files and detached signatures from the approved evidence process as `dealguard-production-signoff-<full-release-sha>`, and retain its producing `signoff_run_id`. The workflow downloads and verifies that artifact; it does not generate approvals or sign on anyone's behalf. The evidence receipt deliberately records `productionReady:false` until rollout and post-deployment acceptance are completed.

## Phase 5 — Production backup and write freeze

Every production upgrade needs a fresh encrypted backup, verified checksum, isolated restore evidence and a documented write/queue control plan. Steps 6, 11 and 12 below refer to the first D1 cutover only. On existing Neon, use the PostgreSQL backup/restore procedure and skip source import; record the reason. Avoid freezing unrelated customer work longer than the reviewed migration requires.

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
- package version is the exact stable v3 candidate version;
- staging Controlled deploy passed with the full profile;
- backup and restore evidence is attached;
- migration verification has zero failures;
- production environment approval is available;
- all eleven signed evidence categories and both independent approvals are valid, unexpired and bound to this source and staging run;
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
signoff_run_id=<run containing the independently signed candidate evidence artifact>
acceptance_profile=full
portal_id=<production acceptance portal>
user_id=<identified HubSpot acceptance administrator ID>
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
7. download the independent sign-off artifact and verify its signatures, source, reports, staging binding and validity;
8. apply and verify PostgreSQL migrations;
9. validate tenant constraints;
10. deploy the production Worker environment;
11. verify `/health` reports the exact candidate package version;
12. run `npm run production:smoke`;
13. run signed full acceptance and required intelligence certification;
14. record source and migration checksums;
15. generate and upload the deployment record and sanitized sign-off receipt.

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
5. Confirm the active App Home loads. The retained `EnterpriseHomeV3.tsx` manifest entry imports the current `EnterpriseHomeV4.tsx` implementation; the entry filename is not the product release version.
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
- independent pre-deployment approval is valid and retained; all mandatory source/CI/security/load/recovery/pilot/operations evidence is verified;
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
Do not bypass the independent sign-off gate for rollback. Preselect a compatible approved source and a tested recovery plan, including reconciliation of writes after the cutover. On an existing Neon upgrade, keep the authoritative database and restore strategy from that change plan; the legacy-D1 fallback applies only to a first cutover.

## Required final evidence bundle

Retain for at least 90 days, or longer when contractual requirements apply:

- release SHA and PR;
- CI and Release readiness records;
- staging and production Controlled deploy records;
- original independently signed production dossier, all eleven reports, detached signatures and verification receipt;
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

Workflow deployment artifacts include the run attempt: `dealguard-deployment-<target>-<run-id>-<attempt>`. Keep raw customer evidence in access-controlled storage and retain sanitized references in the release record. Public repository CI can verify code and isolated PostgreSQL behavior; signed-in HubSpot, billing-provider, load, production recovery and pilot evidence still require their authorized environments.
