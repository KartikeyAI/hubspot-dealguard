# Slack app and customer connection setup

## Rokad Slack app configuration

Create one Slack app owned by Rokad and configure:

- OAuth redirect URL: `https://dealguard-api.rokad.co/oauth/slack/callback`
- Bot scope: `incoming-webhook`
- Distribution: enable organisation-external installation when ready for beta customers

No user token scopes, channel-history scopes, commands, events or message-read permissions are required.

Store the Slack app credentials as Worker secrets:

```bash
npx wrangler secret put SLACK_CLIENT_ID
npx wrangler secret put SLACK_CLIENT_SECRET
```

## Customer connection

1. Assign the HubSpot portal `beta_growth` or `growth`.
2. Open DealGuard under HubSpot connected-app settings.
3. Select **Prepare Slack connection**.
4. Open the generated Slack authorisation link.
5. Choose the workspace and destination channel.
6. Return to HubSpot and refresh connection status.
7. Enable the required alert types, save settings, and send a test alert.

## Disconnect behaviour

DealGuard calls Slack token revocation on a best-effort basis and always deletes its locally encrypted Slack credentials. An administrator can additionally remove the Rokad Slack app from Slack's installed-app settings.
