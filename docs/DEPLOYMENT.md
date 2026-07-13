# Deployment and HubSpot test setup

## 1. Install tools

```bash
npm install
npm install -g @hubspot/cli@latest
```

HubSpot's current project platform requires the latest CLI and the repository targets platform version `2026.03`.

## 2. Create D1

```bash
npx wrangler d1 create dealguard-production
```

Copy the returned database ID into `wrangler.toml`, then apply migrations:

```bash
npm run db:migrate:remote
```

For v1.2, confirm `0004_native_sync.sql` is applied before exposing native sync controls.

## 3. Configure Worker secrets

Generate an encryption key:

```bash
openssl rand -base64 32
```

Set secrets:

```bash
npx wrangler secret put HUBSPOT_CLIENT_ID
npx wrangler secret put HUBSPOT_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put SLACK_CLIENT_ID
npx wrangler secret put SLACK_CLIENT_SECRET
```

`RESEND_API_KEY` and the Slack secrets are optional until their corresponding integrations are tested.

## 4. Deploy backend

```bash
npm run deploy:worker
```

Map the Worker to `dealguard-api.rokad.co`, then verify:

```bash
curl https://dealguard-api.rokad.co/health
```

## 5. Upload HubSpot project

Authenticate the Rokad developer account:

```bash
hs account auth
npm run hubspot:deps
npm run hubspot:upload
```

Open the uploaded project:

```bash
hs project open
```

Copy the generated app ID, client ID, and client secret into Worker configuration/secrets. Confirm the app ID in `wrangler.toml` and redeploy.

Validate the workflow action output schema during the authenticated project upload. JSON validation in CI does not replace HubSpot's platform-schema validation.

## 6. Reauthorize existing installations

v1.2 adds these scopes:

- `crm.objects.deals.write`
- `crm.schemas.deals.write`

Existing portals must complete OAuth again after the updated HubSpot project and Worker are deployed. Confirm the token metadata includes both scopes before provisioning properties.

The write scopes are used only to create and update the fixed `dealguard_*` properties. DealGuard does not write to customer-owned, non-DealGuard fields.

## 7. Install into a developer test account

From the HubSpot project page, install or reauthorize the app in a configurable developer test account. Open a deal record and add **DealGuard Readiness** from the App card library to the middle column.

Open Marketplace → Connected apps → DealGuard by Rokad → Settings to run the first scan and configure rules.

## 8. Validate native HubSpot sync

Use a Growth or beta-Growth test portal:

1. Open DealGuard settings.
2. Select **Provision properties**.
3. Verify all seven `dealguard_*` properties exist with the expected types.
4. Enable native property write-back and save settings.
5. Run **Backfill assessed deals**.
6. Confirm the values appear on assessed deal records.
7. Create a list filtered by `dealguard_readiness_status`.
8. Create a report using readiness score and status.
9. Run a deal-based workflow using **Assess deal with DealGuard** and validate all output fields.
10. Modify a monitored deal field and confirm webhook-triggered reassessment updates the DealGuard properties.

## 9. Data ownership and removal

Deleting DealGuard data removes Rokad-hosted tenant data, assessments, integration credentials, and operational records. Values already written to HubSpot are part of the customer's CRM and are not automatically cleared. The provisioned property definitions also remain unless the customer removes them in HubSpot.

This separation prevents an external app deletion from unexpectedly erasing customer CRM reporting data. A dedicated, explicitly confirmed HubSpot-property cleanup operation can be added in a later release if required.

## 10. Local development

Create `.dev.vars` from `.env.example`, apply local migrations, and start Worker development:

```bash
npm run db:migrate:local
npm run dev:worker
```

HubSpot UI extensions cannot permit localhost directly. Configure the HubSpot local proxy workflow during `hs project dev`, or temporarily deploy a Worker preview URL and add its HTTPS prefix to `permittedUrls.fetch`.
