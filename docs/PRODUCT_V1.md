# DealGuard v1 product definition

## Product promise

DealGuard identifies the concrete operational conditions that make a HubSpot deal unreliable, difficult to forecast, or unsafe to hand over to delivery. It does not use opaque predictive AI in v1. Every score deduction is traceable to an explicit rule.

## Included in v1

- Read-only HubSpot OAuth installation for multiple portals.
- Deal-record app card with readiness score, grade, status, ordered issues, review action, and closed-won handoff confirmation.
- Full-portal scans on install, schedule, and administrator request.
- Custom required-property rule builder plus core governance checks: owner, amount, close date, overdue close date, next step, activity age, stage age, company, contact, and custom required properties.
- Pipeline and stage exclusions with metadata-driven selectors.
- Portal dashboard with health totals, latest scan status, recurring gaps, and the highest-priority at-risk deals.
- Weekly email digest on Free; daily or weekly on Growth.
- Audit trail for installs, scans, settings changes, reviews, handoffs, plan changes, and data deletion.
- AES-256-GCM encrypted OAuth token storage.
- Soft deletion that removes assessment, review, handoff, and scan data and destroys stored credentials.
- Free, Growth, and beta-Growth entitlements enforced server-side.

## Deliberate exclusions

- Deal mutation or automatic stage changes.
- Predictive win probability.
- Autonomous actions.
- Slack, Teams, Jira, accounting, or project-management integrations.
- Customer-facing billing checkout.
- Custom workflow action.

These are post-v1 expansion surfaces. Their absence does not make the product incomplete: the install, assessment, governance, handoff, dashboard, and digest workflows are independently useful.

## Initial commercial packaging

### Free

- Up to 250 deals per scan.
- Daily background scan plus on-demand background scans.
- Three custom required-property rules.
- 30-day operational history target.
- Weekly digest.

### Growth

- Up to 5,000 deals per scan.
- Hourly background scan plus on-demand background scans.
- Twenty-five custom required-property rules.
- 365-day operational history target.
- Daily or weekly digest.
- Priority support positioning.

During closed beta, portals can be promoted to `beta_growth` through the authenticated internal plan endpoint.
