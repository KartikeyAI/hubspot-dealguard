# DealGuard Intelligence Release Convergence

This document defines the release boundary for the DealGuard intelligence programme accumulated across PRs #17–#33.

The release objective is to replace the long-lived stacked pull-request chain with one reviewable change from `main`, validate PostgreSQL migrations `0015` through `0022`, deploy through the existing guarded release process, and capture sanitized acceptance evidence from a HubSpot developer account.

## 1. Consolidated capability set

The converged release includes:

1. Deal-state-accurate and currency-safe analytics.
2. CRM process momentum and close-date credibility.
3. Buyer-committee and relationship coverage.
4. Unified deterministic Deal Brief.
5. Metadata-only engagement evidence.
6. Optional commercial-integrity evidence.
7. Manager Decision Queue.
8. Executive Revenue View.
9. Recommendation lifecycle and observed-outcome measurement.
10. Governed recommendation follow-up and evidence export.
11. Customer-configurable recommendation routing and escalation SLAs.
12. Recommendation delivery analytics.
13. Recommendation delivery SLO enforcement and incidents.

The release remains deterministic. It does not add calibrated forecast probabilities, buyer-intent inference, communication-content analysis, causal attribution, autonomous CRM mutation, or a new required HubSpot OAuth scope.

## 2. Consolidation model

The release branch must be based directly on `main` and contain one release commit whose tree is the reviewed final state.

The consolidated pull request supersedes these open stacked pull requests:

```text
#17 #18 #19 #20 #21 #23 #24 #25 #26 #27 #28 #29 #31 #32 #33
```

The superseded branches remain available as development history. They are not merged individually.

PR #22 and PR #30 were already closed because they were replaced by corrected implementations.

## 3. Repository hygiene

The consolidated tree removes temporary validation markers and low-value placeholder documents created during iterative development.

Primary product specifications remain under `docs/` and are the authoritative implementation references. Temporary files such as `.do-not-create`, local validation markers, and one-line merge-status notes are not release artifacts.

The repository-level release contract is:

```bash
npm run release:convergence
```

It checks:

- contiguous migrations through `0022`;
- the expected migration-owned tables and columns;
- the complete Worker route chain through `routes-v17`;
- Neon schema qualification for every new relation;
- canonical database validators;
- HubSpot manifest parsing;
- the stable required and optional OAuth scope boundary;
- App Home composition;
- required product documentation;
- absence of obsolete direct-recipient and invalid task-scope artifacts.

## 4. GitHub Actions runner diagnosis

A temporary diagnostic pull request used a minimal workflow with:

- one `ubuntu-24.04` job;
- one shell step;
- no checkout action;
- no dependency installation;
- no service container;
- no repository command;
- no secret or environment.

The job still ended before runner allocation with:

```text
runner_id: 0
runner_name: ""
steps: []
```

Therefore, repository workflow syntax and DealGuard code are not the cause of the pre-run failures.

The remaining remediation boundary is the GitHub account or organization Actions execution layer. An organization owner must review:

1. Account verification or suspension state.
2. Billing or payment lock state.
3. Organization Actions enablement.
4. GitHub-hosted runner policy.
5. Allowed Actions and reusable-workflow policy.
6. Repository Actions access and fork policy.

The release must not be merged until the consolidated pull request receives an allocated runner and the canonical CI job executes its steps.

## 5. Canonical CI gate

The canonical `.github/workflows/ci.yml` gate uses PostgreSQL 18 and must execute:

```bash
npm run release:convergence
npm run typecheck
npm run typecheck:ui
npm run build
npm run db:migrate
npm run db:migrate:check
npm run db:validate
npm test
```

It must also parse HubSpot manifests and complete the Cloudflare Wrangler staging dry run.

Focused workflows may continue to provide narrower diagnostics, but the canonical CI result is the release decision.

## 6. Database migration set

The converged release contains:

| Migration | Purpose |
|---|---|
| `0015_trustworthy_intelligence_currency.sql` | Currency provenance for historical assessments |
| `0016_manager_decision_queue.sql` | Bounded Deal Brief snapshots |
| `0017_executive_revenue_view.sql` | Daily executive revenue snapshots |
| `0018_recommendation_outcomes.sql` | Recommendation lifecycle and observed outcomes |
| `0019_recommendation_operations.sql` | Governed follow-up batches and items |
| `0020_recommendation_routing_policies.sql` | Routing policies and dispatch state |
| `0021_recommendation_delivery_sla_analytics.sql` | Deduplicated delivery-control evidence |
| `0022_recommendation_delivery_slo_alerts.sql` | Delivery SLO policies, incidents and notifications |

## 7. Isolated Neon validation procedure

Database validation must run against a temporary child of the production branch.

### Required sequence

1. Create a temporary Neon branch from `production`.
2. Record the branch ID and production parent ID.
3. Read the current `dealguard.schema_migrations` baseline.
4. Run the repository migration runner against the temporary branch.
5. Run immutable checksum validation.
6. Run all schema validators.
7. Verify the expected migration version is `22`.
8. Verify tenant-bound foreign keys and indexes.
9. Run representative read/write transactions for new tables.
10. Compare the temporary branch schema with its parent.
11. Preserve evidence and delete the temporary branch.
12. Do not apply changes to production during validation.

### Commands

```bash
DATABASE_URL='<temporary-branch-url>' npm run db:migrate
DATABASE_URL='<temporary-branch-url>' npm run db:migrate:check
DATABASE_URL='<temporary-branch-url>' npm run db:validate
```

### Validation queries

At minimum, validate:

- latest migration and migration count;
- new table existence;
- required column existence;
- required index existence;
- tenant-cascade foreign keys;
- one-open-incident protection;
- recommendation and notification deduplication;
- active-incident semantic locks;
- incident-history retention protection.

The production database must remain unchanged until the consolidated pull request and isolated branch validation both pass.

## 8. Neon connector limitation

The currently connected Neon tool exposes camelCase fields such as `projectId` and `branchId`, while its backend rejects them and requires snake_case fields such as `project_id` and `branch_id`. The outer tool schema then rejects the snake_case form.

This is an adapter-contract defect outside the repository. Search and project inspection work, but branch creation and SQL execution do not reach Neon.

Until the connector is corrected, isolated Neon validation must be executed through either:

- the repository migration runner using a temporary Neon connection string; or
- the Neon console/CLI by an administrator.

Do not treat static SQL review as equivalent to an executed PostgreSQL migration test.

## 9. HubSpot developer-account acceptance

The release adds a dedicated signed acceptance suite:

```bash
npm run acceptance:intelligence
```

Required environment:

```text
ACCEPTANCE_BASE_URL
ACCEPTANCE_PORTAL_ID
HUBSPOT_CLIENT_SECRET
```

Recommended environment:

```text
HUBSPOT_APP_ID
ACCEPTANCE_USER_ID
ACCEPTANCE_USER_EMAIL
ACCEPTANCE_TEST_DEAL_ID
ACCEPTANCE_OPERATOR
GITHUB_SHA
```

Optional controls:

```text
ACCEPTANCE_INTELLIGENCE_PORTFOLIO=true
ACCEPTANCE_INTELLIGENCE_REFRESH_DEAL=true
ACCEPTANCE_TIMEOUT_MS=25000
ACCEPTANCE_OUTPUT_DIR=artifacts/intelligence-acceptance
```

The suite writes sanitized JSON and Markdown evidence.

### Required developer-account scenarios

#### Installation and authorization

- Install the project into a developer test account.
- Confirm only the required scope set is mandatory.
- Confirm line-item and quote scopes are optional.
- Confirm existing installs retain non-commercial functionality without reauthorization.

#### Deterministic deal intelligence

- Assess a real test deal.
- Verify readiness score and issues.
- Verify momentum and close-date credibility.
- Verify relationship coverage.
- Verify engagement metadata without communication content.
- Verify commercial intelligence only when optional authorization is granted.
- Verify the unified Deal Brief and evidence limitations.

#### Portfolio intelligence

- Load Manager Decision Queue.
- Load Executive Revenue View and establish the first movement baseline.
- Verify currencies remain separated.
- Verify slippage and pull-in outputs are review prompts, not predictions.

#### Recommendation lifecycle

- Refresh a test deal to present a recommendation.
- Verify recommendation history.
- Exercise viewer and manager permission paths.
- Accept, complete and dismiss only dedicated test recommendations.
- Generate a later Deal Brief and verify observational outcome classification.
- Confirm `causalAttribution` remains false.

#### Governed operations

- Preview manual follow-up and verify nothing is sent before confirmation.
- Confirm one bounded follow-up.
- Verify Slack, Teams, email and signed-webhook routes.
- Verify quiet hours, cooldowns and notification caps.
- Verify one-time manager escalation.
- Generate and consume a one-time recommendation evidence export.

#### Delivery analytics and SLOs

- Generate delivered, partially failed and failed channel evidence.
- Verify route and channel health.
- Verify escalation-SLA compliance and breach behavior.
- Configure a portal-wide delivery SLO route.
- Verify insufficient-data protection.
- Verify breach persistence, acknowledgement, reminder and recovery.
- Verify active-incident semantic locks and incident-history retention.

#### Removal and degradation

- Revoke optional commercial scopes and verify graceful degradation.
- Disable a notification channel and verify bounded failure evidence.
- Confirm no test flow modifies deal stage, amount, owner, close date or forecast category without an explicit user action.

## 10. Deployment sequence

The production sequence is:

1. Restore GitHub-hosted runner allocation.
2. Execute consolidated PR CI.
3. Validate migrations `0015–0022` on an isolated Neon branch.
4. Review the schema diff and validation evidence.
5. Merge the consolidated PR.
6. Verify a current production backup or point-in-time recovery boundary.
7. Apply migrations `0015–0022` through the repository migration runner.
8. Re-run checksum and schema validation against production.
9. Deploy the Cloudflare Worker.
10. Run production health and signed read-only smoke checks.
11. Upload the HubSpot project.
12. Run `npm run acceptance:intelligence` against the developer account.
13. Run the standard live acceptance suite.
14. Record the deployment and evidence artifacts.
15. Begin customer rollout only after the developer-account suite passes.

## 11. Rollback boundary

If migration validation fails, do not deploy the Worker.

If the Worker deployment fails after successful migrations:

1. Roll back the Worker to the prior deployment.
2. Keep the additive database schema in place unless a reviewed reverse migration is required.
3. Do not drop new tables containing evidence.
4. Record the failed deployment and request IDs.

If the HubSpot upload fails:

1. Keep the prior published project version active.
2. Leave the Worker backward-compatible.
3. Correct manifest or extension errors before another upload.

If live acceptance fails:

1. Stop rollout.
2. Preserve sanitized evidence.
3. Classify the failure as Worker, database, HubSpot project, permission, configuration or external-delivery related.
4. Fix and rerun the smallest affected gate plus the complete acceptance suite.

## 12. Release decision

The release is ready to merge only when all of the following are true:

- [ ] Consolidated PR is the sole open implementation PR for this programme.
- [ ] GitHub-hosted runner is allocated.
- [ ] Canonical CI executes and passes.
- [ ] Migrations `0015–0022` pass on an isolated PostgreSQL 18 branch.
- [ ] Migration checksums and schema validators pass.
- [ ] Cloudflare dry run passes.
- [ ] HubSpot manifests parse and project upload succeeds.
- [ ] Developer-account intelligence acceptance passes.
- [ ] Standard live acceptance passes.
- [ ] No production customer notification was sent during validation.
- [ ] Release and rollback evidence is recorded.
