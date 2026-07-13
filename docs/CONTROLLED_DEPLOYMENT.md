# Controlled deployment

DealGuard deploys through `.github/workflows/controlled-deploy.yml`. The workflow is intentionally manual and protected by the `dealguard-staging` or `dealguard-production` GitHub Environment.

## Required sequence

1. Run **Release readiness** for staging.
2. Create and verify a provider-managed D1 backup or restore point.
3. Record that backup reference in the deployment request.
4. Run **Controlled deploy** to staging for a full immutable commit SHA.
5. Complete signed post-deployment acceptance.
6. Retain the staging deployment artifact.
7. For production, provide the successful staging workflow run ID and deploy the exact same SHA.
8. Production promotion is rejected when staging evidence, version, health, acceptance, commit, or backup reference does not match.

## What the workflow performs

- validates a full 40-character release SHA;
- checks out that exact commit with persisted Git credentials disabled;
- runs the complete repository gate and protected preflight;
- downloads and verifies matching staging evidence before production;
- applies reviewed remote D1 migrations;
- deploys the Cloudflare Worker;
- verifies the deployed `/health` version against `package.json`;
- runs signed HubSpot/Dodo acceptance;
- records source and migration checksums;
- emits a deployment record and redacted acceptance evidence.

## Secret boundary

The workflow does not create, export, or upload Worker secret files. Cloudflare Worker secrets must be provisioned through the restricted operational procedure before deployment. Signed post-deployment acceptance proves that the deployed Worker can use the required HubSpot and Dodo configuration.

The rendered `.release/wrangler.toml` is temporary and deleted after execution. Artifacts contain only deployment metadata, checksums, health output, preflight output, and redacted acceptance evidence.

## Database boundary

The workflow requires a non-empty provider backup or restore-point reference before applying migrations. It does not automatically reverse D1 migrations or restore data. Any restoration must occur in an isolated database and follow the approved disaster-recovery procedure.

## Production promotion evidence

The staging deployment artifact must contain `deployment-record.json` with:

- `target: staging`;
- `result: passed`;
- the exact requested production commit;
- the same release version;
- passing preflight, health, and signed acceptance;
- a recorded backup reference.

Production uses `scripts/verify-staging-promotion.mjs` to reject stale, mismatched, incomplete, or failed evidence before any migration or deployment step.

## Rollback

Application rollback uses Cloudflare deployment history and must be separately approved. Database rollback is never automatic. After any Worker rollback, run the read-only signed acceptance profile and preserve the incident and rollback evidence.
