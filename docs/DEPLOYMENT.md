# Deployment and enterprise release operations

DealGuard `2.0.0-rc.1` uses Cloudflare Workers and D1, HubSpot developer platform `2026.03`, Dodo Payments, Slack, Resend, and optional customer-managed delivery/SIEM endpoints.

Repository CI proves source consistency. It does not replace authenticated HubSpot upload, Dodo test-mode validation, remote migration evidence, or production acceptance.

## 1. Release environments

Create protected GitHub Environments:

- `dealguard-staging`
- `dealguard-production`
- `dealguard-acceptance`

Production should require an approving reviewer. Do not expose environment secrets to pull-request workflows from untrusted forks.

### Environment variables

Configure these GitHub Environment variables for staging and production:

```text
APP_BASE_URL
HUBSPOT_APP_ID
HUBSPOT_CLIENT_ID
D1_DATABASE_ID
SLACK_CLIENT_ID
DODO_ENVIRONMENT
DODO_GROWTH_MONTHLY_PRODUCT_ID
DODO_GROWTH_YEARLY_PRODUCT_ID
DODO_ENTERPRISE_MONTHLY_PRODUCT_ID
DODO_ENTERPRISE_YEARLY_PRODUCT_ID
DODO_AI_CREDIT_EVENT_NAME
DODO_ACTIVE_DEAL_EVENT_NAME
DODO_EVENT_OVERAGE_EVENT_NAME
DODO_RETENTION_EVENT_NAME
```

`DODO_ENVIRONMENT` must be `test` in staging and `live` only after Dodo production approval.

### Environment secrets

Configure:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
HUBSPOT_CLIENT_SECRET
HUBSPOT_CLI_CONFIG_B64
TOKEN_ENCRYPTION_KEY
ADMIN_API_KEY
RESEND_API_KEY
SLACK_CLIENT_SECRET
DODO_API_KEY
DODO_WEBHOOK_SECRET
```

The Cloudflare token must be restricted to the required Workers and D1 resources. `TOKEN_ENCRYPTION_KEY` must contain at least 32 characters. Store the HubSpot CLI configuration as base64 only in the protected environment; never commit it.

The `dealguard-acceptance` environment requires at minimum:

```text
HUBSPOT_CLIENT_SECRET
DODO_WEBHOOK_SECRET
```

## 2. Release readiness workflow

Run **Release readiness** from GitHub Actions before any account mutation.

The workflow:

1. runs Worker and all HubSpot-extension typechecks;
2. runs the automated test suite;
3. validates required environment configuration by presence only;
4. validates package/runtime version consistency;
5. validates HubSpot manifest domains and marketplace distribution;
6. verifies migrations are contiguous through `0013_policy_dimension_mappings.sql`;
7. rejects stale Stripe deployment references;
8. renders an ephemeral Wrangler configuration;
9. builds the Worker with `wrangler deploy --dry-run`;
10. publishes only non-sensitive checksums and preflight evidence.

The workflow never writes secret values into artifacts and does not deploy or mutate D1.

Equivalent local command:

```bash
npm run release:preflight
npm run release:bundle
```

## 3. Database preparation

Create the production database once:

```bash
npx wrangler d1 create dealguard-production
```

Store the returned database ID in the protected environment and production Wrangler configuration. DealGuard requires all migrations from `0001_initial.sql` through:

```text
0007_enterprise_complete_dodo.sql
0008_secure_exports_and_audit_promotion.sql
0009_dodo_event_ordering_and_usage_counters.sql
0010_dodo_plan_change_state.sql
0011_preserve_dodo_scheduled_plan_state.sql
0012_change_approval_execution.sql
0013_policy_dimension_mappings.sql
```

Before remote migration:

1. create an encrypted D1 export or verified Cloudflare backup;
2. record the current Worker deployment/version;
3. apply migrations in staging;
4. execute staging acceptance;
5. apply migrations in production only after review.

Apply migrations with the rendered deployment configuration:

```bash
npx wrangler d1 migrations apply dealguard-production --remote \
  --config .release/wrangler.toml
```

Never attempt automatic destructive database rollback. Restore into an isolated database first, verify integrity, and switch bindings only through an approved incident procedure.

## 4. Worker secrets and variables

Set Worker secrets without storing them in shell history or repository files:

```bash
npx wrangler secret put HUBSPOT_CLIENT_ID
npx wrangler secret put HUBSPOT_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put SLACK_CLIENT_ID
npx wrangler secret put SLACK_CLIENT_SECRET
npx wrangler secret put DODO_API_KEY
npx wrangler secret put DODO_WEBHOOK_SECRET
npx wrangler secret put DODO_ENVIRONMENT
npx wrangler secret put DODO_GROWTH_MONTHLY_PRODUCT_ID
npx wrangler secret put DODO_GROWTH_YEARLY_PRODUCT_ID
npx wrangler secret put DODO_ENTERPRISE_MONTHLY_PRODUCT_ID
npx wrangler secret put DODO_ENTERPRISE_YEARLY_PRODUCT_ID
npx wrangler secret put DODO_AI_CREDIT_EVENT_NAME
npx wrangler secret put DODO_ACTIVE_DEAL_EVENT_NAME
npx wrangler secret put DODO_EVENT_OVERAGE_EVENT_NAME
npx wrangler secret put DODO_RETENTION_EVENT_NAME
```

The repository template intentionally retains placeholder app and D1 identifiers. Release preflight renders temporary values into `.release/wrangler.toml`; do not commit the rendered file.

## 5. Dodo Payments setup

Create four recurring products:

- Growth monthly
- Growth annual
- Enterprise monthly
- Enterprise annual

Configure the Dodo customer portal and the webhook endpoint:

```text
https://dealguard-api.rokad.co/webhooks/dodo
```

The Worker accepts only verified Dodo Standard Webhooks. Only `subscription.*` events can mutate commercial entitlement. Payment, refund, and dispute events are retained or ignored according to their operational purpose but cannot activate or downgrade access.

Validate in test mode:

1. all four hosted checkouts;
2. Customer Portal access;
3. activation, renewal, `past_due`, hold, recovery, cancellation, and expiry;
4. immediate and next-billing-date plan changes;
5. cancellation of a scheduled change;
6. stale/out-of-order event rejection;
7. event idempotency;
8. `sum` meters for events and AI credits;
9. `max` meters for active deals and retained storage;
10. capped mode, hard limits, and optional overage;
11. manual Enterprise contracts and expiry.

Do not enable live Dodo products until test-mode evidence is attached to the release record.

## 6. Worker deployment

Deploy only from a reviewed commit that passed release readiness:

```bash
npx wrangler deploy --config .release/wrangler.toml
```

Verify:

```bash
curl --fail https://dealguard-api.rokad.co/health
curl --fail https://dealguard-api.rokad.co/status
```

The `/health` version must exactly match `package.json`. Confirm the 15-minute cron is enabled because scans, SLA escalation, outbox dispatch, SIEM delivery, synthetic checks, billing retries, digests, retention, audit promotion, secure-download cleanup, and maintenance depend on scheduled execution.

## 7. HubSpot project upload

Authenticate locally or load the protected HubSpot CLI configuration, then run:

```bash
npm install -g @hubspot/cli@latest
npm run hubspot:deps
npm run hubspot:upload
hs project open
```

Authenticated upload must validate:

- App Home V3
- deal readiness card
- settings extension
- webhook subscriptions
- **Assess deal with DealGuard** workflow action
- **Create DealGuard remediation** workflow action
- OAuth redirects and permitted fetch URL

JSON parsing in repository CI is not HubSpot platform-schema approval.

## 8. HubSpot scopes and reauthorization

Current required scopes:

```text
crm.objects.deals.read
crm.objects.deals.write
crm.objects.contacts.read
crm.objects.companies.read
crm.objects.tasks.write
crm.schemas.deals.read
crm.schemas.deals.write
```

Existing installations must reauthorize after scope changes. DealGuard writes only its namespaced derived properties and explicitly requested remediation tasks; it does not autonomously rewrite core commercial fields.

## 9. Signed live acceptance

After deployment and HubSpot installation, run **Live acceptance** using the protected `dealguard-acceptance` environment.

Use `read-only` first, then `full`. The full profile can create an uncompleted checkout session, run a scan, assess a test deal, preview a plan change, validate Dodo signature isolation, and verify single-use exports. It does not pay, cancel, delete tenant data, publish policy, change roles, or mutate a subscription plan.

Evidence artifacts are redacted and retained for 30 days. Attach the successful workflow run to the release record.

## 10. Manual enterprise acceptance

Complete the remaining account-bound tests:

### Governance and analytics

- configure team, region, and deal-type mappings;
- simulate with production-equivalent segmentation;
- submit with user A and approve with user B;
- publish and roll back;
- verify scoped roles and redacted App Home reads;
- export analytics and policy packages through single-use links.

### Remediation

- create cases from assessments and workflow actions;
- add comments and evidence;
- bulk assign and create HubSpot tasks;
- resolve, waive, close, and reopen;
- verify SLA escalation and MTTR.

### Delivery

- configure multiple Slack, Teams, email, and signed webhook channels;
- test pipeline/team/owner/region routing;
- test quiet hours and calendars;
- force retries, dead letters, acknowledgement, and replay;
- verify SIEM delivery.

### Compliance and reliability

- verify the audit hash chain;
- export CSV, JSON, and JSONL;
- create and release a legal hold through two-person approval;
- run synthetic checks;
- interrupt and resume a scan;
- recover stale leases;
- restore a backup into an isolated environment;
- execute the disaster-recovery procedure;
- verify customer-visible incident history.

## 11. Rollback and incident boundary

For application regression:

1. stop further releases;
2. identify the previous known-good Worker deployment;
3. roll back Worker code through Cloudflare deployment history;
4. do not reverse D1 migrations automatically;
5. run read-only acceptance;
6. open an incident and preserve logs/evidence.

For data integrity issues, restore only into an isolated D1 database, verify portal counts, audit continuity, subscription state, and policy state, then switch production bindings through an approved change.

## 12. Data ownership

Deleting Rokad-hosted DealGuard data removes tenant configuration, derived assessments, remediation records, destinations, subscriptions, credentials, delivery history, and operational data subject to active legal holds. DealGuard values and tasks already written into HubSpot remain customer-controlled CRM data.

## 13. Local development

Create `.dev.vars` from `.env.example`, apply local migrations, and start the Worker:

```bash
npm run db:migrate:local
npm run dev:worker
```

HubSpot UI extensions cannot fetch arbitrary localhost origins. Use `hs project dev` with HubSpot’s local proxy or an approved temporary HTTPS Worker URL included in the app’s permitted fetch URLs.
