# DealGuard Enterprise Complete Acceptance Matrix

This document is the release gate for DealGuard `2.0.0-rc.1`. A capability is not considered released merely because a route or table exists. It must pass automated validation and the live platform acceptance steps listed below.

## A. Enterprise policy management

- Versioned draft, approval, publish, supersede and rollback lifecycle
- Policy templates and cloning
- Scoped policies for pipeline, stage, team, owner, region, deal type and amount band
- Simulation before publication
- Exception request, approval, rejection, expiry and revocation
- Import and export
- Immutable policy history and change diff

## B. App Home and executive analytics

- Executive, RevOps, manager and representative views
- Readiness and amount-at-risk trends
- Pipeline, stage, owner, team and region breakdowns
- Stage-age heatmap
- Failure-pattern analysis
- Handoff SLA performance
- Policy impact and before/after comparison
- Drill-down, saved views and export

## C. Roles, permissions and approvals

- Administrator, policy administrator, approver, RevOps manager, sales manager, reviewer and viewer roles
- Pipeline/team scope restrictions
- Two-person approval for sensitive actions
- Permission checks on every mutating API
- Actor attribution and session context

## D. Remediation workflow

- Durable cases, assignment, priority, SLA and escalation
- Comments and evidence attachments
- Acknowledge, waive, resolve, reopen and close
- HubSpot task creation and task reconciliation
- Bulk assignment and bulk task creation
- Reopen when the underlying issue returns
- Mean-time-to-resolution and manager queues

## E. Advanced alerts and escalation

- Multiple Slack, Teams, email and webhook destinations
- Routing by event, severity, pipeline, team, owner and region
- Quiet hours and business calendars
- Acknowledgement and escalation chains
- Deduplication, suppression and cooldowns
- Delivery history, retries, dead letters and replay

## F. Enterprise audit and compliance

- Hash-chained audit trail with old/new value diffs
- Search, CSV and JSON exports
- Customer data export
- Retention controls and legal holds
- SIEM delivery
- Subprocessor and DPA disclosure assets
- Encryption-key rotation runbook
- Security and incident-response documentation

## G. Enterprise reliability

- Service-level objectives and health status
- Synthetic checks
- Recoverable leases, exponential retries and dead letters
- Scan resumability and checkpoints
- Backup and restore procedures
- Disaster-recovery plan
- Operational runbooks and customer-visible status history

## H. Commercial infrastructure

- Dodo Payments hosted checkout and customer portal
- Monthly and annual subscriptions
- Merchant-of-record webhook lifecycle
- Manual enterprise contracts, POs and bank-transfer entitlements
- Hybrid base subscription plus usage allowances and overage
- Hard-cap and metered modes
- Dodo usage event reporting with idempotency and retry
- Trials, grace periods, upgrades, downgrades, cancellation and scheduled changes
- Neutral internal entitlement model independent of payment provider

## Automated release gates

- Worker strict TypeScript compilation
- All HubSpot extension typechecks
- Unit and integration tests
- Manifest JSON validation
- Clean D1 migrations through `0008_secure_exports_and_audit_promotion.sql`
- No unresolved review thread

## Live acceptance gates

- Authenticated HubSpot project upload
- Reauthorization and installation in a developer test portal
- Dodo test-mode checkout, portal and signed webhook test
- Dodo metered-usage event test
- Slack, Teams, email, SIEM and customer webhook delivery tests
- HubSpot task association test
- Policy two-person approval and rollback test
- Secure export and legal-hold test
- Failure injection, retry, dead-letter and replay test
- Backup restore and disaster-recovery exercise
