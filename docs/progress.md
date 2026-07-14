# DealGuard migration progress

Last updated: 2026-07-14

## Completed

- Replaced the Worker database adapter with PostgreSQL through Cloudflare Hyperdrive.
- Moved canonical schema migrations to `database/migrations` and converted the complete sequence through `0014_neon_tigris_queues.sql`.
- Added immutable migration checksums, advisory locking, clean-schema application, and PostgreSQL schema validation.
- Added composite tenant ownership constraints for tenant-owned relationships.
- Added Tigris object-storage support for evidence, exports, and encrypted backup artifacts.
- Added Cloudflare Queue producers and consumers for scans, delivery, exports, and maintenance.
- Added bounded retries, async-job state, and dead-letter behavior.
- Removed the legacy runtime database binding and runtime migration directory.
- Updated CI to use PostgreSQL 17 and validate migrations, schema constraints, Worker type safety, HubSpot extensions, and manifests.
- Updated enterprise tests to validate PostgreSQL migrations and queued maintenance execution.
- Updated release preflight for Neon, Hyperdrive, Tigris, Queues, canonical HubSpot manifests, and target rendering.
- Updated protected release-readiness and controlled-deployment workflows.
- Added backup verification before protected migration.
- Added target-specific Worker deployment with explicit `--env` selection.
- Added the operational deployment guide and controlled data-cutover runbook.

## In progress

- Implementing and validating deterministic source snapshot, PostgreSQL import, and independent verification tooling.
- Re-running the full CI suite after release-control and documentation migration.
- Reviewing the complete PR diff for stale provider references and operational gaps.
- Updating PR evidence and acceptance criteria after the final green repository run.

## Blocked

The following require protected provider accounts or human approval and cannot be proven by repository CI:

- provisioning and confirming production Neon, Hyperdrive, Tigris, and Queue resources;
- creating and independently restoring an encrypted production backup;
- final source write freeze and production data snapshot;
- account-bound data import and reconciliation using real tenant data;
- staging and production Worker deployment;
- authenticated HubSpot project upload and portal installation;
- HubSpot install, uninstall, reauthorization, card, App Home, workflow, webhook, role, and supported-tier acceptance;
- Dodo test-mode and live-mode lifecycle acceptance;
- external Slack, Teams, email, webhook, and SIEM delivery tests;
- security review, privacy/legal approval, and Marketplace submission.

## Next

1. Finish source snapshot/import/verification tooling and its deterministic tests.
2. Obtain a green PR CI run at the final migration SHA.
3. Run Release readiness in the protected staging environment.
4. Perform a complete rehearsal using a copied source database and disposable Neon branch.
5. Attach row reconciliation, hash verification, backup, restore, and acceptance evidence.
6. Run the protected staging deployment.
7. Promote to production only after the exact staging release passes and a reviewer approves the cutover.

## Known risks

- A schema/runtime rewrite is not a completed data migration without a verified source export and import.
- Source writes during snapshot creation can produce an internally inconsistent dataset.
- Queue producers must not resume before database import and signed read-only acceptance pass.
- A Worker rollback alone cannot reconcile writes created after production cutover.
- Hyperdrive may point to the wrong branch if environment identifiers are copied incorrectly.
- Object metadata can be correct while the encrypted backup is operationally unusable; isolated restore testing is required.
- Large source tables may exceed a single provider query or process-memory limit; snapshot tooling must read bounded batches.
- SQLite and PostgreSQL represent numeric, boolean, binary, and JSON values differently; verification must normalize by target data type.
- Provider API, HubSpot platform, and marketplace requirements can change and must be revalidated before public release.
