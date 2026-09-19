# Stable DealGuard 3.0: production approval contract

Status: implementation started on 2026-09-19. This document is not a release approval.
Baseline: main `6a6a748196ee2ee3f8813d66723e02237a79f14f`, source tree
`ccf56974c6b226e2b24e17c499a7cbc45afab757`, version `3.0.0-alpha.1`.
The previously agreed three-phase scope remains authoritative. Useful deterministic
behavior without AI and optional professional services remain product requirements.

## First stable-release work package

This package adds an independently signed preproduction approval check, integrates it
before database/Worker mutations in Controlled deploy, includes its receipt in the
post-deployment record, and rejects UI package/version drift in repository baselines.
It does not change the product version, apply customer migrations, deploy a Worker,
perform account acceptance, sign on anyone's behalf, or activate optional features.

`npm run release:signoff -- --input .release/signoff-evidence` verifies an exact stable
v3 candidate. The current alpha must fail this command. The resulting receipt has
`approvalAccepted: true` but **`productionReady: false`**: actual deployment, canary
observation, post-deployment acceptance, monitoring, and final owner sign-off remain
separate. A version bump or a green unit-test suite is insufficient.

## Eleven non-waivable evidence categories

| Gate | Required evidence | Additional measured constraints |
|---|---|---|
| source | Complete merged scope, resolved local-only work, disclosed optional capabilities | Exact commit, source tree and version |
| ci | Canonical CI, Worker/UI types, full regressions, migration/schema validation | Nonzero test total; no failures or skips; successful canonical run ID |
| governance | Required reviews/CI, stale-approval dismissal, force/deletion protection, protected production reviewers/ref restrictions | Actual administrator verification, not proposed settings |
| acceptance | Install, upgrade, seller/manager/executive/admin workflows, removal, denial and optional-source failure | Real HubSpot project build ID and explicit supported profiles |
| security | Isolation, authorization, consent/erasure, injection/abuse, dependencies, independent review | Zero unresolved critical/high findings |
| commercial | Growth/Enterprise monthly/annual, webhook retries/order, cancellation, usage, expiry | Actual supported commercial flows |
| intelligence | Outcome evaluation, ineligible forecasts disabled, native AI provider evaluation/budgets/fallback, Breeze disabled or approved | No substitute of simulated provider outputs for live evaluation |
| load | Advertised capacity, concurrent tenants, provider limits, queue recovery | At least 10,000 deals and two concurrent portals; cached read p95 >0 and <=2,000 ms |
| recovery | Encrypted restore, row integrity, object reconciliation, rollback | Actual provider DB/object restoration; RPO <=3,600 s and RTO >0 and <=14,400 s |
| pilot | Consented customer accounts/workflows; blockers resolved | At least three distinct account fingerprints and no blocking defects |
| operations | Monitoring, on-call runbooks, terms, setup/privacy/security docs, incident response | Real operating ownership and materials |

These are the agreed engineering/pilot targets, not claims of current performance
or customer SLAs. Marketplace approval is a separate external state. Breeze may be
excluded from the production project while approval is pending. Native AI cannot
be silently removed from the agreed 3.0 scope to make this gate pass. Customer-visible
forecast probabilities must stay disabled for ineligible cohorts.

The exact required check identifiers are exported as `SIGNOFF_GATES` in
`scripts/production-signoff.mjs`. Every report must contain each of its checks once,
with status `passed`; missing, skipped, failed, unknown and duplicate checks fail.

## Evidence format and custody

Use an artifact with precisely this top-level layout (extra files are not executed):

```text
dossier.json
signatures.json
reports/source.json
reports/ci.json
reports/governance.json
reports/acceptance.json
reports/security.json
reports/commercial.json
reports/intelligence.json
reports/load.json
reports/recovery.json
reports/pilot.json
reports/operations.json
```

The dossier contains schemaVersion `1`, kind `dealguard-production-approval`,
`candidate: {repository, commit, tree, version}`, `stagingRunId`, `createdAt`,
`expiresAt`, and `gates`. Each gate is `{path, sha256}` over the exact report bytes.
The repository is `KartikeyAI/hubspot-dealguard`. Use full lowercase Git SHA-1 IDs,
SHA-256 digests, and canonical UTC ISO timestamps including milliseconds. Approval
may last no more than 24 hours. Reports must have ordered `startedAt`/`completedAt`
within seven days, and finish before the dossier's approval timestamp.

Each report contains schemaVersion `1`, the exact `candidate`, its `gate`, timestamps,
`checks: [{id, status}]`, and applicable `measurements`. Measurement fields:

- ci: `testsTotal`, `testsPassed`, `testsFailed`, `testsSkipped`, `workflowPath`
  (`.github/workflows/ci.yml`), numeric-string `runId`, `conclusion` (`success`).
- acceptance: nonempty unique `hubspotProfiles`, numeric-string `projectBuildId`.
- security: `unresolvedCritical`, `unresolvedHigh`.
- load: `cachedReadP95Ms`, `testedDeals`, `concurrentPortals`.
- recovery: `rpoSeconds`, `rtoSeconds`, `providerDatabaseRestored`, `providerObjectsReconciled`.
- pilot: unique SHA-256 `accountFingerprints`, `unresolvedBlockingDefects`.

Keep raw evidence and customer identifiers in the access-controlled evidence system.
Reports should reference that material without copying secrets or CRM content. The
reviewers must independently check original CI/provider/customer evidence and actual
scope coverage. **A signature authenticates who approved these bytes; it does not
prove that a report's measurements are true.** Test fixtures are explicitly synthetic
and must never be used as release reports.

## Two independent approvals

Exactly two Ed25519 signatures are required: one `release_owner` and one
`security_reviewer`, with distinct stable GitHub numeric principals and distinct key
material. The role/identity mapping comes only from an administrator-controlled
`PRODUCTION_SIGNOFF_TRUST_JSON` environment variable in `dealguard-production`:

```json
{
  "schemaVersion": 1,
  "keys": [
    {
      "id": "release-owner-key",
      "principal": "github:<numeric-user-id>",
      "role": "release_owner",
      "publicKeyPem": "<Ed25519 SPKI PUBLIC KEY PEM>",
      "notBefore": "<UTC ISO timestamp>",
      "notAfter": "<UTC ISO timestamp>"
    },
    {
      "id": "security-reviewer-key",
      "principal": "github:<different-numeric-user-id>",
      "role": "security_reviewer",
      "publicKeyPem": "<different Ed25519 SPKI PUBLIC KEY PEM>",
      "notBefore": "<UTC ISO timestamp>",
      "notAfter": "<UTC ISO timestamp>"
    }
  ]
}
```

The registry above is a format example with deliberately invalid placeholders.
Never commit private keys, put them in a dossier, paste them in chat, or make them
available to pull-request jobs. Each designated person keeps their own key in an
approved signing system. This change neither creates those keys nor enrolls users.
Only active keys are accepted. Rotate/remove expired registry entries. Approval
validity must fall within each signing key's configured validity interval.

Sign the exact UTF-8 byte sequence `DealGuard production approval v1\n` followed by
unmodified `dossier.json` bytes, using Ed25519 (no external pre-hash). Put each
64-byte signature in `signatures.json` as unpadded base64url:

```json
[
  {"keyId": "release-owner-key", "signature": "<86-character-signature>"},
  {"keyId": "security-reviewer-key", "signature": "<86-character-signature>"}
]
```

Changing whitespace in the signed dossier invalidates approval. Every report is
bound by its signed digest. Dossier-supplied trust keys, reused principal/key material,
unknown roles, missing evidence, symlinks, traversal and oversized files are rejected.
Two keys cannot prove organizational independence if one person possesses both;
key custody and reviewer appointment remain administrator responsibilities.

## Controlled deployment integration

Publish the reviewed reports, dossier and detached signatures from the separately
controlled evidence-preparation job using `actions/upload-artifact`, named exactly
`dealguard-production-signoff-<full-release-sha>`. The job must not include private
keys or secrets in its artifact. This work package implements the consumer, not an
automatic signing or evidence-submission workflow.

Pass the artifact-producing `signoff_run_id` to Controlled deploy for production.
The artifact is downloaded from this repository only into `.release/signoff-evidence`.
Its producing run is a transport locator, **not a trusted approver**: detached
signatures and the protected key registry supply that authority. The dossier also
pins the independently verified `staging_run_id`.

Existing exact-SHA, stable-version, staging acceptance, encrypted-backup, confirmation,
and post-deployment checks stay mandatory. Sign-off verification runs after backup
verification and immediately before migrations. Failure halts deployment. The
sanitized receipt is retained in the deployment artifact and checked for matching
source/expiry in the final deployment record. That record's structural receipt check
is not a standalone signature verifier: audit the original signed evidence artifact.

Do not bypass this check for rollback. Rollback planning must identify an approved
compatible release, its authorization and the tested database recovery procedure.
No new uploader, deployment, approval, or restoration was executed by this change.

## Current open work and sequencing

1. Review this PR and configure/verify main protection and protected release approvals
   (#42). The live branch read on 2026-09-19 reported `protected: false`.
2. Reconcile the separately preserved candidate against alpha main, in reviewed source
   changes. Its source publication was previously blocked; do not use an alternate
   encoded/CI-based route to circumvent that decision. It is not part of this PR.
3. Complete remaining deterministic/product fixes, governed intelligence, onboarding,
   billing and optional-feature boundaries, preserving tests and release identity.
4. Configure staging (#41) and execute project/account/UI acceptance (#38). The previous
   missing-configuration probe has not been rerun by this package.
5. Collect real security/load/recovery/pilot/operational evidence. Only then nominate
   an exact stable candidate, obtain independent approval, and use controlled rollout.

The preserved candidate tree `fb4d30ac59e63b7197bd2435571692cb6f606ec1` predates the alpha
version bump. Its archive has 52 paths absent from alpha main and 37 differing shared
paths; alpha main has two paths absent from that archive, including release identity
coverage. This is a three-way reconciliation task, not a blanket replacement of main.
The prior 670-test result belongs to that separate tree, not the merged alpha.

Implementation tests cover signatures, roles, clocks, source binding, report integrity,
all mandatory categories, numeric thresholds, input paths and workflow ordering. They
validate the approval machinery, not the real-world evidence needed to pass it.
