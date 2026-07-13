# Release blockers

DealGuard 2.0 must not be released while any of the following remains unresolved:

- Failing Worker or HubSpot extension compilation
- Failing automated test or migration
- Invalid HubSpot manifest
- Unverified Dodo webhook signature flow
- Entitlement reactivation after cancellation due to stale events
- Permission bypass on mutating enterprise routes
- Audit-chain verification failure
- Export leakage of encrypted secrets or OAuth credentials
- Unrecoverable scan, alert, outbox or billing usage state
- Missing live HubSpot or Dodo acceptance evidence
- Missing backup restore and disaster-recovery evidence
- Unapproved privacy, terms, DPA or subprocessor disclosures
