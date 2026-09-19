# DealGuard 3.0.0-alpha.1

Date: September 19, 2026. Status: development prerelease, not a production release.

## Included source

This version consolidates the source already published on PR #46 through commit
`9f34835ec638975c58e78a983ccc2bdbdbf847b5`, then synchronizes the root package,
Worker health identity, deal card, settings extension and App Home versions.
It does not change HubSpot project/component UIDs or OAuth scopes.

The included development work covers exact-source release baselines and
intelligence acceptance gates; scoped analytics and saved-view ownership;
portfolio history, durable daily captures and lifecycle-correct outcomes;
evidence aging and non-sliding advisory deadlines; handoff cycles;
opt-in background enrichment and fair scheduling; archive/restore handling;
durable webhook receipt; record authorization; and the transactional
recommendation-to-remediation workflow and scoped work console.

The schema includes additive migrations through `0030`. A source merge does not
apply migrations to a customer database or upload the HubSpot project.

## Preserved work not included

The separately preserved 81-file local candidate with source tree
`fb4d30ac59e63b7197bd2435571692cb6f606ec1` is NOT included in this version.
Source publication for that batch remains blocked by a tool safety check.
Its 670-test local result must not be attributed to this release's source.
The candidate remains available in the development conversation as a complete
source archive, baseline-relative patch, and validation evidence bundle.

That pending work includes independent enrichment-source clocks,
evidence-gated automatic resolution, consented historical outcome evaluation,
native AI assistance, optional read-only Breeze adapters, installation consent
reset, bounded request parsing, scoped Home totals and setup guidance.
Those capabilities must not be represented as shipped in this prerelease.

## Release boundaries

The prerelease can be validated for staging; existing release-version policy
rejects it for production. Production protections and acceptance requirements
are unchanged. No deployment, HubSpot upload, live AI call, billing operation or
customer notification is authorized by this version bump.

Protected staging configuration, repository governance, HubSpot account/UI
acceptance, remaining product implementation, independent security review,
representative load, provider recovery, customer pilots and production sign-off
remain open. Track live/configuration gates in #38, #41 and #42.

The first stable `3.0.0` release requires the agreed three-phase exit gates.
