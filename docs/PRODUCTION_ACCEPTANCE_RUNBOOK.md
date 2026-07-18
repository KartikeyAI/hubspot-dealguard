# DealGuard 2.1.0 production acceptance runbook

Use this runbook after the production Worker is deployed and the production HubSpot project is uploaded. Run the sections in order. Record every result, request ID, provider screenshot, and artifact reference.

A skipped required test is a failed release gate. Optional tests may be skipped only when the stated prerequisite is absent and the skip reason is recorded.

## 1. Test identities and data

Prepare:

- one HubSpot production acceptance portal;
- one administrator or installer identity;
- a second user for two-person approval tests;
- one existing test deal with company, contact, amount, stage, close date, and owner;
- one deal intentionally missing required information;
- one Growth billing test customer where available;
- one Enterprise billing test customer where available;
- one Slack destination;
- one email destination;
- one webhook or SIEM receiver;
- one receiver that intentionally fails for retry testing.

Do not use a real customer deal for destructive or failure-injection tests.

## 2. Automated public smoke checks

Run:

```bash
PRODUCTION_SMOKE_BASE_URL=https://dealguard-api.rokad.co \
PRODUCTION_SMOKE_EXPECT_VERSION=2.1.0 \
npm run production:smoke
```

The Controlled deploy workflow runs the same command automatically.

| ID | Test | Pass criteria |
|---|---|---|
| `DG-PROD-001` | Production HTTPS identity | Exact production origin and HTTPS |
| `DG-PROD-002` | Health and release identity | HTTP 200, service `dealguard-api`, version `2.1.0` |
| `DG-PROD-003` | Public status | HTTP 200 JSON with no sensitive diagnostic content |
| `DG-PROD-004` | Docs, privacy, terms, support | All return non-empty HTML |
| `DG-PROD-005` | Unsigned protected API | Billing API returns HTTP 401 |
| `DG-PROD-006` | OAuth install redirect | Redirects to `app.hubspot.com` with production callback and required parameters |
| `DG-PROD-007` | Public secret-leak scan | No database URLs, API tokens, webhook secrets, or private keys |

Evidence is written to:

```text
.release/production-smoke/evidence.json
.release/production-smoke/evidence.md
```

## 3. Signed automated acceptance

Run the full profile:

```bash
ACCEPTANCE_PROFILE=full \
ACCEPTANCE_BASE_URL=https://dealguard-api.rokad.co \
ACCEPTANCE_PORTAL_ID=<portal-id> \
ACCEPTANCE_USER_ID=<optional-user-id> \
ACCEPTANCE_USER_EMAIL=<admin-email> \
ACCEPTANCE_EXPECT_TIER=<free|growth|enterprise> \
ACCEPTANCE_TEST_DEAL_ID=<test-deal-id> \
ACCEPTANCE_CHECKOUT_TIER=enterprise \
ACCEPTANCE_CHECKOUT_INTERVAL=year \
HUBSPOT_APP_ID=<production-app-id> \
HUBSPOT_CLIENT_SECRET=<secret> \
DODO_WEBHOOK_SECRET=<secret> \
npm run acceptance:live
```

The full profile does not complete a payment, cancel a subscription, delete tenant data, publish policy, modify roles, or apply a subscription-plan change.

| ID | Test | Pass criteria |
|---|---|---|
| `DG-LIVE-001` | Public health | Exact current release identity |
| `DG-LIVE-002` | Legal and support surfaces | All public HTML surfaces respond |
| `DG-LIVE-003` | Signature enforcement | Unsigned protected request returns 401 |
| `DG-LIVE-004` | Billing status | Tier, status, provider, entitlement, and allowances resolve |
| `DG-LIVE-005` | Access context | Role and permissions resolve |
| `DG-LIVE-006` | Dashboard and HubSpot metadata | Dashboard, properties, and pipelines load |
| `DG-LIVE-007` | Enterprise App Home read model | All panels return data or explicit redaction |
| `DG-LIVE-008` | Live deal assessment | Existing test deal receives a complete score and issue set |
| `DG-LIVE-009` | Portal scan | Scan is accepted and becomes observable |
| `DG-LIVE-010` | Invalid Dodo signature | Invalid signature returns 401 |
| `DG-LIVE-011` | Non-subscription Dodo isolation | Signed payment event does not change entitlement |
| `DG-LIVE-012` | Checkout creation | HTTPS checkout is created without granting entitlement |
| `DG-LIVE-013` | Plan preview | Provider preview returns without mutating subscription state |
| `DG-LIVE-014` | Single-use audit export | First download succeeds; replay returns 410 |

Production requires zero failed tests. `DG-LIVE-008` and `DG-LIVE-009` must not be skipped for the final production certification. `DG-LIVE-014` requires an active Enterprise acceptance portal; when that prerequisite is unavailable, test it in the dedicated Enterprise billing account before launch.

## 4. HubSpot installation and OAuth

1. Open the production install URL.
2. Confirm the browser is redirected only to `app.hubspot.com`.
3. Confirm the displayed application is the production DealGuard app.
4. Review every requested scope.
5. Install in the acceptance portal.
6. Confirm the callback returns to `https://dealguard-api.rokad.co/install/success`.
7. Confirm a tenant record is created.
8. Confirm an install-triggered scan is queued.
9. Uninstall the app from a disposable portal.
10. Confirm uninstall or data-deletion processing behaves as documented.
11. Reinstall or reauthorize the acceptance portal.
12. Confirm an OAuth token from another app is rejected.

Evidence:

- install and scope screenshots;
- Worker request IDs;
- tenant and scan identifiers;
- uninstall or deletion evidence.

## 5. HubSpot App Home

1. Open DealGuard App Home.
2. Confirm the overview loads without console errors.
3. Confirm policy, analytics, access, remediation, alerts, compliance, reliability, and billing sections are present.
4. Confirm role-restricted sections are either visible or explicitly redacted.
5. Confirm no panel displays another portal's data.
6. Refresh and reopen the app to verify stable routing.
7. Test with an administrator.
8. Test with a restricted viewer.
9. Confirm saved views and filters persist as intended.
10. Confirm links open only approved DealGuard or HubSpot origins.

## 6. Deal record card

1. Open the prepared complete test deal.
2. Confirm the DealGuard card loads.
3. Run an assessment.
4. Confirm score, grade, status, and issues match the deterministic policy.
5. Confirm the seven DealGuard-owned properties synchronize when native sync is enabled.
6. Mark the deal reviewed.
7. Confirm review audit evidence.
8. Confirm handoff on a ready deal.
9. Confirm the card blocks or explains handoff for an unready deal.
10. Confirm DealGuard does not change stage, owner, amount, close date, or forecast category.

Repeat with the intentionally incomplete test deal.

## 7. Settings and native property sync

1. Open the settings extension.
2. Confirm current plan and settings load.
3. Save a non-governed setting.
4. Reload and confirm persistence.
5. Enable or provision native property sync in the test portal.
6. Confirm DealGuard-owned properties exist with correct types.
7. Run a backfill.
8. Confirm progress and completion.
9. Confirm governed rules cannot be changed through general settings after governance is enabled.
10. Confirm a user without `settings.manage` cannot save changes.

## 8. Workflow actions

### Assess deal with DealGuard

1. Build a workflow using the action.
2. Enroll the complete test deal.
3. Confirm the action completes.
4. Confirm workflow outputs contain the expected readiness result.
5. Confirm the assessment is recorded and visible in DealGuard.
6. Repeat with an incomplete deal.

### Create DealGuard remediation

1. Build a workflow using the remediation action.
2. Enroll the incomplete test deal.
3. Confirm exactly one remediation case is created.
4. Replay the same action and confirm idempotent behavior.
5. Confirm the case links to the correct deal and portal.

## 9. HubSpot webhook handling

1. Trigger a relevant deal property change.
2. Confirm HubSpot sends the webhook to the production endpoint.
3. Confirm the signature validates.
4. Confirm the event is accepted with HTTP 202.
5. Confirm the correct portal is updated.
6. Replay the same event and confirm idempotent behavior.
7. Send an invalid signature and confirm rejection.
8. Confirm webhook failure does not leak credentials or raw tokens.

## 10. Scans and Cloudflare Queues

1. Record initial depth for scan, delivery, maintenance, and dead-letter queues.
2. Start a manual portal scan.
3. Confirm the API returns HTTP 202 and a scan ID.
4. Confirm the scan message enters the production scan queue.
5. Confirm the consumer processes it.
6. Confirm scan status and counts update.
7. Confirm the dashboard shows the latest scan.
8. Interrupt or fail a test scan in a controlled staging-equivalent environment.
9. Confirm retry and checkpoint recovery.
10. Confirm an exhausted test message reaches the dead-letter queue.
11. Confirm replay or operator recovery works.
12. Confirm no queue message contains plaintext credentials.

## 11. Governance and approvals

1. Enable governance in the Enterprise test portal.
2. Create a policy from a template.
3. Add pipeline, team, owner, or region segmentation.
4. Run a production-equivalent simulation.
5. Review changed deals and score distribution.
6. Submit with user A.
7. Attempt self-approval with user A and confirm rejection.
8. Approve with user B.
9. Publish the policy.
10. Reassess the prepared deals and confirm the expected scoring change.
11. Create a new draft based on the published policy.
12. Confirm the self-referential policy-history link is intact.
13. Roll back and confirm restoration.
14. Create, approve, expire, revoke, and audit an exception.

## 12. Remediation

1. Generate remediation from a critical assessment.
2. Confirm severity, owner, SLA, and linked deal.
3. Add a comment.
4. Upload evidence to Tigris.
5. Confirm size and checksum metadata.
6. Require independent evidence review.
7. Bulk assign cases.
8. Create HubSpot tasks.
9. Confirm tasks are associated with the correct deal.
10. Acknowledge, start, resolve, reopen, waive, and close cases as permitted.
11. Trigger an overdue case and confirm escalation.
12. Confirm timeline and audit records are immutable and portal-scoped.

## 13. Alerts and external delivery

For Slack, email, webhook, Teams, and SIEM destinations declared supported at launch:

1. Create the destination.
2. Send a test event.
3. Confirm receipt and expected formatting.
4. Confirm HMAC signatures for customer webhooks.
5. Test pipeline, team, owner, region, event, and severity routing.
6. Test quiet hours and business calendars.
7. Acknowledge an alert.
8. Route one event to the intentionally failing destination.
9. Confirm bounded retries.
10. Confirm dead-letter state after exhaustion.
11. Fix the destination.
12. Replay and confirm successful delivery.
13. Confirm delivery history and request IDs.

## 14. Dodo Payments

Use a dedicated live-mode billing test customer and the smallest approved transaction where an actual payment is necessary.

1. Verify all four production product IDs.
2. Create a Growth monthly checkout.
3. Create a Growth annual checkout.
4. Create an Enterprise monthly checkout.
5. Create an Enterprise annual checkout.
6. Confirm checkout creation alone does not grant entitlement.
7. Complete the approved test purchase.
8. Confirm signed `subscription.*` activation grants the correct entitlement.
9. Open the Customer Portal.
10. Preview immediate and scheduled plan changes.
11. Confirm preview does not mutate state.
12. Apply a plan change only in the billing test account.
13. Test `past_due`, recovery, cancellation, renewal, and expiry.
14. Send duplicate and stale events and confirm idempotency and ordering.
15. Send non-subscription payment, refund, and dispute events and confirm they do not change entitlement.
16. Verify cumulative usage meters.
17. Verify gauge usage meters.
18. Verify hard caps and optional overage.
19. Verify a manual Enterprise contract and purchase-order reference.

## 15. Compliance and audit

1. Search audit events by actor, source, time, and action.
2. Verify the cryptographic chain.
3. Export CSV, JSON, and JSONL.
4. Confirm export permissions.
5. Create a single-use export.
6. Download it once.
7. Confirm replay returns 410.
8. Create a legal hold.
9. Run retention processing.
10. Confirm held records are not deleted.
11. Remove the hold through the approved process.
12. Generate a complete customer data export.
13. Deliver a test event to the SIEM destination.
14. Confirm no cross-tenant records appear.

## 16. Tigris and backup/restore

1. Upload a non-customer test attachment.
2. Verify database metadata, object key, size, and checksum.
3. Download it through the approved access path.
4. Confirm expired or replayed links fail.
5. Create an encrypted production backup.
6. Verify the backup object with `storage:backup:head`.
7. Download it with checksum verification.
8. Restore into an isolated Neon branch.
9. Run `db:migrate:check` and `db:validate`.
10. Verify tenant counts, subscriptions, policy history, remediation, audit continuity, and object references.
11. Record restore duration and recovery-point timestamp.

## 17. Reliability and observability

1. Confirm `/status` reports the expected public state.
2. Run synthetic checks.
3. Confirm Worker logs contain request IDs but not secrets.
4. Confirm Hyperdrive connection and transaction telemetry.
5. Confirm Neon connection count and query latency remain within expected thresholds.
6. Confirm queue depth returns to baseline.
7. Confirm dead-letter depth is zero or every item is explained.
8. Trigger a controlled incident in staging and verify incident history.
9. Recover a stale job lease.
10. Confirm scheduled scans and maintenance run at the expected cadence.

## 18. Security checks

1. Confirm all public and API traffic uses HTTPS.
2. Confirm unsigned API requests are rejected.
3. Confirm invalid HubSpot and Dodo signatures are rejected.
4. Confirm an OAuth token for another app is rejected.
5. Confirm restricted users cannot access administrative operations.
6. Confirm last-administrator protection.
7. Confirm two-person approval and self-approval prevention.
8. Confirm no secrets appear in HTML, JSON, logs, queue messages, or artifacts.
9. Confirm tenant identifiers are included in tenant-owned constraints.
10. Confirm direct Neon credentials are not present in Worker configuration.
11. Confirm Tigris object access is scoped and time-limited.
12. Confirm data deletion requires the exact confirmation phrase and appropriate permission.

## 19. Performance baseline

Record:

- `/health` latency;
- signed dashboard latency;
- signed metadata latency;
- assessment latency;
- scan throughput;
- queue wait and processing time;
- Neon query latency and connection count;
- Tigris upload and download latency;
- external delivery latency.

Compare against the release SLOs. Investigate significant regression from staging before declaring the release successful.

## 20. Final acceptance record

The final acceptance package must include:

- production smoke JSON and Markdown;
- full signed acceptance JSON and Markdown;
- HubSpot installation and UI evidence;
- workflow and webhook evidence;
- queue and dead-letter evidence;
- Dodo lifecycle evidence;
- Tigris upload and restore evidence;
- audit-chain and legal-hold evidence;
- performance baseline;
- list of skipped optional tests with reasons;
- operator and approver names;
- exact release SHA and version;
- final go/no-go decision.

Release only when all required tests pass and the production approver signs the evidence record.
