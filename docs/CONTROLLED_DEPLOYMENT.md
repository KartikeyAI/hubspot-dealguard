# Controlled deployment

DealGuard deploys through `.github/workflows/controlled-deploy.yml`. The workflow is intentionally manual and protected by the `dealguard-staging` or `dealguard-production` GitHub Environment.

## Required sequence

1. Run **Release readiness** for staging.
2. Create, encrypt, verify and independently restore-test a Neon PostgreSQL backup through the documented Tigris backup procedure.
3. Record the target-specific encrypted backup object key and its independent SHA-256 digest.
4. Run **Controlled deploy** to staging for a full immutable commit SHA and an approved Enterprise acceptance portal/test deal.
5. Complete standard signed acceptance and all twelve required intelligence certification tests.
6. Retain the run/attempt-specific staging deployment artifact and live HubSpot acceptance evidence.
7. For production, provide the successful staging workflow run ID and deploy the exact same SHA.
8. Production promotion requires v4 full-profile evidence generated within the intelligence gate's 24-hour window. It rejects stale, mismatched, incomplete, diagnostic-only or failed evidence.

See [Intelligence release certification](INTELLIGENCE_RELEASE_GATE.md) for the normative automated evidence contract, diagnostic behavior and remaining manual gates.

## What the workflow performs

- validates a full 40-character release SHA and target-specific encrypted backup key/digest;
- checks out that exact commit with persisted Git credentials disabled and captures its repository baseline;
- runs the complete repository gate and protected preflight;
- fetches trusted GitHub run metadata and downloads matching run/attempt staging evidence before production;
- verifies the encrypted Tigris backup evidence before applying reviewed PostgreSQL migrations;
- validates migration checksums and tenant constraints;
- deploys the Cloudflare Worker using direct Neon connectivity;
- verifies the deployed `/health` service and version against `package.json`;
- runs public smoke and signed HubSpot/Dodo acceptance;
- runs mandatory intelligence certification for the full profile;
- records source and migration checksums;
- emits a v4 deployment record and sanitized acceptance evidence.

## Secret boundary

The workflow does not create, export, or upload Worker secret files. Worker secrets must be provisioned through the restricted operational procedure before deployment. Acceptance tests exercise only their specified configuration paths; passing them is not proof of every provider integration or account capability.

The rendered `.release/wrangler.toml` is temporary and deleted after execution. Artifacts use explicit paths for baseline, deployment metadata, checksums, health, preflight, smoke, and sanitized standard/intelligence results. `.env` and rendered configuration are excluded. Treat portal/deal identifiers and operational evidence as restricted release records.

## Database boundary

The workflow requires an encrypted `backups/<target>/...enc` Tigris object and an independent SHA-256 before applying migrations. It does not automatically reverse migrations or restore data. Restore testing must occur in an isolated database and follow the approved disaster-recovery procedure. Production and staging must use separate protected Neon credentials and resources. Hyperdrive and D1 are not the current runtime database path.

## Production promotion evidence

The staging artifact is named `dealguard-deployment-staging-<run-id>-<attempt>`. It must contain exactly one `deployment-record.json` with:

- `schemaVersion: 4`, `target: staging`, `result: passed`, and `promotable: true`;
- the exact proposed production commit/version and a matching repository baseline;
- the selected trusted workflow run and attempt;
- consistent target/origin/portal/test-deal identities across acceptance results;
- complete, passing public smoke and full standard/intelligence result sets;
- a staging-specific encrypted backup reference and valid independent digest.

`scripts/verify-staging-promotion.mjs` revalidates these conditions before any migration or deployment. Schema-v3 records and read-only diagnostics are not promoted. Rerun staging instead of editing earlier evidence. GitHub Marketplace approval and actual HubSpot project build/UI acceptance remain separate gates; this workflow does not automatically upload the HubSpot project.

## Rollback

Application rollback uses Cloudflare deployment history and must be separately approved. Database rollback is never automatic. After any Worker rollback, run appropriate signed diagnostics and preserve incident and rollback evidence. The standard read-only profile can still assess a supplied test deal; consult the intelligence-gate side-effect boundary before selecting test inputs.
