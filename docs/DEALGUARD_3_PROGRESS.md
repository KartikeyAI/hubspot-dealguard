# DealGuard 3.0 delivery progress

Updated: 2026-09-14. Programme: the agreed three-phase production roadmap.
This file records development progress, not a production-release declaration.

## Current slice: M1.1 release baseline and staging controls

Starting source: `eb8f49612fa3d6b85a3b5732af9db9517be1be00` on `main`.
The intelligence programme from PR #35 is already merged. The package and Worker
release identity remain `2.1.0`; this slice does not relabel production as 3.0.
The current architecture is Cloudflare Workers, direct Neon PostgreSQL, Tigris,
Cloudflare Queues and Dodo Payments. Hyperdrive is not the runtime database path.

### Implemented in this slice

- `npm run release:baseline` inventories the exact committed source, Git tree,
  package/Worker identity, UI package versions, migration SHA-256 hashes, HubSpot
  component UIDs/types, required/optional OAuth scopes and configuration hashes.
- The command rejects mismatched release SHAs, dirty tracked source, untracked
  release source, symlinked inventory files, invalid/duplicate migrations,
  duplicate component identities and inconsistent package/Worker versions.
- Baselines read committed Git objects rather than relying on `GITHUB_SHA`, which
  can identify the workflow trigger instead of a separately checked-out release.
- CI and Controlled deploy record the baseline before dependency installation,
  migration or deployment. The deployment checksum list includes the baseline.
- Staging supports stable versions and `alpha.N`, `beta.N`, `rc.N` prereleases.
  Production remains stable-only. Unknown targets fail closed. Build metadata
  and other prerelease channel names are intentionally not supported.
- Protected preflight no longer pins the product to exactly `2.1.0`.
- Dispatch values are passed to deployment shell validation through quoted
  environment variables, not substituted directly into executable shell source.
- Hidden baseline/deployment evidence is uploaded through explicit path lists;
  neither `.env` nor rendered `.release/wrangler.toml` is uploaded.
- Dependency-free tests exercise Git repositories, CLI behavior, preflight
  integration and actual shell validation, not only source-string contracts.

### Use

Run from a clean, committed repository root before installing dependencies:

```bash
npm run release:baseline -- --target staging
RELEASE_TARGET=production RELEASE_SHA=<exact-40-character-sha> npm run release:baseline
node --test test/release-baseline.test.mjs
```

The default output is `.release/release-baseline.json` (mode 0600). Generated
release artifacts and `.env` are not source inventory. Untracked source beneath
Worker, HubSpot, migration, script or workflow directories must be committed or
removed first. Do not pass secret values on the command line.

This is a **repository baseline**, not an attestation of live deployment. It does
not read protected secrets, call HubSpot, query Neon, apply migrations, upload a
project, run checkout, or send notifications. Applied database version and
HubSpot project build ID remain null; live verification fields stay
`not_verified`. Source hashes do not replace checksum validation against the
actual database, signed acceptance, backup restoration or operator approval.

### Remaining M1.1 gates

- Configure/verify isolated staging resources and protected environment values
  (existing issue #41); this commit does not create or inspect secret values.
- Enable/verify required CI, reviewed changes and main-branch protection
  (existing issue #42); workflow checks do not enable repository protection.
- Run protected readiness and Controlled staging deployment on the exact SHA.
- Upload the staging HubSpot project and record its real build identifier.
- Execute intelligence and standard acceptance in a developer account; validate
  the main customer surfaces and permission-denial paths (existing issue #38).
- Preserve actual database, backup/restore, project and acceptance evidence.
- Finish feature/edition/permission validation and reconcile remaining stale
  overview documents without rewriting historical release records.

M1.1 is **in progress** until those live gates pass. M1.2-M1.6 have not been
completed by this release-tooling slice.

## Existing feature acceptance inventory

`Implemented` below refers to the merged PR #35 scope, not live customer proof.
The authoritative behavior remains in the linked specifications. All live
acceptance is pending for the 3.0 candidate.

| Capability | Repository basis | 3.0 live validation |
|---|---|---|
| Currency-safe current-state analytics | `ENTERPRISE_ANALYTICS.md` | Pending M1.2 |
| Momentum and close-date credibility | `DEAL_MOMENTUM_AND_CLOSE_DATE.md` | Pending M1.3 |
| Buyer-committee coverage | `BUYER_COMMITTEE_INTELLIGENCE.md` | Pending M1.3 |
| Six-dimension Deal Brief | `DEAL_BRIEF.md` | Pending M1.3 |
| Metadata-only engagement | `ENGAGEMENT_INTELLIGENCE.md` | Pending M1.3 |
| Optional commercial integrity | `COMMERCIAL_INTEGRITY.md` | Pending M1.3 |
| Manager Decision Queue | `MANAGER_DECISION_QUEUE.md` | Pending M1.5 |
| Executive Revenue View | `EXECUTIVE_REVENUE_VIEW.md` | Pending M1.5 |
| Recommendation lifecycle/outcomes | `RECOMMENDATION_OUTCOMES.md` | Pending M1.6/M2.1 |
| Follow-up, routing and delivery controls | `RECOMMENDATION_OPERATIONS.md` and related routing/SLO specifications | Pending M1.6 |

Background portfolio enrichment, qualified forecasting, native governed AI and
Breeze adapters are future milestones, not features shipped by this slice.

## Programme checkpoints

| Phase | Milestones | Exit condition |
|---|---|---|
| 1: deterministic product | M1.1 staging baseline; M1.2 trustworthy metrics/history; M1.3 complete Deal Brief; M1.4 bounded background intelligence; M1.5 persona workflows; M1.6 closed-loop remediation/handoff | Live-validated deterministic alpha |
| 2: intelligence and AI beta | M2.1 outcome datasets; M2.2 qualified forecasts; M2.3 grounded AI; M2.4 AI governance/budgets; M2.5 Breeze adapters; M2.6 self-service/billing | Feature-complete native beta; prediction eligibility and tool approvals explicit |
| 3: production release | M3.1 acceptance/upgrades; M3.2 security/privacy; M3.3 load/recovery; M3.4 controlled pilot; M3.5 support/Marketplace readiness; M3.6 cutover/sign-off | Evidenced, monitored, supported `3.0.0` deployment |

Versions follow alpha, beta, RC, then stable only when their respective gates
pass. Useful deterministic behavior remains mandatory when AI is unavailable.
Marketplace approval, Breeze approval, code merge and production readiness are
separate states.
