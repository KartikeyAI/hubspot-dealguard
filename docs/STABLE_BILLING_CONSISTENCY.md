# Stable v3 commercial consistency

Status: implemented and locally validated on the production-signoff branch; not a
production release or live Dodo acceptance. The product stays 3.0.0-alpha.1.

## Usage reservation

A usage batch seeds and locks its portal/metric/period counter before checking the
allowance, inserting an idempotent event, and changing the counter. These statements
share one PostgreSQL transaction. Concurrent first-use and existing-counter requests
cannot both consume the same remaining amount. Max-aggregation events store only
their incremental high-water delta locally, but report the absolute value externally.

Capped mode stops at the included amount (or an earlier explicit hard limit).
Metered overage requires entitlement and both subscription/metric opt-in, and never
bypasses an explicit hard limit. Keys longer than 255 characters are rejected rather
than truncated; a replay with a different metric or requested quantity is a conflict.

New events persist an independent provider event ID, original timestamp, and a versioned
original-target receipt before transport. The receipt binds test/live environment,
customer, subscription, product, available period boundaries and configured meter.
Service-owned receipt fields cannot be supplied by caller metadata and are not sent as
provider metadata. Current authorization and target must still match before delivery.
Local-only observations never become billable merely because a plan is upgraded later.

Delivery state does not undo local consumption: pending, reported, withheld and local-only
observations still count toward allowances. Legacy public usage functions delegate to the
same atomic path; retries no longer delete and recreate events. Metadata has bounded key,
value and field counts; keys are not truncated into collisions. Calls reject redirects,
have deadlines and read bounded provider responses. Only sanitized error codes are stored.

Retry processing includes crash-created pending events with no recorded transport error.
A corrupt event is held individually without aborting later events. Missing provenance,
changed authorization/targets, permanent rejection and observations outside the provider
window enter the existing failed state for reconciliation. No legacy target is invented;
no old event ID or occurrence timestamp is rewritten. Transient provider errors stay pending.
Concurrent failed delivery cannot reset an already reported or independently modified row.
A zero-ingestion response is verified by retrieving the provider event and comparing its
ID, customer, meter, timestamp and complete metadata. It is not treated as success alone.

The documented provider ingestion window is one hour in the past and five minutes in the
future. Events outside that window are withheld rather than changed to the current time.
Provider rejections and billing-account changes therefore require explicit operational
reconciliation. This implementation does not infer invoice adjustments or refunds.

## Subscription event transaction

Webhook receipt, subscription state, tenant plan and successful-update audit must
agree. Accepted updates serialize duplicate receipt processing and compare the exact
previous subscription state before updating it. A concurrent change causes a bounded
re-read and ordering decision, not an overwrite using stale optional fields. Audit
failure rolls the accepted state and plan change back. A processed/ignored receipt
cannot be reset by a later delivery. Ignored receipt transitions and their audits also
share one UPDATE RETURNING statement. A delayed duplicate can neither append an ignored
audit after successful processing nor change a refreshed retry receipt with another
payload fingerprint. Audit failure rolls back the ignored transition before failure
classification. Deterministic two-session tests cover both duplicate paths.

Supported provider product IDs, not possibly stale checkout tier metadata, determine
Growth/Enterprise and month/year. Conflicting portal/customer/subscription correlation
is rejected. A manual contract remains authoritative. A different subscription can
replace a terminal subscription only on a strictly newer activation; it does not inherit
old cancellation, period, trial or overage settings.

Repeated on-hold/past-due deliveries preserve the delinquency episode's first grace
clock, even after expiration. A genuine active recovery followed by a new hold starts
a new clock. Equal-time ambiguous transitions fail conservatively. Unsupported events
are acknowledged as ignored; they cannot create an entitlement.

Dodo documents that deliveries can be out of order and may contain the latest object
payload rather than its historical state. Failed, uncommitted receipts can therefore
accept a refreshed retry payload; completed receipts remain idempotent. Original event
timestamps still cannot establish a newer observation than their source proves.

## Executed evidence and remaining boundaries

`test/billing-concurrency-postgres.test.mjs` executes real production service SQL using
two independent disposable PostgreSQL sessions, deterministic concurrency barriers,
transaction rollback injection, all four configured product mappings, entitlement and
identity checks, and explicitly simulated HTTP responses. It is not live checkout,
provider invoice reconciliation, or production concurrency/performance acceptance.

## Billing administrator experience

`GET /api/v1/billing/delivery` is read-only, signed-user and portal-wide `billing.manage`
gated. It returns retained event counts, oldest observations and allowlisted reason codes,
never raw errors, provider identities or payloads. It does not require an active paid plan;
the installation and billing role must still be valid. Access is rechecked before returning
results. Checkout and customer-portal operations use the same management boundary.
Expired-plan UI fallback preserves explicitly assigned permissions and record scopes.

Active App Home shows the delivery panel only for known, unrestricted billing managers.
It loads on request, clears prior results, and discards responses after unmount/access
changes. Checkout provides monthly or annual cadence for its supported upgrade paths.
The page does not claim delivery acknowledgment is an invoice, payment, or completed refund.

## September 25 continuation: verification boundaries

Canonical CI on interrupted head `326ccb50cad02319e09d1ee802e7c3502e91a47f` exposed the
duplicate-audit race. The new deterministic tests reproduce the prior defect and pass
with the receipt fix. The separate delivery and administrator tests use actual service
SQL with disposable PostgreSQL, simulated provider transport, permission revocation,
tenant isolation and source-contract checks. UI typechecks/source tests are not rendered
HubSpot acceptance. No migration, dependency, OAuth scope or live charge is added.

Still required: actual test-mode checkout, account portal, cancellation, invoice
reconciliation, reviewer approval, live provider behavior, representative throughput and
failure recovery. In-flight external requests cannot be recalled by a later consent change.
Missing or ambiguous historic provider receipts require operator comparison with original
provider records, not automatic re-billing. Retained-event diagnostics are not lifetime
invoice totals. Exact-head GitHub results are recorded in PR #47, not inferred from local tests.

Official provider references checked during implementation:
- https://docs.dodopayments.com/developer-resources/webhooks
- https://docs.dodopayments.com/features/usage-based-billing/event-ingestion
- https://docs.dodopayments.com/api-reference/usage-events/get-event
- https://github.com/dodopayments/dodopayments-typescript/blob/main/src/resources/usage-events.ts

The production-signoff contract and its independent review requirements remain intact.
The separately saved intelligence candidate remains outside this branch.
