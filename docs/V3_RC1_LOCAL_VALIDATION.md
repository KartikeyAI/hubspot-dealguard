# DealGuard 3.0.0-rc.1 local validation

Observed November 21, 2026. This receipt describes the integrated candidate's
local engineering validation. GitHub CI must separately validate the published
commit. It is not a production approval, customer acceptance or deployment.

## Complete gate

Fresh `npm ci --ignore-scripts` installations succeeded in the root, cards,
settings and pages packages. The complete isolated PostgreSQL runner then passed:

| Check | Observed result |
| --- | --- |
| Full automated suite | **997 passed, 0 failed, 0 skipped** |
| Worker and all three UI TypeScript checks | Passed |
| Migration application and immutable digest verification | All **43** migrations |
| Base schema validation | **112 tables**, **145 foreign keys**, **173 tenant-leading indexes** |
| Additional intelligence schema | 16 tables, 24 tenant-bound cascading foreign keys, 9 lifecycle triggers, 30 checked atomic functions |
| Release convergence | **124/124** checks |
| Four dependency audits | **0 vulnerabilities** reported in each package |
| Fresh-install staging Worker dry run | Passed; no Worker published |

The environment used Node.js 24.22.3 and PostgreSQL 18.7. Canonical GitHub CI
uses Node 22 and PostgreSQL 18, so its result must be recorded independently.
Previously published migrations 0001–0030 remain unchanged.

The full suite includes real, disposable PostgreSQL and signed HubSpot request
tests for paired administrator setup; exact role review/application; changed
target, requester and reviewer authority; concurrent decisions and administrator
removal; execution leases; audit rollback; OAuth callback/refresh races;
resumable deletion; billing expiry and scheduling; evidence freshness;
remediation delivery; AI admission/settlement/cache; and forecast lifecycle.
Provider responses and storage failures are simulated where indicated by tests.

## Local scale and recovery

The actual recorded-assessment service completed 10,000 distinct deal reads in
two concurrent synthetic portals, with eight readers and 90,000 measured SQL
queries. Both portals deliberately shared deal IDs to exercise tenant binding.
The measured read window was 5,216.902 ms; p50 was 3.998 ms, p95 6.629 ms and p99
9.716 ms. There were zero attempted writes, wrong-portal parameters/rows or
external requests. All 112 schema table fingerprints remained unchanged.

An actual local PostgreSQL dump, encryption, checksum, decryption and restore
verified all 112 table fingerprints, including populated synthetic data in all
seven forecast relations. The restored database passed consent/hold withholding,
job cancellation and deactivation/cascade checks. Total fixture rehearsal time
was 475 ms. The synthetic forecast was suspended and had no review approval.

These are local Node/PostgreSQL rehearsals, not deployed Workers/Neon latency,
Cloudflare CPU, Tigris restoration or production RPO/RTO measurements. Detailed
methods and repeatable commands are in `LOCAL_SCALE_REHEARSAL.md` and
`LOCAL_RECOVERY_REHEARSAL.md`.

## Independent review and release

Use `CODEX_V3_VALIDATION.md` with the exact published commit. Read the full diff,
the current product scope, administrator setup, deterministic operation safety,
AI/outcome/forecast documentation and the production sign-off contract.

The candidate remains `3.0.0-rc.1`. Actual HubSpot build/install/rendered persona
acceptance, test-mode Dodo reconciliation, live AI quality/privacy/cost evidence,
independent security review, protected deployment governance, representative
provider load/restore, consenting pilots and the signed eleven-category dossier
remain required before stable promotion and controlled production deployment.
AI, forecasting and Breeze remain disabled by default.
