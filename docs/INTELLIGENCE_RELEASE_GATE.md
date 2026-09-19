# Intelligence release certification (Phase 1 / M1.1, slice 2)

This gate certifies execution of the existing automated intelligence smoke suite.
It is not HubSpot UI acceptance, prediction validation, proof of revenue impact,
Marketplace approval, or proof that M1.1 is complete.

## Full certification versus diagnostics

`npm run acceptance:intelligence` remains usable for ad-hoc diagnostics. By
default, `ACCEPTANCE_INTELLIGENCE_REQUIRED=false`: omitted data and disabled
sections are recorded as skipped and the report cannot certify a release.

Controlled deploy runs the command after standard live acceptance for every
`full` profile, with these settings enforced:

```text
ACCEPTANCE_INTELLIGENCE_REQUIRED=true
ACCEPTANCE_INTELLIGENCE_PORTFOLIO=true
ACCEPTANCE_INTELLIGENCE_REFRESH_DEAL=true
```

Full certification requires an active Enterprise acceptance portal, an identified
acceptance user, a dedicated numeric test deal, a valid release target and HTTPS
origin, an exact RELEASE_SHA, and GitHub workflow run/attempt identifiers. Missing
configuration is rejected before the suite sends requests. The caller must have
permissions for all tested Enterprise endpoints. No entitlement is changed by
the suite to make a test pass.

All twelve IDs, `DG-INT-001` through `DG-INT-012`, must appear exactly once, be
marked required, and pass. The verifier recomputes result counts; a zero-failure
summary, missing tests, downgraded optional tests, or skipped tests cannot pass.
The suite checks access, refresh/read Deal Brief, recommendation history, seven
portfolio/operations endpoints, and unsigned-request rejection. Missing briefs,
invalid scores, absent history arrays, empty/redacted portfolio objects and HTTP
failures are rejected. Insufficient evidence can be a legitimate Deal Brief state;
this automated gate does not establish that every optional source is available.

A diagnostic run with refresh disabled explicitly records DG-INT-002 as skipped
rather than omitting it. Every diagnostic report remains non-certifying, even
when its executed checks pass.

## Side effects and test-account boundary

Full acceptance is not read-only. The standard suite may assess a test deal,
start a scan, create an unpaid checkout session, exercise an inert billing
webhook and create/consume an export. Intelligence refresh can persist derived
assessments, snapshots and recommendation observations through existing code.
Existing configured readiness write-back or assessment-triggered delivery may
also run. Only approved test deals, test accounts and non-customer notification
routes may be used. This change introduces no new HubSpot CRM mutation endpoint.

A read-only Controlled deploy run does not invoke intelligence certification and
cannot produce promotable staging evidence. The existing standard read-only
profile is unchanged; supplying a test deal can still invoke its assessment
check. Do not interpret the profile name as a guarantee of zero derived writes.

## Deployment record v4

The deployment record now preserves the sanitized result sets, rather than only
summary counters, and binds them to version, selected release SHA, target,
origin, portal, test deal, workflow run and workflow attempt. It also validates the
repository baseline and public smoke identity. Both acceptance scripts prefer
RELEASE_SHA over GITHUB_SHA, because the workflow ref can differ from the exact
release checked out by Controlled deploy.

Exactly one JSON report may exist in each acceptance evidence directory. The
workflow clears both directories immediately before executing acceptance; record
generation does not choose the lexicographically last report from mixed runs.

Standard acceptance requires all fourteen unique IDs. Full certification requires
all to pass except DG-LIVE-013 may explicitly report `Portal has no Dodo
subscription.` for a manual Enterprise contract. Disabling plan-preview testing
is not an accepted exception. Read-only diagnostics preserve the existing seven
mandatory read checks but are never promotable.

The embedded intelligence evidence has a SHA-256 content fingerprint. This detects
inconsistency; it is not a cryptographic signature or independent attestation.
The trust boundary remains the reviewed code and protected GitHub workflow.

## Production promotion

The protected job fetches metadata directly from the GitHub API for the selected
staging run and downloads only that run/attempt's named deployment artifact:

```text
dealguard-deployment-staging-<run-id>-<attempt>
```

The verifier requires the current repository, a successful completed
`workflow_dispatch` execution of `.github/workflows/controlled-deploy.yml`, the
same run and attempt in the deployment record, the exact proposed production
commit/version, and passing full evidence. The workflow metadata's head_sha is
not substituted for the separately selected release commit.

Intelligence evidence must have ordered timestamps and be no older than 24 hours
(with one minute of future clock tolerance). Expired, legacy v3, ambiguous,
malformed, mismatched, or incomplete evidence is rejected. Rerun staging against
the exact release rather than editing old evidence. The verifier rejects symlinks
inside the downloaded evidence tree and bounds traversal.

Backup target, encryption naming, independent digest, exact-SHA checkout,
protected environment and explicit production confirmation remain mandatory.
Application rollback and database restore remain separately governed.

## Validation and remaining work

The focused Node tests execute the actual acceptance and deployment-record CLIs
with test-only transport/filesystem fixtures. No fixture is used in production.
GitHub canonical CI remains the full Worker/UI/PostgreSQL/regression gate.

Pending M1.1: protected staging configuration (#41), branch governance (#42),
actual staging deployment, HubSpot project upload/build identity, and live
developer-account acceptance (#38). The current health endpoint proves service
and version identity, not an independently attested deployed source SHA. The
repository baseline is not a replacement for live database reconciliation or
HubSpot build evidence. No M1.2-M1.6 feature is claimed complete by this slice.
