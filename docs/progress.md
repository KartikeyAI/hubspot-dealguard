# DealGuard production release progress

Last updated: 2026-07-18

Release: `2.1.0`
Release branch: `agent/neon-hyperdrive-tigris-queues`
Production-preparation SHA: `5390477bb83a1b54b32770c2c9bd77a5374fa12f`
Validation: CI run `#300` passed

## Completed

### Runtime migration

- Replaced the Worker database adapter with Neon PostgreSQL through Cloudflare Hyperdrive.
- Moved canonical schema migrations to `database/migrations` through `0014_neon_tigris_queues.sql`.
- Added immutable migration checksums, advisory locking, clean-schema application, and PostgreSQL schema validation.
- Added composite tenant ownership constraints for tenant-owned relationships.
- Added Tigris object storage for evidence, exports, attachments, and encrypted backups.
- Added Cloudflare Queue producers and consumers for scans, delivery, exports, and maintenance.
- Added bounded retries, async-job state, and dead-letter behavior.
- Removed the legacy runtime database binding and runtime migration directory.

### Data cutover

- Added deterministic D1 source snapshot tooling with bounded reads and manifest checksums.
- Added empty-target, foreign-key-ordered, parameterized, transactional PostgreSQL import tooling.
- Added self-referential row ordering for policy-version history.
- Added independent row-count, normalized-content, primary-key, and foreign-key verification reports.
- Added real PostgreSQL fixtures for transactional import and independent verification.
- Added the controlled source-freeze, import, reconciliation, and rollback runbook.

### Production release preparation

- Promoted the product version from `2.1.0-rc.1` to stable `2.1.0`.
- Centralized the Worker release identity in `worker/src/version.ts`.
- Added public smoke checks `DG-PROD-001` through `DG-PROD-007`.
- Added automated smoke evidence in JSON and Markdown.
- Hardened Controlled deploy with:
  - exact immutable release SHA;
  - verified backup reference;
  - matching full-profile staging evidence;
  - mandatory production test deal;
  - exact production confirmation phrase;
  - stable semantic version;
  - production environment approval;
  - health, smoke, and signed acceptance gates.
- Added public smoke evidence to the deployment record.
- Updated staging-promotion verification to require deployment evidence schema v2, smoke success, valid health identity, and full signed acceptance.
- Updated CI, Release readiness, preflight, bundle validation, and release evidence for the production architecture.
- Added `docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md` with step-by-step infrastructure, migration, deployment, monitoring, go/no-go, and rollback procedures.
- Replaced `docs/PRODUCTION_ACCEPTANCE_RUNBOOK.md` with the complete automated and manual production test matrix.
- Updated `docs/DEPLOYMENT.md`, `README.md`, and `CHANGELOG.md` for DealGuard `2.1.0`.
- Confirmed CI run `#300` passes at SHA `5390477bb83a1b54b32770c2c9bd77a5374fa12f`.

## Current state

The product and repository are prepared for protected staging certification. Production has not been deployed, and no real customer data has been migrated during repository preparation.

PR #7 remains draft intentionally. It should stay draft until the exact release SHA passes protected staging deployment, full HubSpot acceptance, provider tests, backup restore, and a complete migration rehearsal.

## Required staging gates

1. Configure `dealguard-staging`, `dealguard-production`, and `dealguard-acceptance` GitHub Environments.
2. Provision isolated staging Neon, Hyperdrive, Tigris, queues, dead-letter queue, domain, and scheduler.
3. Run protected staging Release readiness.
4. Rehearse the complete source snapshot, import, and independent reconciliation against copied data.
5. Create and independently restore an encrypted staging backup.
6. Run staging Controlled deploy using the exact production release SHA and the `full` acceptance profile.
7. Upload the rendered HubSpot staging project.
8. Complete App Home, card, settings, workflow, webhook, OAuth, role, Dodo test-mode, delivery, queue, Tigris, compliance, and restore acceptance.
9. Preserve the successful staging run ID and evidence bundle.

## Required production gates

1. Provision and verify production Neon, Hyperdrive, Tigris, queues, dead-letter queue, domain, scheduler, and protected environment values.
2. Approve the production change window and assign release, database, HubSpot, billing, approval, and incident roles.
3. Establish the write freeze.
4. Create the final deterministic source snapshot.
5. Encrypt, upload, verify, download, and independently restore the production backup.
6. Import the source snapshot into the verified production Neon target.
7. Complete exact row-count, content-hash, primary-key, foreign-key, tenant, audit, subscription, policy, remediation, and object-reference reconciliation.
8. Run production Controlled deploy with:
   - exact release SHA;
   - verified production backup reference;
   - successful matching staging run ID;
   - full acceptance profile;
   - real test deal;
   - production approval;
   - confirmation phrase `DEPLOY DEALGUARD TO PRODUCTION`.
9. Upload the production HubSpot project and reauthorize the acceptance portal.
10. Complete `DG-PROD-001` through `DG-PROD-007`, `DG-LIVE-001` through `DG-LIVE-014`, and the manual production acceptance matrix.
11. Reopen queue consumers, webhooks, user writes, and scheduled scans in the documented order.
12. Monitor through the approved rollback window and record the final go/no-go decision.

## External or human-controlled gates

These cannot be proven by repository CI alone:

- real provider-resource provisioning;
- production DNS and custom-domain validation;
- protected environment values and reviewer approval;
- source write freeze and real data export;
- real customer-data import and reconciliation;
- encrypted backup restore using production data;
- authenticated HubSpot upload, installation, reauthorization, and UI acceptance;
- Dodo live-mode lifecycle and approved payment test;
- Slack, Teams, email, webhook, and SIEM delivery;
- security review, privacy/legal approval, and Marketplace submission.

## Known risks

- A successful code deployment is not a completed data migration without exact reconciliation.
- Source writes during snapshot creation can produce an inconsistent dataset.
- Queue producers must not resume before import verification and signed acceptance pass.
- A Worker rollback alone cannot reconcile writes created after production cutover.
- Hyperdrive can point to the wrong Neon branch when identifiers are copied incorrectly.
- Backup metadata can be valid while the encrypted backup is operationally unusable; isolated restore testing is mandatory.
- Large source tables require bounded snapshot reads and sufficient operator disk and memory capacity.
- SQLite and PostgreSQL represent numeric, boolean, binary, JSON, and temporal values differently; normalized verification remains mandatory.
- Provider requirements can change and must be revalidated immediately before production deployment.
