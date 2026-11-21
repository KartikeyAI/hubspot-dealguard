# Release blockers

Stable DealGuard v3 must not be declared production-ready while any of the following remains unresolved. This is a release checklist, not a claim that the listed evidence exists. The exact mandatory checks, measurements and independent signature contract are in `STABLE_3_0_SIGNOFF.md`.

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
- Merged source, migration manifest or root/UI/Worker version drift; required scope remains local-only
- Canonical CI evidence missing for the frozen SHA, or required PostgreSQL tests skipped
- Missing enforcement of protected branches, independent review and production environment restrictions
- A current trial, cancellation, grace or manual-contract boundary ignored at request time
- Unknown/stale evidence shown as healthy, zero probability or complete coverage
- A recorded card GET causing provider refresh, writes or recommendation creation
- Missing live validation of governed AI and the supported handover/evidence purposes
- Forecast eligibility granted without current consent, qualified immutable model, distinct reviewer, valid monitoring and current scope/lifecycle checks
- Native AI, forecast or Breeze controls enabled without their required portal consent and approved external configuration
- Missing measured 10,000-deal/two-portal load evidence or cached-read p95 above 2,000 ms
- Missing real provider restore/object reconciliation, RPO above one hour or RTO above four hours
- Fewer than three consenting pilot accounts, or unresolved blocking pilot defects
- Missing either independent production evidence signature, expired/mismatched source/staging evidence, or unverified signer key custody
- Failed post-deployment acceptance, canary observation or operating-owner approval

Public CI and `npm run test:local` validate code and isolated database behavior. They cannot establish HubSpot build/account acceptance, payment-provider lifecycle support, production recovery, customer pilot consent, live AI quality, marketplace approval or human sign-off. Keep optional forecast/Breeze production switches disabled when their prerequisites are absent; do not silently remove agreed native-AI scope to make release reports pass.
