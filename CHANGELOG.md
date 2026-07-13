# Changelog

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
