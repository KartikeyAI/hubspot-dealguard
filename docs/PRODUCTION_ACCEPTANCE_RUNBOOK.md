# Production acceptance runbook

## Automated gate

Use the protected GitHub Actions workflow **Live acceptance** after deploying the target release.

The workflow runs `npm run acceptance:live` and uploads secret-redacted JSON and Markdown evidence for 30 days. Configure the GitHub Environment `dealguard-acceptance` with:

- `HUBSPOT_CLIENT_SECRET`
- `DODO_WEBHOOK_SECRET`

Required workflow inputs include the deployed Worker URL, HubSpot developer-test portal ID, app ID, installer/admin acceptance identity, expected tier, and an optional test deal ID.

Profiles:

- `read-only`: public health/legal surfaces, signature rejection, signed billing/access, HubSpot metadata, dashboard, and permission-resilient enterprise reads.
- `full`: all read-only checks plus a portal scan, signed Dodo isolation checks, hosted checkout creation, provider plan preview when a Dodo subscription exists, and a single-use audit export for an active Enterprise portal.

The full profile does not make a payment, mutate a subscription plan, cancel service, delete tenant data, publish a policy, or change roles.

Local execution:

```bash
ACCEPTANCE_PROFILE=full \
ACCEPTANCE_BASE_URL=https://dealguard-api.rokad.co \
ACCEPTANCE_PORTAL_ID=123456 \
ACCEPTANCE_USER_EMAIL=installer@example.com \
HUBSPOT_APP_ID=1234567 \
HUBSPOT_CLIENT_SECRET=... \
DODO_WEBHOOK_SECRET=... \
npm run acceptance:live
```

## 1. Database and Worker

1. Create a production D1 backup.
2. Apply migrations through `0013_policy_dimension_mappings.sql`.
3. Deploy the Worker with all required secrets.
4. Run the `read-only` acceptance profile.
5. Confirm scheduled jobs are firing.

## 2. HubSpot

1. Authenticate the HubSpot CLI.
2. Upload the project and resolve schema errors.
3. Install in a developer test portal.
4. Reauthorize all declared scopes.
5. Test the deal card, App Home and every workflow action.
6. Provision DealGuard-owned properties and run backfill.
7. Verify task-to-deal association.
8. Run the `full` acceptance profile with a real test deal ID.

## 3. Dodo Payments

1. Use test mode.
2. Run all four subscription checkouts.
3. Open the Customer Portal.
4. Trigger signed lifecycle events.
5. Verify activation, grace, recovery, cancellation and expiry.
6. Send metered usage and verify idempotency.
7. Test capped mode and hard-limit enforcement.
8. Preview immediate and scheduled plan changes; apply them only in the dedicated billing test account.
9. Activate and expire a manual Enterprise contract.
10. Attach Dodo dashboard evidence to the automated acceptance artifact.

## 4. Governance

1. Create a scoped policy from a template.
2. Simulate it.
3. Submit with user A.
4. Approve with user B.
5. Repeat the exact action and verify approval discovery and execution leasing.
6. Publish and verify scoring change.
7. Roll back and verify restoration.
8. Create, approve, expire and revoke an exception.

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

1. Search and export audit data in CSV, JSON and JSONL.
2. Verify hash-chain integrity.
3. Create a customer data export.
4. Verify single-use secure downloads reject replay.
5. Create a legal hold and confirm retention jobs skip held records.
6. Deliver events to the SIEM endpoint.
7. Rotate an encryption key in a staging copy.

## 8. Reliability

1. Run synthetic checks.
2. Interrupt a scan and resume it.
3. Recover stale processing leases.
4. Restore a D1 backup into an isolated environment.
5. Execute the disaster-recovery runbook.
6. Verify customer-visible incident history.

Release only after every item has evidence attached to the release record. Automated evidence supplements, but does not replace, screenshots and provider-console evidence for account-bound actions.
