# Deployment and HubSpot enterprise test setup

## 1. Install tools

```bash
npm install
npm install -g @hubspot/cli@latest
```

The repository targets HubSpot developer platform `2026.03`.

## 2. Create and migrate D1

```bash
npx wrangler d1 create dealguard-production
```

Copy the database ID into `wrangler.toml`, then apply all migrations through enterprise operations:

```bash
npm run db:migrate:remote
```

Confirm `0004_native_sync.sql`, `0005_enterprise_governance.sql`, and `0006_enterprise_operations.sql` are applied before exposing v1.4 controls.

## 3. Configure Worker secrets

Generate an encryption key:

```bash
openssl rand -base64 32
```

Set core and integration secrets:

```bash
npx wrangler secret put HUBSPOT_CLIENT_ID
npx wrangler secret put HUBSPOT_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put SLACK_CLIENT_ID
npx wrangler secret put SLACK_CLIENT_SECRET
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Configure these non-secret Worker variables or secrets according to the deployment policy:

```text
STRIPE_GROWTH_MONTHLY_PRICE_ID
STRIPE_GROWTH_YEARLY_PRICE_ID
STRIPE_ENTERPRISE_MONTHLY_PRICE_ID
STRIPE_ENTERPRISE_YEARLY_PRICE_ID
```

`RESEND_API_KEY`, Slack, and Stripe can remain unset only while their features are disabled. Enterprise release acceptance requires them.

## 4. Configure Stripe

1. Create four recurring Prices: Growth monthly/yearly and Enterprise monthly/yearly.
2. Configure the Stripe Customer Portal for subscription, payment-method, invoice, and cancellation management.
3. Add webhook endpoint `https://dealguard-api.rokad.co/webhooks/stripe`.
4. Subscribe to:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Store the webhook signing secret in `STRIPE_WEBHOOK_SECRET`.
6. Confirm portal and tier metadata is visible on Checkout and Subscription objects.

DealGuard uses Stripe-hosted Checkout and Customer Portal. It does not collect or store card data.

## 5. Deploy backend

```bash
npm run deploy:worker
```

Map the Worker to `dealguard-api.rokad.co`, then verify:

```bash
curl https://dealguard-api.rokad.co/health
```

Confirm the scheduled trigger is enabled because scanning, overdue-case escalation, outbox delivery, retry, digests, and maintenance depend on cron execution.

## 6. Upload HubSpot project

```bash
hs account auth
npm run hubspot:deps
npm run hubspot:upload
hs project open
```

Copy the generated app ID, client ID, and client secret into Worker configuration. Validate both workflow action schemas and App Home during authenticated upload; JSON validation in CI is not HubSpot platform-schema validation.

## 7. Reauthorize installations

v1.4 requires:

- `crm.objects.deals.read`
- `crm.objects.deals.write`
- `crm.objects.contacts.read`
- `crm.objects.companies.read`
- `crm.objects.tasks.write`
- `crm.schemas.deals.read`
- `crm.schemas.deals.write`

The task-write scope is used only when an administrator, assessment rule, or workflow explicitly creates a DealGuard remediation task. DealGuard does not modify core deal fields.

## 8. Validate native reporting and governance

1. Provision all seven `dealguard_*` properties.
2. Enable native write-back and run a controlled backfill.
3. Verify lists, saved views, reports, workflow branches, and both workflow actions.
4. Enable enterprise governance under an active manual or Stripe Enterprise entitlement.
5. Assign separate policy-creator and policy-approver users.
6. Simulate, approve, publish, and roll back a policy revision.
7. Verify direct live-rule editing is blocked.

## 9. Validate remediation

1. Create a critical deal issue and run an assessment.
2. Confirm one active remediation case is created for the deal and issue code.
3. Confirm the associated HubSpot task has subject, body, due time, priority, owner, and deal association.
4. Acknowledge, start, resolve, and reopen cases from App Home.
5. Allow a test SLA to expire and confirm scheduled escalation to `overdue`.
6. Remove the underlying assessment issue and confirm an assessment-created case resolves automatically.
7. Execute **Create DealGuard remediation** from a deal-based workflow and validate outputs.

## 10. Validate delivery reliability

1. Create a Microsoft Teams Workflow using the Teams webhook trigger and configure its HTTPS URL as a DealGuard destination.
2. Create an email destination.
3. Create a generic webhook destination and verify `X-DealGuard-Signature` using the configured secret.
4. Route events by event type, severity, and pipeline.
5. Force endpoint failures and confirm retries use increasing delay.
6. Confirm the eighth failure becomes a dead letter.
7. Restore the endpoint and replay the dead letter from App Home.
8. Inspect delivery-attempt history and per-portal health.

## 11. Validate billing

1. Start Growth and Enterprise monthly/annual Checkout sessions.
2. Confirm signed webhooks update subscription state and internal entitlements.
3. Open Stripe Customer Portal and test payment method, invoice, cancellation, and renewal behavior.
4. Simulate `past_due` and confirm the seven-day grace window.
5. Simulate cancellation or unpaid status and confirm Enterprise-only mutations are blocked.
6. Apply a manual Enterprise contract through the authenticated internal endpoint and confirm entitlement.

## 12. Data ownership and removal

Deleting DealGuard data removes Rokad-hosted tenant data, assessments, remediation cases, destinations, subscriptions, integration credentials, delivery history, and operational records. DealGuard property values and tasks already written to HubSpot remain customer-controlled CRM data.

## 13. Local development

Create `.dev.vars` from `.env.example`, apply local migrations, and start the Worker:

```bash
npm run db:migrate:local
npm run dev:worker
```

HubSpot UI extensions cannot permit localhost directly. Use `hs project dev` with the HubSpot local proxy or a temporary HTTPS Worker preview URL listed under `permittedUrls.fetch`.
