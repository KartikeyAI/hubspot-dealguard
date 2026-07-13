# Changelog

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
