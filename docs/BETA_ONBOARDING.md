# Enterprise portal onboarding and acceptance

## Target portal

- Uses HubSpot Sales Hub with at least 25 open deals.
- Has a documented pipeline and a real sales-to-delivery transition.
- Provides a HubSpot administrator for installation and reauthorization.
- Provides separate policy-creator and policy-approver identities for governance acceptance.

## Installation and disclosure

1. Confirm the HubSpot portal, pipelines, sales motion, required deal fields, and data-retention expectations.
2. Explain all required OAuth scopes, including the constrained deal and deal-schema write scopes used only for DealGuard-owned properties.
3. Install or reauthorize DealGuard and add the readiness card to the default deal record view.
4. Provision the fixed `dealguard_*` properties and explicitly enable native sync when required.
5. Run the initial scan and verify native values, dashboard metrics, and pipeline amount-at-risk calculations.

## Governance acceptance

1. Enable enterprise governance and verify baseline policy v1 is captured and published.
2. Assign administrator, policy administrator, approver, manager, and viewer roles to separate test users where available.
3. Create and edit a policy draft.
4. Run a simulation and confirm no live deal or policy state changes.
5. Submit the draft and confirm the creator cannot self-approve.
6. Approve through a separate identity, publish, and verify live scoring rules change atomically.
7. Create a rollback draft from a historical policy.
8. Verify direct scoring-rule edits through general settings are blocked.
9. Search recent audit events and export the audit CSV.

## Operational acceptance

- Test deal review and one closed-won handoff.
- Test Slack connection, alert delivery, cooldown, and disconnect.
- Test email digest delivery.
- Test webhook-triggered reassessment and workflow outputs.
- Verify an administrator can run scans and delete data, while viewers cannot perform sensitive actions.
- Verify uninstall, data deletion, reinstallation, and reauthorization behavior.

## Success criteria

- At least 95% of eligible active deals are assessed without permanent API errors.
- App Home and the deal card are understandable without developer assistance.
- Policy simulation and publication produce reproducible results.
- No non-DealGuard HubSpot property is written or modified.
- Sensitive operations are blocked for unauthorized roles.
- Customer-hosted HubSpot values and Rokad-hosted data deletion behavior match the published documentation.
