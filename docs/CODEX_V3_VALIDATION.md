# DealGuard v3 release-candidate validation in Codex

Candidate version: **3.0.0-rc.1**. Repository: `KartikeyAI/hubspot-dealguard`.
Read `DEALGUARD_3_CURRENT.md`, `STABLE_3_0_SIGNOFF.md`, the production runbooks,
the complete release diff and the strategy/three-phase scope before evaluating
readiness. This candidate is for independent code review and staging acceptance.

## Establish the exact source

Check out the immutable SHA from the release handoff or resolve the current PR #47
head. Preserve unrelated user changes and use a clean checkout/worktree.

```bash
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
node scripts/release-baseline.mjs --target staging
```

The baseline records source, root/Worker/UI versions, manifests and migration
digests. An older CI result does not cover a new source commit.

## Install locked dependencies

Use Node.js 22.12 or newer; canonical CI uses Node 22. PostgreSQL 18 is the target.

```bash
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix src/app/cards
npm ci --ignore-scripts --prefix src/app/settings
npm ci --ignore-scripts --prefix src/app/pages
```

The four committed lockfiles are authoritative. Run `npm audit --audit-level=high`
in each package when registry access is available; retain the actual dated result.

## Run the complete isolated gate

Put `initdb` and `postgres` on PATH, then run:

```bash
npm run test:local
```

For a PostgreSQL installation outside PATH:

```bash
DEALGUARD_POSTGRES_BIN=/absolute/path/to/postgresql/bin npm run test:local
```

The runner creates a new loopback cluster, applies every migration, checks their
immutable digests, validates schema constraints, typechecks the Worker and all
three UI packages, and runs the full test suite. It supplies both database-test
URLs, overrides inherited database URLs, ignores `.env`, and removes its own
cluster on completion. Run as a non-root user, as required by PostgreSQL initdb.

Require **zero failures and zero skipped tests**. Plain `npm test` without the
database-test URLs may skip PostgreSQL suites and is insufficient for release.
For focused investigation after building:

```bash
npm run build
npm run test:local -- node --test test/ai-handover-postgres.test.mjs
```

An existing disposable CI PostgreSQL service can instead use:

```bash
touch .env
# Set DATABASE_URL, DEALGUARD_ANALYTICS_TEST_DATABASE_URL and
# DEALGUARD_CUTOVER_TEST_DATABASE_URL to the disposable service only.
npm run db:migrate
npm run db:migrate:check
npm run db:validate
npm run check
```

## Verify packaging and actual CI

Canonical `.github/workflows/ci.yml` validates the HubSpot JSON manifests, renders
a staging-only non-secret Wrangler configuration and runs `wrangler deploy
--dry-run`. Its `verify` job must succeed for the exact release head. Preserve the
baseline, test log and Wrangler diagnostics from that run.

Typechecks and a Worker dry run do not replace a real HubSpot project build or
rendered extension acceptance. Use dedicated developer records and test routes
as described in `PRODUCTION_ACCEPTANCE_RUNBOOK.md`.

## Review changed behavior and races

- Recorded reads versus explicit refresh; current tenant/record authorization;
  historical comparison scope; unknown/stale source states.
- OAuth refresh and callback races with disconnect, deletion and reinstall.
- Paired first-administrator setup with two real signed identities, scoped legacy
  upgrade eligibility and reserved bootstrap isolation; later exact-change review,
  target-state binding, requester/reviewer revocation and concurrent decisions.
- Atomic role/audit/approval completion, email-to-ID binding, final usable
  administrator protection, self-demotion and stale execution lease acknowledgments.
- Durable deletion authorization, maintenance retries, legal-hold interruption,
  storage pagination and final sweep after the preissued-upload expiry window.
- Trial/grace/period expiry without webhooks, Free allowance fallback, Dodo
  ordering and concurrent/manual scheduled changes.
- Remediation rollback, duplicate admission and uncertain task delivery.
- AI source/cycle/consent changes during generation and cached reads; rejected
  output accounting; malformed/refused output; unavailable handoff facts.
- Forecast target compatibility, immutable artifacts, distinct reviewer,
  policy binding, calibration support, monitor drift/expiry, holds and kill switch.
- UI late-response rejection, billing-only access, real role/scope gates and
  unavailable states. Hook tests are not a rendered HubSpot browser test.
- Upgrade/checksum behavior, retention/cascades, encrypted recovery and protected
  deployment/signature gates.

AI, forecasting and Breeze default off. Enable them only with real configured
test environments, reviewed provider settings and explicit tenant consent.

## Report evidence precisely

Report exact commit/tree/version, commands and exit codes, test counts including
skips, migration/schema result, dependency audit, Worker bundle result and every
reproducible blocker. Separate local fixtures, actual PostgreSQL integration,
GitHub CI and live provider/account acceptance. Include source and run links.

The RC must fail stable production version/sign-off checks. Promotion to `3.0.0`
requires the complete approval contract, independently retained reviewer
signatures and actual staging/pilot/provider evidence. Do not substitute
synthetic approval or measurements for those facts.

### Suggested Codex task

```text
Read the entire DealGuard v3 release-candidate diff and the scope, validation and
production-signoff documents. Check out the exact supplied SHA. Run locked
dependency installation, the isolated PostgreSQL gate and canonical CI/dry run.
Review authorization and lifecycle races, billing expiry, role bootstrap and
final-administrator protection, task dispatch, native-AI grounding/privacy/cost,
forecast eligibility/monitoring, migration safety, retention and active HubSpot UI.
Fix reproducible defects with focused regressions, then rerun affected gates.
Report exact source identity, executed evidence and remaining external release
gates. Keep production approval and real provider/pilot evidence truthful.
```
