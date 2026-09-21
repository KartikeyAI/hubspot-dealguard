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

New events persist an independent provider event ID before transport, including when
the transport fails. Retries preserve it and the original timestamp. Legacy retries
retain their existing ID convention because changing an ID after an uncertain provider
response can double count. Reserved metadata cannot replace portal identity/quantity;
numeric quantities stay numeric. Provider calls have deadlines and reject redirects.

## Subscription event transaction

Webhook receipt, subscription state, tenant plan and successful-update audit must
agree. Accepted updates serialize duplicate receipt processing and compare the exact
previous subscription state before updating it. A concurrent change causes a bounded
re-read and ordering decision, not an overwrite using stale optional fields. Audit
failure rolls the accepted state and plan change back. A processed/ignored receipt
cannot be reset by a later delivery.

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

The full local validation currently passes 675 tests, with no failures or skips, plus
Worker and all three HubSpot UI typechecks and 124 release-convergence checks.
No migration, dependency, OAuth scope, actual charge or live provider call is added.

Still required: live test-mode checkout/portal/cancellation and invoice reconciliation;
provider-payload reconciliation for ambiguous delivery histories; entitlement changes
that race with in-flight work; historical provider-target provenance for queued usage;
and operator handling of events outside the provider ingestion window. These tests do
not certify those separate flows. In particular, never change an old usage event's
occurrence timestamp merely to get the provider to accept it.

Official provider references checked during implementation:
- https://docs.dodopayments.com/developer-resources/webhooks
- https://docs.dodopayments.com/features/usage-based-billing/event-ingestion

The production-signoff contract and its independent review requirements remain intact.
The separately saved intelligence candidate remains outside this branch.
