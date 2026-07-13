# Production acceptance runbook

## 1. Database and Worker

1. Create the production D1 backup.
2. Apply migrations through `0008_secure_exports_and_audit_promotion.sql`.
3. Deploy the Worker with all required secrets.
4. Verify `/health` and authenticated health endpoints.
5. Confirm scheduled jobs are firing.

## 2. HubSpot

1. Authenticate the HubSpot CLI.
2. Upload the project and resolve schema errors.
3. Install in a developer test portal.
4. Reauthorize all declared scopes.
5. Test the deal card, App Home and every workflow action.
6. Provision DealGuard-owned properties and run backfill.
7. Verify task-to-deal association.

## 3. Dodo Payments

1. Use test mode.
2. Run all four subscription checkouts.
3. Open the Customer Portal.
4. Trigger signed lifecycle events.
5. Verify activation, grace, recovery, cancellation and expiry.
6. Send metered usage and verify idempotency.
7. Test capped mode and hard-limit enforcement.
8. Activate and expire a manual Enterprise contract.

## 4. Governance

1. Create a scoped policy from a template.
2. Simulate it.
3. Submit with user A.
4. Approve with user B.
5. Publish and verify scoring change.
6. Roll back and verify restoration.
7. Create, approve, expire and revoke an exception.

## 5. Remediation

1. Generate cases from a critical assessment.
2. Add comments and evidence.
3. Bulk assign cases and create HubSpot tasks.
4. Resolve, reopen and waive cases.
5. Verify SLA escalation and MTTR.

## 6. Alerts and delivery

1. Configure multiple Slack, Teams, email and webhook destinations.
2. Verify route filters, quiet hours and business calendars.
3. Acknowledge an alert.
4. Inject delivery failures.
5. Verify retry, dead letter and replay.

## 7. Compliance

1. Search and export audit data in CSV and JSON.
2. Verify hash-chain integrity.
3. Create a customer data export.
4. Create a legal hold and confirm retention jobs skip held records.
5. Deliver events to the SIEM endpoint.
6. Rotate an encryption key in a staging copy.

## 8. Reliability

1. Run synthetic checks.
2. Interrupt a scan and resume it.
3. Recover stale processing leases.
4. Restore a D1 backup into an isolated environment.
5. Execute the disaster-recovery runbook.
6. Verify customer-visible incident history.

Release only after every item has evidence attached to the release record.
