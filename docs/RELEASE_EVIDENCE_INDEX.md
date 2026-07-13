# Release evidence index

Every release must retain an auditable evidence chain. Repository validation is necessary but does not replace account-bound provider evidence.

## 1. Source and repository integrity

- Pull request and immutable release commit SHA
- CI workflow run
- Worker and HubSpot extension typechecks
- Automated test report
- Manifest validation
- Migration validation through the latest numbered migration

## 2. Release readiness

- `dealguard-release-readiness-<target>-<run>` artifact
- Preflight JSON
- Worker bundle checksums
- HubSpot manifest checksums
- Dodo environment mode validation
- Protected-environment approval evidence

## 3. Controlled deployment

- Provider-managed backup or restore-point reference created before migration
- `dealguard-deployment-staging-<run>` artifact
- Staging deployment record with exact commit and version
- Remote migration checksums
- Deployed health response
- Signed staging acceptance report
- Production promotion verification for the identical staging commit
- `dealguard-deployment-production-<run>` artifact
- Application rollback or incident reference when applicable

## 4. HubSpot platform acceptance

- Authenticated HubSpot upload output
- Install and uninstall validation
- OAuth and reauthorization validation
- Deal card evidence
- App Home V3 evidence
- Settings extension evidence
- Workflow action evidence
- Webhook evidence
- Native property provisioning and backfill evidence
- Task-to-deal association evidence

## 5. Dodo Payments acceptance

- Dodo test-mode product configuration
- Checkout evidence for every tier and billing interval
- Customer Portal evidence
- Signed subscription lifecycle webhooks
- Stale and replay event tests
- Non-subscription entitlement-isolation evidence
- Plan preview, immediate change, scheduled change, and cancellation evidence
- Usage meter and hard-cap evidence
- Grace, recovery, cancellation, and expiry evidence
- Dodo live-mode approval before production billing

## 6. Enterprise A–H acceptance

- Role and scope authorization tests
- Exact-payload two-person approval tests
- Policy simulation, publish, rollback, import, and export tests
- Segmentation and dimension-mapping tests
- Executive analytics and export tests
- Remediation case, evidence, bulk-action, SLA, and HubSpot-task tests
- Multi-channel routing, acknowledgement, retry, dead-letter, and replay tests
- Audit-chain, legal-hold, retention, data-export, and SIEM tests
- Synthetic health, resumable scan, lease recovery, and incident-history tests

## 7. Recovery and operational evidence

- Backup restore into an isolated environment
- Record-count and integrity comparison
- Disaster-recovery exercise
- Encryption-key rotation exercise
- Worker rollback exercise
- Post-rollback signed acceptance
- Incident and corrective-action record

## 8. Security, legal, and commercial approval

- External security review and vulnerability testing
- Privacy policy and terms
- Data-processing agreement
- Subprocessor disclosures
- Support and SLA materials
- Pricing and commercial approval
- HubSpot Marketplace submission and approval

Release approval requires reviewer sign-off against this index. Evidence must not contain access tokens, signing secrets, encryption keys, full customer personal data, or unencrypted database exports.
