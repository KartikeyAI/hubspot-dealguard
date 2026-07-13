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
```

`RESEND_API_KEY` is optional until digest email is tested.

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

## 6. Install into a developer test account

From the HubSpot project page, install the app into a configurable developer test account. Open a deal record and add **DealGuard Readiness** from the App card library to the middle column.

Open Marketplace → Connected apps → DealGuard by Rokad → Settings to run the first scan and configure rules.

## 7. Local development

Create `.dev.vars` from `.env.example`, apply local migrations, and start Worker development:

```bash
npm run db:migrate:local
npm run dev:worker
```

HubSpot UI extensions cannot permit localhost directly. Configure the HubSpot local proxy workflow during `hs project dev`, or temporarily deploy a Worker preview URL and add its HTTPS prefix to `permittedUrls.fetch`.
