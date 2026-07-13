# Release evidence index

A production release record must link every evidence class below. Repository CI alone is insufficient.

## 1. Source and package integrity

- reviewed commit SHA and pull request
- successful CI workflow run
- Worker, deal card, settings and App Home typechecks
- automated test summary
- HubSpot manifest checksums
- migration sequence through `0013_policy_dimension_mappings.sql`

## 2. Protected release readiness

- successful **Release readiness** workflow run
- target environment (`staging` or `production`)
- `2.0.0-rc.x` package/runtime version match
- release-preflight JSON artifact
- deployable Worker bundle checksums
- explicit Dodo mode (`test` for staging, `live` for production)
- confirmation that no secret value appears in the artifact

## 3. Deployment and database

- encrypted or provider-managed pre-migration backup reference
- backup checksum and restore owner
- D1 remote migration output
- previous and deployed Worker version identifiers
- `/health` response proving the deployed package version
- cron/scheduled-handler verification

## 4. HubSpot platform acceptance

- authenticated HubSpot project upload output
- app ID and developer-test portal ID
- install and reauthorization evidence
- App Home V3 screenshots
- deal-readiness card evidence
- both workflow-action executions and outputs
- webhook delivery evidence
- property provisioning and backfill evidence
- task-to-deal association evidence

## 5. Signed live acceptance

- successful **Live acceptance** read-only artifact
- successful **Live acceptance** full artifact
- HubSpot v3 signature rejection and acceptance
- Dodo invalid-signature rejection
- non-subscription entitlement-isolation result
- checkout creation without premature entitlement
- plan-preview no-mutation result
- single-use secure-download replay rejection

## 6. Dodo Payments acceptance

- all four test-mode checkout results
- Customer Portal result
- subscription activation, renewal, grace, recovery, cancellation and expiry
- immediate and scheduled plan changes
- stale and out-of-order event handling
- idempotent event processing
- `sum` usage meters for events and AI credits
- `max` usage meters for active deals and retained storage
- capped mode, hard limit and metered-overage evidence
- manual Enterprise contract activation and expiry

## 7. Enterprise A–H acceptance

- scoped policy simulation, two-person approval, publication and rollback
- role and scope authorization tests
- analytics audiences, drill-down and export tests
- remediation evidence, bulk operations and HubSpot task tests
- multi-channel routing, quiet hours, acknowledgement, dead-letter and replay tests
- audit-chain verification, CSV/JSON/JSONL exports and legal-hold tests
- SIEM delivery evidence
- synthetic checks, stale-lease recovery and resumable-scan evidence

## 8. Recovery and governance

- isolated backup restore test
- disaster-recovery exercise
- incident record and customer-status evidence
- encryption-key rotation evidence
- external security review and vulnerability test
- legal, privacy, DPA, support, pricing and Marketplace approvals

## Release decision

The release owner and an independent reviewer must record one of:

- `approved`
- `approved with documented exceptions`
- `rejected`

Exceptions require an owner, risk statement, compensating control and expiry date. Evidence must not contain access tokens, signing secrets, encryption material, full customer PII or unencrypted database exports.
