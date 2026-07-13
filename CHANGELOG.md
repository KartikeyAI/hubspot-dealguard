# Changelog

## 1.4.0-beta.1 — 2026-07-13

### Added

- Durable remediation cases with assignment, severity, priority, SLA, status history, escalation, resolution, waiver, closure, and reopening.
- Automatic remediation creation for current critical readiness issues and automatic resolution when the issue disappears.
- Optional HubSpot tasks associated with the affected deal using dynamically discovered association metadata.
- Deal-based **Create DealGuard remediation** workflow action with reusable case and task outputs.
- Microsoft Teams Workflow, email, and signed generic webhook destinations.
- Event-type, severity, and pipeline routing for enterprise destinations.
- Encrypted endpoint and signing-secret storage.
- Durable delivery outbox with processing leases, exponential backoff, attempt history, dead-letter state, and administrator replay.
- Per-portal operational health for scans, webhooks, delivery failures, dead letters, and overdue remediation cases.
- Stripe-hosted subscription Checkout and Stripe Customer Portal sessions.
- Signed and idempotent Stripe billing webhook processing, annual/monthly prices, payment-failure grace periods, and manual Enterprise contracts.
- Enterprise App Home controls for billing, remediation queues, destinations, health, and dead-letter replay.
- D1 migration `0006_enterprise_operations.sql` and v1.4 operations tests.

### Changed

- Enterprise commercial entitlement maps to the existing internal `beta_growth` capability bucket; customer-facing tier names are Free, Growth, and Enterprise.
- Enterprise scans support up to 10,000 deals and policy simulations up to 5,000 deals.
- HubSpot OAuth now requests `crm.objects.tasks.write` for explicit remediation-task creation.
- Version advanced to `1.4.0-beta.1` across Worker and HubSpot extensions.

## 1.3.0-beta.1 — 2026-07-13

### Added

- Dedicated HubSpot App Home for enterprise governance and executive pipeline exposure.
- Versioned policy lifecycle with draft, edit, submit, approve, reject, publish, supersede, rollback, and simulation states.
- Two-person approval and policy self-approval prevention.
- Governance roles for administrators, policy administrators, approvers, managers, and viewers.
- Signed governance APIs for policy and role administration.
- Searchable audit-event API and CSV export.
- Commercial assessment context for owner, pipeline, stage, and deal amount.
- Daily analytics snapshots with readiness trend, amount at risk, incomplete handoffs, pipeline breakdown, and owner breakdown.
- Asynchronous policy simulation against up to 1,000 current deals.
- Enterprise governance schema migration and automated governance/context tests.

### Changed

- Live scoring rules become read-only in general settings after governance mode is enabled.
- Only an approved and published policy version can change governed scoring rules.
- Version advanced to `1.3.0-beta.1`.

## 1.2.0-beta.1 — 2026-07-13

### Added

- Seven fixed, namespaced HubSpot deal properties for readiness score, status, grade, issue count, handoff state, latest assessment time, and optional summary.
- Growth-only property provisioning with schema versioning and incompatible-property conflict detection.
- Per-assessment native write-back from record, webhook, and workflow execution paths.
- Batched native property updates during portal scans.
- Controlled backfill of existing DealGuard assessments.
- Native sync status, error, provisioning, and backfill controls in HubSpot settings.
- Reusable workflow outputs for score, status, grade, issue count, handoff status, summary, and assessment time.
- Automated native property mapping and entitlement tests.

### Changed

- HubSpot OAuth now requests `crm.objects.deals.write` and `crm.schemas.deals.write` for DealGuard-owned property creation and updates.
- Existing installations require reauthorization after the v1.2 app update.
- DealGuard writes remain disabled by default and are limited to the fixed `dealguard_*` property set.
- Version advanced to `1.2.0-beta.1` across Worker and UI extension packages.

## 1.1.0-beta.1 — 2026-07-13

### Added

- Slack OAuth installation using only the `incoming-webhook` bot scope.
- Encrypted Slack webhook and access-token storage.
- Critical-deal, handoff-required, handoff-confirmed, workflow, and test Slack messages.
- Repeat-alert cooldowns, transition detection, notification idempotency, and delivery history.
- HubSpot webhook subscriptions for deal creation and high-signal property changes.
- Signed, asynchronous webhook receiver with event deduplication and bounded retention.
- Deal-based **Assess deal with DealGuard** custom workflow action.
- Growth-plan notification settings and Slack connection management in HubSpot.
- Background cleanup for expired OAuth state and old operational events.
- Integration and workflow parser tests.

### Changed

- Deal-record refreshes and webhook events use a shared assessment service.
- Full data deletion now removes the tenant row and retains only a hashed deletion reference.
- Version advanced to `1.1.0-beta.1` across Worker and UI extension packages.

## 1.0.0-beta.1 — 2026-07-13

- Initial sellable external-beta release with readiness scoring, pipeline scanning, deal card, connected-app settings, handoff governance, digests, plans, security controls, and operational documentation.
