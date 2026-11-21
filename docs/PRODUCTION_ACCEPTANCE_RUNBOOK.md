# DealGuard 3.0 production acceptance runbook

Use this runbook after the production Worker is deployed and the production HubSpot project is uploaded. Run the sections in order. Record every result, request ID, provider screenshot, and artifact reference.

Rehearse the same profiles on the exact candidate SHA in staging before approval. Unchecked steps are not acceptance evidence. The stable release must separately satisfy `STABLE_3_0_SIGNOFF.md`, including two independent signers and all eleven evidence categories. A version bump, successful CI job or pre-deployment approval receipt alone does not establish production readiness.

A skipped required test is a failed release gate. Optional tests may be skipped only when the stated prerequisite is absent and the skip reason is recorded.

## 1. Test identities and data

Prepare:

- one HubSpot production acceptance portal;
- two independently identified HubSpot administrator/setup identities;
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
PRODUCTION_SMOKE_EXPECT_VERSION="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json","utf8")).version')" \
npm run production:smoke
```

The Controlled deploy workflow runs the same command automatically.

| ID | Test | Pass criteria |
|---|---|---|
| `DG-PROD-001` | Production HTTPS identity | Exact production origin and HTTPS |
| `DG-PROD-002` | Health and release identity | HTTP 200, service `dealguard-api`, version the exact stable v3 candidate version |
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
ACCEPTANCE_USER_ID=<identified-admin-user-id> \
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
3. Confirm the current Home overview, manager queue, evidence panels, setup and billing controls match the installed user's permissions. The manifest's retained V3 entry loads the V4 implementation.
4. Confirm denied administrative panels are absent and inaccessible through their APIs. Billing-only administrators must still load billing when analytics is unavailable or denied.
5. Confirm no panel displays another portal's data.
6. Refresh and reopen the app to verify stable routing.
7. Test with an administrator.
8. Test with a restricted viewer.
9. Confirm saved views and filters persist as intended.
10. Confirm links open only approved DealGuard or HubSpot origins.
11. For a new enterprise setup or supported legacy migration, use **Initial enterprise administrator setup** with two distinct signed identities. Verify the requester can nominate only a different exact user ID and email, proposal grants nothing, only the nominee can accept the exact fingerprint before expiry, and acceptance atomically establishes both administrators. Self-acceptance, changed identities, changed installation state and a newly existing administrator must deny setup.
12. Use **Workspace roles and record access** to request a separate reviewer with `forecast.approve`, then have the other authorized administrator inspect and approve it through **Two-person role changes**. Verify approval alone does not assign access. Explicitly apply the exact stored request; changed payload, stale permissions, expired approval and replay must fail. Repeat for a scoped edit and approved removal. Verify email-only assignment promotion, preservation of all scope dimensions, final-admin protection and Home access refresh after self-demotion.

## 6. Deal record card

1. Open the prepared complete test deal.
2. Confirm the DealGuard card loads.
3. Verify opening the card performs only a recorded assessment GET. An authorized reviewer's explicit refresh performs POST; a viewer cannot refresh, review or confirm handoff. No prior assessment produces an explicit unavailable state, never an automatic HubSpot fetch.
4. Confirm score, grade, status, and issues match the deterministic policy.
5. Confirm the seven DealGuard-owned properties synchronize when native sync is enabled.
6. Mark the deal reviewed.
7. Confirm review audit evidence.
8. Confirm handoff on a ready deal.
9. Confirm the card blocks or explains handoff for an unready deal.
10. Confirm DealGuard does not change stage, owner, amount, close date, or forecast category.

Repeat with the intentionally incomplete test deal.
Navigate rapidly between two prepared records while one response is delayed. The old record's assessment, errors, actions and success notice must not appear on the new record. Repeat while a review request is in flight. Stale or unknown evidence must remain visibly labeled; an absent optional source must not be presented as healthy or as a zero score.

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
6. Verify the backup object with `storage:backup:head`, supplying the independently recorded SHA-256.
7. Download the exact object with the same expected checksum and verify the downloaded bytes.
8. Restore into an isolated Neon branch.
9. Run `db:migrate:check` and `db:validate`.
10. Verify tenant counts, subscriptions, policy history, remediation, audit continuity, and object references.
11. Record restore duration and recovery-point timestamp.

## 17. Reliability and observability

1. Confirm `/status` reports the expected public state.
2. Run synthetic checks.
3. Confirm Worker logs contain request IDs but not secrets.
4. Confirm direct Neon HTTP query latency, timeout and error telemetry for the Worker adapter. The runtime has no Hyperdrive binding; migration/test PostgreSQL connections are a separate path.
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

## 20. Stable v3 product and intelligence acceptance

Run these with identified users, a dedicated acceptance portal and retained original provider evidence. Local unit/SQL fixtures verify the implementation but cannot attest that an account, provider contract or live user flow works.

| Surface | Required observations |
|---|---|
| Installation and setup | Granted required scopes are correct, optional commercial sources require explicit authorization, reconnect preserves billing and usable history without reviving revoked optional consent, expired/replayed OAuth state cannot reinstall, installer sees real next steps and can explicitly run a permitted scan. |
| Home and access | Empty or malformed evidence is unavailable, a measured zero remains zero, stale source times stay visible, permissions hide privileged panels, and owner/pipeline/team/region restrictions apply to every read and mutation. Billing-only and expired administrators retain their allowed billing/revocation controls. |
| Recorded cards | GET never refreshes HubSpot or creates recommendations. Manual refresh, review and handoff require their record capabilities; partial source evidence is explained, current lifecycle rules hold, and switching records discards late results. |
| Billing expiry | Without a new webhook, a recorded trial end, current period end or grace end removes paid access at its boundary. A cancellation lacking a valid end fails closed. Paid allowance overrides/overage do not survive expired entitlement. An explicitly open-ended manual contract remains valid by design; record that contract's owner and terms. |
| Manual billing schedule | A due change updates subscription, tenant plan and audit together once. Concurrent contract/provider changes cannot apply stale entitlement. A failed audit rolls back the whole change. Dodo renewal events retain pending provider plan changes until the authoritative plan-change/cancellation event. |
| Remediation | Explicit task creation is authorized and idempotent across retries; an ambiguous remote result does not create a second task blindly. Closure, deletion, reactivation and changed assignment cannot restore stale permission or work. |
| Historical outcomes | Consent is explicit and revocable after subscription expiry. Datasets retain scope, policy, quarter, retention and fingerprints; missing observations are excluded. Training queues a durable bounded job, and queued/running/failed/cancelled rows display without fabricated metrics. Repeated requests do not create duplicate jobs. |
| Qualified forecasts | Global and portal switches default off. Register only a recent qualified evaluation with an expiring immutable artifact; an independent assigned reviewer supplies a retained review-evidence digest. Same requester/reviewer, changed policy/artifact, revoked consent or role, expired model/monitor, ineligible/unavailable cohort evidence and lifecycle changes deny eligibility. The UI labels quarter-start origin, target and historical bin uncertainty; an unavailable probability never becomes 0%. |
| Native AI assistance | Evaluate the approved live model against recorded risk, manager-review, next-action and eligible closed-won handover evidence. Confirm source citations/times, current handover cycle, schema/injection defenses, consent, permissions, concurrent/daily/cost caps, timeout/error fallback, revocation, retention and no actions executed. Synthetic provider responses are engineering tests only. |
| Breeze | Keep optional actions out of the production project until their applicable approval is real. For any declared supported profile, confirm exact registered action IDs, signed portal identity, explicit consent, bounded usage, current source evidence and no unauthorized mutation. |

Active recurring subscriptions that arrive without an optional period end and without cancellation remain compatible with their authoritative provider status. This is not a guarantee that a missing webhook can never leave access open: retain provider reconciliation/monitoring ownership and verify supported lifecycle payloads include their boundaries. Do not claim a global finite-expiry guarantee from local date tests.

Forecast review is independent model approval, not release approval. Current monitoring must run through the maintenance worker; opening a status panel must not train or monitor synchronously. Confirm stale/failed monitoring suspends eligibility, and retained observed outcomes remain distinct from forecasts and from claims of causal revenue improvement.

Measure the agreed capacity in the actual staging/provider environment: at least 10,000 deals and two concurrent portals, cached read p95 greater than zero and at most 2,000 ms, documented provider limits and queue recovery. Restore the encrypted provider database and objects, reconcile their contents, and measure RPO at most 3,600 seconds and RTO greater than zero and at most 14,400 seconds. Three distinct consenting pilot accounts and zero unresolved blocking defects are required by the release contract. A disposable local PostgreSQL rehearsal does not prove those external thresholds.

## 21. Final acceptance record

The final acceptance package must include:

- production smoke JSON and Markdown;
- full signed acceptance JSON and Markdown;
- required intelligence certification and live native-AI/forecast/Breeze profile evidence;
- HubSpot installation and UI evidence;
- workflow and webhook evidence;
- queue and dead-letter evidence;
- Dodo lifecycle evidence;
- Tigris encrypted-object key, independent SHA-256, download verification, and restore evidence;
- audit-chain and legal-hold evidence;
- performance baseline;
- list of skipped optional tests with reasons;
- operator and approver names;
- exact release SHA and version;
- final go/no-go decision.

Attach the exact commit/tree/version, canonical CI run with zero skipped required tests, full staging run and attempt-specific deployment artifact, independently signed eleven-category dossier, protected-trust verification receipt, and production observation record. Retain original reports and reviewer signatures; a sanitized receipt is not a substitute for verifying the signed evidence.

Release only when all required tests pass and the production approver signs the evidence record.
